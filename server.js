require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// -------------------- MUSIC ORIGIN METRICS (MusicBrainz) --------------------
const artistOriginCache = new Map();
const aggregateCache = new Map();

function normalizeArtistName(name) {
  return String(name || "").trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, headers = {}) {
  const resp = await fetch(url, { headers });
  const txt = await resp.text();
  try {
    return { ok: resp.ok, status: resp.status, json: JSON.parse(txt) };
  } catch {
    return { ok: resp.ok, status: resp.status, json: null };
  }
}

async function lookupArtistCountryMusicBrainz(artistName) {
  const key = normalizeArtistName(artistName);
  if (!key) return null;

  const cached = artistOriginCache.get(key);
  const TTL = 30 * 24 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.ts < TTL) return cached.countryName;

  const q = encodeURIComponent(`artist:"${artistName}"`);
  const url = `https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=1`;
  const { ok, json } = await fetchJson(url, {
    "User-Agent": "whatishenrylisteningto/1.0 (contact: none)",
    Accept: "application/json",
  });

  if (!ok || !json || !Array.isArray(json.artists) || json.artists.length === 0) {
    artistOriginCache.set(key, { countryName: null, ts: Date.now() });
    return null;
  }

  const a = json.artists[0];
  let countryName = null;
  if (a.country && /^[A-Z]{2}$/.test(a.country)) {
    try {
      const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
      countryName = regionNames.of(a.country) || a.country;
    } catch {
      countryName = a.country;
    }
  } else if (a.area && a.area.name) {
    countryName = a.area.name;
  }

  artistOriginCache.set(key, { countryName, ts: Date.now() });
  return countryName;
}

// Serve static assets from the project directory (logo, favicons)
app.use(express.static(__dirname));

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
const ENV_SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN || "";
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI ||
  "https://whatishenrylisteningto.com/spotify/callback";
const SPOTIFY_AUTH_KEY = process.env.SPOTIFY_AUTH_KEY || "";

const { CF_API_TOKEN, CF_ZONE_TAG } = process.env;

// -------------------- PERSISTENCE --------------------
const PERSISTENT_DIR = "/var/data";
const DATA_DIR = fs.existsSync(PERSISTENT_DIR) ? PERSISTENT_DIR : __dirname;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SPOTIFY_TOKEN_FILE = path.join(DATA_DIR, "spotify-refresh-token.txt");
console.log("Using DATA_DIR:", DATA_DIR);

function defaultState() {
  return {
    music: { current: null, history: [] },
    podcast: { current: null, history: [] },
  };
}

function migrateState(parsed) {
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
    return migrateState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
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

function readSpotifyRefreshToken() {
  try {
    if (fs.existsSync(SPOTIFY_TOKEN_FILE)) {
      const token = fs.readFileSync(SPOTIFY_TOKEN_FILE, "utf8").trim();
      if (token) return token;
    }
  } catch (e) {
    console.error("Could not read Spotify token file:", e.message);
  }
  return ENV_SPOTIFY_REFRESH_TOKEN.trim();
}

function saveSpotifyRefreshToken(token) {
  const clean = String(token || "").trim();
  if (!clean) throw new Error("Spotify returned an empty refresh token");
  fs.writeFileSync(SPOTIFY_TOKEN_FILE, clean, { encoding: "utf8", mode: 0o600 });
  console.log("Spotify refresh token saved to persistent storage.");
}

// Seed persistent storage from the Render environment variable the first time.
try {
  if (!fs.existsSync(SPOTIFY_TOKEN_FILE) && ENV_SPOTIFY_REFRESH_TOKEN) {
    saveSpotifyRefreshToken(ENV_SPOTIFY_REFRESH_TOKEN);
  }
} catch (e) {
  console.error("Could not seed Spotify token file:", e.message);
}

const loaded = safeReadState();
let music = loaded.music;
let podcast = loaded.podcast;
let spotifyAuthError = null;

// -------------------- TOKEN --------------------
async function getAccessToken() {
  const refreshToken = readSpotifyRefreshToken();
  if (!refreshToken) throw new Error("Missing Spotify refresh token");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    spotifyAuthError = data;
    throw new Error(JSON.stringify(data));
  }

  spotifyAuthError = null;

  // Spotify may rotate refresh tokens. If it does, keep the new one automatically.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    saveSpotifyRefreshToken(data.refresh_token);
  }

  return data.access_token;
}

// -------------------- SPOTIFY REAUTHORIZATION --------------------
// One-time setup in Render:
//   SPOTIFY_AUTH_KEY=<a private value you choose>
// In Spotify Developer Dashboard add this Redirect URI:
//   https://whatishenrylisteningto.com/spotify/callback
// Future reauth becomes one browser visit:
//   https://whatishenrylisteningto.com/spotify/login?key=<SPOTIFY_AUTH_KEY>
const spotifyAuthStates = new Map();

function pruneSpotifyAuthStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, createdAt] of spotifyAuthStates) {
    if (createdAt < cutoff) spotifyAuthStates.delete(state);
  }
}

app.get("/spotify/login", (req, res) => {
  if (!SPOTIFY_AUTH_KEY) {
    return res
      .status(503)
      .send("Spotify reauthorization is not configured. Set SPOTIFY_AUTH_KEY in Render.");
  }

  if (req.query.key !== SPOTIFY_AUTH_KEY) {
    return res.status(403).send("Not authorized.");
  }

  pruneSpotifyAuthStates();
  const state = crypto.randomBytes(24).toString("hex");
  spotifyAuthStates.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope:
      "user-read-currently-playing user-read-playback-state user-read-recently-played",
    state,
  });

  return res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${String(error)}`);
  }

  pruneSpotifyAuthStates();
  if (!state || !spotifyAuthStates.has(state)) {
    return res.status(400).send("Spotify authorization session expired. Start again from /spotify/login.");
  }
  spotifyAuthStates.delete(state);

  if (!code) return res.status(400).send("Spotify did not return an authorization code.");

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      console.error("Spotify callback token exchange failed:", data);
      return res.status(502).send("Spotify authorization succeeded, but the token exchange failed.");
    }

    saveSpotifyRefreshToken(data.refresh_token);
    spotifyAuthError = null;

    // Update immediately instead of waiting for the next poll.
    setTimeout(() => pollAndRemember().catch(() => {}), 0);

    return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify Connected</title></head>
<body style="font-family:system-ui;padding:40px;max-width:680px;margin:auto;line-height:1.5">
<h1>Spotify is connected again.</h1>
<p>The new refresh token was saved automatically. You can close this page.</p>
<p><a href="/">Return to What is Henry listening to?</a></p>
</body></html>`);
  } catch (e) {
    console.error("Spotify callback error:", e);
    return res.status(500).send("Could not save the new Spotify authorization.");
  }
});

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
  if (existingIdx === 0) return false;
  if (existingIdx > -1) section.history.splice(existingIdx, 1);
  section.history.unshift({ item, seen_at: nowIso });
  section.history = section.history.slice(0, 10);
  return true;
}

function updateCurrent(section, item, isPlaying, nowIso) {
  let changed = false;
  const currentId = section.current?.item?.id ?? null;
  const newId = item?.id ?? null;
  if (!newId) return { section, changed };

  changed = pushHistory(section, item, nowIso) || changed;
  if (!currentId || currentId !== newId) {
    section.current = { item, is_playing: !!isPlaying, seen_at: nowIso };
    changed = true;
  } else if (section.current.is_playing !== !!isPlaying) {
    section.current.is_playing = !!isPlaying;
    changed = true;
  }
  return { section, changed };
}

// -------------------- BACKFILL (music only) --------------------
async function backfillMusicHistoryIfNeeded() {
  try {
    const have = Array.isArray(music.history) ? music.history.length : 0;
    if (have >= 2) return;
    const accessToken = await getAccessToken();
    const res = await fetch(
      "https://api.spotify.com/v1/me/player/recently-played?limit=50",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
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
    const res = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing?additional_types=episode",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

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
      anyChanged = forceNotPlaying(podcast) || anyChanged;
    }

    if (isEpisode(item)) {
      const out = updateCurrent(podcast, item, isPlaying, nowIso);
      podcast = out.section;
      anyChanged = anyChanged || out.changed;
      anyChanged = forceNotPlaying(music) || anyChanged;
    }

    if (anyChanged) safeWriteState({ music, podcast });
  } catch (e) {
    // Don't crash the app, but log auth failures so they are visible in Render.
    if (spotifyAuthError) {
      console.error("Spotify polling auth error:", JSON.stringify(spotifyAuthError));
    }
  }
}

setInterval(pollAndRemember, 5000);
pollAndRemember();
backfillMusicHistoryIfNeeded();

// -------------------- API --------------------
function lastTwo(section) {
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
  while (recent.length < 2) recent.push(null);
  return { label, is_playing: isPlaying, playing, recent };
}

app.get("/api/status", (req, res) => {
  return res.json({
    ok: true,
    music: sectionPayload(music, "Henry’s music"),
    podcast: sectionPayload(podcast, "Henry’s podcasts"),
  });
});

// -------------------- CLOUDFLARE METRICS (Country map) --------------------
app.get("/api/metrics/countries", async (req, res) => {
  try {
    if (!CF_API_TOKEN || !CF_ZONE_TAG) {
      return res.status(500).json({ ok: false, error: "Missing CF_API_TOKEN or CF_ZONE_TAG" });
    }

    const hours = Math.max(1, Math.min(24, Number(req.query.hours || 24)));
    const end = new Date();
    const start = new Date(Date.now() - hours * 60 * 60 * 1000);
    const query = `
      query($zoneTag: String!, $start: Time!, $end: Time!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequestsAdaptiveGroups(
              limit: 200,
              orderBy: [count_DESC],
              filter: { datetime_geq: $start, datetime_lt: $end }
            ) {
              count
              dimensions { clientCountryName }
            }
          }
        }
      }
    `;

    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          zoneTag: CF_ZONE_TAG,
          start: start.toISOString(),
          end: end.toISOString(),
        },
      }),
    });

    const json = await resp.json();
    if (!resp.ok || json.errors) {
      console.error("Analytics upstream error", json.errors || json);
      return res.status(502).json({ ok: false, error: "Analytics temporarily unavailable" });
    }

    const groups = json?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
    const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    const data = groups
      .filter((g) => g?.dimensions?.clientCountryName)
      .map((g) => {
        const raw = String(g.dimensions.clientCountryName).trim().toUpperCase();
        const isCode = /^[A-Z]{2}$/.test(raw);
        const name = isCode ? regionNames.of(raw) || raw : raw;
        return { countryCode: isCode ? raw : null, country: name, requests: g.count };
      });

    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      ok: true,
      hours,
      start: start.toISOString(),
      end: end.toISOString(),
      data,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
});

async function getRecentSpotifyItems(days) {
  const accessToken = await getAccessToken();
  const afterMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const MAX_ITEMS = 500;
  const items = [];
  let before = Date.now();

  while (items.length < MAX_ITEMS) {
    const url = `https://api.spotify.com/v1/me/player/recently-played?limit=50&before=${before}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const t = await r.text();
      const err = new Error(t);
      err.status = r.status;
      throw err;
    }

    const j = await r.json();
    const batch = Array.isArray(j.items) ? j.items : [];
    if (batch.length === 0) break;

    for (const it of batch) {
      const playedAt = new Date(it.played_at).getTime();
      if (!Number.isFinite(playedAt) || playedAt < afterMs) continue;
      items.push(it);
      if (items.length >= MAX_ITEMS) break;
    }

    const last = batch[batch.length - 1];
    const lastPlayedAt = last?.played_at ? new Date(last.played_at).getTime() : null;
    if (!lastPlayedAt || lastPlayedAt <= afterMs) break;
    before = lastPlayedAt - 1;
  }

  return items;
}

// -------------------- MUSIC METRICS: Unique artists by origin --------------------
app.get("/api/metrics/artist-origins", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days || 30)));
    const cacheKey = `artist-origins:${days}`;
    const cached = aggregateCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json(cached.payload);
    }

    const items = await getRecentSpotifyItems(days);
    const uniqueArtists = new Set();
    for (const it of items) {
      const artists = Array.isArray(it?.track?.artists) ? it.track.artists : [];
      for (const a of artists) if (a?.name) uniqueArtists.add(a.name);
    }

    const countryToArtists = new Map();
    let i = 0;
    for (const name of uniqueArtists) {
      if (i > 0) await sleep(1000);
      i++;
      const country = (await lookupArtistCountryMusicBrainz(name)) || "Unknown";
      if (!countryToArtists.has(country)) countryToArtists.set(country, new Set());
      countryToArtists.get(country).add(name);
    }

    const data = Array.from(countryToArtists.entries())
      .map(([country, set]) => ({ country, uniqueArtists: set.size }))
      .sort((a, b) => b.uniqueArtists - a.uniqueArtists);

    const payload = {
      ok: true,
      days,
      uniqueArtistsTotal: uniqueArtists.size,
      playsScanned: items.length,
      data,
    };
    aggregateCache.set(cacheKey, { payload, ts: Date.now() });
    res.set("Cache-Control", "public, max-age=300");
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
});

// -------------------- MUSIC METRICS: Artist origins detail --------------------
app.get("/api/metrics/artist-origins-detail", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days || 30)));
    const cacheKey = `artist-origins-detail:${days}`;
    const cached = aggregateCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json(cached.payload);
    }

    const items = await getRecentSpotifyItems(days);
    const artistCounts = new Map();
    for (const it of items) {
      const artists = Array.isArray(it?.track?.artists) ? it.track.artists : [];
      for (const a of artists) {
        if (!a?.name) continue;
        const url = a.external_urls?.spotify || null;
        const cur = artistCounts.get(a.name) || { count: 0, url };
        cur.count += 1;
        if (!cur.url && url) cur.url = url;
        artistCounts.set(a.name, cur);
      }
    }

    const uniqueArtists = Array.from(artistCounts.keys());
    const countryToArtists = new Map();
    let i = 0;
    for (const name of uniqueArtists) {
      if (i > 0) await sleep(1000);
      i++;
      const country = (await lookupArtistCountryMusicBrainz(name)) || "Unknown";
      if (!countryToArtists.has(country)) countryToArtists.set(country, []);
      const meta = artistCounts.get(name) || { count: 0, url: null };
      countryToArtists.get(country).push({ name, url: meta.url, count: meta.count });
    }

    const data = Array.from(countryToArtists.entries())
      .map(([country, artists]) => {
        artists.sort((a, b) => b.count - a.count);
        return {
          country,
          uniqueArtists: artists.length,
          plays: artists.reduce((sum, a) => sum + a.count, 0),
          artists,
        };
      })
      .sort((a, b) => b.uniqueArtists - a.uniqueArtists);

    const payload = {
      ok: true,
      days,
      uniqueArtistsTotal: uniqueArtists.length,
      playsScanned: items.length,
      data,
    };
    aggregateCache.set(cacheKey, { payload, ts: Date.now() });
    res.set("Cache-Control", "public, max-age=300");
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
});

// -------------------- PAGE --------------------
function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.get("/", (req, res) => {
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

  const ogImageTag = previewImage
    ? '<meta property="og:image" content="' + escapeHtml(previewImage) + '" />'
    : "";

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${previewTitle}</title>
  <meta property="og:title" content="${escapeHtml(previewTitle)}" />
  <meta property="og:description" content="${escapeHtml(previewDesc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://whatishenrylisteningto.com" />
  ${ogImageTag}
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
    .headerRow { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
    .title { margin:0; font-size:16px; font-weight:850; letter-spacing:0.2px; }
    @media (min-width: 900px) { .title { font-size:18px; } }
    .badges { display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid rgba(43,43,43,0.14); border-radius:999px; font-size:12px; opacity:0.92; white-space:nowrap; backdrop-filter:blur(6px); }
    .live { border-color:rgba(255,59,48,0.55); box-shadow:0 0 0 3px rgba(255,59,48,0.10); }
    .dot { width:8px; height:8px; border-radius:999px; background:var(--danger); box-shadow:0 0 0 0 rgba(255,59,48,0.55); animation:pulse 1.2s infinite; }
    @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(255,59,48,.55)} 70%{box-shadow:0 0 0 10px rgba(255,59,48,0)} 100%{box-shadow:0 0 0 0 rgba(255,59,48,0)} }
    .eq { display:inline-flex; align-items:flex-end; gap:3px; height:14px; }
    .eq span { width:3px; border-radius:3px; background:var(--accent); animation:bounce .9s infinite ease-in-out; opacity:.95; }
    .eq span:nth-child(1){height:6px;animation-delay:0s}.eq span:nth-child(2){height:12px;animation-delay:.12s}.eq span:nth-child(3){height:8px;animation-delay:.24s}.eq span:nth-child(4){height:14px;animation-delay:.36s}
    @keyframes bounce { 0%,100%{transform:scaleY(.5)}50%{transform:scaleY(1.15)} }
    .special { margin:6px 0 12px; color:rgba(43,43,43,.90); font-size:13px; line-height:1.35; }
    .special strong { color:#fff; }
    .subhead { margin:12px 0 6px; font-size:12px; letter-spacing:.3px; text-transform:uppercase; color:var(--muted); }
    .mediaRow { display:grid; grid-template-columns:74px 1fr; gap:12px; align-items:center; margin-bottom:6px; }
    @media (min-width:900px){.mediaRow{grid-template-columns:88px 1fr}}
    .art { width:74px; height:74px; border-radius:14px; object-fit:cover; background:rgba(0,0,0,.04); border:1px solid rgba(43,43,43,.10); }
    @media (min-width:900px){.art{width:88px;height:88px;border-radius:16px}}
    .name { margin:0 0 4px; font-size:16px; font-weight:850; line-height:1.2; }
    .who { margin:0; color:rgba(43,43,43,.72); font-size:13px; line-height:1.3; }
    a { color:var(--accent); text-decoration:none; font-weight:800; display:inline-block; padding:8px 0; }
    .empty { margin:0; color:var(--muted); font-size:14px; line-height:1.35; }
    .hint { margin:14px 0 0; color:var(--muted); font-size:13px; }
    .site-header { display:flex; flex-direction:column; align-items:center; gap:12px; margin-bottom:18px; }
    .logo { max-width:520px; width:100%; height:auto; }
    @media (max-width:600px){.logo{max-width:92%}}
    .journal-rule { width:100%; max-width:900px; height:1px; background:linear-gradient(to right,transparent,rgba(43,43,43,.22),transparent); margin:10px 0 6px; }
    .meta { margin-top:6px; font-size:13px; color:rgba(43,43,43,.58); }
    .visitorsGrid { margin-top:14px; display:grid; grid-template-columns:1fr; gap:14px; }
    @media (min-width:900px){.visitorsGrid{margin-top:18px}}
    .small { font-size:12px; color:var(--muted); }
    .originGrid { display:grid; grid-template-columns:1fr; gap:12px; }
    @media (min-width:900px){.originGrid{grid-template-columns:1fr 1fr}}
    .originCountry { border:1px solid rgba(0,0,0,.06); border-radius:14px; padding:12px; background:rgba(255,255,255,.55); }
    .originCountry h3 { margin:0 0 8px; font-size:14px; }
    .originCountry ol { margin:0; padding-left:18px; }
    .originCountry li { margin:6px 0; }
    .originCountry a { color:inherit; text-decoration:underline; text-underline-offset:2px; }
    .originMeta { font-size:12px; color:var(--muted); margin-top:2px; }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
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

    <div class="visitorsGrid">
      <div class="card" id="visitors">
        <div class="headerRow">
          <p class="title">Artist Origins</p>
          <div class="badges"><span class="pill">Last 30d</span></div>
        </div>
        <p class="empty" id="visitorsStatus">Loading map…</p>
        <div id="countryMap" style="height:420px;border-radius:14px;overflow:hidden;"></div>
        <div id="originTable" style="margin-top:14px;"></div>
        <p class="small" id="visitorsNote" style="display:none;">Shading is based on artist origin by country and may lag a bit.</p>
      </div>
    </div>

    <p class="hint" style="text-align:center;">Auto-refreshes every 10 seconds.</p>
    <footer style="margin-top:24px;text-align:center;color:rgba(43,43,43,0.55);font-size:13px;">
      Made with ♥ by Henry Franco
    </footer>
  </div>

  <script>
    function badges(isPlaying) {
      if (isPlaying) {
        return \`<span class="pill live"><span class="dot"></span>LIVE <span class="eq"><span></span><span></span><span></span><span></span></span></span><span class="pill">Playing</span>\`;
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
      return String(Math.floor(hr / 24)) + "d ago";
    }

    function renderMini(block, label) {
      if (!block || !block.item) return "";
      const i = block.item;
      const art = i.image ? \`<img class="art" src="\${i.image}" alt="" />\` : \`<div class="art"></div>\`;
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
            \${i.spotify_url ? \`<a href="\${i.spotify_url}" target="_blank" rel="noopener">Open in Spotify</a>\` : ""}
            \${when}
          </div>
        </div>\`;
    }

    function renderRecentList(recent) {
      return recent.map((entry, idx) => {
        if (!entry || !entry.item) {
          return \`<div class="subhead">\${idx === 0 ? "Most recent" : "Second most recent"}</div><p class="empty">—</p>\`;
        }
        return renderMini(entry, idx === 0 ? "Most recent" : "Second most recent");
      }).join("");
    }

    function renderSection(containerId, section) {
      const el = document.getElementById(containerId);
      const hasPlaying = section.playing && section.playing.item;
      el.innerHTML = \`
        <div class="headerRow"><p class="title">\${section.label}</p><div class="badges">\${badges(!!section.is_playing)}</div></div>
        \${section.is_playing && hasPlaying ? "<p class='special'><strong>You caught Henry live.</strong> He’s listening right now.</p>" : ""}
        \${section.is_playing && hasPlaying ? renderMini(section.playing, "Playing now") : ""}
        \${renderRecentList(section.recent || [])}\`;
    }

    async function loadOriginTable() {
      const el = document.getElementById("originTable");
      if (!el) return;
      try {
        const r = await fetch("/api/metrics/artist-origins-detail?days=30");
        const j = await r.json();
        if (!j || !j.ok || !Array.isArray(j.data) || j.data.length === 0) {
          el.innerHTML = "";
          return;
        }
        const countries = j.data.slice(0, 8);
        const parts = ['<div class="originGrid">'];
        countries.forEach(function(c) {
          parts.push('<div class="originCountry">');
          parts.push('<h3>' + c.country + ' <span class="originMeta">(' + c.uniqueArtists + ' artists)</span></h3><ol>');
          c.artists.slice(0, 8).forEach(function(a) {
            parts.push('<li>');
            if (a.url) parts.push('<a href="' + a.url + '" target="_blank" rel="noopener noreferrer">' + a.name + '</a>');
            else parts.push(a.name);
            parts.push('<span class="originMeta"> — ' + a.count + '</span></li>');
          });
          parts.push('</ol></div>');
        });
        parts.push('</div>');
        el.innerHTML = parts.join("");
      } catch {
        el.innerHTML = "";
      }
    }

    async function loadVisitors() {
      const statusEl = document.getElementById("visitorsStatus");
      const mapEl = document.getElementById("countryMap");
      const noteEl = document.getElementById("visitorsNote");

      if (!window.__countryMap) {
        const map = L.map("countryMap", { zoomControl: true, attributionControl: false }).setView([20, 0], 2);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 5 }).addTo(map);
        window.__countryMap = map;
        window.__countryLayer = null;
        setTimeout(() => { try { map.invalidateSize(); } catch(e) {} }, 50);
      }

      mapEl.style.display = "block";
      noteEl.style.display = "none";
      statusEl.style.display = "block";
      statusEl.textContent = "Map is live. Shading will appear once visit data is available.";

      try {
        const res = await fetch("/api/metrics/artist-origins?days=30");
        const json = await res.json();
        if (!json || !json.ok || !json.data || json.data.length === 0) return;

        const counts = {};
        json.data.forEach(r => { counts[r.country] = (counts[r.country] || 0) + (r.uniqueArtists || 0); });
        const aliases = {
          "United States of America": "United States",
          "Russian Federation": "Russia",
          "Viet Nam": "Vietnam",
          "Korea, Republic of": "South Korea",
          "Korea, Democratic People's Republic of": "North Korea",
          "Iran (Islamic Republic of)": "Iran",
          "Bolivia (Plurinational State of)": "Bolivia",
          "Tanzania, United Republic of": "Tanzania",
          "Congo, Democratic Republic of the": "Democratic Republic of the Congo",
          "Congo": "Republic of the Congo",
          "Syrian Arab Republic": "Syria",
          "Lao People's Democratic Republic": "Laos",
          "Moldova, Republic of": "Moldova",
          "Venezuela (Bolivarian Republic of)": "Venezuela",
          "Türkiye": "Turkey",
          "Czechia": "Czech Republic"
        };

        const map = window.__countryMap;
        if (window.__countryLayer) {
          window.__countryLayer.remove();
          window.__countryLayer = null;
        }

        const geo = await fetch("https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json").then(r => r.json());
        const circles = [];
        function radiusFor(v) { return Math.max(4, Math.sqrt(v) * 6); }

        geo.features.forEach(feature => {
          const name = feature.properties.name;
          const key = aliases[name] || name;
          const v = counts[key] || 0;
          if (v <= 0) return;

          const overrides = { "United States": [39.8283, -98.5795] };
          let lat, lng;
          if (overrides[key]) {
            lat = overrides[key][0];
            lng = overrides[key][1];
          } else {
            try {
              const center = L.geoJSON(feature).getBounds().getCenter();
              lat = center.lat;
              lng = center.lng;
            } catch { return; }
          }

          const circle = L.circleMarker([lat, lng], {
            radius: radiusFor(v),
            color: "#60a5fa",
            fillColor: "#60a5fa",
            fillOpacity: 0.6,
            weight: 1,
          }).bindPopup(key + ": " + v + " artist" + (v === 1 ? "" : "s"));
          circle.addTo(map);
          circles.push(circle);
        });

        window.__countryLayer = L.layerGroup(circles).addTo(map);
        statusEl.textContent = "Shading shows artist origins (last 30d).";
        noteEl.style.display = "block";
        loadOriginTable();
      } catch {
        statusEl.textContent = "Map is live. Shading will appear once data is available.";
      }
    }

    async function load() {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (!data.ok) return;
      renderSection("music", data.music);
      renderSection("podcast", data.podcast);
      loadVisitors();

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

app.get("/logo.png", (req, res) => res.sendFile(path.join(__dirname, "logo.png")));
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "favicon.png")));
app.get("/favicon-live.png", (req, res) => res.sendFile(path.join(__dirname, "favicon-live.png")));

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on http://127.0.0.1:${PORT}`);
  console.log("State file:", STATE_FILE);
  console.log("Spotify token file:", SPOTIFY_TOKEN_FILE);
});
