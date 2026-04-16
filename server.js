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
const nodemailer = require("nodemailer");

const app = express();
app.use((req, res, next) => {
  if (req.path === '/webhook/razorpay') return next();
  express.json({ limit: '20mb' })(req, res, next);
});

// -- EMAIL TRANSPORTER (Nodemailer + Gmail SMTP) --
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,       // your gmail address
    pass: process.env.GMAIL_APP_PASS,   // Gmail App Password (not your login password)
  },
});

// In-memory OTP store: { email: { otp, expiresAt } }
const otpStore = {};

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTPEmail(email, otp) {
  await emailTransporter.sendMail({
    from: `"Bloom AI 🌸" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Your Bloom AI verification code',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:40px 32px;background:#FAF6F1;border-radius:16px;">
        <div style="font-size:32px;font-weight:600;color:#C4704F;margin-bottom:8px;">🌸 bloom</div>
        <h2 style="color:#2C2420;font-weight:500;margin-bottom:8px;">Verify your email</h2>
        <p style="color:#8C7468;margin-bottom:24px;">Use the code below to complete your Bloom AI signup. It expires in 10 minutes.</p>
        <div style="background:#fff;border:2px solid #E8DDD5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
          <div style="font-size:40px;font-weight:700;letter-spacing:12px;color:#C4704F;">${otp}</div>
        </div>
        <p style="color:#B8A89F;font-size:13px;">If you did not request this, please ignore this email.</p>
      </div>
    `,
  });
}

async function sendResetEmail(email, resetUrl) {
  await emailTransporter.sendMail({
    from: `"Bloom AI 🌸" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Reset your Bloom AI password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:40px 32px;background:#FAF6F1;border-radius:16px;">
        <div style="font-size:32px;font-weight:600;color:#C4704F;margin-bottom:8px;">🌸 bloom</div>
        <h2 style="color:#2C2420;font-weight:500;margin-bottom:8px;">Reset your password</h2>
        <p style="color:#8C7468;margin-bottom:24px;">Click the button below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#C4704F;color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:500;margin-bottom:24px;">Reset Password →</a>
        <p style="color:#B8A89F;font-size:13px;">If you did not request a password reset, your account is safe — ignore this email.</p>
        <p style="color:#B8A89F;font-size:12px;margin-top:8px;">Link: ${resetUrl}</p>
      </div>
    `,
  });
}

// -- KNOWLEDGE BASE --
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
  } catch (e2) { console.log('No knowledge base found'); }
}

// -- RAG SEARCH --
function searchKnowledge(query, profile, topK = 10) {
  if (!knowledgeBase.length) return '';
  const queryWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  const contextTerms = [];
  if (profile) {
    const syms = profile.symptoms || [];
    const meds = profile.medications || [];
    if (syms.includes('pcos_diagnosed')) contextTerms.push('pcos', 'polycystic');
    if (syms.includes('irregular_periods')) contextTerms.push('anovulation', 'irregular');
    if (meds.includes('Metformin')) contextTerms.push('metformin', 'insulin');
    if (meds.includes('Letrozole')) contextTerms.push('letrozole', 'ovulation induction');
    if (meds.includes('Clomiphene')) contextTerms.push('clomiphene', 'ovulation induction');
    if (profile.journeyStage === 'pregnant') contextTerms.push('pregnancy', 'prenatal', 'obstetric');
    if (profile.journeyStage === 'ttc_ivf') contextTerms.push('ivf', 'assisted reproduction', 'embryo');
    if (profile.amh && profile.amh < 1.5) contextTerms.push('low amh', 'diminished ovarian reserve');
  }
  const allTerms = [...new Set([...queryWords, ...contextTerms])];
  const chapterPriority = {
    pcos_hyperandrogenism: ['pcos', 'polycystic', 'hirsutism', 'androgen'],
    endometriosis: ['endometriosis', 'endometrioma', 'adenomyosis'],
    fibroids: ['fibroid', 'leiomyoma', 'myomectomy'],
    infertility: ['infertility', 'fertility', 'conception', 'ttc'],
    infertility_workup: ['workup', 'investigation', 'fsh', 'amh', 'hsg', 'semen'],
    male_factor_infertility: ['semen', 'sperm', 'azoospermia', 'oligospermia'],
    infertility_treatment: ['ivf', 'iui', 'letrozole', 'clomiphene', 'ovulation induction'],
    prenatal_care: ['prenatal', 'antenatal', 'pregnancy care'],
    preeclampsia: ['preeclampsia', 'hypertension pregnancy'],
    diabetes_mellitus: ['gestational diabetes', 'gdm', 'glucose'],
    miscarriage: ['miscarriage', 'pregnancy loss', 'recurrent'],
    low_amh: ['amh', 'ovarian reserve', 'diminished', 'egg quality'],
    thyroid_fertility: ['thyroid', 'tsh', 'hypothyroid'],
    puerperium_postpartum: ['postpartum', 'postnatal', 'breastfeeding'],
  };
  const scored = knowledgeBase.map(chunk => {
    const chunkText = chunk.text.toLowerCase();
    const chunkChapter = (chunk.chapter || '').toLowerCase();
    let score = 0;
    for (const term of allTerms) {
      score += (chunkText.match(new RegExp(term, 'g')) || []).length * 2;
      if (chunkChapter.includes(term)) score += 5;
    }
    for (const [chapter, keywords] of Object.entries(chapterPriority)) {
      if (chunkChapter === chapter) {
        for (const kw of keywords) {
          if (allTerms.some(t => t.includes(kw) || kw.includes(t))) score += 8;
        }
      }
    }
    if (chunk.source && chunk.source.includes('Williams')) score += 1;
    return { ...chunk, score };
  });
  const relevant = scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  if (!relevant.length) {
    return knowledgeBase.filter(c => ['ttc_basics', 'preconception', 'menstrual_cycle', 'hormone_ranges'].includes(c.chapter)).slice(0, 5).map(c => `[${c.chapter}]\n${c.text}`).join('\n\n---\n\n');
  }
  return relevant.map(c => `[${c.source || 'Clinical KB'} - ${c.chapter}]\n${c.text}`).join('\n\n---\n\n');
}

// -- BLOOM SYSTEM PROMPT --
const BLOOM_SYSTEM_PROMPT = `You are Bloom, a warm, knowledgeable, and compassionate AI fertility and women's health companion, created by a licensed gynecologist.

You provide accurate, evidence-based information grounded in:
- Evidence-based clinical guidelines (NICE, ESHRE, ASRM, RCOG, FIGO)
- Current obstetrics and gynaecology clinical standards

Core principles:
1. Evidence-based - grounded in clinical guidelines
2. Personalised - tailor responses to the user's profile, journey stage, symptoms and medications
3. Compassionate - fertility journeys are emotionally demanding; respond with warmth
4. Safe - always recommend consulting a doctor for diagnosis and treatment decisions

Communication style:
- Warm and professional - like a knowledgeable gynaecologist friend
- Clear language - explain medical terms when used
- In Indian context - reference Indian dietary options, acknowledge cost considerations

STRICT RULES — NEVER BREAK THESE:
- NEVER mention any book name, textbook, author, edition, or chapter name in your response. No "Williams Obstetrics", no "Speroff", no citations, no "[source]" tags.
- NEVER include raw text like "BLOOM_TIP" in your response — this is handled separately by the system.
- ALWAYS read the full conversation history. If the user asks a follow-up ("what medicines for it?", "which hormones?", "how to treat it?"), answer SPECIFICALLY in the context of the previous topic — never switch topics.

Important boundaries:
- Do NOT diagnose conditions definitively
- Do NOT prescribe specific drug doses without recommending medical consultation
- Emergency symptoms (severe pain, heavy bleeding, reduced fetal movements) -> always direct to immediate medical care`;

let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    isConnected = true;
    console.log("MongoDB connected");
  } catch (err) { console.error("MongoDB error:", err.message); }
}
connectDB();

// -- USER SCHEMA --
const UserSchema = new mongoose.Schema({
  email:               { type: String, required: true, unique: true },
  createdAt:           { type: Date, default: Date.now },
  password:            { type: String, required: true },
  isVerified:          { type: Boolean, default: false },
  resetToken:          String,
  resetTokenExpiry:    Date,
  plan:                { type: String, default: "free" },
  isPremium:           { type: Boolean, default: false },
  messageCount:        { type: Number, default: 0 },
  reportAnalysisCount: { type: Number, default: 0 },
  profile: {
    // BASIC
    name: String, age: Number, cycleLength: Number, periodLength: Number,
    journeyStage: String, symptoms: [String], medications: [String], notes: String,
    // MENSTRUAL
    lmp: String, cycleRegularity: String, flowHeaviness: [String],
    painLevel: [String], intermenstrual: [String], menarche: Number,
    // FERTILITY HISTORY
    ttcDuration: String, gravida: String, pregnancyOutcomes: [String],
    semenAnalysis: [String], prevTreatments: [String], txCycles: Number,
    fertilityConditions: [String],
    previousSurgeries: [String],
    familyHistory: [String],
    // FERTILITY TESTS
    investigationsDone: [String],
    amh: Number, fsh: Number, lh: Number, tsh: Number,
    prolactin: Number, testosterone: Number, dheas: Number,
    estradiol: Number, progesterone: Number,
    fastingGlucose: Number, hba1c: Number, fastingInsulin: Number, homaIr: Number,
    hb: Number, ferritin: Number,
    vitaminD: Number, vitaminB12: Number,
    bloodGroup: String, rhFactor: String,
    afc: Number, endometrialThickness: Number, usgFindings: [String],
    hsgResult: String,
    // TREATMENT STATUS
    workupStatus: String, txPhase: String, cycleDay: Number,
    doctorInvolved: [String], nextStep: String, concerns: String,

    // ── OBSTETRIC HISTORY (detailed) ──
    obsGravida: Number,        // G
    obsPara: Number,           // P
    obsAbortions: Number,      // A (spontaneous + induced combined)
    obsSpontaneous: Number,    // spontaneous miscarriages
    obsInduced: Number,        // induced abortions (MTP)
    obsLiving: Number,         // L
    obsDeliveryModes: [String],// e.g. ["normal","lscs","lscs"]
    obsLscsReasons: [String],  // e.g. ["fetal distress","placenta praevia"]
    obsYearsAgo: [Number],     // years since each pregnancy
    obsComplications: [String],// e.g. ["pph","preeclampsia"]
    obsPriorMedications: String,
    obsPriorSurgeries: String,

    // PREGNANCY (current)
    pregLmp: String, pregEdd: String, pregBookingWeek: Number,
    pregConception: String,
    pregHighRisk: [String],

    // ANC BLOOD TESTS — extended
    ancBloodGroup: String, ancRhFactor: String,
    ancHb1: Number, ancHb2: Number, ancHb3: Number,
    // CBC components
    ancTlc: Number,            // Total leucocyte count (×10³/µL)
    ancPlateletCount: Number,  // Platelets (×10³/µL)
    ancRbs: Number,            // Random blood sugar (mg/dL)
    ancSgpt: Number,           // SGPT / ALT (U/L)
    ancSgot: Number,           // SGOT / AST (U/L)
    ancUrea: Number,           // Blood urea (mg/dL)
    ancCreatinine: Number,     // Serum creatinine (mg/dL)
    ancUricAcid: Number,       // Serum uric acid (mg/dL) — last 3 months
    ancVdrl: String,
    ancHiv: String,
    ancHbsag: String,
    ancHcv: String,            // HCV antibody
    // APLA profile
    ancAplaLupus: String,      // Lupus anticoagulant
    ancAnticardiolipin: String,// Anticardiolipin antibody (IgG/IgM)
    ancBeta2Gp1: String,       // Anti-β2-glycoprotein I
    // Other outcome-changing
    ancTsh: Number,
    ancFt4: Number,            // Free T4
    ancAntiTpo: Number,        // Anti-TPO antibody
    ancFerritin: Number,
    ancVitaminD: Number,
    ancOgttFasting: Number, ancOgtt1hr: Number, ancOgtt2hr: Number,
    ancUrineRoutine: String,
    ancUrineProtein: String,   // urine protein (for pre-eclampsia)
    ancGbs: String,            // Group B Strep (35-37 weeks)
    // ANC USG
    ancDatingScan: String,
    ancNuchalNt: Number, ancNuchalCrl: Number, ancNuchalResult: String,
    ancAnomalyScan: String, ancGrowthScan: String,
    ancDoppler: String, ancPlacentaPos: String, ancCervixLength: Number,
    // Immunizations
    immTt1Date: String, immTt2Date: String, immTdDate: String,
    immFluDate: String, immCovidDone: Boolean,
    bpReading1: String, bpReading1Date: String,
    bpReading2: String, bpReading2Date: String,
    // POSTPARTUM
    ppDeliveryDate: String, ppDeliveryMode: String,
    ppMotherComplaints: [String], ppMotherMeds: [String],
    pp6wkCheck: String, ppContraception: String,
    ppHb: Number, ppBp: String, ppTsh: Number,
    ppBirthWeight: Number, ppCurrentWeight: Number, ppBabyAgeWeeks: Number,
    ppFeeding: [String], ppBabyComplaints: [String], ppBabyVaccines: [String],
    ppBilirubin: Number, ppBabyHb: Number,
    ppBabyScreens: [String], ppBabyNotes: String,
  },
  fertilityPlan: { content: String, generatedAt: Date },
});

const User = mongoose.models.User || mongoose.model("User", UserSchema);
const OrderSchema = new mongoose.Schema({
  razorpayOrderId: String, userId: mongoose.Schema.Types.ObjectId,
  plan: String, amount: Number,
  status: { type: String, default: "pending" }, createdAt: { type: Date, default: Date.now },
});
const Order = mongoose.models.Order || mongoose.model("Order", OrderSchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || "dummy", key_secret: process.env.RAZORPAY_KEY_SECRET || "dummy" });
const PLANS = {
  pro_monthly:  { amount: 10000, label: "Bloom Pro", planId: "plan_SZJjRcuuxv2eLA", interval: "monthly" },
  pro_annual:   { amount: 100000, label: "Bloom Pro Annual", planId: "plan_SZJlEEAYfheySC", interval: "yearly" },
  complete_monthly: { amount: 30000, label: "Bloom Complete", planId: "plan_SZJlvVDyrb0Tfu", interval: "monthly" },
  complete_annual:  { amount: 270000, label: "Bloom Complete Annual", planId: "plan_SZJmn5lVvfBLnR", interval: "yearly" },
};
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || "BLOOM_SECRET"); next(); }
  catch (e) { res.status(401).json({ error: "Invalid token" }); }
}

// -- STATIC ROUTES --
app.get("/test", (req, res) => res.json({ status: "ok", mongo: process.env.MONGO_URI ? "set" : "missing", groq: process.env.GROQ_API_KEY ? "set" : "missing", dbState: mongoose.connection.readyState === 1 ? "connected" : "disconnected", kbChunks: knowledgeBase.length }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/report", (req, res) => res.sendFile(path.join(__dirname, "public", "report.html")));
app.get("/roadmap", (req, res) => res.sendFile(path.join(__dirname, "public", "roadmap.html")));
app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "public", "reset-password.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────

// STEP 1: Send OTP (called before account is created)
app.post("/send-otp", async (req, res) => {
  try {
    await connectDB();
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const otp = generateOTP();
    otpStore[email] = { otp, expiresAt: Date.now() + 10 * 60 * 1000 }; // 10 min
    await sendOTPEmail(email, otp);
    res.json({ message: "OTP sent" });
  } catch (err) {
    console.error("OTP send error:", err.message);
    res.status(500).json({ error: "Could not send OTP. Check Gmail config." });
  }
});

// STEP 2: Verify OTP + create account
app.post("/verify-otp", async (req, res) => {
  try {
    await connectDB();
    const { email, otp, password } = req.body;
    if (!email || !otp || !password) return res.status(400).json({ error: "Email, OTP and password required" });
    const record = otpStore[email];
    if (!record) return res.status(400).json({ error: "No OTP found. Please request a new one." });
    if (Date.now() > record.expiresAt) {
      delete otpStore[email];
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }
    if (record.otp !== otp.trim()) return res.status(400).json({ error: "Incorrect OTP." });
    delete otpStore[email];
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });
   const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hash, isVerified: false, createdAt: new Date() });
    res.json({ message: "Account created", userId: user._id });
  } catch (err) {
    res.status(500).json({ error: "Signup failed: " + err.message });
  }
});

// LEGACY signup (kept for compatibility, but now requires OTP first)
app.post("/signup", async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hash, isVerified: false });
    res.json({ message: "Account created", userId: user._id });
  } catch (err) { res.status(500).json({ error: "Signup failed: " + err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "No account found with that email" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password" });
    const token = jwt.sign({ id: user._id, plan: user.plan }, process.env.JWT_SECRET || "BLOOM_SECRET", { expiresIn: "30d" });
    res.json({ token, plan: user.plan, email: user.email, messageCount: user.messageCount });
  } catch (err) { res.status(500).json({ error: "Login failed: " + err.message }); }
});

// FORGOT PASSWORD — send reset link
app.post("/forgot-password", async (req, res) => {
  try {
    await connectDB();
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const user = await User.findOne({ email });
    // Always return success (don't reveal if email exists)
    if (!user) return res.json({ message: "If this email is registered, a reset link has been sent." });
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await User.findByIdAndUpdate(user._id, { resetToken, resetTokenExpiry });
    const resetUrl = `${process.env.APP_URL || 'https://bloomhealth.fit'}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
    await sendResetEmail(email, resetUrl);
    res.json({ message: "If this email is registered, a reset link has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ error: "Could not send reset email." });
  }
});

// RESET PASSWORD — set new password using token
app.post("/reset-password", async (req, res) => {
  try {
    await connectDB();
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) return res.status(400).json({ error: "All fields required" });
    const user = await User.findOne({ email, resetToken: token });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset link." });
    if (new Date() > user.resetTokenExpiry) return res.status(400).json({ error: "Reset link expired. Please request a new one." });
    const hash = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, { password: hash, resetToken: null, resetTokenExpiry: null });
    res.json({ message: "Password reset successfully. You can now sign in." });
  } catch (err) {
    res.status(500).json({ error: "Could not reset password." });
  }
});

app.get("/me", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/profile", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findByIdAndUpdate(req.user.id, { profile: req.body }, { new: true }).select("-password");
    res.json(user);
  } catch (err) { res.status(500).json({ error: "Could not update profile" }); }
});

// -- CHAT --
app.post("/chat", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const trialDays = 3;
    const accountAge = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const inTrial = user.plan === "free" && accountAge <= trialDays;
    if (user.plan === "free" && !inTrial) {
      return res.json({ reply: null, limitReached: true, message: "Your 3-day free trial has ended. Upgrade to Bloom Pro to continue chatting 🌸" });
    }
    user.messageCount++;
    await user.save();
   const profile = user.profile || {};
    const userMessage = req.body.message || '';
    const wantsDetail = req.body.wantsDetail || false;
    const conversationHistory = req.body.history || [];
    const isInConversation = conversationHistory.length >= 2;

    // Use conversation topic for RAG search when mid-conversation
    // This prevents profile-biased KB chunks from dominating
    const lastUserMsgs = conversationHistory.filter(m => m.role === 'user');
    const lastUserMsg = lastUserMsgs.slice(-1)[0]?.content || '';
    const secondLastUserMsg = lastUserMsgs.slice(-2)[0]?.content || '';
    const searchQuery = isInConversation
      ? `${secondLastUserMsg} ${lastUserMsg} ${userMessage}`.slice(0, 300)
      : userMessage;

    // Only pass profile to RAG if NOT in active conversation about a different topic
    const ragProfile = isInConversation ? null : profile;
    const relevantKnowledge = searchKnowledge(searchQuery, ragProfile, 10);

    // Build minimal profile context - only name and journey, no clinical values
    let profileContext = '';
    if (profile.name) profileContext = `User's name: ${profile.name}.`;
    const lastAssistantMsg = conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0]?.content || '';

    // Build system prompt based on conversation state
    let systemPrompt;
    if (isInConversation) {
      systemPrompt = `${BLOOM_SYSTEM_PROMPT}

━━━ CONVERSATION MODE — READ THIS FIRST ━━━
You are in an ongoing conversation. The chat history below shows the full context.
The user's previous question was: "${secondLastUserMsg.slice(0, 200)}"
Your previous answer was about: "${lastAssistantMsg.slice(0, 200)}"
The user is now asking: "${userMessage}"

YOUR ONLY TASK: Answer "${userMessage}" as a continuation of this conversation.
- If the question is a follow-up (treatment, medicines, causes, complications, symptoms, management), it refers to the PREVIOUS TOPIC in the conversation, not the user's health profile.
- The health profile below is REFERENCE ONLY — do not use it to determine the topic.
- Only switch topics if the user clearly introduces an entirely new subject.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[HEALTH PROFILE — reference only, do not override conversation topic]
${profileContext || 'No profile set'}

${wantsDetail ? `Provide a thorough, detailed answer — full explanation with all relevant points.
FORMATTING: Use bullet points (*) for lists, each on its own line. Explain medical terms in brackets.` : `RESPONSE RULES:
1. Answer briefly and to the point — give only the core facts, no padding or elaboration
2. Simple language — explain medical terms in brackets
3. Use bullet points (*) only if listing multiple items
4. NEVER mention book names, textbooks, authors, or citations
5. End with ONE short follow-up question on the SAME topic`}

--- RELEVANT CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;
    } else {
      systemPrompt = `${BLOOM_SYSTEM_PROMPT}

[USER PROFILE]
${profileContext || 'No profile set'}

${wantsDetail ? `Provide a thorough, detailed answer — full explanation with all relevant points.
FORMATTING: Use bullet points (*) for lists, each on its own line. Explain medical terms in brackets.` : `RESPONSE RULES:
1. Answer briefly and to the point — give only the core facts, no padding or elaboration
2. Simple language — explain medical terms in brackets
3. Use bullet points (*) only if listing multiple items
4. NEVER mention book names, textbooks, authors, or citations
5. End with ONE short follow-up question on the SAME topic`}

--- RELEVANT CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-14),
      { role: "user", content: userMessage }
    ];

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messages,
      max_tokens: wantsDetail ? 1500 : 350,
      temperature: 0.1,
    });

   const rawReply = response.choices[0].message.content;
      const lines = rawReply.trim().split('\n');
      let mainReply = rawReply.trim();
      let followupSuggestion = null;
      // Extract last line if it's a follow-up question
      const lastLine = lines[lines.length - 1].trim();
      if (lines.length > 1 && lastLine.startsWith('BLOOM_TIP')) {
        followupSuggestion = lastLine.replace('BLOOM_TIP', '').trim();
        mainReply = lines.slice(0, -1).join('\n').trim();
     } else if (lines.length > 1 && (lastLine.endsWith('?') || lastLine.toLowerCase().includes('would you like'))) {
        followupSuggestion = 'Learn more about this topic';
        mainReply = lines.slice(0, -1).join('\n').trim();
      }
    res.json({ reply: mainReply, followup: wantsDetail ? null : followupSuggestion, isDetailed: wantsDetail, originalMessage: userMessage, messageCount: user.messageCount, plan: user.plan });
  } catch (err) { res.status(500).json({ error: "Something went wrong: " + err.message }); }
});

// -- FERTILITY PLAN --
app.get("/fertility-plan", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.plan !== "complete") return res.status(403).json({ error: "upgrade_required" });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (user.fertilityPlan && user.fertilityPlan.content && user.fertilityPlan.generatedAt > thirtyDaysAgo) {
      return res.json({ plan: user.fertilityPlan.content, generatedAt: user.fertilityPlan.generatedAt, cached: true });
    }
    const profile = user.profile || {};
    const planQuery = [profile.journeyStage || 'fertility', profile.symptoms ? profile.symptoms.join(' ') : '', profile.medications ? profile.medications.join(' ') : '', 'fertility plan nutrition supplements lifestyle'].join(' ');
    const relevantKnowledge = searchKnowledge(planQuery, profile, 15);
    const systemPrompt = `You are Bloom's senior fertility advisor AI, created by a licensed gynecologist. Generate detailed, personalised, evidence-based fertility plans in structured markdown format.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;
    const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: buildPlanPrompt(profile) }], max_tokens: 2000 });
    const planContent = response.choices[0].message.content;
    await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
    res.json({ plan: planContent, generatedAt: new Date(), cached: false });
  } catch (err) { res.status(500).json({ error: "Could not generate plan: " + err.message }); }
});

app.post("/fertility-plan/regenerate", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.plan !== "complete") return res.status(403).json({ error: "upgrade_required" });
    const profile = user.profile || {};
    const relevantKnowledge = searchKnowledge([profile.journeyStage || 'fertility', profile.symptoms ? profile.symptoms.join(' ') : '', 'fertility plan nutrition supplements lifestyle'].join(' '), profile, 15);
    const systemPrompt = `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;
    const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: buildPlanPrompt(profile) }], max_tokens: 2000 });
    const planContent = response.choices[0].message.content;
    await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
    res.json({ plan: planContent, generatedAt: new Date(), cached: false });
  } catch (err) { res.status(500).json({ error: "Could not regenerate plan: " + err.message }); }
});

function buildPlanPrompt(p) {
  return `Generate a personalised fertility plan:\nName: ${p.name || 'Not provided'}\nAge: ${p.age || 'Not provided'}\nJourney: ${p.journeyStage || 'general'}\nCycle: ${p.cycleLength ? p.cycleLength + ' days' : 'Not provided'}\nSymptoms: ${p.symptoms && p.symptoms.length ? p.symptoms.join(', ') : 'None'}\nMedications: ${p.medications && p.medications.length ? p.medications.join(', ') : 'None'}\nTTC duration: ${p.ttcDuration || 'Not provided'}\nAMH: ${p.amh ? p.amh + ' ng/mL' : 'Not done'}\nTSH: ${p.tsh ? p.tsh + ' mIU/L' : 'Not done'}\nHb: ${p.hb ? p.hb + ' g/dL' : 'Not done'}\nVitamin D: ${p.vitaminD ? p.vitaminD + ' ng/mL' : 'Not done'}\nWorkup status: ${p.workupStatus || 'Not provided'}\nNotes: ${p.notes || 'None'}\n\nCreate a comprehensive plan with: 1. Overview 2. Cycle insights 3. Nutrition 4. Supplements 5. Lifestyle 6. Emotional wellbeing 7. 4-Week roadmap 8. When to see doctor`;
}

// -- REPORT ANALYZER --
app.post("/analyze-report", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
   const reportTrialDays = 3;
    const reportAccountAge = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const reportInTrial = user.plan === "free" && reportAccountAge <= reportTrialDays;
    if (!reportInTrial && user.plan !== "complete") return res.status(403).json({ error: "upgrade_required", message: "Report analyzer is available in Bloom Complete. Upgrade to access 🌸" });
    const { imageBase64, reportType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });
    const profile = user.profile || {};
    const reportQueries = { hormone: 'FSH LH AMH estradiol progesterone prolactin testosterone hormone ranges', thyroid: 'thyroid TSH T3 T4 anti-TPO hypothyroid fertility', ultrasound: 'ultrasound antral follicle count AFC endometrium ovarian cyst fibroid PCOS', semen: 'semen analysis sperm count motility morphology azoospermia WHO criteria', blood: 'haemoglobin ferritin iron fasting glucose HbA1c insulin HOMA-IR CBC', general: 'medical report investigation fertility gynecology' };
    const reportKnowledge = searchKnowledge(reportQueries[reportType] || reportQueries.general, profile, 8);
    const profileContext = [profile.name ? `Name: ${profile.name}` : null, profile.age ? `Age: ${profile.age}` : null, profile.journeyStage ? `Journey: ${profile.journeyStage}` : null, profile.symptoms && profile.symptoms.length ? `Symptoms: ${profile.symptoms.join(', ')}` : null, profile.medications && profile.medications.length ? `Medications: ${profile.medications.join(', ')}` : null].filter(Boolean).join('\n');
    const systemPrompt = `You are Bloom's expert medical report analyzer, created by a licensed gynecologist.\n\nAnalyze this image and return JSON ONLY.\n\nPatient: ${profileContext || 'No profile'}\n\n--- CLINICAL REFERENCE ---\n${reportKnowledge}\n--- END ---\n\nFIRST determine what type of image this is:\n- If it is an ULTRASOUND SCAN, DOPPLER WAVEFORM, COLOR DOPPLER, SPECTRAL DOPPLER, X-RAY, MRI, CT, ECHOCARDIOGRAM, FETAL MONITOR TRACE, or ANY IMAGING STUDY (not a printed text lab report with numbers in rows): set "imageType":"imaging"\n- If it is a printed or digital LAB REPORT with text values in a table or list: set "imageType":"lab"\n\nFor IMAGING — STRICT RULES:\n1. ONLY describe what you literally see: colors, shapes, patterns, scan type\n2. DO NOT diagnose any condition\n3. DO NOT infer organ pathology from a scan photo\n4. DO NOT mention ovarian cyst, fibroid, mass, or any diagnosis unless it is explicitly written as text IN the image\n5. A Doppler waveform (orange/gold flame-shaped peaks) means blood flow velocity — do NOT interpret this as any organ finding\n6. concerns[] must be EMPTY []\n7. positives[] must be EMPTY []\nReturn: {"imageType":"imaging","values":[],"summary":"Plain visual description only. Example: This appears to be a pelvic ultrasound image with a spectral Doppler waveform at the bottom showing blood flow velocity patterns. The scan was performed on a Samsung WS80A machine.","concerns":[],"positives":[],"personalised":"This is a scan image that needs to be interpreted by a radiologist or your treating doctor in the context of your clinical history. Bloom cannot diagnose conditions from scan photos.","nextSteps":["Share this scan image directly with your doctor or radiologist for interpretation","Ask your doctor to explain what the Doppler waveform findings mean for you","If you have a written ultrasound report, upload that instead — Bloom can analyze text reports much more accurately"]}\n\nFor LAB REPORTS:\nReturn: {"imageType":"lab","values":[{"name":"FSH","description":"Follicle Stimulating Hormone","value":"7.2 IU/L","normalRange":"3-10 IU/L","status":"normal"}],"summary":"2-3 sentence summary","concerns":[{"title":"Issue","detail":"Explanation"}],"positives":[{"title":"Positive","detail":"Explanation"}],"personalised":"2-3 sentences for this patient","nextSteps":["Action 1","Action 2"]}\n\nStatus values: normal, low, high, borderline, na. Return ONLY valid JSON. No markdown.`;
    const response = await groq.chat.completions.create({ model: "meta-llama/llama-4-scout-17b-16e-instruct", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }, { type: "text", text: systemPrompt }] }], max_tokens: 2000, temperature: 0.1 });
    const rawText = response.choices[0].message.content.trim();
    let parsed;
    try { parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim()); }
    catch(e) { return res.status(500).json({ error: "Could not parse report analysis. Please try with a clearer image." }); }
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    res.json(parsed);
  } catch (err) { res.status(500).json({ error: "Analysis failed: " + err.message }); }
});

// -- ORDERS & PAYMENTS --
app.post("/create-order", auth, async (req, res) => {
  try {
    await connectDB();
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });
    const subscription = await razorpay.subscriptions.create({
      plan_id: PLANS[plan].planId,
      customer_notify: 1,
      quantity: 1,
      total_count: PLANS[plan].interval === "yearly" ? 1 : 12,
      notes: { userId: req.user.id.toString(), plan },
    });
    await Order.create({ razorpayOrderId: subscription.id, userId: req.user.id, plan, amount: PLANS[plan].amount });
    res.json({ subscriptionId: subscription.id, plan, planLabel: PLANS[plan].label, amount: PLANS[plan].amount });
  } catch (err) { res.status(500).json({ error: "Could not create subscription: " + err.message }); }
});

app.post("/verify-payment", auth, async (req, res) => {
  try {
    await connectDB();
    const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const expectedSig = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(razorpay_payment_id + "|" + razorpay_subscription_id).digest("hex");
    if (expectedSig !== razorpay_signature) return res.status(400).json({ error: "Payment verification failed." });
    await Order.findOneAndUpdate({ razorpayOrderId: razorpay_subscription_id }, { status: "paid" });
    const planKey = plan.includes("complete") ? "complete" : "pro";
    const updatedUser = await User.findByIdAndUpdate(req.user.id, { plan: planKey, isPremium: true }, { new: true });
    const newToken = jwt.sign({ id: updatedUser._id, plan: updatedUser.plan }, process.env.JWT_SECRET || "BLOOM_SECRET", { expiresIn: "30d" });
    res.json({ success: true, plan: updatedUser.plan, token: newToken });
  } catch (err) { res.status(500).json({ error: "Payment verification failed: " + err.message }); }
});

app.get("/plan-status", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id).select("plan messageCount reportAnalysisCount fertilityPlan");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ plan: user.plan, messageCount: user.messageCount, reportAnalysisCount: user.reportAnalysisCount, hasPlan: !!(user.fertilityPlan && user.fertilityPlan.content), planGeneratedAt: user.fertilityPlan ? user.fertilityPlan.generatedAt : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -- WEBHOOK --
app.post('/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
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

// ─────────────────────────────────────────────
//  ROBUST GROQ JSON PARSER
// ─────────────────────────────────────────────
function safeParseGroqResponse(raw) {
  if (!raw) return { main_content: 'Content could not be loaded. Please retry.', key_points: [], personalised_tip: '', clinical_note: '', action_items: [] };

  // Step 1: Strip markdown fences
  let cleaned = raw.replace(/```json|```/g, '').trim();

  // Step 2: Extract outermost { }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  // Step 3: Try direct JSON.parse
  try {
    const result = JSON.parse(cleaned);
    // Validate it has main_content
    if (result && typeof result === 'object' && (result.main_content !== undefined || result.key_points !== undefined)) {
      // Clean up: ensure no raw JSON leaked into main_content
      if (typeof result.main_content === 'string') {
        // If main_content contains JSON keys like "key_points": strip them
        result.main_content = result.main_content
          .replace(/",\s*"key_points"\s*:\s*\[[\s\S]*$/, '')
          .replace(/",\s*"personalised_tip"\s*:[\s\S]*$/, '')
          .replace(/",\s*"clinical_note"\s*:[\s\S]*$/, '')
          .replace(/",\s*"action_items"\s*:[\s\S]*$/, '')
          .trim();
      }
      // Ensure arrays
      if (!Array.isArray(result.key_points)) result.key_points = [];
      if (!Array.isArray(result.action_items)) result.action_items = [];
      if (typeof result.personalised_tip !== 'string') result.personalised_tip = '';
      if (typeof result.clinical_note !== 'string') result.clinical_note = '';
      return result;
    }
  } catch(e) {}

  // Step 4: Field-by-field regex extraction
  try {
    const extractStr = (key) => {
      const rx = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
      const m = cleaned.match(rx);
      return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
    };
    const extractArr = (key) => {
      const rx = new RegExp('"' + key + '"\\s*:\\s*\\[((?:[^\\[\\]]|"[^"]*")*)\\]');
      const m = cleaned.match(rx);
      if (!m) return [];
      const items = [];
      const itemRx = /"((?:[^"\\\\]|\\\\.)*)"/g;
      let match;
      while ((match = itemRx.exec(m[1])) !== null) {
        items.push(match[1].replace(/\\n/g, '\n'));
      }
      return items;
    };
    return {
      main_content: extractStr('main_content'),
      key_points: extractArr('key_points'),
      personalised_tip: extractStr('personalised_tip'),
      clinical_note: extractStr('clinical_note'),
      action_items: extractArr('action_items'),
    };
  } catch(e2) {}

  // Step 5: Last resort — return raw text as main_content directly
  const plainText = raw
    .replace(/```json|```/g, '')
    .replace(/\*\*/g, '')
    .trim();
  return { main_content: plainText, key_points: [], personalised_tip: '', clinical_note: '', action_items: [] };
}

// ─────────────────────────────────────────────
//  ROADMAP CONTENT API
// ─────────────────────────────────────────────
app.post("/roadmap-content", auth, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const roadmapTrialDays = 3;
    const roadmapAccountAge = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (user.plan !== "complete" && !(user.plan === "free" && roadmapAccountAge <= roadmapTrialDays)) return res.status(403).json({ error: "upgrade_required" });

    const { journey, month, week, section, checkin, ppStage } = req.body;
    const profile = user.profile || {};

    function determineClinicalStage(p) {
      const txPhase = p.txPhase; const workupStatus = p.workupStatus;
      const prevTreatments = p.prevTreatments || []; const symptoms = p.symptoms || [];
      const medications = p.medications || []; const ttcDuration = p.ttcDuration;
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

    function buildClinicalContext(p) {
      const lines = [];
      if (p.name) lines.push(`Name: ${p.name}`);
      if (p.age) lines.push(`Age: ${p.age}`);
      if (p.journeyStage) lines.push(`Journey: ${p.journeyStage}`);
      if (p.cycleLength) lines.push(`Cycle: ${p.cycleLength} days`);
      if (p.lmp) lines.push(`LMP: ${p.lmp}`);
      if (p.cycleRegularity) lines.push(`Cycle regularity: ${p.cycleRegularity}`);
      if (p.symptoms && p.symptoms.length) lines.push(`Symptoms: ${p.symptoms.join(', ')}`);
      if (p.medications && p.medications.length) lines.push(`Medications: ${p.medications.join(', ')}`);
      if (p.ttcDuration) lines.push(`TTC duration: ${p.ttcDuration}`);
      // Obstetric history
      if (p.obsGravida !== undefined) lines.push(`Gravida: ${p.obsGravida}`);
      if (p.obsPara !== undefined) lines.push(`Para: ${p.obsPara}`);
      if (p.obsAbortions !== undefined) lines.push(`Abortions: ${p.obsAbortions} (Spontaneous: ${p.obsSpontaneous||0}, Induced: ${p.obsInduced||0})`);
      if (p.obsLiving !== undefined) lines.push(`Living children: ${p.obsLiving}`);
      if (p.obsDeliveryModes && p.obsDeliveryModes.length) lines.push(`Delivery modes: ${p.obsDeliveryModes.join(', ')}`);
      if (p.obsLscsReasons && p.obsLscsReasons.length) lines.push(`LSCS reasons: ${p.obsLscsReasons.join(', ')}`);
      if (p.obsComplications && p.obsComplications.length) lines.push(`Obstetric complications: ${p.obsComplications.join(', ')}`);
      if (p.obsPriorMedications) lines.push(`Prior medications in pregnancy: ${p.obsPriorMedications}`);
      if (p.obsPriorSurgeries) lines.push(`Prior surgeries: ${p.obsPriorSurgeries}`);
      if (p.pregnancyOutcomes && p.pregnancyOutcomes.length) lines.push(`Outcomes: ${p.pregnancyOutcomes.join(', ')}`);
      if (p.semenAnalysis && p.semenAnalysis.length) lines.push(`Semen analysis: ${p.semenAnalysis.join(', ')}`);
      if (p.prevTreatments && p.prevTreatments.length) lines.push(`Previous treatments: ${p.prevTreatments.join(', ')}`);
      if (p.fertilityConditions && p.fertilityConditions.length) lines.push(`Fertility conditions: ${p.fertilityConditions.join(', ')}`);
      if (p.previousSurgeries && p.previousSurgeries.length) lines.push(`Previous surgeries: ${p.previousSurgeries.join(', ')}`);
      // Hormones
      if (p.amh) lines.push(`AMH: ${p.amh} ng/mL ${p.amh < 1.0 ? '(LOW)' : p.amh < 1.5 ? '(borderline low)' : '(normal)'}`);
      if (p.fsh) lines.push(`FSH: ${p.fsh} IU/L ${p.fsh > 10 ? '(ELEVATED)' : '(normal)'}`);
      if (p.lh) lines.push(`LH: ${p.lh} IU/L${p.fsh && p.lh/p.fsh > 2 ? ' (LH:FSH >2 -- PCOS pattern)' : ''}`);
      if (p.tsh) lines.push(`TSH: ${p.tsh} mIU/L ${p.tsh > 2.5 ? '(above TTC optimal)' : '(optimal)'}`);
      if (p.prolactin) lines.push(`Prolactin: ${p.prolactin} ng/mL ${p.prolactin > 25 ? '(ELEVATED)' : '(normal)'}`);
      if (p.testosterone) lines.push(`Testosterone: ${p.testosterone} ng/dL ${p.testosterone > 70 ? '(ELEVATED)' : '(normal)'}`);
      if (p.hb) lines.push(`Hb: ${p.hb} g/dL ${p.hb < 11 ? '(ANAEMIC)' : '(normal)'}`);
      if (p.ferritin) lines.push(`Ferritin: ${p.ferritin} ng/mL`);
      if (p.fastingGlucose) lines.push(`Fasting glucose: ${p.fastingGlucose} mg/dL`);
      if (p.vitaminD) lines.push(`Vitamin D: ${p.vitaminD} ng/mL ${p.vitaminD < 20 ? '(DEFICIENT)' : p.vitaminD < 30 ? '(insufficient)' : '(normal)'}`);
      if (p.afc) lines.push(`AFC: ${p.afc}`);
      if (p.usgFindings && p.usgFindings.length) lines.push(`USG findings: ${p.usgFindings.join(', ')}`);
      if (p.hsgResult) lines.push(`HSG result: ${p.hsgResult}`);
      if (p.workupStatus) lines.push(`Workup status: ${p.workupStatus}`);
      if (p.txPhase) lines.push(`Treatment phase: ${p.txPhase}`);
      // Pregnancy
      if (p.pregLmp) lines.push(`Pregnancy LMP: ${p.pregLmp}`);
      if (p.pregEdd) lines.push(`EDD: ${p.pregEdd}`);
      if (p.pregHighRisk && p.pregHighRisk.length) lines.push(`High risk factors: ${p.pregHighRisk.join(', ')}`);
      // ANC extended labs
      if (p.ancHb1) lines.push(`ANC Hb 1st trim: ${p.ancHb1} g/dL ${p.ancHb1 < 11 ? '(ANAEMIC)' : ''}`);
      if (p.ancHb2) lines.push(`ANC Hb 2nd trim: ${p.ancHb2} g/dL ${p.ancHb2 < 10.5 ? '(ANAEMIC)' : ''}`);
      if (p.ancHb3) lines.push(`ANC Hb 3rd trim: ${p.ancHb3} g/dL ${p.ancHb3 < 11 ? '(ANAEMIC)' : ''}`);
      if (p.ancTlc) lines.push(`TLC: ${p.ancTlc} ×10³/µL`);
      if (p.ancPlateletCount) lines.push(`Platelets: ${p.ancPlateletCount} ×10³/µL ${p.ancPlateletCount < 150 ? '(LOW)' : ''}`);
      if (p.ancRbs) lines.push(`RBS: ${p.ancRbs} mg/dL ${p.ancRbs > 140 ? '(ELEVATED)' : ''}`);
      if (p.ancSgpt) lines.push(`SGPT/ALT: ${p.ancSgpt} U/L ${p.ancSgpt > 40 ? '(ELEVATED)' : ''}`);
      if (p.ancSgot) lines.push(`SGOT/AST: ${p.ancSgot} U/L ${p.ancSgot > 40 ? '(ELEVATED)' : ''}`);
      if (p.ancUrea) lines.push(`Blood urea: ${p.ancUrea} mg/dL ${p.ancUrea > 40 ? '(ELEVATED)' : ''}`);
      if (p.ancCreatinine) lines.push(`Creatinine: ${p.ancCreatinine} mg/dL ${p.ancCreatinine > 0.9 ? '(ELEVATED)' : ''}`);
      if (p.ancUricAcid) lines.push(`Serum uric acid: ${p.ancUricAcid} mg/dL ${p.ancUricAcid > 5.5 ? '(ELEVATED -- pre-eclampsia risk)' : ''}`);
      if (p.ancVdrl) lines.push(`VDRL: ${p.ancVdrl}`);
      if (p.ancHiv) lines.push(`HIV: ${p.ancHiv}`);
      if (p.ancHbsag) lines.push(`HBsAg: ${p.ancHbsag}`);
      if (p.ancHcv) lines.push(`HCV: ${p.ancHcv}`);
      // APLA
      if (p.ancAplaLupus) lines.push(`Lupus anticoagulant: ${p.ancAplaLupus}`);
      if (p.ancAnticardiolipin) lines.push(`Anticardiolipin Ab: ${p.ancAnticardiolipin}`);
      if (p.ancBeta2Gp1) lines.push(`Anti-β2-GP1: ${p.ancBeta2Gp1}`);
      // More ANC
      if (p.ancTsh) lines.push(`ANC TSH: ${p.ancTsh} mIU/L ${p.ancTsh > 2.5 ? '(above optimal)' : ''}`);
      if (p.ancFt4) lines.push(`Free T4: ${p.ancFt4}`);
      if (p.ancAntiTpo) lines.push(`Anti-TPO: ${p.ancAntiTpo} IU/mL ${p.ancAntiTpo > 35 ? '(POSITIVE)' : ''}`);
      if (p.ancFerritin) lines.push(`ANC Ferritin: ${p.ancFerritin} ng/mL`);
      if (p.ancOgttFasting) lines.push(`OGTT fasting: ${p.ancOgttFasting}, 1hr: ${p.ancOgtt1hr||'?'}, 2hr: ${p.ancOgtt2hr||'?'} mg/dL`);
      if (p.ancUrineProtein) lines.push(`Urine protein: ${p.ancUrineProtein}`);
      if (p.ancGbs) lines.push(`Group B Strep: ${p.ancGbs}`);
      if (p.ancNuchalNt) lines.push(`Nuchal NT: ${p.ancNuchalNt} mm`);
      if (p.ancAnomalyScan) lines.push(`Anomaly scan: ${p.ancAnomalyScan}`);
      if (p.ancPlacentaPos) lines.push(`Placenta: ${p.ancPlacentaPos}`);
      if (p.bpReading1) lines.push(`BP reading 1: ${p.bpReading1}${p.bpReading1Date ? ' on ' + p.bpReading1Date : ''}`);
      if (p.bpReading2) lines.push(`BP reading 2: ${p.bpReading2}${p.bpReading2Date ? ' on ' + p.bpReading2Date : ''}`);
      if (p.concerns) lines.push(`Concerns: ${p.concerns}`);
      if (p.notes) lines.push(`Notes: ${p.notes}`);
      return lines.join('\n');
    }

   const clinicalStage = determineClinicalStage(profile);
    const clinicalContext = buildClinicalContext(profile);
    // ── POSTPARTUM ──
    if (journey === 'postpartum') {
      const ppStageLabel = { day1_3: 'Day 1-3 after birth', week1_2: 'Week 1-2 postpartum', week3_6: 'Week 3-6 postpartum', '6week_check': '6-week postnatal check', month3: '3 months postpartum', month6: '6 months postpartum' }[ppStage] || 'postpartum';
      const ppQuery = `postpartum breastfeeding newborn baby care recovery immunization vaccination ${ppStage}`;
      const relevantKnowledge = searchKnowledge(ppQuery, profile, 10);

      const ppSectionPrompts = {
        overview: `Generate a comprehensive postpartum overview for ${ppStageLabel}. Cover: physical recovery, emotional wellbeing, what is normal vs warning signs. Warm and specific.`,

        breastfeeding: `Generate detailed breastfeeding guidance for ${ppStageLabel}. Cover: feeding frequency (8-12 times/day newborn), latch technique, milk supply, engorgement, mastitis (signs and treatment), sore nipples, blocked ducts, when to seek lactation support. Indian-context advice.`,

        recovery: `Generate postpartum recovery guidance for ${ppStageLabel}. Cover: lochia (normal progression: red->pink->white), perineal care (stitches, sitz bath), C-section wound care if relevant, when to return to exercise, postpartum blues vs PPD (Edinburgh score mention), when to see doctor urgently.`,

        baby_care: `Generate DETAILED baby care guidance for ${ppStageLabel}.

INCLUDE ALL of the following appropriate to stage:
→ Feeding: cues, frequency, wet nappy count (6+ per day by day 5 = adequate)
→ Sleep: normal patterns, safe sleep position (supine), room temperature
→ Umbilical cord: dry care, when it falls off (7-14 days), signs of infection
→ Skin: vernix, milia, erythema toxicum, neonatal acne — what is normal
→ Jaundice: physiological (day 2-5, resolves by day 14) vs pathological (first 24hrs, >14 days, very yellow) — when to get bilirubin checked
→ Weight: normal loss 7-10% in first week, regain by 2 weeks
→ Temperature: normal 36.5-37.5°C, when to go to hospital (any fever <3 months = emergency)
→ Colic and crying: causes, soothing techniques (5 S's: swaddle, side/stomach, shush, swing, suck)
→ Constipation: normal in breastfed baby (can go days without stool)
→ Rashes: heat rash, cradle cap, eczema — management
→ Vision and hearing: what baby can see/hear at this stage
→ Development: milestones to watch for 0-6 months (smiling at 6w, head control at 3m, rolling at 4-5m, sitting at 6m)
→ Baby complaints: NOT feeding / refusing feeds, excessive crying, blood in stool, green watery stools, projectile vomiting, not passing meconium (first 24hrs), blue lips, grunting breathing
→ URGENT signs: go to hospital NOW — fever >38°C in under 3 months, blue lips/tongue, not breathing normally, seizures, inconsolable high-pitched cry, bulging fontanelle, very yellow skin
→ Paediatrician review: when to book, routine follow-up schedule
Keep it practical. Indian context.`,

        immunization: `Generate complete immunization schedule for ${ppStageLabel}.

BABY — Indian National Immunization Schedule (complete):
→ Birth (within 24 hours): BCG (left shoulder, intradermal) — protects against TB
→ Birth (within 24 hours): OPV-0 (oral) — polio
→ Birth (within 24 hours): Hepatitis B (birth dose) — hepatitis B
→ 6 weeks: DTwP-1 or DTaP-1, IPV-1, Hib-1, HepB-2, PCV-1, Rotavirus-1
→ 10 weeks: DTwP-2, IPV-2, Hib-2, PCV-2, Rotavirus-2
→ 14 weeks: DTwP-3, IPV-3, Hib-3, HepB-3, PCV-3, Rotavirus-3
→ 6 months: OPV-1, Influenza-1 (first dose, repeat after 4 weeks, then annually)
→ 9 months: MMR-1, OPV-2, Vitamin A (first dose)
→ 12 months: Hepatitis A-1
→ 15 months: MMR-2, Varicella-1, PCV booster
→ 18 months: DTwP booster-1, IPV booster, Hib booster, Hepatitis A-2

Additional recommended (private):
→ Meningococcal, Typhoid conjugate, HPV (girls 9-14 years)

MOTHER after delivery:
→ TT/Td if incomplete during pregnancy
→ Rubella if non-immune (avoid pregnancy for 28 days after)
→ Flu vaccine (safe while breastfeeding)

Specify which vaccines are due at ${ppStageLabel}. What each protects against. Common side effects to expect. When to call doctor post-vaccination.`,

        supplements: `Generate postpartum nutrition and supplement guidance for ${ppStageLabel}. Cover: iron (if Hb low after delivery), calcium 1000-1200mg (crucial while breastfeeding — depletes maternal bone), vitamin D, omega-3 DHA (200mg for breastfeeding), B12, hydration (3L/day minimum while breastfeeding). Indian foods that boost milk supply: methi (fenugreek), jeera water, dill (suva), saunf, ragi, saag, til (sesame), drumstick leaves. Foods to avoid while breastfeeding (gassy foods if baby colicky: cabbage, beans). Include Indian brand names where helpful. Format: → Supplement — Dose — Timing — Why`,
      };

      const ppSystemMsg = `You are Bloom's postpartum and newborn care specialist, created by a licensed Indian gynaecologist.

Patient: ${clinicalContext || 'New mother'}

FORMATTING RULES — STRICTLY FOLLOW:
- Use → (arrow) symbol for ALL bullet points, NOT hyphens or asterisks
- Leave ONE blank line between each → point for readability
- CRITICAL: main_content must be a plain text string with NO JSON syntax inside it
- main_content format example: "At week 18 your baby is growing rapidly.\n\n→ Your baby is now 14cm long.\n\n→ You may start feeling movement."
- Do NOT put JSON keys or curly braces inside main_content
- No long paragraphs — max 2 sentences then arrows
- Warm, supportive tone

CRITICAL JSON RULES:
- Return ONLY a single JSON object, nothing else before or after
- All string values must use escaped newlines \\n not actual newlines
- Do NOT nest JSON inside string values
- key_points must be a JSON array of strings

Format response as EXACTLY this structure:
{"main_content":"intro sentence.\\n\\n→ Point one\\n\\n→ Point two","key_points":["Point 1","Point 2","Point 3","Point 4"],"personalised_tip":"1-2 sentences specific to this patient","clinical_note":"important warning sign or urgent flag","action_items":["→ Action 1","→ Action 2","→ Action 3"]}

IMPORTANT: main_content field MUST have at least 3-4 sentences of actual content. Never leave main_content empty or as an empty string.
Return ONLY valid JSON. No markdown. No preamble. No text after the closing }


--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

      const ppResponse = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: ppSystemMsg }, { role: "user", content: ppSectionPrompts[section] || ppSectionPrompts.overview }], max_tokens: 1800, temperature: 0.3 });
      const ppRaw = ppResponse.choices[0].message.content.trim();
let ppParsed = safeParseGroqResponse(ppRaw);
if (!ppParsed.main_content || ppParsed.main_content.trim() === '') {
  const cleaned = ppRaw.replace(/```json|```/g, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
  ppParsed = { main_content: cleaned, key_points: [], personalised_tip: '', clinical_note: '', action_items: [] };
}
return res.json({ content: ppParsed, journey, section, ppStage });
    }

    const stageDescriptions = {
      early_ttc: 'Early TTC (less than 6 months)',
      needs_workup: 'TTC 6-12 months or has PCOS -- investigations should begin',
      needs_urgent_workup: 'TTC over 12 months -- urgent investigations needed',
      workup_partial: 'Some investigations done -- workup incomplete',
      workup_complete: 'Full workup complete -- awaiting treatment',
      oi_active: 'Currently on ovulation induction',
      monitoring: 'Currently in follicle monitoring phase',
      iui_active: 'Currently in an IUI cycle',
      pre_ivf: 'Preparing for IVF',
      ivf_active: 'Currently in active IVF cycle',
    };

    // ── SECTION PROMPTS (TTC + PREGNANCY) ──
    let query = '';
    if (journey === 'ttc') {
      const stageQueries = {
        early_ttc: 'preconception folic acid cycle tracking ovulation fertile window',
        needs_workup: 'infertility workup investigations FSH AMH TSH prolactin semen analysis',
        needs_urgent_workup: 'infertility workup specialist referral investigations urgent',
        workup_partial: 'infertility investigations results interpretation next steps',
        workup_complete: 'ovulation induction letrozole clomiphene treatment plan',
        oi_active: 'ovulation induction letrozole clomiphene follicle monitoring trigger',
        monitoring: 'follicle scan monitoring luteal phase progesterone support',
        iui_active: 'IUI cycle preparation timing success rate',
        pre_ivf: 'IVF pre-treatment optimisation egg quality supplements',
        ivf_active: 'IVF stimulation monitoring egg retrieval embryo transfer TWW',
      };
      query = stageQueries[clinicalStage] || 'fertility trying to conceive';
    } else {
      const weekTopics = {
        4: 'implantation early pregnancy hCG progesterone',
        6: 'fetal heartbeat embryo development viability scan',
        8: 'organogenesis teratogens embryo development',
        10: 'luteal placental shift first trimester nuchal',
        12: 'first trimester nuchal translucency combined screening',
        16: 'second trimester fetal movement anatomy scan iron supplements',
        20: 'anomaly scan fetal anatomy ultrasound',
        24: 'viability gestational diabetes OGTT fetal movements',
        28: 'third trimester preeclampsia monitoring iron anaemia growth',
        32: 'growth scan doppler monitoring third trimester',
        36: 'term delivery preparation labour signs birth plan GBS',
        38: 'full term labour onset delivery',
      };
      const weeks = Object.keys(weekTopics).map(Number);
      const closest = weeks.reduce((prev, curr) => Math.abs(curr - week) < Math.abs(prev - week) ? curr : prev);
      query = weekTopics[closest] || 'pregnancy prenatal care antenatal';
    }

    const syms = profile.symptoms || [];
    const meds = profile.medications || [];
    const profileTerms = [];
    if (syms.includes('pcos_diagnosed')) profileTerms.push('PCOS polycystic ovary syndrome');
    if (profile.amh && profile.amh < 1.5) profileTerms.push('low AMH diminished ovarian reserve CoQ10 DHEA');
    if (meds.includes('Metformin')) profileTerms.push('metformin insulin resistance');
    if (meds.includes('Letrozole')) profileTerms.push('letrozole ovulation induction');
    if (profile.tsh && profile.tsh > 2.5) profileTerms.push('thyroid TSH hypothyroid fertility');

    const relevantKnowledge = searchKnowledge(query + ' ' + profileTerms.join(' '), profile, 12);

    const checkinContext = checkin && checkin.chips && checkin.chips.length
      ? `\nPATIENT CHECK-IN THIS WEEK: ${checkin.chips.join(', ')}${checkin.notes ? '\nNotes: ' + checkin.notes : ''}`
      : '';

    // Build a comprehensive ANC context string for the AI
    const ancSummary = [];
    if (profile.ancHb1 || profile.ancHb2 || profile.ancHb3) {
      const hbVals = [profile.ancHb1 && `1st trim: ${profile.ancHb1}`, profile.ancHb2 && `2nd trim: ${profile.ancHb2}`, profile.ancHb3 && `3rd trim: ${profile.ancHb3}`].filter(Boolean);
      ancSummary.push(`Hb: ${hbVals.join(', ')} g/dL`);
    }
    if (profile.ancTlc) ancSummary.push(`TLC: ${profile.ancTlc}`);
    if (profile.ancPlateletCount) ancSummary.push(`Platelets: ${profile.ancPlateletCount}`);
    if (profile.ancRbs) ancSummary.push(`RBS: ${profile.ancRbs} mg/dL`);
    if (profile.ancSgpt || profile.ancSgot) ancSummary.push(`LFT: SGPT ${profile.ancSgpt||'?'}, SGOT ${profile.ancSgot||'?'} U/L`);
    if (profile.ancUrea || profile.ancCreatinine) ancSummary.push(`RFT: Urea ${profile.ancUrea||'?'} mg/dL, Creatinine ${profile.ancCreatinine||'?'} mg/dL`);
    if (profile.ancUricAcid) ancSummary.push(`Uric acid: ${profile.ancUricAcid} mg/dL`);
    if (profile.ancAplaLupus || profile.ancAnticardiolipin || profile.ancBeta2Gp1) {
      ancSummary.push(`APLA: LA=${profile.ancAplaLupus||'?'}, aCL=${profile.ancAnticardiolipin||'?'}, β2GP1=${profile.ancBeta2Gp1||'?'}`);
    }
    if (profile.ancTsh) ancSummary.push(`TSH: ${profile.ancTsh} mIU/L`);
    if (profile.ancAntiTpo) ancSummary.push(`Anti-TPO: ${profile.ancAntiTpo} IU/mL`);
    if (profile.ancOgttFasting) ancSummary.push(`OGTT: F=${profile.ancOgttFasting}, 1h=${profile.ancOgtt1hr||'?'}, 2h=${profile.ancOgtt2hr||'?'} mg/dL`);
    const ancContext = ancSummary.length ? `\nANC investigations done:\n${ancSummary.join('\n')}` : '';

    const sectionPrompts = {

      overview: journey === 'pregnancy'
        ? `Generate a personalised clinical overview for WEEK ${week} of PREGNANCY.
This is an ACTIVE PREGNANCY — do NOT mention TTC, fertility investigations, HSG, semen analysis, or trying to conceive.
Trimester: ${week <= 13 ? 'First' : week <= 26 ? 'Second' : 'Third'} trimester.
${checkinContext}

Cover:
→ What is happening with baby and mother's body at Week ${week}
→ Key focus areas this week
→ Any personalised notes based on her ANC results and obstetric history
→ What to watch out for this specific week

Patient obstetric history: G${profile.obsGravida||'?'}P${profile.obsPara||'?'}A${profile.obsAbortions||'?'}L${profile.obsLiving||'?'}
${ancContext}
High risk factors: ${profile.pregHighRisk && profile.pregHighRisk.length ? profile.pregHighRisk.join(', ') : 'none documented'}`

        : `Generate a personalised clinical overview for TTC.
STAGE: ${stageDescriptions[clinicalStage]}
${checkinContext}
Address her specific stage, conditions, and results directly. What is the priority right now?`,

      lifestyle: journey === 'pregnancy'
        ? `Generate lifestyle and monitoring guidance for Week ${week} of PREGNANCY.
This is an ACTIVE PREGNANCY — no TTC references.
Trimester: ${week <= 13 ? 'First' : week <= 26 ? 'Second' : 'Third'} trimester.
${checkinContext}

Cover:
→ Diet for this trimester (Indian foods) — include specific foods for anaemia if Hb low
→ Safe exercise (walking, prenatal yoga — what to avoid)
→ Sleep (left lateral position from Week 20 onwards and why)
→ Work and activity restrictions if any
→ Emotional wellbeing and stress management
→ Sexual activity — what is safe/unsafe at this stage
→ Travel — what is allowed at this week`

        : `Generate lifestyle and ovulation timing guidance for TTC.
STAGE: ${stageDescriptions[clinicalStage]}
${checkinContext}
Cover diet, exercise, sleep, stress, fertile window for ${profile.cycleLength||28}-day cycle, OPK use, PCOS irregular cycle advice if relevant.`,

      supplements: (function(){
        let p = journey === 'pregnancy'
          ? `Generate supplement guidance for WEEK ${week} of PREGNANCY.
This is an ACTIVE PREGNANCY — do NOT reference TTC.
Trimester: ${week <= 13 ? 'First' : week <= 26 ? 'Second' : 'Third'} trimester.
${ancContext}
`
          : `Generate specific supplement protocol for TTC.
STAGE: ${stageDescriptions[clinicalStage]||clinicalStage}
`;
        if(checkinContext) p += 'CHECK-IN SYMPTOMS: ' + (checkin && checkin.chips ? checkin.chips.join(', ') : '') + '\nAddress each symptom with supplement/dietary advice. Flag bleeding/reduced movements/headache/swelling as URGENT first.\n';
        if(journey === 'pregnancy' && (profile.bpReading1 || profile.bpReading2)) {
          const bp1 = profile.bpReading1 || '';
          const sys = parseInt(bp1.split('/')[0]) || 0;
          const dia = parseInt(bp1.split('/')[1]) || 0;
          p += `BP READINGS: ${bp1}${profile.bpReading2 ? ' / '+profile.bpReading2 : ''}\n`;
          if (sys >= 140 || dia >= 90) p += 'ALERT: BP is above 140/90 — flag pre-eclampsia risk prominently. Advise: rest, reduce salt, avoid NSAIDs, contact doctor urgently.\n';
        }
       if(journey === 'pregnancy') {
          const nrHighRisk = [];
          if(syms.includes('prev_ntd_baby')) nrHighRisk.push('previous NTD baby');
          if(syms.includes('epilepsy')||syms.includes('on_valproate')||syms.includes('on_carbamazepine')||syms.includes('on_phenytoin')) nrHighRisk.push('anti-epileptic medication');
          if(syms.includes('diabetes_preexisting')) nrHighRisk.push('pre-existing diabetes');
          if(profile.bmi && profile.bmi >= 35) nrHighRisk.push('BMI >= 35');
          if(syms.includes('thalassemia_trait')||syms.includes('sickle_cell_trait')) nrHighRisk.push('haemoglobinopathy');
          if(syms.includes('mthfr_mutation')) nrHighRisk.push('MTHFR mutation');
          if(syms.includes('malabsorption')) nrHighRisk.push('malabsorption (coeliac/IBD)');
          if(syms.includes('family_ntd')) nrHighRisk.push('family history NTD');
          const isNtdHighRisk = nrHighRisk.length > 0;
          const hasMTHFR = syms.includes('mthfr_mutation');
          let folicLine = '';
          if(week <= 12) {
            if(isNtdHighRisk) {
              folicLine = '→ Folic Acid 5mg: Once daily with food — HIGH-RISK DOSE because: ' + nrHighRisk.join(', ') + '. Brand: Folvite 5mg (Abbott). Continue until Week 12, then step down to 500mcg as IFA tablet.';
            } else {
              folicLine = '→ Folic Acid 400-500mcg (0.4-0.5mg): Once daily with food — standard dose for neural tube protection. Brand: Folvite 0.5mg. Continue until Week 12, then switch to IFA tablet (Iron 60mg + Folic Acid 500mcg).';
            }
          } else if(week <= 14) {
            folicLine = '→ Folic Acid 500mcg: NOW as part of IFA tablet (Iron 60mg + Folic Acid 500mcg). Neural tube period complete but folate still needed for DNA synthesis, RBC production, placental growth. ' + (isNtdHighRisk ? 'Step down from 5mg to 500mcg now.' : 'Switch from standalone folic acid to IFA combination.');
          } else {
            folicLine = '→ Folic Acid 500mcg: Continued as part of daily IFA tablet throughout pregnancy. GOI protocol: Iron 60mg + Folic Acid 500mcg from 2nd trimester till 6 weeks postpartum. Brands: Autrin, Hemifer-XT, Livogen.';
          }
          if(hasMTHFR) folicLine += ' MTHFR mutation: consider L-methylfolate — Folsafe Plus, Meconerv Plus.';
          if(week >= 36) folicLine += ' Continue IFA for 6 weeks postpartum especially if breastfeeding.';
          p += `STRICT PREGNANCY SUPPLEMENT RULES (PERSONALISED):
FOLIC ACID (personalised to this patient):
${folicLine}
${profile.hb ? 'Patient Hb: ' + profile.hb + ' g/dL' + (profile.hb < 11 ? ' — ANAEMIC, emphasise iron compliance and take with Vitamin C' : '') : ''}
OTHER SUPPLEMENTS BY WEEK:
→ Iron 60mg: Week 14+ ONLY as IFA tablet (do NOT give in first trimester unless Hb<9). Take on empty stomach with Vitamin C. Avoid tea/coffee/calcium within 2 hours.
→ Calcium 500mg BD: Week 16+ (morning and night, NOT with iron). Brands: Shelcal 500, Calcimax, Cipcal.
→ Vitamin D 1000 IU: Safe throughout. ${profile.vitaminD ? 'Patient level: ' + profile.vitaminD + ' ng/mL' + (profile.vitaminD < 20 ? ' — DEFICIENT: 60,000 IU weekly x 8 weeks loading' : profile.vitaminD < 30 ? ' — INSUFFICIENT: 60,000 IU weekly x 4 weeks' : ' — adequate') : ''}
→ DHA 200mg: Week 16+ (fetal brain and eye development). Brands: DHA from Merck, USV.
→ Aspirin 75-150mg: ONLY if pre-eclampsia risk factors, from Week 12-16. ${profile.pregHighRisk && profile.pregHighRisk.includes('prev_preeclampsia') ? 'PREVIOUS PRE-ECLAMPSIA — Aspirin 150mg RECOMMENDED.' : ''}
Current week: ${week}
If Hb is low — emphasise iron-rich Indian foods (green leafy vegetables, til, jaggery, meat) and iron supplement timing.
${week >= 36 ? 'Remind: Continue IFA for 6 weeks postpartum.' : ''}`;
        } else {
          const ttcNrHighRisk = [];
          if(syms.includes('prev_ntd_baby')) ttcNrHighRisk.push('previous NTD baby');
          if(syms.includes('epilepsy')||syms.includes('on_valproate')||syms.includes('on_carbamazepine')) ttcNrHighRisk.push('anti-epileptic medication');
          if(syms.includes('diabetes_preexisting')) ttcNrHighRisk.push('pre-existing diabetes');
          if(profile.bmi && profile.bmi >= 35) ttcNrHighRisk.push('BMI >= 35');
          if(syms.includes('thalassemia_trait')) ttcNrHighRisk.push('thalassemia trait');
          if(syms.includes('mthfr_mutation')) ttcNrHighRisk.push('MTHFR mutation');
          if(syms.includes('malabsorption')) ttcNrHighRisk.push('malabsorption');
          if(syms.includes('family_ntd')) ttcNrHighRisk.push('family history NTD');
          const ttcHighRisk = ttcNrHighRisk.length > 0;
          p += 'TTC SUPPLEMENTS (PERSONALISED):\n\n';
          if(ttcHighRisk) {
            p += '→ Folic Acid 5mg daily — HIGH-RISK because: ' + ttcNrHighRisk.join(', ') + '. Start 3 months before conception. Brand: Folvite 5mg.\n';
          } else {
            p += '→ Folic Acid 400-800mcg daily — standard pre-conception dose. Start NOW, ideally 3 months before. Neural tube closes Day 28. Brand: Folvite 0.5mg.\n';
          }
          if(syms.includes('mthfr_mutation')) p += '→ MTHFR mutation: consider L-methylfolate — Folsafe Plus, Meconerv Plus.\n';
          if(syms.includes('pcos_diagnosed')) p += '→ PCOS: Myo-inositol 2g + D-chiro-inositol 50mg BD (Oosure/Fertisure), NAC 600mg, Omega-3 1g\n';
          if(profile.amh && profile.amh < 1.5) p += '→ Low AMH (' + profile.amh + '): CoQ10 ubiquinol 400-600mg, DHEA 25mg TDS (doctor supervised), Melatonin 3mg bedtime\n';
          if(profile.vitaminD && profile.vitaminD < 30) p += '→ Vitamin D ' + profile.vitaminD + ' ng/mL (' + (profile.vitaminD < 20 ? 'DEFICIENT' : 'INSUFFICIENT') + '): 60,000 IU weekly x ' + (profile.vitaminD < 20 ? '8' : '4') + ' weeks, then 1000 IU daily. Brands: D-Rise 60K, Calcirol.\n';
          p += '→ Universal TTC: Vitamin D 1000 IU, Omega-3 1g, Vitamin E 400 IU, Zinc 15mg';
        }
        p += '\nInclude Indian brand names. Format: → Supplement — Dose — Timing — Why';
        return p;
      })(),

      // ── INVESTIGATIONS TAB — FULLY PREGNANCY-AWARE ──
      pretreatment: journey === 'pregnancy'
        ? `Generate a PREGNANCY INVESTIGATIONS guide specifically for WEEK ${week}.

This is an ACTIVE PREGNANCY. Do NOT mention HSG, semen analysis, AMH, FSH, or fertility investigations.
The Investigations tab should only show ANTENATAL (ANC) tests relevant to pregnancy.

Patient: G${profile.obsGravida||'?'}P${profile.obsPara||'?'}A${profile.obsAbortions||'?'}L${profile.obsLiving||'?'}
Week: ${week}, Trimester: ${week <= 13 ? 'First' : week <= 26 ? 'Second' : 'Third'}
High risk: ${profile.pregHighRisk && profile.pregHighRisk.length ? profile.pregHighRisk.join(', ') : 'none'}
${ancContext}

Structure your response as:

SECTION 1 — TESTS DUE THIS WEEK (Week ${week}):
List ONLY investigations appropriate for Week ${week}. For each test:
→ Test name — why it's done at this stage — what a normal result looks like — what to do if abnormal

IMPORTANT WEEK-SPECIFIC GUIDANCE:
- Weeks 6-10: viability scan, booking bloods (blood group, Rh, CBC, VDRL, HIV, HBsAg, HCV, TSH, urine)
- Weeks 11-13: Nuchal translucency scan, combined first trimester screening (PAPP-A, free β-hCG)
- Week 16: CBC (Hb check), TSH, ferritin, urine routine
- Weeks 18-22: Anomaly scan (level II USG) — detailed anatomy
- Weeks 24-28: OGTT (75g — fasting, 1hr, 2hr), CBC, urine protein
- Week 28+: Anti-D if Rh negative
- Weeks 28-32: Growth scan, Doppler if indicated
- Weeks 32-36: CBC, urine protein, LFT, RFT (urea, creatinine, uric acid) if preeclampsia risk
- Weeks 35-37: Group B Strep swab (GBS)
- APLA profile: if recurrent miscarriage history, prior preeclampsia, IUGR, antiphospholipid syndrome suspected

SECTION 2 — RESULTS INTERPRETATION:
Based on her actual ANC values entered, interpret any abnormal results and give specific advice.
${ancContext}

SECTION 3 — UPCOMING INVESTIGATIONS:
Next 4 weeks — what to plan and book.

SECTION 4 — HIGH RISK MONITORING:
If she has any high risk factors (${profile.pregHighRisk && profile.pregHighRisk.length ? profile.pregHighRisk.join(', ') : 'none'}), what additional monitoring is needed.`

       : `Generate investigation and pre-treatment guidance for TTC.
WORKUP STATUS: ${profile.workupStatus || 'not specified'}
INVESTIGATIONS DONE: ${profile.investigationsDone && profile.investigationsDone.length ? profile.investigationsDone.join(', ') : 'none'}

PATIENT'S ACTUAL VALUES (interpret each one that is available):
${profile.amh ? '→ AMH: ' + profile.amh + ' ng/mL ' + (profile.amh < 1.0 ? '(LOW — diminished ovarian reserve)' : profile.amh < 1.5 ? '(borderline low)' : profile.amh > 3.5 ? '(high — consider PCOS)' : '(normal)') : '→ AMH: not done yet'}
${profile.fsh ? '→ FSH (Day 2/3): ' + profile.fsh + ' IU/L ' + (profile.fsh > 10 ? '(ELEVATED — reduced reserve)' : '(normal)') : '→ FSH: not done yet'}
${profile.lh ? '→ LH (Day 2/3): ' + profile.lh + ' IU/L' + (profile.fsh ? ' | LH:FSH ratio: ' + (profile.lh/profile.fsh).toFixed(1) + (profile.lh/profile.fsh > 2 ? ' (ELEVATED — PCOS pattern)' : ' (normal)') : '') : '→ LH: not done yet'}
${profile.tsh ? '→ TSH: ' + profile.tsh + ' mIU/L ' + (profile.tsh > 4.0 ? '(HIGH — hypothyroid)' : profile.tsh > 2.5 ? '(above optimal for TTC — target <2.5)' : '(optimal)') : '→ TSH: not done yet'}
${profile.prolactin ? '→ Prolactin: ' + profile.prolactin + ' ng/mL ' + (profile.prolactin > 25 ? '(ELEVATED — may inhibit ovulation)' : '(normal)') : '→ Prolactin: not done yet'}
${profile.testosterone ? '→ Testosterone: ' + profile.testosterone + ' ng/dL ' + (profile.testosterone > 70 ? '(ELEVATED — hyperandrogenism)' : '(normal)') : ''}
${profile.dheas ? '→ DHEA-S: ' + profile.dheas + ' µg/dL' : ''}
${profile.estradiol ? '→ Estradiol: ' + profile.estradiol + ' pg/mL' : ''}
${profile.progesterone ? '→ Day 21 Progesterone: ' + profile.progesterone + ' ng/mL ' + (profile.progesterone > 5 ? '(ovulatory)' : '(anovulatory — not ovulating this cycle)') : ''}
${profile.hb ? '→ Hb: ' + profile.hb + ' g/dL ' + (profile.hb < 11 ? '(ANAEMIC)' : '(normal)') : ''}
${profile.vitaminD ? '→ Vitamin D: ' + profile.vitaminD + ' ng/mL ' + (profile.vitaminD < 20 ? '(DEFICIENT)' : profile.vitaminD < 30 ? '(insufficient)' : '(normal)') : ''}
${profile.fastingInsulin ? '→ Fasting insulin: ' + profile.fastingInsulin + ' µIU/mL ' + (profile.fastingInsulin > 12 ? '(ELEVATED — insulin resistance)' : '(normal)') : ''}
${profile.hba1c ? '→ HbA1c: ' + profile.hba1c + '%' : ''}
${profile.afc ? '→ AFC: ' + profile.afc + ' ' + (profile.afc < 5 ? '(LOW — poor reserve)' : profile.afc > 20 ? '(HIGH — PCOS pattern)' : '(normal)') : '→ AFC: not done yet'}
${profile.endometrialThickness ? '→ Endometrial thickness: ' + profile.endometrialThickness + ' mm ' + (profile.endometrialThickness < 7 ? '(THIN — may need estrogen support)' : '(adequate)') : ''}
${profile.usgFindings && profile.usgFindings.length ? '→ USG findings: ' + profile.usgFindings.join(', ') : ''}
${profile.hsgResult ? '→ HSG: ' + profile.hsgResult : '→ HSG: not done yet'}
${profile.semenAnalysis && profile.semenAnalysis.length ? '→ Semen analysis: ' + profile.semenAnalysis.join(', ') : '→ Semen analysis: not done yet'}

INSTRUCTIONS:
${!profile.workupStatus || profile.workupStatus === 'no_workup' ? 'No investigations done yet. Give a PRIORITISED list of what she needs, which cycle day to do each test, and why each matters.' : 'Interpret ALL her available values above. What is normal, what is abnormal, what needs action. Then list what is STILL MISSING and should be done next.'}
For tests not yet done: explain why it matters, when to do it (cycle day), and normal range.
For tests already done: interpret the value, flag if abnormal, give specific advice.
Format each as: → Test name — Her value (or "not done") — Normal range — What it means — Action needed`,
      immunization: journey === 'pregnancy'
        ? `Generate pregnancy immunization guidance for Week ${week} of PREGNANCY.
This is a PREGNANCY — do NOT reference TTC.

INDIA PREGNANCY IMMUNIZATION SCHEDULE:
→ TT-1: At first ANC contact (before 26 weeks if unimmunized)
→ TT-2: 4 weeks after TT-1
→ TT Booster: If previously immunized within 3 years
→ Td (Tetanus + Diphtheria): Preferred over TT in many centres
→ Flu vaccine: Recommended in all trimesters during flu season
→ COVID booster: Safe in 2nd/3rd trimester

VACCINES TO AVOID in pregnancy (live vaccines): MMR, Varicella, BCG

Immunization status from profile:
TT-1: ${profile.immTt1Date || 'not recorded'}
TT-2/Td: ${profile.immTdDate || 'not recorded'}
Flu: ${profile.immFluDate || 'not recorded'}

Specify what is due at Week ${week}. Why each vaccine matters. What to plan for post-delivery.`
        : `Generate pre-conception immunization guidance for TTC.
Check: rubella immunity, Hepatitis B, Varicella, HPV, flu, COVID. Why pre-conception immunization matters. What CANNOT be given once pregnant.
Format: → Vaccine — Who needs it — When — Why`,

      // TTC-specific sections
      lifestyle_ttc: `Generate lifestyle and ovulation timing guidance for TTC.
STAGE: ${stageDescriptions[clinicalStage]}
${checkinContext}
Cover: Indian diet for her conditions, exercise, sleep, stress, fertile window, OPK use.`,

      hormones: (function(){
        const vals = [];
        if(profile.amh) vals.push('AMH ' + profile.amh + ' ng/mL');
        if(profile.fsh) vals.push('FSH ' + profile.fsh + ' IU/L');
        if(profile.lh && profile.fsh) vals.push('LH:FSH ' + (profile.lh/profile.fsh).toFixed(1));
        if(profile.tsh) vals.push('TSH ' + profile.tsh + ' mIU/L');
        if(profile.prolactin) vals.push('Prolactin ' + profile.prolactin + ' ng/mL');
        if(profile.vitaminD) vals.push('Vitamin D ' + profile.vitaminD + ' ng/mL');
        if(profile.hb) vals.push('Hb ' + profile.hb + ' g/dL');
        if(profile.ferritin) vals.push('Ferritin ' + profile.ferritin + ' ng/mL');
        if(profile.afc) vals.push('AFC ' + profile.afc);
        const valsText = vals.length ? 'Interpret her values:\n' + vals.join('\n') : 'No hormone tests done yet. Explain which tests she needs and when.';
        return `Generate a My Results summary for this patient.
STAGE: ${stageDescriptions[clinicalStage]||clinicalStage}
${valsText}
For each value: what is normal, is hers normal, what does it mean for her fertility/health.
Format: → Test — Her value — Normal range — What it means — Action needed`;
      })(),
    };

    // Map 'pretreatment' section for TTC
    let prompt = sectionPrompts[section] || sectionPrompts.overview;

    const systemMsg = `You are Bloom's clinical content engine — specialist in reproductive medicine and obstetrics, created by a licensed Indian gynaecologist, grounded in evidence-based clinical guidelines.

Patient clinical profile:
${clinicalContext}

FORMATTING RULES — STRICTLY FOLLOW:
- Use → (arrow) for ALL bullet points throughout the response
- Leave ONE blank line between each → point for readability
- CRITICAL: main_content must be a plain text string with NO JSON syntax inside it
- main_content format example: "At week 18 your baby is growing rapidly.\\n\\n→ Your baby is 14cm long.\\n\\n→ You may feel movement."
- Do NOT put JSON keys, curly braces, or square brackets inside main_content string value
- NO long paragraphs — max 2 sentences then arrows
- Simple language — explain medical terms in brackets immediately after
- Adequate spacing between different topics/sections

CRITICAL JSON RULES:
- Return ONLY a single JSON object, nothing before or after
- All string values must use escaped newlines \\n not actual newlines
- Do NOT nest JSON inside string values
- key_points and action_items must be JSON arrays of strings

Format as EXACTLY this structure:
{"main_content":"intro sentence.\\n\\n→ Point one\\n\\n→ Point two\\n\\n→ Point three","key_points":["→ Point 1","→ Point 2","→ Point 3","→ Point 4","→ Point 5"],"personalised_tip":"Specific to THIS patient based on her actual results and history","clinical_note":"One important warning or urgent clinical note","action_items":["→ Action 1","→ Action 2","→ Action 3"]}

IMPORTANT: main_content field MUST have at least 3-4 sentences of actual content. Never leave main_content empty or as an empty string.
Return ONLY valid JSON. No markdown. No preamble. No text after the closing }


--- CLINICAL KNOWLEDGE ---
${relevantKnowledge}
--- END ---`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemMsg }, { role: "user", content: prompt }],
      max_tokens: 1800,
      temperature: 0.3,
    });

    const rawText = response.choices[0].message.content.trim();
let parsed = safeParseGroqResponse(rawText);
if (!parsed.main_content || parsed.main_content.trim() === '') {
  const cleaned = rawText.replace(/```json|```/g, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
  parsed = { main_content: cleaned, key_points: [], personalised_tip: '', clinical_note: '', action_items: [] };
}
res.json({ content: parsed, journey, month, week, section, clinicalStage });

  } catch (err) {
    console.error("Roadmap content error:", err.message);
    res.status(500).json({ error: "Could not generate content: " + err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', function () { console.log("Bloom running on port " + PORT); });
module.exports = app;
