// server.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * === PERSISTENT STORAGE CONFIG ===
 * Render persistent disks are mounted at /var/data
 * We intentionally hardcode this as the primary location
 * and fall back to the local directory for local dev.
 */
const PERSISTENT_DIR = "/var/data";
const DATA_DIR = fs.existsSync(PERSISTENT_DIR) ? PERSISTENT_DIR : __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");

console.log("Using DATA_DIR:", DATA_DIR);
console.log("State file:", STATE_FILE);

// Ensure state file exists
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ music: {}, podcast: {} }, null, 2)
  );
}

// ---- existing logic below remains unchanged ----
// (Spotify polling, routes, UI rendering, etc.)
// ------------------------------------------------

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>What is Henry listening to?</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
</head>
<body>
  <h1>What is Henry listening to?</h1>
  <p>Checking in on Henry’s current vibe…</p>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Running on http://127.0.0.1:${PORT}`);
});
