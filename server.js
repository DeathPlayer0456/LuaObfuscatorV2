const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── Serve frontend ───
app.use(express.static(__dirname + "/public"));

// ─── GET all files in a GitHub repo (recursive tree) ───
// Query: ?owner=PY44N&repo=LuaObfuscatorV2&branch=main
app.get("/api/repo-files", async (req, res) => {
  try {
    const { owner, repo, branch } = req.query;
    if (!owner || !repo) {
      return res.status(400).json({ error: "Missing owner or repo" });
    }

    const branchName = branch || "main";

    // GitHub API: get the full recursive tree
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branchName}?recursive=1`;
    const response = await axios.get(url, {
      headers: { "User-Agent": "LuaPure-App" }
    });

    // Filter only files (not directories), skip huge/binary files
    const files = response.data.tree
      .filter(item => item.type === "file")
      .filter(item => item.size < 500000) // skip files > 500KB
      .map(item => ({
        path: item.path,
        size: item.size,
        sha: item.sha
      }));

    res.json({ files, total: files.length });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ─── GET single file content from GitHub ───
// Query: ?owner=PY44N&repo=LuaObfuscatorV2&path=src/main.rs
app.get("/api/file-content", async (req, res) => {
  try {
    const { owner, repo, path } = req.query;
    if (!owner || !repo || !path) {
      return res.status(400).json({ error: "Missing owner, repo, or path" });
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await axios.get(url, {
      headers: { "User-Agent": "LuaPure-App" }
    });

    // GitHub returns base64 encoded content
    const content = Buffer.from(response.data.content, "base64").toString("utf-8");
    res.json({ content, path });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ─── POST convert code to pure Lua via Groq AI ───
// Body: { filePath: "src/main.rs", code: "fn main() { ... }", originalLang: "Rust" }
app.post("/api/convert", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY is not set in environment variables" });
    }

    const { filePath, code, originalLang } = req.body;
    if (!code) {
      return res.status(400).json({ error: "No code provided" });
    }

    const prompt = `You are a Lua code conversion expert. Convert the following ${originalLang || "code"} into pure Lua 5.1 code.

Rules:
- Output ONLY the converted Lua code. No explanations, no markdown, no comments unless they are necessary.
- The converted code must be valid Lua 5.1 syntax.
- Make it functional and preserve the original logic as much as possible.
- If something cannot be directly translated to Lua, find the closest Lua equivalent.
- Do NOT use any external libraries or modules that are not part of Lua 5.1 standard library.
- If the file is a build config or tool-specific file (like Cargo.toml, package.json), convert its logic/purpose into a Lua script that achieves the same goal where possible.

Original file: ${filePath}
Original language: ${originalLang || "unknown"}

Code to convert:
\`\`\`
${code}
\`\`\`

Converted Lua 5.1 code:`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-70b-8192",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 4096
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    let luaCode = response.data.choices[0].message.content.trim();

    // Strip markdown code fences if Groq wraps it
    luaCode = luaCode.replace(/^```lua\n?/i, "").replace(/^```\n?/i, "").replace(/\n?```$/i, "").trim();

    res.json({ convertedCode: luaCode, filePath });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

// ─── Health check ───
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", groqConfigured: !!GROQ_API_KEY });
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`LuaPure server running on port ${PORT}`);
  if (!GROQ_API_KEY) {
    console.warn("⚠️  GROQ_API_KEY is not set! Conversion endpoint won't work.");
  }
});
