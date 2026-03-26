require("dotenv").config();

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const Groq = require("groq-sdk");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── DB ────────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// ─── MODELS ────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },
  plan:         { type: String, default: "free" },
  isPremium:    { type: Boolean, default: false },
  messageCount: { type: Number, default: 0 },
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

const User = mongoose.model("User", UserSchema);

const OrderSchema = new mongoose.Schema({
  razorpayOrderId: String,
  userId:          mongoose.Schema.Types.ObjectId,
  plan:            String,
  amount:          Number,
  status:          { type: String, default: "pending" },
  createdAt:       { type: Date, default: Date.now },
});

const Order = mongoose.model("Order", OrderSchema);

// ─── CLIENTS ───────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── PRICING ───────────────────────────────────────────────────────────────
const PLANS = {
  pro:      { amount: 20000,  label: "Bloom Pro",     monthly: 200  },
  complete: { amount: 80000,  label: "Bloom Complete", monthly: 800  },
};

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "BLOOM_SECRET");
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get("/",      (req, res) => res.sendFile(path.join(__dirname, "public/landing.html")));
app.get("/app",   (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public/login.html")));

// ── Auth ──────────────────────────────────────────────────────────────────
app.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hash });
    res.json({ message: "Account created", userId: user._id });
  } catch {
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/login", async (req, res) => {
  try {
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
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Profile ───────────────────────────────────────────────────────────────
app.get("/me", auth, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

app.put("/profile", auth, async (req, res) => {
  try {
    const { name, age, cycleLength, periodLength, journeyStage, symptoms, medications, notes } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profile: { name, age, cycleLength, periodLength, journeyStage, symptoms, medications, notes } },
      { new: true }
    ).select("-password");
    res.json(user);
  } catch {
    res.status(500).json({ error: "Could not update profile" });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────
app.post("/chat", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan === "free" && user.messageCount >= 5) {
      return res.json({
        reply: null,
        limitReached: true,
        message: "You've used your 5 free messages. Upgrade to Bloom Pro for unlimited conversations.",
      });
    }

    user.messageCount++;
    await user.save();

    const profile = user.profile || {};
    let systemPrompt = `You are Bloom, a warm, knowledgeable, and compassionate AI fertility companion.
You provide accurate, evidence-based information about fertility, menstrual cycles, IVF, PCOS, and reproductive health.
You are supportive, non-judgmental, and always remind users to consult their doctor for medical decisions.
Keep responses warm, clear, and concise.`;

    if (profile.journeyStage) {
      systemPrompt += `\n\nUser context: ${profile.name || "This user"} is on a ${profile.journeyStage} journey.`;
      if (profile.age) systemPrompt += ` Age: ${profile.age}.`;
      if (profile.cycleLength) systemPrompt += ` Average cycle: ${profile.cycleLength} days.`;
      if (profile.symptoms?.length) systemPrompt += ` Noted symptoms: ${profile.symptoms.join(", ")}.`;
    }

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: req.body.message },
      ],
      max_tokens: 500,
    });

    res.json({
      reply:        response.choices[0].message.content,
      messageCount: user.messageCount,
      plan:         user.plan,
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Fertility Plan ─────────────────────────────────────────────────────────
app.get("/fertility-plan", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.plan !== "complete") {
      return res.status(403).json({
        error: "upgrade_required",
        message: "Personalised fertility plans are part of Bloom Complete (₹1,200/month).",
      });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (user.fertilityPlan?.content && user.fertilityPlan.generatedAt > thirtyDaysAgo) {
      return res.json({ plan: user.fertilityPlan.content, generatedAt: user.fertilityPlan.generatedAt, cached: true });
    }

    const profile = user.profile || {};
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are Bloom's senior fertility advisor AI. Generate detailed, personalised, evidence-based fertility plans in structured markdown format.
Always include: introduction, cycle insights, nutrition plan, supplement recommendations, lifestyle adjustments, stress management, and monthly roadmap.
Be warm, specific, and actionable. Always remind the user this complements (not replaces) medical care.`,
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
    console.error("Plan error:", err);
    res.status(500).json({ error: "Could not generate plan. Please try again." });
  }
});

app.post("/fertility-plan/regenerate", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.plan !== "complete") return res.status(403).json({ error: "upgrade_required" });

    const profile = user.profile || {};
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are Bloom's senior fertility advisor AI. Generate detailed personalised fertility plans in markdown format. Be warm and actionable.`,
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
  } catch {
    res.status(500).json({ error: "Could not regenerate plan." });
  }
});

function buildPlanPrompt(profile) {
  return `Please generate a personalised fertility plan for this user:
Name: ${profile.name || "Not provided"}
Age: ${profile.age || "Not provided"}
Journey stage: ${profile.journeyStage || "general fertility support"}
Average cycle length: ${profile.cycleLength ? profile.cycleLength + " days" : "Not provided"}
Average period length: ${profile.periodLength ? profile.periodLength + " days" : "Not provided"}
Current symptoms: ${profile.symptoms?.join(", ") || "None noted"}
Current medications: ${profile.medications?.join(", ") || "None"}
Additional notes: ${profile.notes || "None"}

Create a comprehensive personalised fertility plan with these sections:
1. Personal Overview & Key Insights
2. Understanding Your Cycle
3. Nutrition Plan
4. Supplement Protocol
5. Lifestyle Adjustments
6. Stress & Emotional Wellbeing
7. 4-Week Action Roadmap
8. When to Speak to Your Doctor`;
}

// ── Payments ──────────────────────────────────────────────────────────────
app.post("/create-order", auth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });

    const razorpayOrder = await razorpay.orders.create({
      amount:   PLANS[plan].amount,
      currency: "INR",
      notes:    { userId: req.user.id.toString(), plan },
    });

    await Order.create({
      razorpayOrderId: razorpayOrder.id,
      userId:          req.user.id,
      plan,
      amount:          PLANS[plan].amount,
    });

    res.json({
      orderId:   razorpayOrder.id,
      amount:    razorpayOrder.amount,
      currency:  razorpayOrder.currency,
      plan,
      planLabel: PLANS[plan].label,
    });
  } catch (err) {
    console.error("Order error:", err);
    res.status(500).json({ error: "Could not create order" });
  }
});

app.post("/verify-payment", auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed." });
    }

    await Order.findOneAndUpdate({ razorpayOrderId: razorpay_order_id }, { status: "paid" });

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { plan, isPremium: true },
      { new: true }
    );

    const newToken = jwt.sign(
      { id: updatedUser._id, plan: updatedUser.plan },
      process.env.JWT_SECRET || "BLOOM_SECRET",
      { expiresIn: "30d" }
    );

    res.json({ success: true, plan: updatedUser.plan, token: newToken });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

app.get("/plan-status", auth, async (req, res) => {
  const user = await User.findById(req.user.id).select("plan messageCount fertilityPlan");
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    plan:            user.plan,
    messageCount:    user.messageCount,
    hasPlan:         !!user.fertilityPlan?.content,
    planGeneratedAt: user.fertilityPlan?.generatedAt,
  });
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Bloom running on port ${PORT}`));
