require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const Groq = require("groq-sdk");
const crypto = require("crypto");

const app = express();
app.use((req, res, next) => {
  if (req.path === '/webhook/razorpay') return next();
  express.json({ limit: '20mb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, "public")));

// -- KNOWLEDGE BASE - RAG --
// Load full knowledge base (Williams Obs + Williams Gynec + Clinical Guidelines)
let knowledgeBase = [];
try {
  const kbPath = path.join(__dirname, 'data', 'bloom_kb_complete.json');
  knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  console.log(`Knowledge base loaded: ${knowledgeBase.length} chunks`);
} catch (e) {
  // Fallback to old markdown file if JSON not yet uploaded
  console.log('JSON KB not found, falling back to markdown KB');
  try {
    const mdPath = path.join(__dirname, 'data', 'bloom_ai_system_prompt_kb.md');
    const mdText = fs.readFileSync(mdPath, 'utf8');
    knowledgeBase = [{ id: 'legacy', source: 'Legacy KB', chapter: 'general', text: mdText }];
    console.log('Markdown KB loaded as fallback');
  } catch (e2) {
    console.log('No knowledge base found');
  }
}

// -- RAG SEARCH FUNCTION --
function searchKnowledge(query, profile, topK = 10) {
  if (!knowledgeBase.length) return '';

  // Extract search terms from query
  const queryWords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Add profile-based context terms
  const contextTerms = [];
  if (profile) {
    const syms = profile.symptoms || [];
    const meds = profile.medications || [];
    if (syms.includes('pcos_diagnosed')) contextTerms.push('pcos', 'polycystic');
    if (syms.includes('irregular_periods')) contextTerms.push('anovulation', 'irregular');
    if (meds.includes('metformin')) contextTerms.push('metformin', 'insulin');
    if (meds.includes('letrozole')) contextTerms.push('letrozole', 'ovulation induction');
    if (meds.includes('clomiphene')) contextTerms.push('clomiphene', 'ovulation induction');
    if (profile.journeyStage === 'pregnant') contextTerms.push('pregnancy', 'prenatal', 'obstetric');
    if (profile.journeyStage === 'ttc_ivf') contextTerms.push('ivf', 'assisted reproduction', 'embryo');
    if (profile.journeyStage === 'perimenopause') contextTerms.push('menopause', 'perimenopause', 'hrt');
  }

  const allTerms = [...new Set([...queryWords, ...contextTerms])];

  // Chapter priority keywords
  const chapterPriority = {
    pcos_hyperandrogenism: ['pcos', 'polycystic', 'hirsutism', 'androgen', 'hyperandrogenism'],
    endometriosis: ['endometriosis', 'endometrioma', 'adenomyosis'],
    fibroids: ['fibroid', 'leiomyoma', 'myomectomy'],
    menopause: ['menopause', 'menopausal', 'hrt', 'hot flush', 'perimenopause'],
    infertility: ['infertility', 'infertile', 'fertility', 'conception', 'ttc'],
    infertility_treatment: ['ivf', 'iui', 'letrozole', 'clomiphene', 'ovulation induction'],
    prenatal_care: ['prenatal', 'antenatal', 'pregnancy care', 'booking'],
    normal_labor: ['labour', 'labor', 'delivery', 'birth', 'contraction'],
    preeclampsia: ['preeclampsia', 'pre-eclampsia', 'hypertension pregnancy', 'eclampsia'],
    diabetes_mellitus: ['gestational diabetes', 'gdm', 'glucose', 'insulin pregnancy'],
    contraception: ['contraception', 'birth control', 'pill', 'iud', 'condom'],
    cervical_disease: ['cervical', 'hpv', 'pap smear', 'colposcopy', 'cin'],
    abnormal_uterine_bleeding: ['bleeding', 'heavy periods', 'menorrhagia', 'aub'],
    miscarriage: ['miscarriage', 'pregnancy loss', 'recurrent', 'spontaneous abortion'],
    ectopic_pregnancy: ['ectopic', 'tubal pregnancy', 'methotrexate'],
    low_amh: ['amh', 'ovarian reserve', 'diminished', 'egg quality'],
    thyroid_fertility: ['thyroid', 'tsh', 'hypothyroid', 'hyperthyroid'],
    preterm_birth: ['preterm', 'premature', 'preterm labour'],
    puerperium_postpartum: ['postpartum', 'postnatal', 'puerperium', 'breastfeeding'],
  };

  // Score each chunk
  const scored = knowledgeBase.map(chunk => {
    const chunkText = chunk.text.toLowerCase();
    const chunkChapter = (chunk.chapter || '').toLowerCase();
    let score = 0;

    // Score based on query word matches
    for (const term of allTerms) {
      const textMatches = (chunkText.match(new RegExp(term, 'g')) || []).length;
      score += textMatches * 2;
      if (chunkChapter.includes(term)) score += 5;
    }

    // Boost score based on chapter priority match
    for (const [chapter, keywords] of Object.entries(chapterPriority)) {
      if (chunkChapter === chapter) {
        for (const kw of keywords) {
          if (allTerms.some(t => t.includes(kw) || kw.includes(t))) {
            score += 8;
          }
        }
      }
    }

    // Boost Williams textbook sources
    if (chunk.source && chunk.source.includes('Williams')) score += 1;

    return { ...chunk, score };
  });

  // Return top K relevant chunks
  const relevant = scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (!relevant.length) {
    // Fallback: return general fertility chunks
    return knowledgeBase
      .filter(c => ['ttc_basics', 'preconception', 'menstrual_cycle', 'hormone_ranges'].includes(c.chapter))
      .slice(0, 5)
      .map(c => `[${c.chapter}]\n${c.text}`)
      .join('\n\n---\n\n');
  }

  return relevant
    .map(c => `[${c.source || 'Clinical KB'} - ${c.chapter}]\n${c.text}`)
    .join('\n\n---\n\n');
}

// -- BLOOM SYSTEM PROMPT --
const BLOOM_SYSTEM_PROMPT = `You are Bloom, a warm, knowledgeable, and compassionate AI fertility and women's health companion, created by a licensed gynecologist.

You provide accurate, evidence-based information grounded in:
- Williams Obstetrics (26th Edition)
- Williams Gynecology (4th Edition)  
- Speroff's Clinical Gynecologic Endocrinology and Infertility (9th Edition)
- Current clinical guidelines (NICE, ESHRE, ASRM, RCOG, FIGO)

Core principles:
1. Evidence-based - cite clinical evidence when relevant
2. Personalised - tailor responses to the user's profile, journey stage, symptoms and medications
3. Compassionate - fertility journeys are emotionally demanding; respond with warmth
4. Safe - always recommend consulting a doctor for diagnosis and treatment decisions
5. Accurate - if uncertain, say so clearly

Communication style:
- Warm and professional - like a knowledgeable gynaecologist friend
- Clear language - explain medical terms when used
- Always end with a practical, actionable next step
- In Indian context - reference Indian dietary options, acknowledge cost considerations

Important boundaries:
- Do NOT diagnose conditions definitively
- Do NOT prescribe specific drug doses without recommending medical consultation
- Emergency symptoms (severe pain, heavy bleeding, reduced fetal movements) -> always direct to immediate medical care
- Always include: "Please discuss with your doctor before making any changes"`;

let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB error:", err.message);
  }
}

connectDB();

const UserSchema = new mongoose.Schema({
  email:               { type: String, required: true, unique: true },
  password:            { type: String, required: true },
  plan:                { type: String, default: "free" },
  isPremium:           { type: Boolean, default: false },
  messageCount:        { type: Number, default: 0 },
  reportAnalysisCount: { type: Number, default: 0 },
  profile: {
    name:         String,
    age:          Number,
    cycleLength:  Number,
    periodLength: Number,
    journeyStage: String,
    symptoms:     [String],
    medications:  [String],
    notes:        String,
  },
  fertilityPlan: {
    content:     String,
    generatedAt: Date,
  },
});

const User = mongoose.models.User || mongoose.model("User", UserSchema);

const OrderSchema = new mongoose.Schema({
  razorpayOrderId: String,
  userId:          mongoose.Schema.Types.ObjectId,
  plan:            String,
  amount:          Number,
  status:          { type: String, default: "pending" },
  createdAt:       { type: Date, default: Date.now },
});

const Order = mongoose.models.Order || mongoose.model("Order", OrderSchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID || "dummy",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "dummy",
});

const PLANS = {
  pro:      { amount: 14900, label: "Bloom Pro",      monthly: 149 },
  complete: { amount: 44900, label: "Bloom Complete",  monthly: 449 },
};

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "BLOOM_SECRET");
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.get("/test", (req, res) => {
  res.json({
    status:    "ok",
    mongo:     process.env.MONGO_URI       ? "set" : "missing",
    groq:      process.env.GROQ_API_KEY    ? "set" : "missing",
    jwt:       process.env.JWT_SECRET      ? "set" : "missing",
    razorpay:  process.env.RAZORPAY_KEY_ID ? "set" : "missing",
    dbState:   mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    kbChunks:  knowledgeBase.length,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/signup", async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hash });
    res.json({ message: "Account created", userId: user._id });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Signup failed: " + err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "No account found with that email" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password" });
    const token = jwt.sign(
      { id: user._id, plan: user.plan },
      process.env.JWT_SECRET || "BLOOM_SECRET",
      { expiresIn: "30d" }
    );
    res.json({ token, plan: user.plan, email: user.email, messageCount: user.messageCount });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed: " + err.message });
  }
});

app.get("/me", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/profile", auth, async (req, res) => {
  try {
    await connectDB();
    const { name, age, cycleLength, periodLength, journeyStage, symptoms, medications, notes } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profile: { name, age, cycleLength, periodLength, journeyStage, symptoms, medications, notes } },
      { new: true }
    ).select("-password");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Could not update profile" });
  }
});

// -- CHAT --
app.post("/chat", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Free plan: 3 messages/day limit
    if (user.plan === "free" && user.messageCount >= 3) {
      return res.json({
        reply: null,
        limitReached: true,
        message: "You've used your 3 free messages. Upgrade to Bloom Pro for unlimited conversations.",
      });
    }

    user.messageCount++;
    await user.save();

    const profile = user.profile || {};
    const userMessage = req.body.message || '';

    // RAG - fetch relevant knowledge chunks for this query
    const relevantKnowledge = searchKnowledge(userMessage, profile, 10);

    // Build personalised context
    let profileContext = '';
    if (profile.journeyStage) {
      profileContext = `\n\nUser profile: ${profile.name || 'User'} is on a ${profile.journeyStage} journey.`;
      if (profile.age) profileContext += ` Age: ${profile.age}.`;
      if (profile.cycleLength) profileContext += ` Cycle: ${profile.cycleLength} days.`;
      if (profile.symptoms && profile.symptoms.length) profileContext += ` Symptoms: ${profile.symptoms.join(', ')}.`;
      if (profile.medications && profile.medications.length) profileContext += ` Medications: ${profile.medications.join(', ')}.`;
    }

    const systemPrompt = `${BLOOM_SYSTEM_PROMPT}${profileContext}

Use the following clinically relevant knowledge to answer the user's question accurately. Synthesise this into a warm, clear, helpful response - do not copy it verbatim.

--- RELEVANT CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage },
      ],
      max_tokens: 800,
    });

    res.json({
      reply:        response.choices[0].message.content,
      messageCount: user.messageCount,
      plan:         user.plan,
    });

  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Something went wrong: " + err.message });
  }
});

// -- FERTILITY PLAN --
app.get("/fertility-plan", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan !== "complete") {
      return res.status(403).json({
        error: "upgrade_required",
        message: "Personalised fertility plans are part of Bloom Complete.",
      });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (user.fertilityPlan && user.fertilityPlan.content && user.fertilityPlan.generatedAt > thirtyDaysAgo) {
      return res.json({ plan: user.fertilityPlan.content, generatedAt: user.fertilityPlan.generatedAt, cached: true });
    }

    const profile = user.profile || {};

    // RAG - fetch knowledge relevant to this user's profile
    const planQuery = [
      profile.journeyStage || 'fertility',
      profile.symptoms ? profile.symptoms.join(' ') : '',
      profile.medications ? profile.medications.join(' ') : '',
      'fertility plan nutrition supplements lifestyle',
    ].join(' ');

    const relevantKnowledge = searchKnowledge(planQuery, profile, 15);

    const systemPrompt = `You are Bloom's senior fertility advisor AI, created by a licensed gynecologist. Generate detailed, personalised, evidence-based fertility plans in structured markdown format. 

Always include: introduction, cycle insights, nutrition plan, supplement recommendations, lifestyle adjustments, stress management, and monthly roadmap. Be warm, specific, and actionable. Reference clinical evidence where appropriate.

Use this clinically relevant knowledge to ensure accuracy:
--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: buildPlanPrompt(profile) },
      ],
      max_tokens: 2000,
    });

    const planContent = response.choices[0].message.content;
    await User.findByIdAndUpdate(req.user.id, {
      fertilityPlan: { content: planContent, generatedAt: new Date() },
    });

    res.json({ plan: planContent, generatedAt: new Date(), cached: false });

  } catch (err) {
    console.error("Plan error:", err.message);
    res.status(500).json({ error: "Could not generate plan: " + err.message });
  }
});

app.post("/fertility-plan/regenerate", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.plan !== "complete") return res.status(403).json({ error: "upgrade_required" });

    const profile = user.profile || {};
    const planQuery = [
      profile.journeyStage || 'fertility',
      profile.symptoms ? profile.symptoms.join(' ') : '',
      profile.medications ? profile.medications.join(' ') : '',
      'fertility plan nutrition supplements lifestyle',
    ].join(' ');

    const relevantKnowledge = searchKnowledge(planQuery, profile, 15);

    const systemPrompt = `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format. Be warm, evidence-based, and actionable.

--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: buildPlanPrompt(profile) },
      ],
      max_tokens: 2000,
    });

    const planContent = response.choices[0].message.content;
    await User.findByIdAndUpdate(req.user.id, {
      fertilityPlan: { content: planContent, generatedAt: new Date() },
    });

    res.json({ plan: planContent, generatedAt: new Date(), cached: false });
  } catch (err) {
    res.status(500).json({ error: "Could not regenerate plan: " + err.message });
  }
});

function buildPlanPrompt(profile) {
  return "Please generate a personalised fertility plan for this user:\n" +
    "Name: " + (profile.name || "Not provided") + "\n" +
    "Age: " + (profile.age || "Not provided") + "\n" +
    "Journey stage: " + (profile.journeyStage || "general fertility support") + "\n" +
    "Average cycle length: " + (profile.cycleLength ? profile.cycleLength + " days" : "Not provided") + "\n" +
    "Average period length: " + (profile.periodLength ? profile.periodLength + " days" : "Not provided") + "\n" +
    "Current symptoms: " + (profile.symptoms && profile.symptoms.length ? profile.symptoms.join(", ") : "None noted") + "\n" +
    "Current medications: " + (profile.medications && profile.medications.length ? profile.medications.join(", ") : "None") + "\n" +
    "Additional notes: " + (profile.notes || "None") + "\n\n" +
    "Create a comprehensive personalised fertility plan with these sections:\n" +
    "1. Personal Overview and Key Insights\n" +
    "2. Understanding Your Cycle\n" +
    "3. Nutrition Plan\n" +
    "4. Supplement Protocol\n" +
    "5. Lifestyle Adjustments\n" +
    "6. Stress and Emotional Wellbeing\n" +
    "7. 4-Week Action Roadmap\n" +
    "8. When to Speak to Your Doctor";
}

// -- REPORT ANALYZER --
app.post("/analyze-report", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan === "free") {
      return res.status(403).json({
        error: "upgrade_required",
        message: "Report analysis requires Bloom Pro or Complete. Upgrade to get started.",
      });
    }

    if (user.plan === "pro" && user.reportAnalysisCount >= 3) {
      return res.status(403).json({
        error: "limit_reached",
        message: "You've used your 3 monthly report analyses. Upgrade to Bloom Complete for unlimited reports.",
      });
    }

    if (user.plan === "pro") {
      await User.findByIdAndUpdate(req.user.id, { $inc: { reportAnalysisCount: 1 } });
    }

    const { imageBase64, reportType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });

    const profile = user.profile || {};

    // RAG - fetch knowledge relevant to this report type
    const reportQueries = {
      hormone:    'FSH LH AMH estradiol progesterone prolactin testosterone hormone ranges fertility',
      thyroid:    'thyroid TSH T3 T4 anti-TPO hypothyroid fertility',
      ultrasound: 'ultrasound antral follicle count AFC endometrium ovarian cyst fibroid PCOS morphology',
      semen:      'semen analysis sperm count motility morphology azoospermia WHO criteria',
      blood:      'haemoglobin ferritin iron fasting glucose HbA1c insulin HOMA-IR blood count',
      general:    'medical report investigation fertility gynecology',
    };

    const reportKnowledge = searchKnowledge(
      reportQueries[reportType] || reportQueries.general,
      profile,
      8
    );

    const profileContext = [
      profile.name      ? `Name: ${profile.name}`                                         : null,
      profile.age       ? `Age: ${profile.age}`                                           : null,
      profile.journeyStage ? `Journey: ${profile.journeyStage}`                           : null,
      profile.cycleLength  ? `Cycle length: ${profile.cycleLength} days`                  : null,
      profile.symptoms && profile.symptoms.length
                        ? `Symptoms: ${profile.symptoms.join(", ")}`                       : null,
      profile.medications && profile.medications.length
                        ? `Medications: ${profile.medications.join(", ")}`                 : null,
      profile.notes     ? `Notes: ${profile.notes}`                                       : null,
    ].filter(Boolean).join("\n");

    const reportTypeLabels = {
      hormone:    "Hormone Panel (FSH, LH, AMH, estradiol, progesterone, prolactin, testosterone)",
      thyroid:    "Thyroid Function Test (TSH, T3, T4, Anti-TPO)",
      ultrasound: "Pelvic / Transvaginal Ultrasound Report",
      semen:      "Semen Analysis Report",
      blood:      "Blood Test / Complete Blood Count / metabolic panel",
      general:    "General Medical Report",
    };

    const systemPrompt = `You are Bloom's expert medical report analyzer - a specialist in reproductive endocrinology and fertility medicine, created by a licensed gynecologist and grounded in Williams Obstetrics, Williams Gynecology, and Speroff's.

A patient has uploaded their ${reportTypeLabels[reportType] || "medical report"}. Analyze it thoroughly and return a JSON object ONLY - no markdown, no preamble, no explanation outside the JSON.

Patient profile:
${profileContext || "No profile provided"}

Use this clinical reference knowledge for accurate interpretation:
--- CLINICAL REFERENCE ---
${reportKnowledge}
--- END ---

Your JSON must follow this exact structure:
{
  "values": [
    {
      "name": "FSH",
      "description": "Follicle Stimulating Hormone",
      "value": "7.2 IU/L",
      "normalRange": "3-10 IU/L",
      "status": "normal"
    }
  ],
  "summary": "Overall plain-English summary of findings in 2-3 sentences, personalised to this patient's journey",
  "concerns": [
    { "title": "Elevated LH:FSH ratio", "detail": "Detailed explanation of what this means and why it matters for fertility, referencing clinical significance" }
  ],
  "positives": [
    { "title": "AMH within normal range", "detail": "What this means positively for the patient" }
  ],
  "personalised": "2-3 sentences specifically connecting these results to their journey stage, symptoms, and profile",
  "nextSteps": [
    "Book appointment with gynaecologist to discuss LH:FSH ratio",
    "Request day 21 progesterone test to confirm ovulation",
    "Consider transvaginal ultrasound to assess antral follicle count"
  ]
}

Rules:
- status must be one of: "normal", "low", "high", "borderline", "na"
- Extract EVERY value visible in the report - do not skip any
- Use Indian clinical reference ranges where applicable
- Be specific and clinical in concerns/positives - reference actual fertility implications
- nextSteps should be 3-5 actionable, specific recommendations
- If the report is not readable or not a medical report, return: {"error": "Could not read report. Please upload a clearer image."}
- Return ONLY valid JSON. No text before or after.`;

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
            { type: "text", text: systemPrompt },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    });

    const rawText = response.choices[0].message.content.trim();

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch(e) {
      console.error("JSON parse error:", rawText.substring(0, 200));
      return res.status(500).json({ error: "Could not parse report analysis. Please try with a clearer image." });
    }

    if (parsed.error) return res.status(400).json({ error: parsed.error });

    res.json(parsed);

  } catch (err) {
    console.error("Report analysis error:", err.message);
    res.status(500).json({ error: "Analysis failed: " + err.message });
  }
});

// -- ORDERS & PAYMENTS --
app.post("/create-order", auth, async (req, res) => {
  try {
    await connectDB();
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });

    const razorpayOrder = await razorpay.orders.create({
      amount:   PLANS[plan].amount,
      currency: "INR",
      notes:    { userId: req.user.id.toString(), plan: plan },
    });

    await Order.create({
      razorpayOrderId: razorpayOrder.id,
      userId:          req.user.id,
      plan:            plan,
      amount:          PLANS[plan].amount,
    });

    res.json({
      orderId:   razorpayOrder.id,
      amount:    razorpayOrder.amount,
      currency:  razorpayOrder.currency,
      plan:      plan,
      planLabel: PLANS[plan].label,
    });
  } catch (err) {
    console.error("Order error:", err.message);
    res.status(500).json({ error: "Could not create order" });
  }
});

app.post("/verify-payment", auth, async (req, res) => {
  try {
    await connectDB();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed." });
    }

    await Order.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: "paid" });

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { plan: plan, isPremium: true },
      { new: true }
    );

    const newToken = jwt.sign(
      { id: updatedUser._id, plan: updatedUser.plan },
      process.env.JWT_SECRET || "BLOOM_SECRET",
      { expiresIn: "30d" }
    );

    res.json({ success: true, plan: updatedUser.plan, token: newToken });
  } catch (err) {
    console.error("Verify error:", err.message);
    res.status(500).json({ error: "Payment verification failed: " + err.message });
  }
});

app.get("/plan-status", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id).select("plan messageCount reportAnalysisCount fertilityPlan");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      plan:                user.plan,
      messageCount:        user.messageCount,
      reportAnalysisCount: user.reportAnalysisCount,
      hasPlan:             !!(user.fertilityPlan && user.fertilityPlan.content),
      planGeneratedAt:     user.fertilityPlan ? user.fertilityPlan.generatedAt : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- WEBHOOK --
app.post('/webhook/razorpay', express.raw({type: 'application/json'}), async(req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');

  if (signature !== digest) {
    return res.status(400).json({ message: 'Invalid signature' });
  }

  const event = JSON.parse(req.body);

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const userEmail = payment.notes.email;
    await User.findOneAndUpdate(
      { email: userEmail },
      { plan: 'pro', planActivatedAt: new Date() }
    );
  }

  res.json({ status: 'ok' });
});

// -- STATIC ROUTES --
app.get("/report", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "report.html"));
});

app.get("/roadmap", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "roadmap.html"));
});

// -- START --
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', function() {
  console.log("Bloom running on port " + PORT);
});

module.exports = app;

// -- ROADMAP CONTENT API --
app.post("/roadmap-content", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan !== "complete") {
      return res.status(403).json({ error: "upgrade_required" });
    }

    const { journey, month, week, section } = req.body;
    const profile = user.profile || {};

    // Build specific query based on journey + month/week + section
    let query = '';
    if (journey === 'ttc') {
      const monthTopics = {
        1: 'preconception counseling folic acid cycle tracking ovulation fertile window',
        2: 'cervical mucus ovulation detection LH surge fertile signs tracking',
        3: 'ovulation timing intercourse fertile window peak fertility',
        4: 'luteal phase two week wait implantation hCG progesterone',
        5: 'fertility investigations FSH AMH progesterone semen analysis thyroid',
        6: 'fertility nutrition Mediterranean diet supplements CoQ10 vitamin D omega-3',
        7: 'stress cortisol HPA axis lifestyle yoga mindfulness fertility',
        8: 'fertility specialist referral IUI IVF ovulation induction',
        9: 'diminished ovarian reserve low AMH CoQ10 DHEA egg quality',
        10: 'PCOS polycystic ovary syndrome letrozole metformin ovulation induction insulin',
        11: 'IVF pre-treatment protocol egg quality optimization supplements',
        12: 'unexplained infertility recurrent loss specialist review assisted reproduction',
      };
      query = monthTopics[month] || 'fertility trying to conceive';
    } else {
      const weekTopics = {
        4: 'implantation early pregnancy hCG progesterone first trimester',
        6: 'fetal heartbeat embryo development first trimester viability scan',
        8: 'organogenesis teratogens embryo development first trimester',
        10: 'luteal placental shift first trimester screening nuchal',
        12: 'first trimester complete nuchal translucency combined screening',
        16: 'second trimester fetal movement anatomy scan preparation',
        20: 'anomaly scan fetal anatomy ultrasound second trimester',
        24: 'viability gestational diabetes OGTT fetal movements',
        28: 'third trimester preeclampsia monitoring iron anaemia',
        36: 'term delivery preparation labour signs birth plan',
        38: 'full term labour onset oxytocin delivery',
      };
      // Find closest week
      const weeks = Object.keys(weekTopics).map(Number);
      const closest = weeks.reduce((prev, curr) => 
        Math.abs(curr - week) < Math.abs(prev - week) ? curr : prev
      );
      query = weekTopics[closest] || 'pregnancy prenatal care';
    }

    // Add profile-specific terms
    const profileTerms = [];
    const syms = profile.symptoms || [];
    const meds = profile.medications || [];
    if (syms.includes('pcos_diagnosed')) profileTerms.push('PCOS polycystic ovary syndrome');
    if (syms.includes('low_amh')) profileTerms.push('diminished ovarian reserve low AMH');
    if (meds.includes('metformin')) profileTerms.push('metformin insulin resistance');
    if (meds.includes('letrozole')) profileTerms.push('letrozole ovulation induction');
    if (meds.includes('clomiphene')) profileTerms.push('clomiphene ovulation induction');
    if (meds.includes('progesterone')) profileTerms.push('progesterone luteal support');
    if (syms.includes('irregular_periods')) profileTerms.push('anovulation irregular cycles');

    const fullQuery = query + ' ' + profileTerms.join(' ');

    // RAG fetch
    const relevantKnowledge = searchKnowledge(fullQuery, profile, 12);

    // Build profile context
    const profileContext = [
      profile.name ? `Name: ${profile.name}` : null,
      profile.age ? `Age: ${profile.age}` : null,
      profile.journeyStage ? `Journey: ${profile.journeyStage}` : null,
      profile.cycleLength ? `Cycle: ${profile.cycleLength} days` : null,
      syms.length ? `Symptoms: ${syms.join(', ')}` : null,
      meds.length ? `Medications: ${meds.join(', ')}` : null,
      profile.notes ? `Notes: ${profile.notes}` : null,
    ].filter(Boolean).join('\n');

    const sectionPrompts = {
      overview: `Generate a comprehensive clinical overview for ${journey === 'ttc' ? `Month ${month} of TTC` : `Week ${week} of pregnancy`}. Include: what is happening physiologically, key clinical points, and what to watch for. Be specific and evidence-based.`,
      lifestyle: `Generate specific lifestyle guidance for ${journey === 'ttc' ? `Month ${month} of TTC` : `Week ${week} of pregnancy`}. Cover: diet recommendations (specific Indian-friendly foods), exercise, sleep, stress management. Be practical and specific.`,
      timing: journey === 'ttc' 
        ? `Generate detailed fertile window and intercourse timing guidance for Month ${month} of TTC. Include: ovulation detection methods, optimal timing, frequency, practical tips. Be clinical and specific.`
        : `Generate pregnancy monitoring guidance for Week ${week}. Include: what tests/scans are due, what to track, warning signs to watch for, upcoming appointments.`,
      hormones: `Generate a detailed hormone explanation for ${journey === 'ttc' ? `Month ${month} of TTC` : `Week ${week} of pregnancy`}. Explain: which hormones are active, what they are doing, what abnormal values might indicate. Be educational and clear.`,
      supplements: `Generate a specific supplement protocol for ${journey === 'ttc' ? `Month ${month} of TTC` : `Week ${week} of pregnancy`}. Include: what to take, doses, timing, why each supplement helps. Base on clinical evidence.

STRICT CLINICAL RULES FOR PREGNANCY SUPPLEMENTS — follow exactly:
- Folic acid (5mg daily): weeks 1–12 only. After week 12, only if part of prenatal vitamin — do NOT list standalone.
- Iron supplementation: DO NOT recommend before Week 14. Start from Week 14+ only — 60mg elemental iron daily. Before Week 14, iron must NOT appear.
- Calcium: Week 16 onwards only — 500mg twice daily with meals.
- Vitamin D (600–1000 IU): safe throughout, recommend from booking.
- DHA/Omega-3 (200mg DHA): safe throughout, emphasise from second trimester.
- B12: safe throughout if deficient.
- Do NOT include supplements not clinically indicated for the specific week.`,
      pretreatment: `Generate pre-treatment investigation and optimization guidance for Month ${month} of TTC. Include: which tests to request, what results mean, how to optimize before treatment. Be specific and clinical.`,
    };

    const prompt = sectionPrompts[section] || sectionPrompts.overview;

    const systemMsg = `You are Bloom's clinical content engine - a specialist in reproductive medicine and obstetrics, grounded in established obstetric and gynaecological evidence, reviewed by a licensed gynaecologist.

Patient profile:
${profileContext || 'No profile provided'}

Generate content that is:
1. Evidence-based - cite clinical facts from the knowledge base
2. Personalised - tailor to this specific patient's profile, symptoms, medications
3. Practical - specific actionable guidance, not generic advice
4. Indian-context aware - reference Indian dietary options, acknowledge local healthcare context
5. Warm but clinical in tone

Format your response as a JSON object with these fields:
{
  "main_content": "2-3 paragraphs of main clinical content",
  "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "personalised_tip": "1-2 sentences specifically for this patient based on their profile",
  "clinical_note": "1 important clinical note or warning relevant to this stage",
  "action_items": ["specific action 1", "specific action 2", "specific action 3"]
}

Return ONLY valid JSON. No markdown, no preamble.

Use this clinical knowledge to ensure accuracy:
--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    });

    const rawText = response.choices[0].message.content.trim();
    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch(e) {
      // Return as plain text if JSON parse fails
      parsed = {
        main_content: rawText,
        key_points: [],
        personalised_tip: "",
        clinical_note: "",
        action_items: []
      };
    }

    res.json({ content: parsed, journey, month, week, section });

  } catch (err) {
    console.error("Roadmap content error:", err.message);
    res.status(500).json({ error: "Could not generate content: " + err.message });
  }
});
