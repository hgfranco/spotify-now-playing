require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
// Serve static assets from the project directory (logo, favicons)
app.use(express.static(__dirname));


const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
} = process.env;

// -------------------- PERSISTENCE --------------------
const PERSISTENT_DIR = "/var/data";
const DATA_DIR = fs.existsSync(PERSISTENT_DIR) ? PERSISTENT_DIR : __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");

console.log("Using DATA_DIR:", DATA_DIR);

/**
 * State shape (v2):
 * {
 *   music:   { current: {item,is_playing,seen_at}|null, history: [{item,seen_at}, ...] },
 *   podcast: { current: {item,is_playing,seen_at}|null, history: [{item,seen_at}, ...] }
 * }
 */
function defaultState() {
  return {
    music: { current: null, history: [] },
    podcast: { current: null, history: [] },
  };
}

function migrateState(parsed) {
  // If already v2, keep it
  if (parsed?.music?.history && parsed?.podcast?.history) {
    return {
      music: {
        current: parsed.music.current ?? null,
        history: Array.isArray(parsed.music.history) ? parsed.music.history : [],
      },
      podcast: {
        current: parsed.podcast.current ?? null,
        history: Array.isArray(parsed.podcast.history) ? parsed.podcast.history : [],
      },
    };
  }

  // v1 compatibility: {music:{current,previous}, podcast:{current,previous}}
  const state = defaultState();

  const mCur = parsed?.music?.current ?? null;
  const mPrev = parsed?.music?.previous ?? null;
  if (mCur?.item) state.music.history.push({ item: mCur.item, seen_at: mCur.seen_at });
  if (mPrev?.item) state.music.history.push({ item: mPrev.item, seen_at: mPrev.seen_at });
  state.music.current = mCur?.item ? mCur : null;

  const pCur = parsed?.podcast?.current ?? null;
  const pPrev = parsed?.podcast?.previous ?? null;
  if (pCur?.item) state.podcast.history.push({ item: pCur.item, seen_at: pCur.seen_at });
  if (pPrev?.item) state.podcast.history.push({ item: pPrev.item, seen_at: pPrev.seen_at });
  state.podcast.current = pCur?.item ? pCur : null;

  return state;
}

function safeReadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return migrateState(parsed);
  } catch {
    return defaultState();
  }
}

function safeWriteState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // never crash on write
  }
}

// Load state on startup
const loaded = safeReadState();
let music = loaded.music;
let podcast = loaded.podcast;

// -------------------- TOKEN --------------------
async function getAccessToken() {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString(
          "base64"
        ),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.access_token;
}

// -------------------- FORMAT --------------------
function formatItem(item) {
  if (!item) return null;

  if (item.type === "track") {
    return {
      kind: "track",
      id: item.id,
      title: item.name,
      subtitle: item.artists?.map((a) => a.name).join(", ") ?? "",
      image: item.album?.images?.[0]?.url ?? null,
      spotify_url: item.external_urls?.spotify ?? null,
    };
  }

  if (item.type === "episode") {
    return {
      kind: "episode",
      id: item.id,
      title: item.name,
      subtitle: item.show?.name ?? "",
      image: item.images?.[0]?.url ?? null,
      spotify_url: item.external_urls?.spotify ?? null,
    };
  }

  return null;
}

function isTrack(item) {
  return item && item.type === "track";
}

function isEpisode(item) {
  return item && item.type === "episode";
}

function forceNotPlaying(section) {
  if (section?.current?.is_playing) {
    section.current.is_playing = false;
    return true;
  }
  return false;
}

function pushHistory(section, item, nowIso) {
  if (!item?.id) return false;

  const existingIdx = section.history.findIndex((h) => h?.item?.id === item.id);
  if (existingIdx === 0) return false; // already most recent

  // If exists later, remove it so we can re-add to front
  if (existingIdx > -1) section.history.splice(existingIdx, 1);

  section.history.unshift({ item, seen_at: nowIso });

  // Keep a little extra so you can expand later; UI will show last 2
  section.history = section.history.slice(0, 10);
  return true;
}

function updateCurrent(section, item, isPlaying, nowIso) {
  let changed = false;

  const currentId = section.current?.item?.id ?? null;
  const newId = item?.id ?? null;

  if (!newId) return { section, changed };

  // Track "most recent" even for short listens (as soon as Spotify reports it)
  changed = pushHistory(section, item, nowIso) || changed;

  // Keep current pointer aligned with the latest item we saw
  if (!currentId || currentId !== newId) {
    section.current = { item, is_playing: !!isPlaying, seen_at: nowIso };
    changed = true;
  } else {
    if (section.current.is_playing !== !!isPlaying) {
      section.current.is_playing = !!isPlaying;
      changed = true;
    }
  }

  return { section, changed };
}


// -------------------- BACKFILL (music only) --------------------
// Spotify provides a "Recently Played Tracks" endpoint, but there is no official
// "recently played episodes" endpoint. So we can backfill MUSIC on cold start.
// Podcasts/episodes will fill in as you listen going forward.
async function backfillMusicHistoryIfNeeded() {
  try {
    const have = Array.isArray(music.history) ? music.history.length : 0;
    if (have >= 2) return;

    const accessToken = await getAccessToken();

    // This returns tracks even if you only listened for a few seconds.
    const res = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=50", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = await res.json();
    if (!res.ok || !Array.isArray(data.items)) return;

    let anyChanged = false;

    for (const row of data.items) {
      const t = row && row.track;
      if (!t || t.type !== "track") continue;

      const seenAt = row.played_at || new Date().toISOString();
      anyChanged = pushHistory(music, t, seenAt) || anyChanged;

      if (music.history.length >= 10) break;
    }

    if (anyChanged) safeWriteState({ music, podcast });
  } catch {
    // ignore
  }
}

// -------------------- POLLER --------------------
async function pollAndRemember() {
  try {
    const accessToken = await getAccessToken();

    // Include episodes (podcasts) as well as tracks
    const res = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing?additional_types=episode",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Nothing currently playing: make sure we stop showing LIVE
    if (res.status === 204) {
      let anyChanged = false;
      anyChanged = forceNotPlaying(music) || anyChanged;
      anyChanged = forceNotPlaying(podcast) || anyChanged;
      if (anyChanged) safeWriteState({ music, podcast });
      return;
    }

    const data = await res.json();
    if (!res.ok || !data.item) return;

    const item = data.item;
    const isPlaying = !!data.is_playing;
    const nowIso = new Date().toISOString();

    let anyChanged = false;

    if (isTrack(item)) {
      const out = updateCurrent(music, item, isPlaying, nowIso);
      music = out.section;
      anyChanged = anyChanged || out.changed;

      // If a track is playing, podcasts are not playing.
      anyChanged = forceNotPlaying(podcast) || anyChanged;
    }

    if (isEpisode(item)) {
      const out = updateCurrent(podcast, item, isPlaying, nowIso);
      podcast = out.section;
      anyChanged = anyChanged || out.changed;

      // If a podcast is playing, music is not playing.
      anyChanged = forceNotPlaying(music) || anyChanged;
    }

    if (anyChanged) {
      safeWriteState({ music, podcast });
    }
  } catch {
    // never crash on polling
  }
}

setInterval(pollAndRemember, 5000);
pollAndRemember();
backfillMusicHistoryIfNeeded();

// -------------------- API --------------------
function lastTwo(section) {
  // Always return 2 items for the "Recent" list.
  // If something is currently playing, exclude that item from "recent" so we don't duplicate it.
  const liveId = section.current?.is_playing ? section.current?.item?.id : null;
  const filtered = section.history.filter((h) => h?.item?.id && h.item.id !== liveId);
  return filtered.slice(0, 2);
}

function sectionPayload(section, label) {
  const isPlaying = !!section.current?.is_playing;

  const playing =
    isPlaying && section.current?.item
      ? { item: formatItem(section.current.item), seen_at: section.current.seen_at }
      : null;

  const recent = lastTwo(section).map((h) => ({
    item: formatItem(h.item),
    seen_at: h.seen_at,
  }));

  // If we have less than 2 in history (fresh install), pad with nulls so UI stays consistent.
  while (recent.length < 2) recent.push(null);

  return {
    label,
    is_playing: isPlaying,
    playing,
    recent, // always length 2 (items or null)
  };
}

app.get("/api/status", (req, res) => {
  return res.json({
    ok: true,
    music: sectionPayload(music, "Henry’s music"),
    podcast: sectionPayload(podcast, "Henry’s podcasts"),
  });
});

// -------------------- PAGE --------------------

// Simple HTML escaper for OG meta tags
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.get("/", (req, res) => {
  // ---- Dynamic Open Graph (iMessage/Slack/etc.) preview ----
  let previewTitle = "What is Henry listening to?";
  let previewDesc = "Live music and podcasts Henry is into right now.";
  let previewImage = null;

  const liveMusic = music.current?.is_playing ? music.current : null;
  const livePodcast = podcast.current?.is_playing ? podcast.current : null;

  const live = liveMusic || livePodcast;
  const lastKnown = music.history?.[0] || podcast.history?.[0] || null;

  function buildDesc(entryOrHistory) {
    const it = entryOrHistory?.item;
    if (!it) return previewDesc;
    if (it.type === "track") {
      const artists = it.artists?.map((a) => a.name).join(", ") ?? "";
      return artists ? `${it.name} — ${artists}` : it.name;
    }
    if (it.type === "episode") {
      const show = it.show?.name ?? "";
      return show ? `${it.name} — ${show}` : it.name;
    }
    return previewDesc;
  }

  function pickImage(entryOrHistory) {
    const it = entryOrHistory?.item;
    return it?.album?.images?.[0]?.url || it?.images?.[0]?.url || null;
  }

  if (live) {
    previewTitle = "🎧 Henry is listening right now";
    previewDesc = buildDesc(live);
    previewImage = pickImage(live);
  } else if (lastKnown) {
    previewTitle = "🎵 Henry’s most recent listen";
    previewDesc = buildDesc(lastKnown);
    previewImage = pickImage(lastKnown);
  }

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${previewTitle}</title>

  <!-- Open Graph / iMessage -->
  <meta property="og:title" content="${escapeHtml(previewTitle)}" />
  <meta property="og:description" content="${escapeHtml(previewDesc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://whatishenrylisteningto.com" />
  ${previewImage ? `<meta property="og:image" content="${escapeHtml(previewImage)}" />` : ""}

  <!-- iMessage often prefers large preview images -->
  <meta name="twitter:card" content="summary_large_image" />

  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <style>
    :root {
      --bg: #F7F5F2;
      --fg: #2B2B2B;
      --muted: rgba(43,43,43,0.68);
      --card: rgba(255,255,255,0.92);
      --border: rgba(43,43,43,0.12);
      --accent: #1db954;
      --danger: #C64545;
      --shadow: 0 10px 30px rgba(0,0,0,0.10);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background:
        radial-gradient(1200px 800px at 15% 10%, rgba(198,69,69,0.06), transparent 60%),
        radial-gradient(1200px 800px at 85% 20%, rgba(29,185,84,0.06), transparent 55%),
        var(--bg);
    }

    .wrap {
      width: 100%;
      max-width: 980px;
      margin: 0 auto;
      padding: 18px 14px 26px 14px;
      padding-bottom: calc(26px + env(safe-area-inset-bottom));
    }

    header { display: grid; gap: 8px; margin-bottom: 14px; }

    h1 { margin: 0; font-size: 26px; line-height: 1.1; letter-spacing: 0.2px; }

    .tagline { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.35; }

    .grid { display: grid; grid-template-columns: 1fr; gap: 14px; }

    @media (min-width: 900px) {
      .wrap { padding: 26px 18px 30px 18px; }
      h1 { font-size: 30px; }
      .tagline { font-size: 15px; }
      .grid { grid-template-columns: 1fr 1fr; gap: 18px; }
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      box-shadow: var(--shadow);
      overflow: hidden;
      position: relative;
    }

    @media (min-width: 900px) { .card { padding: 18px; } }

    .headerRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .title { margin: 0; font-size: 16px; font-weight: 850; letter-spacing: 0.2px; }
    @media (min-width: 900px) { .title { font-size: 18px; } }

    .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid rgba(43,43,43,0.14);
      border-radius: 999px;
      font-size: 12px;
      opacity: 0.92;
      white-space: nowrap;
      backdrop-filter: blur(6px);
    }

    .live { border-color: rgba(255,59,48,0.55); box-shadow: 0 0 0 3px rgba(255,59,48,0.10); }

    .dot {
      width: 8px; height: 8px; border-radius: 999px;
      background: var(--danger);
      box-shadow: 0 0 0 0 rgba(255,59,48,0.55);
      animation: pulse 1.2s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(255,59,48,0.55); }
      70% { box-shadow: 0 0 0 10px rgba(255,59,48,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,59,48,0); }
    }

    .eq { display: inline-flex; align-items: flex-end; gap: 3px; height: 14px; }
    .eq span {
      width: 3px; border-radius: 3px; background: var(--accent);
      animation: bounce 0.9s infinite ease-in-out; opacity: 0.95;
    }
    .eq span:nth-child(1) { height: 6px; animation-delay: 0s; }
    .eq span:nth-child(2) { height: 12px; animation-delay: 0.12s; }
    .eq span:nth-child(3) { height: 8px; animation-delay: 0.24s; }
    .eq span:nth-child(4) { height: 14px; animation-delay: 0.36s; }
    @keyframes bounce { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.15); } }

    .special { margin: 6px 0 12px 0; color: rgba(43,43,43,0.90); font-size: 13px; line-height: 1.35; }
    .special strong { color: #fff; }

    .subhead { margin: 12px 0 6px 0; font-size: 12px; letter-spacing: 0.3px; text-transform: uppercase; color: var(--muted); }

    .mediaRow { display: grid; grid-template-columns: 74px 1fr; gap: 12px; align-items: center; margin-bottom: 6px; }
    @media (min-width: 900px) { .mediaRow { grid-template-columns: 88px 1fr; } }

    .art {
      width: 74px; height: 74px; border-radius: 14px; object-fit: cover;
      background: rgba(0,0,0,0.04);
      border: 1px solid rgba(43,43,43,0.10);
    }
    @media (min-width: 900px) { .art { width: 88px; height: 88px; border-radius: 16px; } }

    .name { margin: 0 0 4px 0; font-size: 16px; font-weight: 850; line-height: 1.2; }
    .who { margin: 0; color: rgba(43,43,43,0.72); font-size: 13px; line-height: 1.3; }

    a { color: var(--accent); text-decoration: none; font-weight: 800; display: inline-block; padding: 8px 0; }

    .empty { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.35; }

    .hint { margin: 14px 0 0 0; color: var(--muted); font-size: 13px; }
  
.site-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.logo {
  max-width: 520px;
  width: 100%;
  height: auto;
}

@media (max-width: 600px) {
  .logo {
    max-width: 92%;
  }
}


.journal-rule {
  width: 100%;
  max-width: 900px;
  height: 1px;
  background: linear-gradient(to right, transparent, rgba(43, 43, 43, 0.22), transparent);
  margin: 10px 0 6px 0;
}


.meta{
  margin-top:6px;
  font-size:13px;
  color: rgba(43,43,43,0.58);
}
</style>
</head>
<body>
  <div class="wrap">
    <header class="site-header">
      <img src="/logo.png" alt="What is Henry listening to?" class="logo" />
      <div class="journal-rule"></div>
      <p class="tagline" id="hero">Checking in on Henry’s current vibe…</p>
    </header>

    <div class="grid">
      <div class="card" id="music">Loading…</div>
      <div class="card" id="podcast">Loading…</div>
    </div>

    <p class="hint">Auto-refreshes every 10 seconds.</p>

    <footer style="margin-top:24px;text-align:center;color:rgba(43,43,43,0.55);font-size:13px;">
      Made with ♥ by Henry Franco
    </footer>
  </div>

  <script>
    function badges(isPlaying) {
      if (isPlaying) {
        return \`
          <span class="pill live"><span class="dot"></span>LIVE <span class="eq"><span></span><span></span><span></span><span></span></span></span>
          <span class="pill">Playing</span>
        \`;
      }
      return \`<span class="pill">Not playing</span>\`;
    }

    
    function timeAgo(iso) {
      if (!iso) return "";
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return "";
      const diff = Date.now() - t;
      const sec = Math.max(0, Math.floor(diff / 1000));
      if (sec < 10) return "just now";
      if (sec < 60) return String(sec) + "s ago";
      const min = Math.floor(sec / 60);
      if (min < 60) return String(min) + "m ago";
      const hr = Math.floor(min / 60);
      if (hr < 24) return String(hr) + "h ago";
      const day = Math.floor(hr / 24);
      return String(day) + "d ago";
    }

function renderMini(block, label) {
      if (!block || !block.item) return "";
      const i = block.item;
      const art = i.image ? \`<img class="art" src=\"\${i.image}\" alt=\"\" />\` : \`<div class="art"></div>\`;
      const when = block.seen_at
        ? '<p class="meta">' + (label === 'Playing now' ? 'Updated ' : 'Played ') + timeAgo(block.seen_at) + '</p>'
        : '';
      return \`
        <div class="subhead">\${label}</div>
        <div class="mediaRow">
          \${art}
          <div>
            <p class="name">\${i.title}</p>
            \${i.subtitle ? \`<p class="who">\${i.subtitle}</p>\` : ""}
            \${i.spotify_url ? \`<a href=\"\${i.spotify_url}\" target=\"_blank\" rel=\"noopener\">Open in Spotify</a>\` : ""}
            \${when}
          </div>
        </div>
      \`;
    }


    function renderRecentList(recent) {
      // recent is always length 2, items can be null
      return recent.map((entry, idx) => {
        if (!entry || !entry.item) {
          return \`
            <div class="subhead">\${idx === 0 ? "Most recent" : "Second most recent"}</div>
            <p class="empty">—</p>
          \`;
        }
        const label = idx === 0 ? "Most recent" : "Second most recent";
        return renderMini(entry, label);
      }).join("");
    }

    function renderSection(containerId, section) {
      const el = document.getElementById(containerId);

      const hasPlaying = section.playing && section.playing.item;

      el.innerHTML = \`
        <div class="headerRow">
          <p class="title">\${section.label}</p>
          <div class="badges">\${badges(!!section.is_playing)}</div>
        </div>
        \${section.is_playing && hasPlaying ? "<p class='special'><strong>You caught Henry live.</strong> He’s listening right now.</p>" : ""}
        \${section.is_playing && hasPlaying ? renderMini(section.playing, "Playing now") : ""}
        \${renderRecentList(section.recent || [])}
      \`;
    }

    async function load() {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (!data.ok) return;

      renderSection("music", data.music);
      renderSection("podcast", data.podcast);

      const hero = document.getElementById("hero");
      const isLive = data.music.is_playing || data.podcast.is_playing;

      if (isLive) {
        hero.textContent = "You caught Henry mid-listen — live right now.";
        document.title = "▶ Henry is listening…";
      } else {
        hero.textContent = "Henry’s not listening at the moment. Here’s his most recent vibe.";
        document.title = "What is Henry listening to?";
      }
    }

    load();
    setInterval(load, 10000);
  </script>
</body>
</html>
`);
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on http://127.0.0.1:${PORT}`);
  console.log("State file:", STATE_FILE);

// Explicit fallbacks (useful if middleware order ever changes)
app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "logo.png")));
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "favicon.png")));
app.get("/favicon-live.png", (req, res) => res.sendFile(path.join(__dirname, "favicon-live.png")));

});
