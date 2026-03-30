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
let knowledgeBase = [];
try {
  const kbPath = path.join(__dirname, 'data', 'bloom_kb_complete.json');
  knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  console.log(`Knowledge base loaded: ${knowledgeBase.length} chunks`);
} catch (e) {
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

  const queryWords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

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
    if (profile.amh && profile.amh < 1.5) contextTerms.push('low amh', 'diminished ovarian reserve');
    if (profile.workupStatus === 'no_workup') contextTerms.push('infertility workup', 'investigations');
  }

  const allTerms = [...new Set([...queryWords, ...contextTerms])];

  const chapterPriority = {
    pcos_hyperandrogenism: ['pcos', 'polycystic', 'hirsutism', 'androgen', 'hyperandrogenism'],
    endometriosis: ['endometriosis', 'endometrioma', 'adenomyosis'],
    fibroids: ['fibroid', 'leiomyoma', 'myomectomy'],
    menopause: ['menopause', 'menopausal', 'hrt', 'hot flush', 'perimenopause'],
    infertility: ['infertility', 'infertile', 'fertility', 'conception', 'ttc'],
    infertility_workup: ['workup', 'investigation', 'fsh', 'amh', 'tvs', 'hsg', 'semen'],
    male_factor_infertility: ['semen', 'sperm', 'azoospermia', 'oligospermia', 'male factor'],
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

  const scored = knowledgeBase.map(chunk => {
    const chunkText = chunk.text.toLowerCase();
    const chunkChapter = (chunk.chapter || '').toLowerCase();
    let score = 0;

    for (const term of allTerms) {
      const textMatches = (chunkText.match(new RegExp(term, 'g')) || []).length;
      score += textMatches * 2;
      if (chunkChapter.includes(term)) score += 5;
    }

    for (const [chapter, keywords] of Object.entries(chapterPriority)) {
      if (chunkChapter === chapter) {
        for (const kw of keywords) {
          if (allTerms.some(t => t.includes(kw) || kw.includes(t))) {
            score += 8;
          }
        }
      }
    }

    if (chunk.source && chunk.source.includes('Williams')) score += 1;

    return { ...chunk, score };
  });

  const relevant = scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (!relevant.length) {
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
    name:           String,
    age:            Number,
    cycleLength:    Number,
    periodLength:   Number,
    journeyStage:   String,
    symptoms:       [String],
    medications:    [String],
    notes:          String,
    lmp:              String,
    cycleRegularity:  String,
    flowHeaviness:    [String],
    painLevel:        [String],
    intermenstrual:   [String],
    menarche:         Number,
    ttcDuration:        String,
    gravida:            String,
    pregnancyOutcomes:  [String],
    semenAnalysis:      [String],
    prevTreatments:     [String],
    txCycles:           Number,
    investigationsDone:    [String],
    amh:                   Number,
    fsh:                   Number,
    lh:                    Number,
    tsh:                   Number,
    prolactin:             Number,
    testosterone:          Number,
    afc:                   Number,
    endometrialThickness:  Number,
    usgFindings:           [String],
    workupStatus:    String,
    txPhase:         String,
    cycleDay:        Number,
    doctorInvolved:  [String],
    nextStep:        String,
    concerns:        String,
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

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/report", (req, res) => res.sendFile(path.join(__dirname, "public", "report.html")));
app.get("/roadmap", (req, res) => res.sendFile(path.join(__dirname, "public", "roadmap.html")));

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
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profile: req.body },
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
    const wantsDetail = req.body.wantsDetail || false;
    const relevantKnowledge = searchKnowledge(userMessage, profile, 10);

    let profileContext = '';
    if (profile.journeyStage) {
      profileContext = `\n\nUser profile: ${profile.name || 'User'} is on a ${profile.journeyStage} journey.`;
      if (profile.age) profileContext += ` Age: ${profile.age}.`;
      if (profile.cycleLength) profileContext += ` Cycle: ${profile.cycleLength} days.`;
      if (profile.symptoms && profile.symptoms.length) profileContext += ` Symptoms: ${profile.symptoms.join(', ')}.`;
      if (profile.medications && profile.medications.length) profileContext += ` Medications: ${profile.medications.join(', ')}.`;
      if (profile.amh) profileContext += ` AMH: ${profile.amh} ng/mL.`;
      if (profile.tsh) profileContext += ` TSH: ${profile.tsh} mIU/L.`;
      if (profile.workupStatus) profileContext += ` Workup status: ${profile.workupStatus}.`;
      if (profile.txPhase && profile.txPhase !== 'none') profileContext += ` Currently on: ${profile.txPhase}.`;
    }

    const systemPrompt = wantsDetail
      ? `${BLOOM_SYSTEM_PROMPT}${profileContext}

The user wants a detailed explanation. Provide a thorough, well-structured answer with full clinical depth. Use simple language that a non-medical person can understand — explain any medical terms used. Be warm, complete, and educational.

--- RELEVANT CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`
      : `${BLOOM_SYSTEM_PROMPT}${profileContext}

RESPONSE RULES:
1. Answer in simple, clear language that anyone can understand — not medical jargon
2. Be concise — 2-4 sentences for the main answer
3. If a medical term is unavoidable, explain it in brackets
4. End your response with a single follow-up offer on a new line, like: "💡 Want to understand [specific aspect] in more detail?"
5. Do NOT write long paragraphs or lists unless the question specifically needs it

--- RELEVANT CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage },
      ],
      max_tokens: wantsDetail ? 1200 : 350,
    });

    const rawReply = response.choices[0].message.content;

    // Split main answer from followup suggestion
    const lines = rawReply.trim().split('\n');
    let mainReply = rawReply.trim();
    let followupSuggestion = null;

    // Last line starting with 💡 is the followup
    if (lines.length > 1 && lines[lines.length - 1].startsWith('💡')) {
      followupSuggestion = lines[lines.length - 1].replace('💡', '').trim();
      mainReply = lines.slice(0, -1).join('\n').trim();
    }

    res.json({
      reply: mainReply,
      followup: wantsDetail ? null : followupSuggestion,
      isDetailed: wantsDetail,
      originalMessage: userMessage,
      messageCount: user.messageCount,
      plan: user.plan,
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
      return res.status(403).json({ error: "upgrade_required", message: "Personalised fertility plans are part of Bloom Complete." });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (user.fertilityPlan && user.fertilityPlan.content && user.fertilityPlan.generatedAt > thirtyDaysAgo) {
      return res.json({ plan: user.fertilityPlan.content, generatedAt: user.fertilityPlan.generatedAt, cached: true });
    }

    const profile = user.profile || {};
    const planQuery = [
      profile.journeyStage || 'fertility',
      profile.symptoms ? profile.symptoms.join(' ') : '',
      profile.medications ? profile.medications.join(' ') : '',
      'fertility plan nutrition supplements lifestyle',
    ].join(' ');

    const relevantKnowledge = searchKnowledge(planQuery, profile, 15);

    const systemPrompt = `You are Bloom's senior fertility advisor AI, created by a licensed gynecologist. Generate detailed, personalised, evidence-based fertility plans in structured markdown format.

Always include: introduction, cycle insights, nutrition plan, supplement recommendations, lifestyle adjustments, stress management, and monthly roadmap. Be warm, specific, and actionable.

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
    await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
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
    const planQuery = [profile.journeyStage || 'fertility', profile.symptoms ? profile.symptoms.join(' ') : '', profile.medications ? profile.medications.join(' ') : '', 'fertility plan nutrition supplements lifestyle'].join(' ');
    const relevantKnowledge = searchKnowledge(planQuery, profile, 15);

    const systemPrompt = `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format. Be warm, evidence-based, and actionable.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: buildPlanPrompt(profile) }],
      max_tokens: 2000,
    });

    const planContent = response.choices[0].message.content;
    await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
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
    "Cycle length: " + (profile.cycleLength ? profile.cycleLength + " days" : "Not provided") + "\n" +
    "Period length: " + (profile.periodLength ? profile.periodLength + " days" : "Not provided") + "\n" +
    "Symptoms: " + (profile.symptoms && profile.symptoms.length ? profile.symptoms.join(", ") : "None noted") + "\n" +
    "Medications: " + (profile.medications && profile.medications.length ? profile.medications.join(", ") : "None") + "\n" +
    "TTC duration: " + (profile.ttcDuration || "Not provided") + "\n" +
    "AMH: " + (profile.amh ? profile.amh + " ng/mL" : "Not done") + "\n" +
    "TSH: " + (profile.tsh ? profile.tsh + " mIU/L" : "Not done") + "\n" +
    "Workup status: " + (profile.workupStatus || "Not provided") + "\n" +
    "Notes: " + (profile.notes || "None") + "\n\n" +
    "Create a comprehensive personalised fertility plan with these sections:\n" +
    "1. Personal Overview and Key Insights\n2. Understanding Your Cycle\n3. Nutrition Plan\n4. Supplement Protocol\n5. Lifestyle Adjustments\n6. Stress and Emotional Wellbeing\n7. 4-Week Action Roadmap\n8. When to Speak to Your Doctor";
}

// -- REPORT ANALYZER --
app.post("/analyze-report", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan === "free") return res.status(403).json({ error: "upgrade_required", message: "Report analysis requires Bloom Pro or Complete." });
    if (user.plan === "pro" && user.reportAnalysisCount >= 3) return res.status(403).json({ error: "limit_reached", message: "You've used your 3 monthly report analyses. Upgrade to Bloom Complete for unlimited reports." });
    if (user.plan === "pro") await User.findByIdAndUpdate(req.user.id, { $inc: { reportAnalysisCount: 1 } });

    const { imageBase64, reportType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });

    const profile = user.profile || {};
    const reportQueries = {
      hormone:    'FSH LH AMH estradiol progesterone prolactin testosterone hormone ranges fertility',
      thyroid:    'thyroid TSH T3 T4 anti-TPO hypothyroid fertility',
      ultrasound: 'ultrasound antral follicle count AFC endometrium ovarian cyst fibroid PCOS morphology',
      semen:      'semen analysis sperm count motility morphology azoospermia WHO criteria',
      blood:      'haemoglobin ferritin iron fasting glucose HbA1c insulin HOMA-IR blood count',
      general:    'medical report investigation fertility gynecology',
    };

    const reportKnowledge = searchKnowledge(reportQueries[reportType] || reportQueries.general, profile, 8);
    const profileContext = [
      profile.name ? `Name: ${profile.name}` : null,
      profile.age ? `Age: ${profile.age}` : null,
      profile.journeyStage ? `Journey: ${profile.journeyStage}` : null,
      profile.cycleLength ? `Cycle length: ${profile.cycleLength} days` : null,
      profile.symptoms && profile.symptoms.length ? `Symptoms: ${profile.symptoms.join(", ")}` : null,
      profile.medications && profile.medications.length ? `Medications: ${profile.medications.join(", ")}` : null,
      profile.notes ? `Notes: ${profile.notes}` : null,
    ].filter(Boolean).join("\n");

    const reportTypeLabels = {
      hormone: "Hormone Panel (FSH, LH, AMH, estradiol, progesterone, prolactin, testosterone)",
      thyroid: "Thyroid Function Test (TSH, T3, T4, Anti-TPO)",
      ultrasound: "Pelvic / Transvaginal Ultrasound Report",
      semen: "Semen Analysis Report",
      blood: "Blood Test / Complete Blood Count / metabolic panel",
      general: "General Medical Report",
    };

    const systemPrompt = `You are Bloom's expert medical report analyzer - a specialist in reproductive endocrinology and fertility medicine, created by a licensed gynecologist.

A patient has uploaded their ${reportTypeLabels[reportType] || "medical report"}. Analyze it and return a JSON object ONLY.

Patient profile:
${profileContext || "No profile provided"}

--- CLINICAL REFERENCE ---
${reportKnowledge}
--- END ---

Return this exact JSON structure:
{
  "values": [{"name": "FSH", "description": "Follicle Stimulating Hormone", "value": "7.2 IU/L", "normalRange": "3-10 IU/L", "status": "normal"}],
  "summary": "Overall summary in 2-3 sentences",
  "concerns": [{"title": "Issue title", "detail": "Detailed explanation"}],
  "positives": [{"title": "Positive finding", "detail": "What this means"}],
  "personalised": "2-3 sentences connecting results to their profile",
  "nextSteps": ["Action 1", "Action 2", "Action 3"]
}

Rules: status must be one of: normal, low, high, borderline, na. Extract ALL values. Use Indian reference ranges. Return ONLY valid JSON.`;

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }, { type: "text", text: systemPrompt }] }],
      max_tokens: 2000,
      temperature: 0.1,
    });

    const rawText = response.choices[0].message.content.trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
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
      amount: PLANS[plan].amount, currency: "INR", notes: { userId: req.user.id.toString(), plan },
    });

    await Order.create({ razorpayOrderId: razorpayOrder.id, userId: req.user.id, plan, amount: PLANS[plan].amount });
    res.json({ orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, plan, planLabel: PLANS[plan].label });
  } catch (err) {
    console.error("Order error:", err.message);
    res.status(500).json({ error: "Could not create order" });
  }
});

app.post("/verify-payment", auth, async (req, res) => {
  try {
    await connectDB();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const expectedSig = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
    if (expectedSig !== razorpay_signature) return res.status(400).json({ error: "Payment verification failed." });

    await Order.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: "paid" });
    const updatedUser = await User.findByIdAndUpdate(req.user.id, { plan, isPremium: true }, { new: true });
    const newToken = jwt.sign({ id: updatedUser._id, plan: updatedUser.plan }, process.env.JWT_SECRET || "BLOOM_SECRET", { expiresIn: "30d" });
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
    res.json({ plan: user.plan, messageCount: user.messageCount, reportAnalysisCount: user.reportAnalysisCount, hasPlan: !!(user.fertilityPlan && user.fertilityPlan.content), planGeneratedAt: user.fertilityPlan ? user.fertilityPlan.generatedAt : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- WEBHOOK --
app.post('/webhook/razorpay', express.raw({type: 'application/json'}), async(req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (signature !== digest) return res.status(400).json({ message: 'Invalid signature' });

  const event = JSON.parse(req.body);
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    await User.findOneAndUpdate({ email: payment.notes.email }, { plan: 'pro', planActivatedAt: new Date() });
  }
  res.json({ status: 'ok' });
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
    if (user.plan !== "complete") return res.status(403).json({ error: "upgrade_required" });

    const { journey, month, week, section } = req.body;
    const profile = user.profile || {};

    // -- DETERMINE CLINICAL STAGE --
    function determineClinicalStage(p) {
      const txPhase = p.txPhase;
      const workupStatus = p.workupStatus;
      const prevTreatments = p.prevTreatments || [];
      const symptoms = p.symptoms || [];
      const medications = p.medications || [];
      const ttcDuration = p.ttcDuration;

      if (txPhase && txPhase !== 'none') {
        if (['ivf_stimulation','ivf_tww','ivf_fet'].includes(txPhase)) return 'ivf_active';
        if (txPhase === 'iui_cycle') return 'iui_active';
        if (['oi_letrozole','oi_clomiphene'].includes(txPhase)) return 'oi_active';
        if (['luteal_support','monitoring'].includes(txPhase)) return 'monitoring';
      }
      if (workupStatus === 'ivf_prep' || prevTreatments.includes('iui')) return 'pre_ivf';
      if (workupStatus === 'workup_complete') return 'workup_complete';
      if (workupStatus === 'workup_partial') return 'workup_partial';
      if (!workupStatus || workupStatus === 'no_workup') {
        if (ttcDuration === 'over_12' || ttcDuration === 'over_24') return 'needs_urgent_workup';
        if (ttcDuration === '6_to_12') return 'needs_workup';
        if (symptoms.includes('pcos_diagnosed') || medications.includes('Metformin')) return 'needs_workup';
        return 'early_ttc';
      }
      return 'early_ttc';
    }

    // -- BUILD CLINICAL CONTEXT --
    function buildClinicalContext(p) {
      const lines = [];
      if (p.name) lines.push(`Name: ${p.name}`);
      if (p.age) lines.push(`Age: ${p.age}`);
      if (p.journeyStage) lines.push(`Journey: ${p.journeyStage}`);
      if (p.cycleLength) lines.push(`Cycle length: ${p.cycleLength} days`);
      if (p.periodLength) lines.push(`Period length: ${p.periodLength} days`);
      if (p.lmp) lines.push(`LMP: ${p.lmp}`);
      if (p.cycleRegularity) lines.push(`Cycle regularity: ${p.cycleRegularity}`);
      if (p.flowHeaviness && p.flowHeaviness.length) lines.push(`Flow: ${p.flowHeaviness.join(', ')}`);
      if (p.painLevel && p.painLevel.length) lines.push(`Pain level: ${p.painLevel.join(', ')}`);
      if (p.symptoms && p.symptoms.length) lines.push(`Symptoms: ${p.symptoms.join(', ')}`);
      if (p.medications && p.medications.length) lines.push(`Medications: ${p.medications.join(', ')}`);
      if (p.ttcDuration) lines.push(`TTC duration: ${p.ttcDuration}`);
      if (p.gravida) lines.push(`Previous pregnancies: ${p.gravida}`);
      if (p.pregnancyOutcomes && p.pregnancyOutcomes.length) lines.push(`Pregnancy outcomes: ${p.pregnancyOutcomes.join(', ')}`);
      if (p.semenAnalysis && p.semenAnalysis.length) lines.push(`Semen analysis: ${p.semenAnalysis.join(', ')}`);
      if (p.prevTreatments && p.prevTreatments.length) lines.push(`Previous treatments: ${p.prevTreatments.join(', ')}`);
      if (p.txCycles) lines.push(`Treatment cycles done: ${p.txCycles}`);
      if (p.investigationsDone && p.investigationsDone.length) lines.push(`Investigations done: ${p.investigationsDone.join(', ')}`);
      if (p.amh) lines.push(`AMH: ${p.amh} ng/mL ${p.amh < 1.0 ? '(LOW)' : p.amh < 1.5 ? '(borderline low)' : '(normal)'}`);
      if (p.fsh) lines.push(`FSH: ${p.fsh} IU/L ${p.fsh > 10 ? '(ELEVATED)' : '(normal)'}`);
      if (p.lh) lines.push(`LH: ${p.lh} IU/L${p.fsh && p.lh/p.fsh > 2 ? ' (LH:FSH >2 — PCOS pattern)' : ''}`);
      if (p.tsh) lines.push(`TSH: ${p.tsh} mIU/L ${p.tsh > 2.5 ? '(above TTC optimal — discuss with doctor)' : '(optimal)'}`);
      if (p.prolactin) lines.push(`Prolactin: ${p.prolactin} ng/mL ${p.prolactin > 25 ? '(ELEVATED)' : '(normal)'}`);
      if (p.testosterone) lines.push(`Testosterone: ${p.testosterone} ng/dL ${p.testosterone > 70 ? '(ELEVATED)' : '(normal)'}`);
      if (p.afc) lines.push(`AFC: ${p.afc} ${p.afc < 5 ? '(LOW)' : p.afc < 10 ? '(borderline)' : '(normal)'}`);
      if (p.endometrialThickness) lines.push(`Endometrial thickness: ${p.endometrialThickness} mm`);
      if (p.usgFindings && p.usgFindings.length) lines.push(`Ultrasound findings: ${p.usgFindings.join(', ')}`);
      if (p.workupStatus) lines.push(`Workup status: ${p.workupStatus}`);
      if (p.txPhase) lines.push(`Current treatment phase: ${p.txPhase}`);
      if (p.cycleDay) lines.push(`Current cycle day: ${p.cycleDay}`);
      if (p.doctorInvolved && p.doctorInvolved.length) lines.push(`Doctor involved: ${p.doctorInvolved.join(', ')}`);
      if (p.nextStep) lines.push(`Planned next step: ${p.nextStep}`);
      if (p.concerns) lines.push(`Patient concerns: ${p.concerns}`);
      if (p.notes) lines.push(`Notes: ${p.notes}`);
      return lines.join('\n');
    }

    const clinicalStage = determineClinicalStage(profile);
    const clinicalContext = buildClinicalContext(profile);

    const stageDescriptions = {
      early_ttc: 'Early TTC (less than 6 months, no workup needed yet)',
      needs_workup: 'TTC 6-12 months or has PCOS/symptoms — investigations should begin',
      needs_urgent_workup: 'TTC over 12 months — urgent investigations and specialist referral needed',
      workup_partial: 'Some investigations done — results available, workup incomplete',
      workup_complete: 'Full workup complete — awaiting or planning treatment',
      oi_active: 'Currently on ovulation induction (Letrozole/Clomiphene)',
      monitoring: 'Currently in follicle monitoring / luteal support phase',
      iui_active: 'Currently in an IUI cycle',
      pre_ivf: 'Preparing for IVF — pre-treatment optimisation phase',
      ivf_active: 'Currently in active IVF cycle (stimulation/TWW/FET)',
    };

    // Handle postpartum journey
    if (journey === 'postpartum') {
      const ppStage = req.body.ppStage || 'day1_3';
      const ppQuery = `postpartum breastfeeding newborn baby care recovery ${ppStage}`;
      const relevantKnowledge = searchKnowledge(ppQuery, profile, 10);
      const ppStageLabels = {
        day1_3: 'Day 1-3 after birth (hospital)',
        week1_2: 'Week 1-2 postpartum (coming home)',
        week3_6: 'Week 3-6 postpartum (finding rhythm)',
        '6week_check': '6-week postnatal check',
        month3: '3 months postpartum',
        month6: '6 months postpartum',
      };
      const ppSectionPrompts = {
        overview: `Generate a comprehensive postpartum overview for ${ppStageLabels[ppStage]}. Cover: physical recovery at this stage, what is normal, what needs medical attention, emotional wellbeing, and key priorities. Be warm and specific.`,
        breastfeeding: `Generate detailed breastfeeding guidance for ${ppStageLabels[ppStage]}. Cover: feeding frequency, latch, milk supply, common problems (engorgement, mastitis, sore nipples), when to seek help, and formula supplementation if needed. Include practical Indian-context advice.`,
        lifestyle: `Generate postpartum recovery guidance for ${ppStageLabels[ppStage]}. Cover: physical recovery (perineal care, C-section care if relevant), return to exercise, sleep, nutrition for recovery and breastfeeding, emotional health, and postpartum depression warning signs.`,
        baby_care: `Generate baby care guidance for ${ppStageLabels[ppStage]}. Cover: feeding cues, sleep patterns, nappy changes, bathing, umbilical cord care (early stages), vaccination schedule, developmental milestones to expect, and when to see a paediatrician. Keep advice practical. Always recommend paediatrician for medical concerns.`,
        supplements: `Generate postpartum nutrition and supplement guidance for ${ppStageLabels[ppStage]}. Cover: nutrition for recovery and breastfeeding, iron replacement, calcium, vitamin D, omega-3, foods to eat and avoid while breastfeeding (Indian diet context), hydration. Include specific Indian foods.`,
      };

      const ppPrompt = ppSectionPrompts[section] || ppSectionPrompts.overview;
      const ppSystemMsg = `You are Bloom's postpartum and newborn care specialist, created by a licensed Indian gynaecologist. You provide warm, evidence-based guidance on postpartum recovery, breastfeeding, and basic newborn care.

Patient profile:
${clinicalContext || 'New mother'}

Generate content that is:
1. Evidence-based and clinically accurate
2. Warm and supportive — postpartum is emotionally vulnerable
3. Practical — Indian context, Indian foods, realistic advice
4. Always recommend paediatrician for baby health concerns

Format as JSON:
{
  "main_content": "2-3 paragraphs",
  "key_points": ["point 1", "point 2", "point 3", "point 4"],
  "personalised_tip": "specific tip",
  "clinical_note": "important warning or note",
  "action_items": ["action 1", "action 2", "action 3"]
}

Return ONLY valid JSON.

--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

      const ppResponse = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: ppSystemMsg }, { role: "user", content: ppPrompt }],
        max_tokens: 1200,
        temperature: 0.3,
      });

      const ppRaw = ppResponse.choices[0].message.content.trim();
      let ppParsed;
      try { ppParsed = JSON.parse(ppRaw.replace(/```json|```/g, "").trim()); }
      catch(e) { ppParsed = { main_content: ppRaw, key_points: [], personalised_tip: "", clinical_note: "", action_items: [] }; }
      return res.json({ content: ppParsed, journey, section, ppStage });
    }

    const timeContext = journey === 'ttc' ? `Month ${month} of TTC journey` : `Week ${week} of pregnancy`;

    // Build RAG query
    let query = '';
    if (journey === 'ttc') {
      const stageQueries = {
        early_ttc: 'preconception folic acid cycle tracking ovulation fertile window',
        needs_workup: 'infertility workup investigations FSH AMH TSH prolactin semen analysis',
        needs_urgent_workup: 'infertility workup specialist referral IUI IVF investigations urgent',
        workup_partial: 'infertility investigations results interpretation next steps',
        workup_complete: 'ovulation induction letrozole clomiphene treatment plan fertility',
        oi_active: 'ovulation induction letrozole clomiphene follicle monitoring trigger',
        monitoring: 'follicle scan monitoring luteal phase progesterone support',
        iui_active: 'IUI cycle preparation sperm wash timing success rate',
        pre_ivf: 'IVF pre-treatment optimisation egg quality supplements protocol',
        ivf_active: 'IVF stimulation monitoring egg retrieval embryo transfer TWW',
      };
      query = stageQueries[clinicalStage] || 'fertility trying to conceive';
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
      const weeks = Object.keys(weekTopics).map(Number);
      const closest = weeks.reduce((prev, curr) => Math.abs(curr - week) < Math.abs(prev - week) ? curr : prev);
      query = weekTopics[closest] || 'pregnancy prenatal care';
    }

    const syms = profile.symptoms || [];
    const meds = profile.medications || [];
    const profileTerms = [];
    if (syms.includes('pcos_diagnosed')) profileTerms.push('PCOS polycystic ovary syndrome');
    if (profile.amh && profile.amh < 1.5) profileTerms.push('low AMH diminished ovarian reserve CoQ10 DHEA');
    if (meds.includes('metformin')) profileTerms.push('metformin insulin resistance');
    if (meds.includes('letrozole')) profileTerms.push('letrozole ovulation induction');
    if (meds.includes('clomiphene')) profileTerms.push('clomiphene ovulation induction');
    if (meds.includes('progesterone')) profileTerms.push('progesterone luteal support');
    if (syms.includes('irregular_periods')) profileTerms.push('anovulation irregular cycles');
    if (profile.tsh && profile.tsh > 2.5) profileTerms.push('thyroid TSH hypothyroid fertility');

    const relevantKnowledge = searchKnowledge(query + ' ' + profileTerms.join(' '), profile, 12);

    // -- STAGE-BASED SECTION PROMPTS --
    const sectionPrompts = {
      overview: `Generate a personalised clinical overview for this patient.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
TIME CONTEXT: ${timeContext}
FULL PATIENT CONTEXT:
${clinicalContext}

Based on her SPECIFIC stage and profile, provide:
1. Where she is clinically right now — be direct and specific
2. What is the most important priority for her RIGHT NOW
3. What she should expect at this stage
4. Any specific concerns based on her results or conditions

DO NOT give generic month-by-month content. Respond directly to her actual clinical situation. If she has PCOS, address PCOS. If she has abnormal results, reference them by value. If she has been trying over 12 months with no workup, tell her clearly.`,

      lifestyle: `Generate specific lifestyle guidance for this patient at her current stage.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
FULL PATIENT CONTEXT:
${clinicalContext}

Cover:
- Diet: specific Indian-friendly foods relevant to her conditions (PCOS diet if PCOS, antioxidant-rich if low AMH)
- Exercise: type and intensity appropriate for her stage and treatment phase
- Sleep and stress: evidence-based specific advice
- What to AVOID at her specific stage
- Any lifestyle factors that directly affect her specific conditions

Be specific to her profile — not generic fertility lifestyle advice.`,

      timing: journey === 'ttc'
        ? `Generate fertile window and ovulation timing guidance for this patient.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
FULL PATIENT CONTEXT:
${clinicalContext}

Cover:
- How to detect ovulation given her cycle pattern (${profile.cycleRegularity || 'not specified'}, ${profile.cycleLength || 28} day cycle)
- OPK timing based on her cycle length
- Intercourse timing recommendations
- If PCOS/irregular — specific advice for unpredictable ovulation
- If on OI — follicle scan timing and what to expect
- If in TWW — what to do and not do`
        : `Generate pregnancy monitoring guidance for Week ${week}.

Cover what tests/scans are due, what to track, warning signs, and upcoming appointments. Be specific to this week.`,

      hormones: `Generate a hormone explanation personalised to this patient's actual results.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
FULL PATIENT CONTEXT:
${clinicalContext}

${profile.amh || profile.fsh || profile.lh || profile.tsh || profile.prolactin || profile.testosterone
  ? `She HAS report values — interpret them specifically and directly:
${profile.amh ? `- AMH ${profile.amh} ng/mL: explain what this means for her fertility` : ''}
${profile.fsh ? `- FSH ${profile.fsh} IU/L: explain significance` : ''}
${profile.lh && profile.fsh ? `- LH:FSH ratio ${(profile.lh/profile.fsh).toFixed(1)}: explain PCOS implications if >2` : ''}
${profile.tsh ? `- TSH ${profile.tsh} mIU/L: explain TTC implications, flag if >2.5` : ''}
${profile.prolactin ? `- Prolactin ${profile.prolactin} ng/mL: explain if elevated` : ''}
${profile.testosterone ? `- Testosterone ${profile.testosterone} ng/dL: explain if elevated` : ''}
Be direct about what abnormal values mean and what action is needed.`
  : `She has NOT had hormone tests yet. Explain which tests she needs, when in her cycle, and what they will show.`}`,

      supplements: `Generate a specific supplement protocol for this patient.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
TIME CONTEXT: ${timeContext}
FULL PATIENT CONTEXT:
${clinicalContext}

${journey === 'pregnancy' ? `
STRICT PREGNANCY SUPPLEMENT RULES — apply exactly:
- Folic acid 5mg: weeks 1–12 ONLY. After week 12 only as part of prenatal vitamin.
- Iron 60mg elemental: Week 14+ ONLY. DO NOT recommend before Week 14.
- Calcium 500mg BD: Week 16+ only.
- Vitamin D 600–1000 IU: safe throughout.
- DHA 200mg: safe throughout, emphasise from second trimester.
- B12: safe throughout if deficient.
Current week is ${week} — apply rules strictly.` : `
TTC SUPPLEMENT PROTOCOL based on her specific profile:
${syms.includes('pcos_diagnosed') ? '- PCOS: Myo-inositol 2g + D-chiro-inositol 50mg twice daily, Vitamin D, NAC 600mg, Omega-3' : ''}
${profile.amh && profile.amh < 1.5 ? '- Low AMH: CoQ10 ubiquinol 400-600mg/day, DHEA 25mg (only under doctor supervision), Vitamin D, Omega-3' : ''}
${profile.tsh && profile.tsh > 2.5 ? '- Elevated TSH: refer to doctor for thyroid medication — supplements alone insufficient' : ''}
- Universal TTC: Folic acid 5mg/day, Vitamin D 1000-2000 IU, Omega-3 1g/day
- Include Indian brand names where helpful (e.g. Shelcal, Sunova CoQ10, Inofolic)`}

Include: what to take, dose, timing, why it helps, and where to get it in India.`,

      pretreatment: `Generate investigation and pre-treatment guidance for this patient.

PATIENT CLINICAL STAGE: ${stageDescriptions[clinicalStage] || clinicalStage}
FULL PATIENT CONTEXT:
${clinicalContext}

WORKUP STATUS: ${profile.workupStatus || 'not specified'}
INVESTIGATIONS DONE: ${profile.investigationsDone && profile.investigationsDone.length ? profile.investigationsDone.join(', ') : 'none reported'}

${!profile.workupStatus || profile.workupStatus === 'no_workup'
  ? 'She has NO investigations done. Give her a complete prioritised list of what to get done, on which cycle days, and why each test matters.'
  : 'She has partial/complete workup. Tell her exactly what is still missing and why it matters, or what the next treatment step should be based on her results.'}

Cover:
- Which tests are needed and exact timing (Day 2/3 for FSH/LH, mid-luteal for progesterone etc)
- What to ask her doctor specifically
- How to read results when they come
- Timeline: what should happen in the next 4-8 weeks
- When to escalate to a specialist`,
    };

    const prompt = sectionPrompts[section] || sectionPrompts.overview;

    const systemMsg = `You are Bloom's clinical content engine — a specialist in reproductive medicine and obstetrics, created by a licensed Indian gynaecologist, grounded in Williams Obstetrics, Williams Gynecology, and Speroff's Clinical Gynecologic Endocrinology.

Generate content that is:
1. PERSONALISED — directly address her specific conditions, results, and stage. Never give generic advice.
2. Evidence-based — cite clinical facts
3. Practical — specific actionable guidance
4. Indian-context aware — Indian foods, Indian brands, Indian healthcare context
5. Warm but clinical

Format response as JSON:
{
  "main_content": "2-3 paragraphs of personalised clinical content",
  "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "personalised_tip": "1-2 sentences specifically for THIS patient based on her exact profile and results",
  "clinical_note": "1 important clinical note or warning relevant to her stage",
  "action_items": ["specific action 1", "specific action 2", "specific action 3"]
}

Return ONLY valid JSON. No markdown, no preamble.

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
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch(e) {
      parsed = { main_content: rawText, key_points: [], personalised_tip: "", clinical_note: "", action_items: [] };
    }

    res.json({ content: parsed, journey, month, week, section, clinicalStage });

  } catch (err) {
    console.error("Roadmap content error:", err.message);
    res.status(500).json({ error: "Could not generate content: " + err.message });
  }
});
