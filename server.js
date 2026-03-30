require(“dotenv”).config();

const express = require(“express”);
const path = require(“path”);
const fs = require(“fs”);
const mongoose = require(“mongoose”);
const bcrypt = require(“bcryptjs”);
const jwt = require(“jsonwebtoken”);
const Razorpay = require(“razorpay”);
const Groq = require(“groq-sdk”);
const crypto = require(“crypto”);

const app = express();
app.use((req, res, next) => {
if (req.path === ‘/webhook/razorpay’) return next();
express.json({ limit: ‘20mb’ })(req, res, next);
});
// static middleware moved below routes

// – KNOWLEDGE BASE –
let knowledgeBase = [];
try {
const kbPath = path.join(__dirname, ‘data’, ‘bloom_kb_complete.json’);
knowledgeBase = JSON.parse(fs.readFileSync(kbPath, ‘utf8’));
console.log(`Knowledge base loaded: ${knowledgeBase.length} chunks`);
} catch (e) {
console.log(‘JSON KB not found, falling back to markdown KB’);
try {
const mdPath = path.join(__dirname, ‘data’, ‘bloom_ai_system_prompt_kb.md’);
const mdText = fs.readFileSync(mdPath, ‘utf8’);
knowledgeBase = [{ id: ‘legacy’, source: ‘Legacy KB’, chapter: ‘general’, text: mdText }];
console.log(‘Markdown KB loaded as fallback’);
} catch (e2) { console.log(‘No knowledge base found’); }
}

// – RAG SEARCH –
function searchKnowledge(query, profile, topK = 10) {
if (!knowledgeBase.length) return ‘’;
const queryWords = query.toLowerCase().replace(/[^a-z0-9\s]/g, ’ ‘).split(/\s+/).filter(w => w.length > 3);
const contextTerms = [];
if (profile) {
const syms = profile.symptoms || [];
const meds = profile.medications || [];
if (syms.includes(‘pcos_diagnosed’)) contextTerms.push(‘pcos’, ‘polycystic’);
if (syms.includes(‘irregular_periods’)) contextTerms.push(‘anovulation’, ‘irregular’);
if (meds.includes(‘Metformin’)) contextTerms.push(‘metformin’, ‘insulin’);
if (meds.includes(‘Letrozole’)) contextTerms.push(‘letrozole’, ‘ovulation induction’);
if (meds.includes(‘Clomiphene’)) contextTerms.push(‘clomiphene’, ‘ovulation induction’);
if (profile.journeyStage === ‘pregnant’) contextTerms.push(‘pregnancy’, ‘prenatal’, ‘obstetric’);
if (profile.journeyStage === ‘ttc_ivf’) contextTerms.push(‘ivf’, ‘assisted reproduction’, ‘embryo’);
if (profile.amh && profile.amh < 1.5) contextTerms.push(‘low amh’, ‘diminished ovarian reserve’);
}
const allTerms = […new Set([…queryWords, …contextTerms])];
const chapterPriority = {
pcos_hyperandrogenism: [‘pcos’, ‘polycystic’, ‘hirsutism’, ‘androgen’],
endometriosis: [‘endometriosis’, ‘endometrioma’, ‘adenomyosis’],
fibroids: [‘fibroid’, ‘leiomyoma’, ‘myomectomy’],
infertility: [‘infertility’, ‘fertility’, ‘conception’, ‘ttc’],
infertility_workup: [‘workup’, ‘investigation’, ‘fsh’, ‘amh’, ‘hsg’, ‘semen’],
male_factor_infertility: [‘semen’, ‘sperm’, ‘azoospermia’, ‘oligospermia’],
infertility_treatment: [‘ivf’, ‘iui’, ‘letrozole’, ‘clomiphene’, ‘ovulation induction’],
prenatal_care: [‘prenatal’, ‘antenatal’, ‘pregnancy care’],
preeclampsia: [‘preeclampsia’, ‘hypertension pregnancy’],
diabetes_mellitus: [‘gestational diabetes’, ‘gdm’, ‘glucose’],
miscarriage: [‘miscarriage’, ‘pregnancy loss’, ‘recurrent’],
low_amh: [‘amh’, ‘ovarian reserve’, ‘diminished’, ‘egg quality’],
thyroid_fertility: [‘thyroid’, ‘tsh’, ‘hypothyroid’],
puerperium_postpartum: [‘postpartum’, ‘postnatal’, ‘breastfeeding’],
};
const scored = knowledgeBase.map(chunk => {
const chunkText = chunk.text.toLowerCase();
const chunkChapter = (chunk.chapter || ‘’).toLowerCase();
let score = 0;
for (const term of allTerms) {
score += (chunkText.match(new RegExp(term, ‘g’)) || []).length * 2;
if (chunkChapter.includes(term)) score += 5;
}
for (const [chapter, keywords] of Object.entries(chapterPriority)) {
if (chunkChapter === chapter) {
for (const kw of keywords) {
if (allTerms.some(t => t.includes(kw) || kw.includes(t))) score += 8;
}
}
}
if (chunk.source && chunk.source.includes(‘Williams’)) score += 1;
return { …chunk, score };
});
const relevant = scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
if (!relevant.length) {
return knowledgeBase.filter(c => [‘ttc_basics’, ‘preconception’, ‘menstrual_cycle’, ‘hormone_ranges’].includes(c.chapter)).slice(0, 5).map(c => `[${c.chapter}]\n${c.text}`).join(’\n\n—\n\n’);
}
return relevant.map(c => `[${c.source || 'Clinical KB'} - ${c.chapter}]\n${c.text}`).join(’\n\n—\n\n’);
}

// – BLOOM SYSTEM PROMPT –
const BLOOM_SYSTEM_PROMPT = `You are Bloom, a warm, knowledgeable, and compassionate AI fertility and women’s health companion, created by a licensed gynecologist.

You provide accurate, evidence-based information grounded in:

- Evidence-based clinical guidelines (NICE, ESHRE, ASRM, RCOG, FIGO)
- Current obstetrics and gynaecology clinical standards

Core principles:

1. Evidence-based - cite clinical evidence when relevant
1. Personalised - tailor responses to the user’s profile, journey stage, symptoms and medications
1. Compassionate - fertility journeys are emotionally demanding; respond with warmth
1. Safe - always recommend consulting a doctor for diagnosis and treatment decisions

Communication style:

- Warm and professional - like a knowledgeable gynaecologist friend
- Clear language - explain medical terms when used
- In Indian context - reference Indian dietary options, acknowledge cost considerations

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
console.log(“MongoDB connected”);
} catch (err) { console.error(“MongoDB error:”, err.message); }
}
connectDB();

// – USER SCHEMA –
const UserSchema = new mongoose.Schema({
email:               { type: String, required: true, unique: true },
password:            { type: String, required: true },
plan:                { type: String, default: “free” },
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
hb: Number, cbc: String, ferritin: Number,
vitaminD: Number, vitaminB12: Number,
bloodGroup: String, rhFactor: String,
afc: Number, endometrialThickness: Number, usgFindings: [String],
hsgResult: String,
// TREATMENT STATUS
workupStatus: String, txPhase: String, cycleDay: Number,
doctorInvolved: [String], nextStep: String, concerns: String,
// PREGNANCY HISTORY TAB
obsGravida: Number, obsPara: Number, obsAbortions: Number, obsLiving: Number,
pregLmp: String, pregEdd: String, pregBookingWeek: Number,
pregConception: String,
pregHighRisk: [String],
// ANC blood tests
ancBloodGroup: String, ancRhFactor: String,
ancHb1: Number, ancHb2: Number, ancHb3: Number,
ancVdrl: String, ancHiv: String, ancHbsag: String,
ancOgttFasting: Number, ancOgtt1hr: Number, ancOgtt2hr: Number,
ancTsh: Number, ancFerritin: Number, ancVitaminD: Number,
ancPlateletCount: Number, ancUrineRoutine: String,
// ANC USG
ancDatingScan: String, ancNuchalNt: Number, ancNuchalCrl: Number,
ancNuchalResult: String, ancAnomalyScan: String, ancGrowthScan: String,
ancDoppler: String, ancPlacentaPos: String, ancCervixLength: Number,
// Immunizations
immTt1Date: String, immTt2Date: String, immTdDate: String,
immFluDate: String, immCovidDone: Boolean,
bpReading1: String, bpReading1Date: String,
bpReading2: String, bpReading2Date: String,
},
fertilityPlan: { content: String, generatedAt: Date },
});

const User = mongoose.models.User || mongoose.model(“User”, UserSchema);
const OrderSchema = new mongoose.Schema({
razorpayOrderId: String, userId: mongoose.Schema.Types.ObjectId,
plan: String, amount: Number,
status: { type: String, default: “pending” }, createdAt: { type: Date, default: Date.now },
});
const Order = mongoose.models.Order || mongoose.model(“Order”, OrderSchema);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || “dummy”, key_secret: process.env.RAZORPAY_KEY_SECRET || “dummy” });
const PLANS = { pro: { amount: 14900, label: “Bloom Pro”, monthly: 149 }, complete: { amount: 44900, label: “Bloom Complete”, monthly: 449 } };

function auth(req, res, next) {
const token = req.headers.authorization?.replace(’Bearer ’, ‘’);
if (!token) return res.status(401).json({ error: “No token” });
try { req.user = jwt.verify(token, process.env.JWT_SECRET || “BLOOM_SECRET”); next(); }
catch (e) { res.status(401).json({ error: “Invalid token” }); }
}

app.get(”/test”, (req, res) => res.json({ status: “ok”, mongo: process.env.MONGO_URI ? “set” : “missing”, groq: process.env.GROQ_API_KEY ? “set” : “missing”, dbState: mongoose.connection.readyState === 1 ? “connected” : “disconnected”, kbChunks: knowledgeBase.length }));
app.get(”/”, (req, res) => res.sendFile(path.join(__dirname, “public”, “landing.html”)));
app.get(”/app”, (req, res) => res.sendFile(path.join(__dirname, “public”, “index.html”)));
app.get(”/login”, (req, res) => res.sendFile(path.join(__dirname, “public”, “login.html”)));
app.get(”/report”, (req, res) => res.sendFile(path.join(__dirname, “public”, “report.html”)));
app.get(”/roadmap”, (req, res) => res.sendFile(path.join(__dirname, “public”, “roadmap.html”)));

// Static files served AFTER explicit routes so / serves landing.html not index.html
app.use(express.static(path.join(__dirname, “public”)));

app.post(”/signup”, async (req, res) => {
try {
await connectDB();
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: “Email and password required” });
const existing = await User.findOne({ email });
if (existing) return res.status(409).json({ error: “Email already registered” });
const hash = await bcrypt.hash(password, 10);
const user = await User.create({ email, password: hash });
res.json({ message: “Account created”, userId: user._id });
} catch (err) { res.status(500).json({ error: “Signup failed: “ + err.message }); }
});

app.post(”/login”, async (req, res) => {
try {
await connectDB();
const { email, password } = req.body;
const user = await User.findOne({ email });
if (!user) return res.status(401).json({ error: “No account found with that email” });
const match = await bcrypt.compare(password, user.password);
if (!match) return res.status(401).json({ error: “Incorrect password” });
const token = jwt.sign({ id: user._id, plan: user.plan }, process.env.JWT_SECRET || “BLOOM_SECRET”, { expiresIn: “30d” });
res.json({ token, plan: user.plan, email: user.email, messageCount: user.messageCount });
} catch (err) { res.status(500).json({ error: “Login failed: “ + err.message }); }
});

app.get(”/me”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id).select(”-password”);
if (!user) return res.status(404).json({ error: “User not found” });
res.json(user);
} catch (err) { res.status(500).json({ error: err.message }); }
});

app.put(”/profile”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findByIdAndUpdate(req.user.id, { profile: req.body }, { new: true }).select(”-password”);
res.json(user);
} catch (err) { res.status(500).json({ error: “Could not update profile” }); }
});

// – CHAT –
app.post(”/chat”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id);
if (!user) return res.status(404).json({ error: “User not found” });
if (user.plan === “free” && user.messageCount >= 3) {
return res.json({ reply: null, limitReached: true, message: “You’ve used your 3 free messages. Upgrade to Bloom Pro for unlimited conversations.” });
}
user.messageCount++;
await user.save();

```
const profile = user.profile || {};
const userMessage = req.body.message || '';
const wantsDetail = req.body.wantsDetail || false;
const relevantKnowledge = searchKnowledge(userMessage, profile, 10);

let profileContext = '';
if (profile.journeyStage) {
  profileContext = `\n\nUser profile: ${profile.name || 'User'}, ${profile.journeyStage} journey.`;
  if (profile.age) profileContext += ` Age: ${profile.age}.`;
  if (profile.symptoms && profile.symptoms.length) profileContext += ` Symptoms: ${profile.symptoms.join(', ')}.`;
  if (profile.medications && profile.medications.length) profileContext += ` Medications: ${profile.medications.join(', ')}.`;
  if (profile.amh) profileContext += ` AMH: ${profile.amh} ng/mL.`;
  if (profile.tsh) profileContext += ` TSH: ${profile.tsh} mIU/L.`;
  if (profile.workupStatus) profileContext += ` Workup: ${profile.workupStatus}.`;
  if (profile.txPhase && profile.txPhase !== 'none') profileContext += ` On: ${profile.txPhase}.`;
}

const systemPrompt = wantsDetail
  ? `${BLOOM_SYSTEM_PROMPT}${profileContext}\n\nProvide a detailed, thorough answer.\nFORMATTING: Use bullet points (•) for lists, each on its own line with blank line between bullets. Use simple language, explain medical terms in brackets.\n\n--- RELEVANT CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`
  : `${BLOOM_SYSTEM_PROMPT}${profileContext}\n\nRESPONSE RULES:\n1. Simple, clear language — no jargon\n2. Concise — 2-4 sentences or short bullets\n3. Use bullet points (•) when listing items — each on its own line\n4. Explain medical terms in brackets\n5. End with: "💡 Want to understand [specific aspect] in more detail?"\n\n--- RELEVANT CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;

const response = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
  max_tokens: wantsDetail ? 1200 : 350,
});

const rawReply = response.choices[0].message.content;
const lines = rawReply.trim().split('\n');
let mainReply = rawReply.trim();
let followupSuggestion = null;
if (lines.length > 1 && lines[lines.length - 1].startsWith('💡')) {
  followupSuggestion = lines[lines.length - 1].replace('💡', '').trim();
  mainReply = lines.slice(0, -1).join('\n').trim();
}
res.json({ reply: mainReply, followup: wantsDetail ? null : followupSuggestion, isDetailed: wantsDetail, originalMessage: userMessage, messageCount: user.messageCount, plan: user.plan });
```

} catch (err) { res.status(500).json({ error: “Something went wrong: “ + err.message }); }
});

// – FERTILITY PLAN –
app.get(”/fertility-plan”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id);
if (!user) return res.status(404).json({ error: “User not found” });
if (user.plan !== “complete”) return res.status(403).json({ error: “upgrade_required” });
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
if (user.fertilityPlan && user.fertilityPlan.content && user.fertilityPlan.generatedAt > thirtyDaysAgo) {
return res.json({ plan: user.fertilityPlan.content, generatedAt: user.fertilityPlan.generatedAt, cached: true });
}
const profile = user.profile || {};
const planQuery = [profile.journeyStage || ‘fertility’, profile.symptoms ? profile.symptoms.join(’ ‘) : ‘’, profile.medications ? profile.medications.join(’ ‘) : ‘’, ‘fertility plan nutrition supplements lifestyle’].join(’ ’);
const relevantKnowledge = searchKnowledge(planQuery, profile, 15);
const systemPrompt = `You are Bloom's senior fertility advisor AI, created by a licensed gynecologist. Generate detailed, personalised, evidence-based fertility plans in structured markdown format.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;
const response = await groq.chat.completions.create({ model: “llama-3.3-70b-versatile”, messages: [{ role: “system”, content: systemPrompt }, { role: “user”, content: buildPlanPrompt(profile) }], max_tokens: 2000 });
const planContent = response.choices[0].message.content;
await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
res.json({ plan: planContent, generatedAt: new Date(), cached: false });
} catch (err) { res.status(500).json({ error: “Could not generate plan: “ + err.message }); }
});

app.post(”/fertility-plan/regenerate”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id);
if (!user) return res.status(404).json({ error: “User not found” });
if (user.plan !== “complete”) return res.status(403).json({ error: “upgrade_required” });
const profile = user.profile || {};
const relevantKnowledge = searchKnowledge([profile.journeyStage || ‘fertility’, profile.symptoms ? profile.symptoms.join(’ ‘) : ‘’, ‘fertility plan nutrition supplements lifestyle’].join(’ ’), profile, 15);
const systemPrompt = `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;
const response = await groq.chat.completions.create({ model: “llama-3.3-70b-versatile”, messages: [{ role: “system”, content: systemPrompt }, { role: “user”, content: buildPlanPrompt(profile) }], max_tokens: 2000 });
const planContent = response.choices[0].message.content;
await User.findByIdAndUpdate(req.user.id, { fertilityPlan: { content: planContent, generatedAt: new Date() } });
res.json({ plan: planContent, generatedAt: new Date(), cached: false });
} catch (err) { res.status(500).json({ error: “Could not regenerate plan: “ + err.message }); }
});

function buildPlanPrompt(p) {
return `Generate a personalised fertility plan:\nName: ${p.name || 'Not provided'}\nAge: ${p.age || 'Not provided'}\nJourney: ${p.journeyStage || 'general'}\nCycle: ${p.cycleLength ? p.cycleLength + ' days' : 'Not provided'}\nSymptoms: ${p.symptoms && p.symptoms.length ? p.symptoms.join(', ') : 'None'}\nMedications: ${p.medications && p.medications.length ? p.medications.join(', ') : 'None'}\nTTC duration: ${p.ttcDuration || 'Not provided'}\nAMH: ${p.amh ? p.amh + ' ng/mL' : 'Not done'}\nTSH: ${p.tsh ? p.tsh + ' mIU/L' : 'Not done'}\nHb: ${p.hb ? p.hb + ' g/dL' : 'Not done'}\nVitamin D: ${p.vitaminD ? p.vitaminD + ' ng/mL' : 'Not done'}\nWorkup status: ${p.workupStatus || 'Not provided'}\nNotes: ${p.notes || 'None'}\n\nCreate a comprehensive plan with: 1. Overview 2. Cycle insights 3. Nutrition 4. Supplements 5. Lifestyle 6. Emotional wellbeing 7. 4-Week roadmap 8. When to see doctor`;
}

// – REPORT ANALYZER –
app.post(”/analyze-report”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id);
if (!user) return res.status(404).json({ error: “User not found” });
if (user.plan === “free”) return res.status(403).json({ error: “upgrade_required”, message: “Report analysis requires Bloom Pro or Complete.” });
if (user.plan === “pro” && user.reportAnalysisCount >= 3) return res.status(403).json({ error: “limit_reached”, message: “Upgrade to Bloom Complete for unlimited reports.” });
if (user.plan === “pro”) await User.findByIdAndUpdate(req.user.id, { $inc: { reportAnalysisCount: 1 } });
const { imageBase64, reportType } = req.body;
if (!imageBase64) return res.status(400).json({ error: “No image provided” });
const profile = user.profile || {};
const reportQueries = { hormone: ‘FSH LH AMH estradiol progesterone prolactin testosterone hormone ranges’, thyroid: ‘thyroid TSH T3 T4 anti-TPO hypothyroid fertility’, ultrasound: ‘ultrasound antral follicle count AFC endometrium ovarian cyst fibroid PCOS’, semen: ‘semen analysis sperm count motility morphology azoospermia WHO criteria’, blood: ‘haemoglobin ferritin iron fasting glucose HbA1c insulin HOMA-IR CBC’, general: ‘medical report investigation fertility gynecology’ };
const reportKnowledge = searchKnowledge(reportQueries[reportType] || reportQueries.general, profile, 8);
const profileContext = [profile.name ? `Name: ${profile.name}` : null, profile.age ? `Age: ${profile.age}` : null, profile.journeyStage ? `Journey: ${profile.journeyStage}` : null, profile.symptoms && profile.symptoms.length ? `Symptoms: ${profile.symptoms.join(', ')}` : null, profile.medications && profile.medications.length ? `Medications: ${profile.medications.join(', ')}` : null].filter(Boolean).join(’\n’);
const systemPrompt = `You are Bloom's expert medical report analyzer, created by a licensed gynecologist.\n\nAnalyze this report and return JSON ONLY.\n\nPatient: ${profileContext || 'No profile'}\n\n--- CLINICAL REFERENCE ---\n${reportKnowledge}\n--- END ---\n\nReturn: {"values":[{"name":"FSH","description":"Follicle Stimulating Hormone","value":"7.2 IU/L","normalRange":"3-10 IU/L","status":"normal"}],"summary":"2-3 sentence summary","concerns":[{"title":"Issue","detail":"Explanation"}],"positives":[{"title":"Positive","detail":"Explanation"}],"personalised":"2-3 sentences for this patient","nextSteps":["Action 1","Action 2"]}\n\nStatus: normal, low, high, borderline, na. Return ONLY valid JSON.`;
const response = await groq.chat.completions.create({ model: “meta-llama/llama-4-scout-17b-16e-instruct”, messages: [{ role: “user”, content: [{ type: “image_url”, image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }, { type: “text”, text: systemPrompt }] }], max_tokens: 2000, temperature: 0.1 });
const rawText = response.choices[0].message.content.trim();
let parsed;
try { parsed = JSON.parse(rawText.replace(/`json|`/g, “”).trim()); }
catch(e) { return res.status(500).json({ error: “Could not parse report analysis. Please try with a clearer image.” }); }
if (parsed.error) return res.status(400).json({ error: parsed.error });
res.json(parsed);
} catch (err) { res.status(500).json({ error: “Analysis failed: “ + err.message }); }
});

// – ORDERS & PAYMENTS –
app.post(”/create-order”, auth, async (req, res) => {
try {
await connectDB();
const { plan } = req.body;
if (!PLANS[plan]) return res.status(400).json({ error: “Invalid plan” });
const razorpayOrder = await razorpay.orders.create({ amount: PLANS[plan].amount, currency: “INR”, notes: { userId: req.user.id.toString(), plan } });
await Order.create({ razorpayOrderId: razorpayOrder.id, userId: req.user.id, plan, amount: PLANS[plan].amount });
res.json({ orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, plan, planLabel: PLANS[plan].label });
} catch (err) { res.status(500).json({ error: “Could not create order” }); }
});

app.post(”/verify-payment”, auth, async (req, res) => {
try {
await connectDB();
const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
const expectedSig = crypto.createHmac(“sha256”, process.env.RAZORPAY_KEY_SECRET).update(razorpay_order_id + “|” + razorpay_payment_id).digest(“hex”);
if (expectedSig !== razorpay_signature) return res.status(400).json({ error: “Payment verification failed.” });
await Order.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: “paid” });
const updatedUser = await User.findByIdAndUpdate(req.user.id, { plan, isPremium: true }, { new: true });
const newToken = jwt.sign({ id: updatedUser._id, plan: updatedUser.plan }, process.env.JWT_SECRET || “BLOOM_SECRET”, { expiresIn: “30d” });
res.json({ success: true, plan: updatedUser.plan, token: newToken });
} catch (err) { res.status(500).json({ error: “Payment verification failed: “ + err.message }); }
});

app.get(”/plan-status”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id).select(“plan messageCount reportAnalysisCount fertilityPlan”);
if (!user) return res.status(404).json({ error: “User not found” });
res.json({ plan: user.plan, messageCount: user.messageCount, reportAnalysisCount: user.reportAnalysisCount, hasPlan: !!(user.fertilityPlan && user.fertilityPlan.content), planGeneratedAt: user.fertilityPlan ? user.fertilityPlan.generatedAt : null });
} catch (err) { res.status(500).json({ error: err.message }); }
});

// – WEBHOOK –
app.post(’/webhook/razorpay’, express.raw({ type: ‘application/json’ }), async (req, res) => {
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const signature = req.headers[‘x-razorpay-signature’];
const digest = crypto.createHmac(‘sha256’, secret).update(req.body).digest(‘hex’);
if (signature !== digest) return res.status(400).json({ message: ‘Invalid signature’ });
const event = JSON.parse(req.body);
if (event.event === ‘payment.captured’) {
const payment = event.payload.payment.entity;
await User.findOneAndUpdate({ email: payment.notes.email }, { plan: ‘pro’, planActivatedAt: new Date() });
}
res.json({ status: ‘ok’ });
});

// – ROADMAP CONTENT API –
app.post(”/roadmap-content”, auth, async (req, res) => {
try {
await connectDB();
const user = await User.findById(req.user.id);
if (!user) return res.status(404).json({ error: “User not found” });
if (user.plan !== “complete”) return res.status(403).json({ error: “upgrade_required” });

```
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
  if (p.gravida) lines.push(`Previous pregnancies: ${p.gravida}`);
  if (p.pregnancyOutcomes && p.pregnancyOutcomes.length) lines.push(`Outcomes: ${p.pregnancyOutcomes.join(', ')}`);
  if (p.semenAnalysis && p.semenAnalysis.length) lines.push(`Semen analysis: ${p.semenAnalysis.join(', ')}`);
  if (p.prevTreatments && p.prevTreatments.length) lines.push(`Previous treatments: ${p.prevTreatments.join(', ')}`);
  if (p.fertilityConditions && p.fertilityConditions.length) lines.push(`Fertility conditions: ${p.fertilityConditions.join(', ')}`);
  if (p.previousSurgeries && p.previousSurgeries.length) lines.push(`Previous surgeries: ${p.previousSurgeries.join(', ')}`);
  if (p.amh) lines.push(`AMH: ${p.amh} ng/mL ${p.amh < 1.0 ? '(LOW)' : p.amh < 1.5 ? '(borderline low)' : '(normal)'}`);
  if (p.fsh) lines.push(`FSH: ${p.fsh} IU/L ${p.fsh > 10 ? '(ELEVATED)' : '(normal)'}`);
  if (p.lh) lines.push(`LH: ${p.lh} IU/L${p.fsh && p.lh/p.fsh > 2 ? ' (LH:FSH >2 — PCOS pattern)' : ''}`);
  if (p.tsh) lines.push(`TSH: ${p.tsh} mIU/L ${p.tsh > 2.5 ? '(above TTC optimal)' : '(optimal)'}`);
  if (p.prolactin) lines.push(`Prolactin: ${p.prolactin} ng/mL ${p.prolactin > 25 ? '(ELEVATED)' : '(normal)'}`);
  if (p.testosterone) lines.push(`Testosterone: ${p.testosterone} ng/dL ${p.testosterone > 70 ? '(ELEVATED)' : '(normal)'}`);
  if (p.dheas) lines.push(`DHEA-S: ${p.dheas} µg/dL`);
  if (p.hb) lines.push(`Hb: ${p.hb} g/dL ${p.hb < 11 ? '(ANAEMIC)' : '(normal)'}`);
  if (p.ferritin) lines.push(`Ferritin: ${p.ferritin} ng/mL`);
  if (p.fastingGlucose) lines.push(`Fasting glucose: ${p.fastingGlucose} mg/dL ${p.fastingGlucose > 100 ? '(elevated)' : '(normal)'}`);
  if (p.hba1c) lines.push(`HbA1c: ${p.hba1c}%`);
  if (p.fastingInsulin) lines.push(`Fasting insulin: ${p.fastingInsulin} µIU/mL`);
  if (p.vitaminD) lines.push(`Vitamin D: ${p.vitaminD} ng/mL ${p.vitaminD < 20 ? '(DEFICIENT)' : p.vitaminD < 30 ? '(insufficient)' : '(normal)'}`);
  if (p.vitaminB12) lines.push(`B12: ${p.vitaminB12} pg/mL ${p.vitaminB12 < 200 ? '(LOW)' : '(normal)'}`);
  if (p.afc) lines.push(`AFC: ${p.afc} ${p.afc < 5 ? '(LOW)' : p.afc < 10 ? '(borderline)' : '(normal)'}`);
  if (p.endometrialThickness) lines.push(`Endometrial thickness: ${p.endometrialThickness} mm`);
  if (p.usgFindings && p.usgFindings.length) lines.push(`USG findings: ${p.usgFindings.join(', ')}`);
  if (p.hsgResult) lines.push(`HSG result: ${p.hsgResult}`);
  if (p.workupStatus) lines.push(`Workup status: ${p.workupStatus}`);
  if (p.txPhase) lines.push(`Treatment phase: ${p.txPhase}`);
  if (p.cycleDay) lines.push(`Cycle day: ${p.cycleDay}`);
  if (p.nextStep) lines.push(`Next step: ${p.nextStep}`);
  if (p.concerns) lines.push(`Concerns: ${p.concerns}`);
  // Pregnancy ANC
  if (p.pregLmp) lines.push(`Pregnancy LMP: ${p.pregLmp}`);
  if (p.pregEdd) lines.push(`EDD: ${p.pregEdd}`);
  if (p.ancHb1) lines.push(`ANC Hb 1st trim: ${p.ancHb1} g/dL ${p.ancHb1 < 11 ? '(ANAEMIC)' : ''}`);
  if (p.ancHb2) lines.push(`ANC Hb 2nd trim: ${p.ancHb2} g/dL ${p.ancHb2 < 10.5 ? '(ANAEMIC)' : ''}`);
  if (p.ancOgttFasting) lines.push(`OGTT fasting: ${p.ancOgttFasting}, 1hr: ${p.ancOgtt1hr || '?'}, 2hr: ${p.ancOgtt2hr || '?'} mg/dL`);
  if (p.ancTsh) lines.push(`ANC TSH: ${p.ancTsh} mIU/L`);
  if (p.ancNuchalNt) lines.push(`Nuchal NT: ${p.ancNuchalNt} mm`);
  if (p.ancAnomalyScan) lines.push(`Anomaly scan: ${p.ancAnomalyScan}`);
  if (p.ancPlacentaPos) lines.push(`Placenta: ${p.ancPlacentaPos}`);
  if (p.pregHighRisk && p.pregHighRisk.length) lines.push(`High risk: ${p.pregHighRisk.join(', ')}`);
  if (p.bpReading1) lines.push(`BP reading 1: ${p.bpReading1}${p.bpReading1Date ? ' on ' + p.bpReading1Date : ''}`);
  if (p.bpReading2) lines.push(`BP reading 2: ${p.bpReading2}${p.bpReading2Date ? ' on ' + p.bpReading2Date : ''}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  return lines.join('\n');
}

const clinicalStage = determineClinicalStage(profile);
const clinicalContext = buildClinicalContext(profile);

// POSTPARTUM
if (journey === 'postpartum') {
  const ppStageLabel = { day1_3: 'Day 1-3 after birth', week1_2: 'Week 1-2 postpartum', week3_6: 'Week 3-6 postpartum', '6week_check': '6-week postnatal check', month3: '3 months postpartum', month6: '6 months postpartum' }[ppStage] || 'postpartum';
  const ppQuery = `postpartum breastfeeding newborn baby care recovery immunization vaccination ${ppStage}`;
  const relevantKnowledge = searchKnowledge(ppQuery, profile, 10);

  const ppSectionPrompts = {
    overview: `Generate a comprehensive postpartum overview for ${ppStageLabel}. Cover: physical recovery, emotional wellbeing, what is normal vs warning signs. Warm and specific.`,
    breastfeeding: `Generate detailed breastfeeding guidance for ${ppStageLabel}. Cover: feeding frequency (8-12 times/day newborn), latch technique, milk supply, engorgement, mastitis (signs and treatment), sore nipples, blocked ducts, when to seek lactation support. Indian-context advice.`,
    recovery: `Generate postpartum recovery guidance for ${ppStageLabel}. Cover: lochia (normal progression: red→pink→white), perineal care (stitches, sitz bath), C-section wound care if relevant, when to return to exercise, postpartum blues vs PPD (Edinburgh score mention), when to see doctor urgently.`,
    baby_care: `Generate baby care guidance for ${ppStageLabel}. Cover: feeding cues (rooting, sucking hands), wet nappy count (6+ per day by day 5 = adequate feeding), sleep patterns (normal newborn sleep), umbilical cord care (dry method), bathing, skin care (vernix, milia), jaundice (physiological vs pathological), temperature check, when to call paediatrician URGENTLY. Keep practical.`,
    immunization: `Generate complete immunization schedule for ${ppStageLabel}.
```

BABY — Indian National Immunization Schedule:
Birth: BCG, OPV-0, Hepatitis B (birth dose within 24 hours)
6 weeks: DTwP-1, IPV-1, Hib-1, HepB-2, PCV-1, Rotavirus-1
10 weeks: DTwP-2, IPV-2, Hib-2, PCV-2, Rotavirus-2
14 weeks: DTwP-3, IPV-3, Hib-3, HepB-3, PCV-3, Rotavirus-3
6 months: OPV-1, Influenza-1
9 months: MMR-1, OPV-2
12 months: Hepatitis A-1
15 months: MMR-2, Varicella-1, PCV booster
18 months: DTwP booster-1, IPV booster, Hib booster, Hepatitis A-2

MOTHER after birth:
TT/Td if incomplete during pregnancy
Rubella if non-immune (no breastfeeding 28 days after)
Flu vaccine (safe while breastfeeding)

Specify which vaccines are due at ${ppStageLabel}. Explain what each protects against simply.`, supplements: `Generate postpartum nutrition and supplement guidance for ${ppStageLabel}. Cover: iron replacement (if Hb low after delivery), calcium 1000-1200mg (crucial while breastfeeding), vitamin D, omega-3 DHA, B12, hydration (3L/day minimum while breastfeeding). Indian foods that boost milk supply (methi, jeera, dill, saunf, ragi). Foods to moderate while breastfeeding. Include Indian brand names.`,
};

```
  const ppSystemMsg = `You are Bloom's postpartum and newborn care specialist, created by a licensed Indian gynaecologist.\n\nPatient: ${clinicalContext || 'New mother'}\n\nFORMATTING RULES:\n- Bullet points (•) for all lists, each on own line with blank line between\n- main_content: intro sentence\\n\\n• Point one\\n\\n• Point two\n- No long paragraphs — max 2 sentences then bullets\n- Warm, supportive tone\n\nFormat as JSON:\n{"main_content":"intro\\n\\n• Point one\\n\\n• Point two","key_points":["Point 1","Point 2","Point 3","Point 4"],"personalised_tip":"1-2 sentences","clinical_note":"important warning","action_items":["Action 1","Action 2","Action 3"]}\n\nReturn ONLY valid JSON.\n\n--- CLINICAL KNOWLEDGE ---\n${relevantKnowledge}\n--- END ---`;

  const ppResponse = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: ppSystemMsg }, { role: "user", content: ppSectionPrompts[section] || ppSectionPrompts.overview }], max_tokens: 1200, temperature: 0.3 });
  const ppRaw = ppResponse.choices[0].message.content.trim();
  let ppParsed;
  try {
    const ppCleaned = ppRaw.replace(/```json|```/g, "").trim();
    const ppStart = ppCleaned.indexOf('{');
    const ppEnd = ppCleaned.lastIndexOf('}');
    const ppStr = ppStart !== -1 && ppEnd !== -1 ? ppCleaned.slice(ppStart, ppEnd + 1) : ppCleaned;
    ppParsed = JSON.parse(ppStr);
  } catch(e) {
    ppParsed = { main_content: ppRaw.replace(/```json|```/g,"").trim(), key_points: [], personalised_tip: "", clinical_note: "", action_items: [] };
  }
  return res.json({ content: ppParsed, journey, section, ppStage });
}

const stageDescriptions = {
  early_ttc: 'Early TTC (less than 6 months)',
  needs_workup: 'TTC 6-12 months or has PCOS — investigations should begin',
  needs_urgent_workup: 'TTC over 12 months — urgent investigations needed',
  workup_partial: 'Some investigations done — workup incomplete',
  workup_complete: 'Full workup complete — awaiting treatment',
  oi_active: 'Currently on ovulation induction',
  monitoring: 'Currently in follicle monitoring phase',
  iui_active: 'Currently in an IUI cycle',
  pre_ivf: 'Preparing for IVF',
  ivf_active: 'Currently in active IVF cycle',
};

let query = '';
if (journey === 'ttc') {
  const stageQueries = { early_ttc: 'preconception folic acid cycle tracking ovulation fertile window', needs_workup: 'infertility workup investigations FSH AMH TSH prolactin semen analysis', needs_urgent_workup: 'infertility workup specialist referral investigations urgent', workup_partial: 'infertility investigations results interpretation next steps', workup_complete: 'ovulation induction letrozole clomiphene treatment plan', oi_active: 'ovulation induction letrozole clomiphene follicle monitoring trigger', monitoring: 'follicle scan monitoring luteal phase progesterone support', iui_active: 'IUI cycle preparation timing success rate', pre_ivf: 'IVF pre-treatment optimisation egg quality supplements', ivf_active: 'IVF stimulation monitoring egg retrieval embryo transfer TWW' };
  query = stageQueries[clinicalStage] || 'fertility trying to conceive';
} else {
  const weekTopics = { 4: 'implantation early pregnancy hCG progesterone', 6: 'fetal heartbeat embryo development viability scan', 8: 'organogenesis teratogens embryo development', 10: 'luteal placental shift first trimester nuchal', 12: 'first trimester nuchal translucency combined screening', 16: 'second trimester fetal movement anatomy scan', 20: 'anomaly scan fetal anatomy ultrasound', 24: 'viability gestational diabetes OGTT fetal movements', 28: 'third trimester preeclampsia monitoring iron anaemia', 32: 'growth scan doppler monitoring third trimester', 36: 'term delivery preparation labour signs birth plan', 38: 'full term labour onset delivery' };
  const weeks = Object.keys(weekTopics).map(Number);
  const closest = weeks.reduce((prev, curr) => Math.abs(curr - week) < Math.abs(prev - week) ? curr : prev);
  query = weekTopics[closest] || 'pregnancy prenatal care';
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

const sectionPrompts = {
  overview: `Generate a personalised clinical overview.\nSTAGE: ${stageDescriptions[clinicalStage]}\nTIME: ${journey === 'ttc' ? 'TTC journey' : `Week ${week}`}\n${checkinContext}\nAddress her specific stage, conditions, and results directly. What is the priority right now?`,

  lifestyle: journey === 'ttc'
    ? `Generate lifestyle and ovulation timing guidance combined.\nSTAGE: ${stageDescriptions[clinicalStage]}\n${checkinContext}\nSECTION 1 — LIFESTYLE: Indian-friendly diet for her conditions, exercise (type and frequency), sleep, stress. Specific to her profile.\nSECTION 2 — TIMING & OPK: Fertile window calculation for ${profile.cycleLength || 28}-day cycle, OPK strip use, intercourse timing, cervical mucus tracking. PCOS irregular cycle advice if relevant. Treatment monitoring tips if on OI/IUI.`
    : `Generate lifestyle and monitoring guidance combined for Week ${week}.\n${checkinContext}\nSECTION 1 — LIFESTYLE: Diet, exercise, sleep, stress for this trimester. Indian foods.\nSECTION 2 — MONITORING: Scans/tests due this week, warning signs, upcoming appointments.`,

  timing: journey === 'ttc'
    ? `Generate fertile window and ovulation timing guidance.\nCycle: ${profile.cycleRegularity || 'unknown'}, ${profile.cycleLength || 28} days.\nCover OPK timing, intercourse timing, PCOS irregular cycle advice, OI monitoring if on treatment.`
    : `Generate pregnancy monitoring guidance for Week ${week}.\n${checkinContext}\nWhat scans/tests are due, what to track, warning signs, upcoming appointments.`,

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
    return 'Generate a My Results summary for this patient.\nSTAGE: ' + (stageDescriptions[clinicalStage]||clinicalStage) + '\n' + valsText + '\nFor each value: what is normal, is hers normal, what does it mean for her fertility/health. Be direct.';
  })(),

  supplements: (function(){
    let p = 'Generate specific supplement protocol.\nSTAGE: ' + (stageDescriptions[clinicalStage]||clinicalStage) + '\n';
    if(checkinContext) p += 'CHECK-IN SYMPTOMS: ' + (checkin && checkin.chips ? checkin.chips.join(', ') : '') + '\nAddress each symptom with supplement/dietary advice. Flag bleeding/reduced movements/headache/swelling as URGENT first.\n';
    if(journey === 'pregnancy' && (profile.bpReading1 || profile.bpReading2)) {
      p += 'BP READINGS: ' + (profile.bpReading1||'') + (profile.bpReading2 ? ' / '+profile.bpReading2 : '') + '\nIf systolic >= 140 or diastolic >= 90 — flag pre-eclampsia risk at top. Advise: rest, reduce salt, avoid NSAIDs, contact doctor urgently.\n';
    }
    if(journey === 'pregnancy') {
      p += 'STRICT PREGNANCY RULES:\n- Folic acid 5mg: weeks 1-12 ONLY\n- Iron 60mg: Week 14+ ONLY\n- Calcium: Week 16+ only\n- Vitamin D: safe throughout\nCurrent week: ' + week;
    } else {
      p += 'TTC SUPPLEMENTS:\n';
      if(syms.includes('pcos_diagnosed')) p += '- PCOS: Myo-inositol 2g + D-chiro 50mg BD, Vitamin D, NAC 600mg, Omega-3\n';
      if(profile.amh && profile.amh < 1.5) p += '- Low AMH: CoQ10 ubiquinol 400-600mg, DHEA 25mg (doctor supervised), Vitamin D\n';
      if(profile.vitaminD && profile.vitaminD < 30) p += '- Vitamin D ' + profile.vitaminD + ' ng/mL (deficient): 60,000 IU weekly x 8 weeks\n';
      p += '- Universal TTC: Folic acid 5mg, Vitamin D 1000 IU, Omega-3 1g';
    }
    p += '\nInclude Indian brand names. Format: * Supplement -- Dose -- Timing -- Why';
    return p;
  })(),

  pretreatment: `Generate investigation and pre-treatment guidance.\nWORKUP: ${profile.workupStatus || 'not specified'}\nDONE: ${profile.investigationsDone && profile.investigationsDone.length ? profile.investigationsDone.join(', ') : 'none'}\n${!profile.workupStatus || profile.workupStatus === 'no_workup' ? 'No investigations done. Prioritised list of what to get done, cycle day timing, why.' : 'What is still missing? What happens in next 4-8 weeks?'}`,

  immunization: journey === 'pregnancy'
    ? `Generate pregnancy immunization guidance for Week ${week}.\n\nINDIA PREGNANCY IMMUNIZATION SCHEDULE:\n- TT-1: At first ANC contact (before 26 weeks if unimmunized)\n- TT-2: 4 weeks after TT-1\n- TT Booster: If previously immunized within 3 years\n- Td: Preferred over TT in many centres (tetanus + diphtheria)\n- Flu vaccine: Recommended in all trimesters during flu season\n- COVID booster: Safe in 2nd/3rd trimester\n\nVACCINES TO AVOID in pregnancy: MMR, Varicella, BCG (live vaccines)\n\nSpecify what is due at Week ${week}. Why each vaccine matters. What to plan for post-delivery.`
    : `Generate pre-conception immunization guidance.\nCheck: rubella immunity, Hepatitis B, Varicella, HPV, flu, COVID. Why pre-conception immunization matters. What CANNOT be given once pregnant.`,
};

const prompt = sectionPrompts[section] || sectionPrompts.overview;

const systemMsg = `You are Bloom's clinical content engine — specialist in reproductive medicine and obstetrics, created by a licensed Indian gynaecologist, grounded in evidence-based clinical guidelines.
```

Patient clinical profile:\n${clinicalContext}

FORMATTING RULES — STRICTLY FOLLOW:

- Use bullet points (•) for all multi-item content
- Each bullet on its own line with blank line between bullets
- main_content: intro sentence\n\n• Point one\n\n• Point two\n\n• Point three
- key_points: each a single clear sentence
- action_items: starts with action verb, specific and short
- NO long paragraphs — max 2 sentences then bullets
- Simple language — explain medical terms in brackets

Format as JSON:
{“main_content”:“intro\n\n• Point one\n\n• Point two”,“key_points”:[“Point 1”,“Point 2”,“Point 3”,“Point 4”,“Point 5”],“personalised_tip”:“Specific to THIS patient’s conditions and results”,“clinical_note”:“One important warning or clinical note”,“action_items”:[“Action 1”,“Action 2”,“Action 3”]}

Return ONLY valid JSON. No markdown, no preamble.

— CLINICAL KNOWLEDGE —\n${relevantKnowledge}\n— END —`;

```
const response = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemMsg }, { role: "user", content: prompt }], max_tokens: 1200, temperature: 0.3 });
const rawText = response.choices[0].message.content.trim();
let parsed;
try {
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  const jsonStr = jsonStart !== -1 && jsonEnd !== -1 ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
  parsed = JSON.parse(jsonStr);
} catch(e) {
  // Extract readable text — strip JSON artifacts
  parsed = { main_content: rawText.replace(/```json|```/g,"").trim(), key_points: [], personalised_tip: "", clinical_note: "", action_items: [] };
}
res.json({ content: parsed, journey, month, week, section, clinicalStage });
```

} catch (err) {
console.error(“Roadmap content error:”, err.message);
res.status(500).json({ error: “Could not generate content: “ + err.message });
}
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, ‘0.0.0.0’, function () { console.log(“Bloom running on port “ + PORT); });
module.exports = app;
