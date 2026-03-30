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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.use(express.static(path.join(__dirname, "public")));

// Load knowledge base once at startup
const knowledgeBase = fs.readFileSync(
  path.join(__dirname, 'data', 'bloom_ai_system_prompt_kb.md'),
  'utf8'
);

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
    status:   "ok",
    mongo:    process.env.MONGO_URI    ? "set" : "missing",
    groq:     process.env.GROQ_API_KEY ? "set" : "missing",
    jwt:      process.env.JWT_SECRET   ? "set" : "missing",
    razorpay: process.env.RAZORPAY_KEY_ID ? "set" : "missing",
    dbState:  mongoose.connection.readyState === 1 ? "connected" : "disconnected",
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

    // ── BLOOM AI SYSTEM PROMPT WITH KNOWLEDGE BASE ──
    let systemPrompt = `You are Bloom, a warm, knowledgeable, and compassionate AI fertility companion. You provide accurate, evidence-based information about fertility, menstrual cycles, IVF, PCOS, and reproductive health. You are supportive, non-judgmental, and always remind users to consult their doctor for medical decisions. Keep responses warm, clear, and concise.

Use the following clinical knowledge base to give accurate, helpful answers. Explain things in simple friendly language — not medical jargon.

--- CLINICAL KNOWLEDGE BASE ---
${knowledgeBase}
--- END OF KNOWLEDGE BASE ---`;

    // Personalise with user profile if available
    if (profile.journeyStage) {
      systemPrompt += "\n\nUser context: " + (profile.name || "This user") + " is on a " + profile.journeyStage + " journey.";
      if (profile.age) systemPrompt += " Age: " + profile.age + ".";
      if (profile.cycleLength) systemPrompt += " Average cycle: " + profile.cycleLength + " days.";
      if (profile.symptoms && profile.symptoms.length) systemPrompt += " Noted symptoms: " + profile.symptoms.join(", ") + ".";
    }

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: req.body.message },
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
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are Bloom's senior fertility advisor AI. Generate detailed, personalised, evidence-based fertility plans in structured markdown format. Always include: introduction, cycle insights, nutrition plan, supplement recommendations, lifestyle adjustments, stress management, and monthly roadmap. Be warm, specific, and actionable.

Use this clinical knowledge base to ensure accuracy:
--- CLINICAL KNOWLEDGE BASE ---
${knowledgeBase}
--- END OF KNOWLEDGE BASE ---`,
        },
        { role: "user", content: buildPlanPrompt(profile) },
      ],
      max_tokens: 1000,
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
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format. Be warm and actionable.

Use this clinical knowledge base to ensure accuracy:
--- CLINICAL KNOWLEDGE BASE ---
${knowledgeBase}
--- END OF KNOWLEDGE BASE ---`,
        },
        { role: "user", content: buildPlanPrompt(profile) },
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
    console.log("Payment body:", JSON.stringify(req.body));
    console.log("Secret loaded:", !!process.env.RAZORPAY_KEY_SECRET);
    await connectDB();
    const razorpay_order_id   = req.body.razorpay_order_id;
    const razorpay_payment_id = req.body.razorpay_payment_id;
    const razorpay_signature  = req.body.razorpay_signature;
    const plan                = req.body.plan;

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSig !== razorpay_signature) {
      console.error("Signature mismatch");
      console.error("Expected:", expectedSig);
      console.error("Got:", razorpay_signature);
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

const PORT = process.env.PORT || 5000;

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

app.get("/report", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "report.html"));
});

app.post("/analyze-report", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Free plan: no access
    if (user.plan === "free") {
      return res.status(403).json({
        error: "upgrade_required",
        message: "Report analysis requires Bloom Pro or Complete. Upgrade to get started.",
      });
    }

    // Pro plan: 3 reports/month limit
    if (user.plan === "pro" && user.reportAnalysisCount >= 3) {
      return res.status(403).json({
        error: "limit_reached",
        message: "You've used your 3 monthly report analyses. Upgrade to Bloom Complete for unlimited reports.",
      });
    }

    // Increment count for pro users
    if (user.plan === "pro") {
      await User.findByIdAndUpdate(req.user.id, { $inc: { reportAnalysisCount: 1 } });
    }

    const { imageBase64, reportType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });

    const profile = user.profile || {};

    // Build profile context string
    const profileContext = [
      profile.name      ? `Name: ${profile.name}`                             : null,
      profile.age       ? `Age: ${profile.age}`                               : null,
      profile.journeyStage ? `Journey: ${profile.journeyStage}`               : null,
      profile.cycleLength  ? `Cycle length: ${profile.cycleLength} days`      : null,
      profile.symptoms && profile.symptoms.length
                        ? `Symptoms: ${profile.symptoms.join(", ")}`           : null,
      profile.medications && profile.medications.length
                        ? `Medications: ${profile.medications.join(", ")}`     : null,
      profile.notes     ? `Notes: ${profile.notes}`                           : null,
    ].filter(Boolean).join("\n");

    const reportTypeLabels = {
      hormone:   "Hormone Panel (FSH, LH, AMH, estradiol, progesterone, prolactin, testosterone)",
      thyroid:   "Thyroid Function Test (TSH, T3, T4, Anti-TPO)",
      ultrasound:"Pelvic / Transvaginal Ultrasound Report",
      semen:     "Semen Analysis Report",
      blood:     "Blood Test / Complete Blood Count / metabolic panel",
      general:   "General Medical Report",
    };

    const systemPrompt = `You are Bloom's expert medical report analyzer — a specialist in reproductive endocrinology and fertility medicine with deep knowledge from Speroff's Clinical Gynecologic Endocrinology and Infertility (9th edition).

A patient has uploaded their ${reportTypeLabels[reportType] || "medical report"}. Analyze it thoroughly and return a JSON object ONLY — no markdown, no preamble, no explanation outside the JSON.

Patient profile:
${profileContext || "No profile provided"}

Your JSON must follow this exact structure:
{
  "values": [
    {
      "name": "FSH",
      "description": "Follicle Stimulating Hormone",
      "value": "7.2 IU/L",
      "normalRange": "3–10 IU/L",
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
    "Consider transabdominal ultrasound to assess antral follicle count"
  ]
}

Rules:
- status must be one of: "normal", "low", "high", "borderline", "na"
- Extract EVERY value visible in the report — do not skip any
- Use Indian clinical reference ranges where applicable
- Be specific and clinical in concerns/positives — reference actual fertility implications
- nextSteps should be 3-5 actionable, specific recommendations
- If the report is not readable or not a medical report, return: {"error": "Could not read report. Please upload a clearer image."}
- Return ONLY valid JSON. No text before or after.`;

    // Use Groq vision model
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
            {
              type: "text",
              text: systemPrompt,
            },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.1,
    });

    const rawText = response.choices[0].message.content.trim();

    // Parse JSON safely
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

app.get("/roadmap", (req, res) => { res.sendFile(path.join(__dirname, "public", "roadmap.html")); });

app.listen(PORT, '0.0.0.0', function() {
  console.log("Bloom running on port " + PORT);
});

module.exports = app;
