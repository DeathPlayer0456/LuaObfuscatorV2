const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

// ─── Serve frontend ───
app.use(express.static(__dirname + "/public"));

// ─── Helper: Recursively get all files in directory ───
function getAllFiles(dirPath, arrayOfFiles = [], baseDir = dirPath) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    
    // Skip certain directories
    const skipDirs = ["node_modules", ".git", "public", ".vscode", ".github"];
    if (fs.statSync(fullPath).isDirectory()) {
      if (!skipDirs.includes(file)) {
        arrayOfFiles = getAllFiles(fullPath, arrayOfFiles, baseDir);
      }
    } else {
      // Skip hidden files and certain files
      const skipFiles = [".env", ".env.example", "package-lock.json", ".gitignore", ".DS_Store"];
      if (!file.startsWith(".") && !skipFiles.includes(file)) {
        const relativePath = path.relative(baseDir, fullPath);
        const stats = fs.statSync(fullPath);
        arrayOfFiles.push({
          path: relativePath.replace(/\\/g, "/"), // normalize path separators
          size: stats.size
        });
      }
    }
  });

  return arrayOfFiles;
}

// ─── GET all files in the repo (local filesystem) ───
app.get("/api/repo-files", (req, res) => {
  try {
    const repoDir = __dirname; // the root of the repo
    const files = getAllFiles(repoDir);
    
    // Filter out huge files
    const filtered = files.filter(f => f.size < 500000);
    
    res.json({ files: filtered, total: filtered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET single file content (local filesystem) ───
app.get("/api/file-content", (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) {
      return res.status(400).json({ error: "Missing path" });
    }

    const fullPath = path.join(__dirname, filePath);
    
    // Security check: make sure path is within repo
    if (!fullPath.startsWith(__dirname)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    res.json({ content, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
