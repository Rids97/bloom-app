"use client";
import { useState, useRef, useEffect } from "react";

// ── System prompt ──
const SYSTEM_PROMPT = `You are Bloom, a warm, knowledgeable fertility wellness advisor. 
You guide couples with evidence-based lifestyle advice before IVF. 
Keep answers empathetic, short (3–5 sentences), and include a disclaimer.`;

export default function BloomApp() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatStarted, setChatStarted] = useState(false);

  const [userState, setUserState] = useState({
    isPremium: false,
    messagesUsed: 0,
  });

  const [cycleDay, setCycleDay] = useState(1);
  const [cycleLen, setCycleLen] = useState(28);

  const inputRef = useRef(null);
  const bottomRef = useRef(null);

  // ── Load chat ──
  useEffect(() => {
    const saved = localStorage.getItem("bloom_chat");
    if (saved) setMessages(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem("bloom_chat", JSON.stringify(messages));
  }, [messages]);

  // ── Scroll ──
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    inputRef.current?.focus();
  }, [messages]);

  // ── API CALL (backend only) ──
  const callBloom = async (history) => {
    try {
      const res = await fetch("http://localhost:5000/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: history }),
      });

      const data = await res.json();
      return data.reply;
    } catch {
      return "⚠️ Server error. Try again.";
    }
  };

  // ── SEND MESSAGE ──
  const sendMessage = async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    // 🔒 FREE LIMIT (Monetization trigger)
    if (!userState.isPremium && userState.messagesUsed >= 5) {
      alert("Free limit reached. Upgrade to continue 💛");
      return;
    }

    setInput("");

    const newHistory = [...messages, { role: "user", content: msg }];
    setMessages([...newHistory, { role: "assistant", content: "..." }]);

    setLoading(true);

    const reply = await callBloom(newHistory);

    setMessages([...newHistory, { role: "assistant", content: reply }]);

    setUserState((prev) => ({
      ...prev,
      messagesUsed: prev.messagesUsed + 1,
    }));

    setLoading(false);
  };

  // ── START CHAT ──
  const startChat = () => {
    setChatStarted(true);

    setMessages([
      {
        role: "assistant",
        content: `Hi 🌸 I'm Bloom.

Tell me:
• Trying since?
• Cycle regular?
• Any PCOS/thyroid?
• Ages?`,
      },
    ]);
  };

  // ── RAZORPAY PAYMENT ──
  const handlePayment = async () => {
    const res = await fetch("http://localhost:5000/api/create-order", {
      method: "POST",
    });

    const order = await res.json();

    const options = {
      key: "YOUR_RAZORPAY_KEY",
      amount: order.amount,
      currency: "INR",
      order_id: order.id,
      handler: function () {
        alert("Payment successful 💛");

        setUserState((prev) => ({
          ...prev,
          isPremium: true,
        }));
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.open();
  };

  // ── Cycle logic ──
  const ovDay = Math.round(cycleLen - 14);
  const fertStart = ovDay - 5;
  const fertEnd = ovDay + 1;
  const inFertileWindow =
    cycleDay >= fertStart && cycleDay <= fertEnd;

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h2>🌸 Bloom Fertility App</h2>

      {!chatStarted && (
        <button onClick={startChat}>Start Chat</button>
      )}

      {/* Chat */}
      <div style={{ marginTop: 20 }}>
        {messages.map((m, i) => (
          <div key={i}>
            <b>{m.role === "user" ? "You" : "Bloom"}:</b> {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chatStarted && (
        <>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Ask..."
          />
          <button onClick={sendMessage}>Send</button>
        </>
      )}

      {/* PREMIUM CTA */}
      {!userState.isPremium && (
        <button onClick={handlePayment}>
          Unlock Premium ₹499
        </button>
      )}

      {/* Cycle */}
      <div style={{ marginTop: 20 }}>
        <h3>Cycle Tracker</h3>
        <p>Day {cycleDay}</p>

        <input
          type="range"
          min={1}
          max={cycleLen}
          value={cycleDay}
          onChange={(e) => setCycleDay(+e.target.value)}
        />

        <p>
          {inFertileWindow
            ? "🌟 Fertile window"
            : `Ovulation ~ Day ${ovDay}`}
        </p>
      </div>

      <p style={{ fontSize: 12 }}>
        ⚕️ Informational only. Consult doctor.
      </p>
    </div>
  );
}
