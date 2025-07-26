// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createServer } from "http";
import { Server } from "socket.io";
let context = "";
dotenv.config();
const spyPromptMap = new Map();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

const API_KEY = "AIzaSyAtPZnhmQYj0imcehXmuJY2MUOz_qA86Ys";
const VALID_CODES = "WY98H8";

if (!API_KEY) {
  console.error("❌ GEMINI_API_KEY not found in .env");
  process.exit(1);
}



const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let userContext = {}; // Per-code context
let messageHistory = {}; // In-memory message store per room

// Validate code
app.post("/api/validateCode", (req, res) => {
  console.log("validateCode API called");
  const { code } = req.body;

  if (!code || code != VALID_CODES) {
    return res
      .status(401)
      .json({ valid: false, message: "Invalid or missing code." });
  }

  return res.json({ valid: true });
});

// Traditional REST sendMessage endpoint
app.post("/api/sendMessage", async (req, res) => {
    try
    {

    const { userSays, userThinks, code } = req.body;
    if ( !code) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const prompt = `
You're a friendly and clever chatbot. For every input, reply in the strict format below with no extra characters or formatting.

Respond in this format only:
{
  "reply": "<insert your reply here>",
  "context": "<insert the context for your reply here>"
}

Never include any markdown, quotes, or explanations — only raw JSON.
`;

    const userPrompt = `user says: "${userSays}"${
      userThinks ? `, what you should do: "${userThinks}"` : ""
    }`;

    const result = await model.generateContent([prompt,userPrompt]);
    const response = await result.response;
    const text = response.text();
    const rawText = response.text().trim();

    // Remove code fences if present
    const cleaned = rawText
      .replace(/^```json\n?/, "")
      .replace(/```$/, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("❌ Failed to parse JSON from model:", cleaned);
      return res.status(500).json({ error: "Model returned invalid JSON" });
    }
    userContext[code] =
      (userContext[code] || "") + ", " + extractKeywords(userSays);

    if (!messageHistory[code]) messageHistory[code] = [];
    messageHistory[code].push({ from: "user", text: userSays });
    messageHistory[code].push({ from: "ai", text:parsed.reply });
    
    return res.json({ response: parsed });
  } catch (err) {
    console.error("💥 Error in /api/sendMessage:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Utility to extract keywords for context
function extractKeywords(text) {
  const commonWords = new Set([
    "is",
    "the",
    "a",
    "of",
    "and",
    "to",
    "in",
    "this",
    "that",
    "what",
  ]);
  return text
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter((word) => !commonWords.has(word) && word.length > 2)
    .slice(0, 5)
    .join(", ");
}

// Socket.IO logic
io.on("connection", (socket) => {
  console.log("⚡ Socket connected:", socket.id);

  socket.on("join-room", ({ code, userType }) => {
  if (!code || code != VALID_CODES) {
    socket.emit("error", "Unauthorized: invalid code");
    return socket.disconnect(true);
  }

  socket.join(code);
  console.log(`🔑 ${userType} joined room ${code}`);

  io.to(code).emit("user-joined", { userType });
});

  socket.on("user-typing", ({ code, currentDraft, isTyping }) => {
    socket.to(code).emit("friend-typing", {
      currentDraft,
      isTyping,
    });
  });

    socket.on("update-spy-prompt", ({ code, spyPrompt }) => {
      spyPromptMap.set(code, spyPrompt || "");

      // Broadcast it if you want (optional)
      io.to(code).emit("update-spy-prompt", { code, prankThoughts: spyPrompt });
    });



  socket.on("send-message", async ({ code, userSays, userThinks }) => {
    if (!code || code !== VALID_CODES) {
      return socket.emit("error", "Unauthorized: invalid code");
    }
    console.log(userThinks);
     
     const currentSpyPrompt = spyPromptMap.get(code) || "";
    // console.log(">> Current Spy Prompt:", currentSpyPrompt);

    // Emit user message immediately
    io.to(code).emit("new-message", {
      from: "user",
      text: userSays,
    });

    try {
      const prompt = `
You're a friendly and clever chatbot. For every input, reply in the strict format below with no extra characters or formatting.

Respond in this format only:
{
  "reply": "<insert your reply here>",
  "context": "<insert the context for your reply here>"
}

Never include any markdown, quotes, or explanations — only raw JSON.
`;

      const userPrompt = `${userSays.trim() ? `user says: "${userSays}"` : ""}${
        userThinks
          ? `${userSays ? ", " : ""}what you should do: "${userThinks}"`
          : ""
      }`;
        console.log(userPrompt);

      const result = await model.generateContent([prompt, userPrompt]);
      const response = await result.response;
      const rawText = response.text().trim();

      const cleaned = rawText
        .replace(/^```json\n?/, "")
        .replace(/```$/, "")
        .trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        console.error("❌ Failed to parse JSON from model:", cleaned);
        return socket.emit("error", "Model returned invalid JSON");
      }

      // Save context
      userContext[code] =
        (userContext[code] || "") + ", " + extractKeywords(userSays);

      // Store both user and AI message in memory
      if (!messageHistory[code]) messageHistory[code] = [];
      messageHistory[code].push({ from: "user", text: userSays });
      messageHistory[code].push({ from: "ai", text: parsed.reply });

      // Emit the AI response
      io.to(code).emit("ai-response", {
        from: "ai",
        userMessage: userSays,
        text: parsed.reply,
        context: parsed.context,
      });
    } catch (err) {
      console.error("💥 Error in send-message handler:", err.message);
      socket.emit("error", "AI generation error");
    }
  });


  socket.on("disconnect", (reason) => {
    console.log(`⚡ Socket disconnected: ${socket.id} (${reason})`);
  });
});

// Health check
app.get("/", (req, res) => {
  res.send("🎉 GuiltMate AI backend running!");
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
{
  
  console.log(`🚀 Server live on http://localhost:${PORT}`);
  
});
