require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
} = process.env;

// -------------------- PERSISTENCE --------------------
const STATE_FILE = path.join(__dirname, "state.json");

function safeReadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        music: { current: null, previous: null },
        podcast: { current: null, previous: null },
      };
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      music: {
        current: parsed.music?.current ?? null,
        previous: parsed.music?.previous ?? null,
      },
      podcast: {
        current: parsed.podcast?.current ?? null,
        previous: parsed.podcast?.previous ?? null,
      },
    };
  } catch {
    return {
      music: { current: null, previous: null },
      podcast: { current: null, previous: null },
    };
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
        Buffer.from(
          `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
        ).toString("base64"),
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
      title: item.name,
      subtitle: item.artists?.map((a) => a.name).join(", ") ?? "",
      image: item.album?.images?.[0]?.url ?? null,
      spotify_url: item.external_urls?.spotify ?? null,
    };
  }

  if (item.type === "episode") {
    return {
      kind: "episode",
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

function setCurrentAndPrevious(section, item, isPlaying, nowIso) {
  let changed = false;

  const currentId = section.current?.item?.id ?? null;
  const newId = item?.id ?? null;

  if (!newId) return { section, changed };

  if (!currentId || currentId !== newId) {
    if (section.current?.item) {
      section.previous = {
        item: section.current.item,
        seen_at: section.current.seen_at,
      };
    }

    section.current = {
      item,
      is_playing: !!isPlaying,
      seen_at: nowIso,
    };

    changed = true;
  } else {
    if (section.current && section.current.is_playing !== !!isPlaying) {
      section.current.is_playing = !!isPlaying;
      changed = true;
    }
  }

  return { section, changed };
}

function forceNotPlaying(section) {
  if (section?.current?.is_playing) {
    section.current.is_playing = false;
    return true;
  }
  return false;
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
      const out = setCurrentAndPrevious(music, item, isPlaying, nowIso);
      music = out.section;
      anyChanged = anyChanged || out.changed;

      // If a track is playing, podcasts are not playing.
      anyChanged = forceNotPlaying(podcast) || anyChanged;
    }

    if (isEpisode(item)) {
      const out = setCurrentAndPrevious(podcast, item, isPlaying, nowIso);
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

// -------------------- API --------------------
function sectionPayload(section, label) {
  const current = section.current ?? null;
  const previous = section.previous ?? null;

  const isPlaying = !!current?.is_playing;

  const playingItem = isPlaying ? current : null;

  const lastPlayedItem = isPlaying
    ? (previous ?? null)
    : (current ?? previous ?? null);

  return {
    label,
    is_playing: isPlaying,
    playing: playingItem
      ? { item: formatItem(playingItem.item), seen_at: playingItem.seen_at }
      : null,
    last_played: lastPlayedItem
      ? { item: formatItem(lastPlayedItem.item), seen_at: lastPlayedItem.seen_at }
      : null,
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
app.get("/", (req, res) => {
  // ---- Dynamic Open Graph (iMessage/Slack/etc.) preview ----
  let previewTitle = "What is Henry listening to?";
  let previewDesc = "Live music and podcasts Henry is into right now.";
  let previewImage = null;

  const liveMusic = music.current?.is_playing ? music.current : null;
  const livePodcast = podcast.current?.is_playing ? podcast.current : null;

  const live = liveMusic || livePodcast;

  // Prefer: if not live, use most recent known item from either section
  const lastKnown =
    music.current ||
    podcast.current ||
    music.previous ||
    podcast.previous ||
    null;

  function buildDesc(entry) {
    if (!entry?.item) return previewDesc;
    const it = entry.item;
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

  function pickImage(entry) {
    const it = entry?.item;
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
      --bg: #0b0b0b;
      --fg: #f4f4f4;
      --muted: rgba(244,244,244,0.72);
      --card: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.13);
      --accent: #1db954;
      --danger: #ff3b30;
      --shadow: 0 10px 30px rgba(0,0,0,0.35);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background:
        radial-gradient(900px 600px at 20% 10%, rgba(29,185,84,0.10), transparent 60%),
        radial-gradient(900px 600px at 90% 20%, rgba(255,59,48,0.10), transparent 55%),
        var(--bg);
    }

    .wrap {
      width: 100%;
      max-width: 1040px;
      margin: 0 auto;
      padding: 18px 14px 26px 14px;
      padding-bottom: calc(26px + env(safe-area-inset-bottom));
    }

    header {
      display: grid;
      gap: 8px;
      margin-bottom: 14px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.1;
      letter-spacing: 0.2px;
    }

    .tagline {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.35;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

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

    @media (min-width: 900px) {
      .card { padding: 18px; }
    }

    .headerRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .title {
      margin: 0;
      font-size: 16px;
      font-weight: 850;
      letter-spacing: 0.2px;
    }

    @media (min-width: 900px) {
      .title { font-size: 18px; }
    }

    .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 999px;
      font-size: 12px;
      opacity: 0.92;
      white-space: nowrap;
      backdrop-filter: blur(6px);
    }

    .live {
      border-color: rgba(255,59,48,0.55);
      box-shadow: 0 0 0 3px rgba(255,59,48,0.10);
    }

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

    .eq {
      display: inline-flex;
      align-items: flex-end;
      gap: 3px;
      height: 14px;
    }
    .eq span {
      width: 3px;
      border-radius: 3px;
      background: var(--accent);
      animation: bounce 0.9s infinite ease-in-out;
      opacity: 0.95;
    }
    .eq span:nth-child(1) { height: 6px; animation-delay: 0s; }
    .eq span:nth-child(2) { height: 12px; animation-delay: 0.12s; }
    .eq span:nth-child(3) { height: 8px; animation-delay: 0.24s; }
    .eq span:nth-child(4) { height: 14px; animation-delay: 0.36s; }
    @keyframes bounce {
      0%, 100% { transform: scaleY(0.5); }
      50% { transform: scaleY(1.15); }
    }

    .special {
      margin: 6px 0 12px 0;
      color: rgba(244,244,244,0.90);
      font-size: 13px;
      line-height: 1.35;
    }
    .special strong { color: #fff; }

    .subhead {
      margin: 12px 0 6px 0;
      font-size: 12px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: var(--muted);
    }

    .mediaRow {
      display: grid;
      grid-template-columns: 74px 1fr;
      gap: 12px;
      align-items: center;
      margin-bottom: 6px;
    }

    @media (min-width: 900px) {
      .mediaRow { grid-template-columns: 88px 1fr; }
    }

    .art {
      width: 74px;
      height: 74px;
      border-radius: 14px;
      object-fit: cover;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.10);
    }

    @media (min-width: 900px) {
      .art { width: 88px; height: 88px; border-radius: 16px; }
    }

    .name {
      margin: 0 0 4px 0;
      font-size: 16px;
      font-weight: 850;
      line-height: 1.2;
    }

    .who {
      margin: 0;
      color: rgba(244,244,244,0.78);
      font-size: 13px;
      line-height: 1.3;
    }

    a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 800;
      display: inline-block;
      padding: 8px 0;
    }

    .empty {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.35;
    }

    .hint {
      margin: 14px 0 0 0;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>What is Henry listening to?</h1>
      <p class="tagline" id="hero">Checking in on Henry’s current vibe…</p>
    </header>

    <div class="grid">
      <div class="card" id="music">Loading…</div>
      <div class="card" id="podcast">Loading…</div>
    </div>

    <p class="hint">Auto-refreshes every 10 seconds.</p>
  </div>
    <footer style="margin-top:24px;text-align:center;color:rgba(244,244,244,0.6);font-size:13px;">
      Made with ♥ by Henry
    </footer>


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

    function renderMini(block, label) {
      if (!block || !block.item) return "";
      const i = block.item;
      const art = i.image ? \`<img class="art" src="\${i.image}" alt="" />\` : \`<div class="art"></div>\`;
      return \`
        <div class="subhead">\${label}</div>
        <div class="mediaRow">
          \${art}
          <div>
            <p class="name">\${i.title}</p>
            \${i.subtitle ? \`<p class="who">\${i.subtitle}</p>\` : ""}
            \${i.spotify_url ? \`<a href="\${i.spotify_url}" target="_blank" rel="noopener">Open in Spotify</a>\` : ""}
          </div>
        </div>
      \`;
    }

    function renderSection(containerId, section) {
      const el = document.getElementById(containerId);

      const hasPlaying = section.playing && section.playing.item;
      const hasLast = section.last_played && section.last_played.item;

      if (!hasPlaying && !hasLast) {
        el.innerHTML = \`
          <div class="headerRow">
            <p class="title">\${section.label}</p>
            <div class="badges"><span class="pill">Nothing yet</span></div>
          </div>
          <p class="empty">Henry hasn’t played anything here yet.</p>
        \`;
        return;
      }

      const isPlaying = !!section.is_playing;

      el.innerHTML = \`
        <div class="headerRow">
          <p class="title">\${section.label}</p>
          <div class="badges">\${badges(isPlaying)}</div>
        </div>
        \${isPlaying && hasPlaying ? "<p class='special'><strong>You caught Henry live.</strong> He’s listening right now.</p>" : ""}
        \${isPlaying && hasPlaying ? renderMini(section.playing, "Playing now") : ""}
        \${hasLast ? renderMini(section.last_played, "Most recent") : ""}
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

// Simple HTML escaper for OG meta tags
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on http://127.0.0.1:${PORT}`);
  console.log("State file:", STATE_FILE);
});
