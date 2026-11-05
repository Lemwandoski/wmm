// Rose Reel weekly catalogue scout.
// Finds new seasons and new full-episode series on trusted official channels, flags playlists that stopped working,
// and lists possible new sources for approval. Writes catalogue.json (read by the app) and SCOUT_REPORT.md.
// Run: YT_SCOUT_KEY=... node scripts/scout.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://www.googleapis.com/youtube/v3/";

export const SEASON_RE = /\b(?:season|series|s)\s*0?(\d{1,2})\b/i;
export const SKIP_RE = /promo|teaser|trailer|clip|shorts?\b|best of|best bits|highlight|behind|interview|bts|reaction|recap|webisode|cast|music|podcast|live\b|compilation/i;
export const showKey = t => t.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|a)\b/g, " ").replace(/\s+/g, " ").trim();
export const seasonNum = t => { const m = SEASON_RE.exec(t || ""); return m ? +m[1] : null; };
const oldYear = t => (t.match(/\b(19[2-9]\d)\b/g) || []).length > 0;
const slug = t => showKey(t).replace(/ /g, "-").slice(0, 40);

export function isoSecs(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

/* Turns "Everyone Else Burns | Series 2 | FULL EPISODES | Channel 4 Comedy" into "Everyone Else Burns". */
export function seriesName(title, channelName) {
  let t = title.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  t = t.split(/\s*[|｜]\s*/).filter(part => {
    const k = showKey(part);
    return k && !/^(full episodes?|all episodes|episodes|playlist|full series|complete series|tv series|series|season)$/.test(k)
      && !SEASON_RE.test(part) && k !== showKey(channelName);
  })[0] || t;
  t = t.replace(/\(?\s*(?:season|series|s)\s*0?\d{1,2}\b.*$/i, "").replace(/\s*[-–:]\s*$/, "").replace(/\s*\(.*?\)\s*$/, "").trim();
  return t;
}

export function existingFromIndex(html) {
  const playlists = new Set([...html.matchAll(/"((?:PL|UU)[A-Za-z0-9_-]{10,})"/g)].map(m => m[1]));
  const shows = [...html.matchAll(/\bid: "(\w+)"[^\n]*?\bt: "([^"]+)"/g)].map(m => ({ id: m[1], t: m[2] }));
  return { playlists, shows };
}

export async function scout({ key, fetchImpl = fetch, now = new Date(), files = {} }) {
  if (!key) throw new Error("No YouTube key. Add a repository secret named YT_SCOUT_KEY (see SCOUT_REPORT.md for the steps).");
  let quota = 0;
  const yt = async (p, params) => {
    quota += p === "search" ? 100 : 1;
    const r = await fetchImpl(API + p + "?" + new URLSearchParams({ ...params, key }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data.error && data.error.message) || "HTTP " + r.status); e.status = r.status; throw e; }
    return data;
  };
  const config = JSON.parse(files.config ?? await readFile(path.join(ROOT, "scripts/scout-config.json"), "utf8"));
  const html = files.index ?? await readFile(path.join(ROOT, "index.html"), "utf8");
  let cat;
  try { cat = JSON.parse(files.catalogue ?? await readFile(path.join(ROOT, "catalogue.json"), "utf8")); } catch { cat = {}; }
  cat = { sitcoms: [], seasons: {}, retired: [], pending: [], ...cat };
  const { playlists: builtIn, shows: builtInShows } = existingFromIndex(html);
  const known = new Set([...builtIn, ...cat.sitcoms.flatMap(s => s.seasons.map(x => x[1])), ...Object.values(cat.seasons).flat().map(x => x[1])]);
  const allShows = () => [...builtInShows, ...cat.sitcoms.map(s => ({ id: s.id, t: s.t }))];
  const minSecs = (config.minEpisodeMinutes || 15) * 60;
  const report = { newSeasons: [], newShows: [], broken: [], pending: [], skipped: 0, errors: [] };
  const today = now.toISOString().slice(0, 10);

  async function sample(pl) {
    const l = await yt("playlistItems", { part: "contentDetails", playlistId: pl, maxResults: "10" });
    const ids = (l.items || []).map(i => i.contentDetails.videoId).filter(Boolean);
    if (!ids.length) return { total: 0, full: 0 };
    const v = await yt("videos", { part: "contentDetails,status,snippet", id: ids.join(",") });
    const items = v.items || [];
    const full = items.filter(x => x.status.embeddable !== false && isoSecs(x.contentDetails.duration) >= minSecs).length;
    return { total: items.length, full, oldest: items.map(x => x.snippet.title).find(oldYear) };
  }
  async function channelPlaylists(cid) {
    const out = [];
    let token = "";
    for (let page = 0; page < 6; page++) {
      const r = await yt("playlists", { part: "snippet,contentDetails", channelId: cid, maxResults: "50", ...(token ? { pageToken: token } : {}) });
      out.push(...(r.items || []));
      token = r.nextPageToken;
      if (!token) break;
    }
    return out;
  }
  function matchShow(name) {
    const k = showKey(name);
    if (k.length < 4) return null;
    return allShows().find(s => { const sk = showKey(s.t); return sk === k || (sk.length >= 6 && k.includes(sk)) || (k.length >= 6 && sk.includes(k)); }) || null;
  }
  function addSeason(showId, label, pl, showTitle) {
    (cat.seasons[showId] = cat.seasons[showId] || []).push([label, pl]);
    known.add(pl);
    report.newSeasons.push(`${showTitle}: ${label}`);
  }

  /* 1. Trusted channels: new seasons and new series. */
  for (const ch of config.trusted) {
    try {
      let cid = ch.cid;
      if (!cid && ch.fromPlaylist) {
        const r = await yt("playlists", { part: "snippet", id: ch.fromPlaylist });
        cid = r.items && r.items[0] && r.items[0].snippet.channelId;
      }
      if (!cid) { report.errors.push(`${ch.name}: couldn't find the channel`); continue; }
      for (const p of await channelPlaylists(cid)) {
        const title = p.snippet.title.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        if (known.has(p.id)) continue;
        if (SKIP_RE.test(title) || oldYear(title) || (p.contentDetails.itemCount || 0) < 3) { report.skipped++; continue; }
        const bare = /^\s*(season|series)\s*0?\d{1,2}\s*$/i.test(title);
        const n = seasonNum(title);
        const name = bare ? null : seriesName(title, ch.name);
        const existing = bare ? (ch.bareShow ? allShows().find(s => s.id === ch.bareShow) : null) : matchShow(name);
        if (bare && !existing) { report.skipped++; continue; }
        const s = await sample(p.id);
        if (s.total < 2 || s.full < Math.max(2, Math.ceil(s.total * 0.5)) || s.oldest) { report.skipped++; continue; }
        const label = n !== null ? (/series/i.test(title) ? "Series " : "Season ") + n : "All episodes";
        if (existing) { addSeason(existing.id, label, p.id, existing.t); continue; }
        if (!name || name.length < 3) { report.skipped++; continue; }
        const id = "auto-" + slug(name);
        const show = cat.sitcoms.find(x => x.id === id);
        if (show) { show.seasons.push([label, p.id]); known.add(p.id); report.newSeasons.push(`${show.t}: ${label}`); continue; }
        cat.sitcoms.push({
          id, t: name, by: `${ch.name} · ${ch.country}`, b: `Full episodes from ${ch.name}'s official channel.`,
          min: 600, group: ch.group, ...(ch.ext ? { ext: true } : {}), added: today, seasons: [[label, p.id]]
        });
        known.add(p.id);
        report.newShows.push(`${name} (${ch.name})`);
      }
    } catch (e) { report.errors.push(`${ch.name}: ${e.message}`); if (/quota/i.test(e.message)) break; }
  }

  /* 2. Health check: playlists that were deleted or emptied. */
  const toCheck = [...known].filter(pl => !cat.retired.includes(pl));
  for (const pl of toCheck) {
    try {
      const r = await yt("playlistItems", { part: "id", playlistId: pl, maxResults: "1" });
      if (!(r.items || []).length) throw Object.assign(new Error("empty"), { status: 404 });
    } catch (e) {
      if (e.status === 404 || /empty|cannot be found|not found/i.test(e.message)) { cat.retired.push(pl); report.broken.push(pl); }
      else if (/quota/i.test(e.message)) { report.errors.push("Health check stopped: " + e.message); break; }
    }
  }

  /* 3. Discovery: possible new official sources, for approval only. */
  const trustedIds = new Set(config.trusted.map(t => t.cid).filter(Boolean));
  const seenPending = new Set(cat.pending.map(x => x.playlist));
  for (const q of config.searches || []) {
    try {
      const r = await yt("search", { part: "snippet", type: "playlist", q, maxResults: "15" });
      const chans = [...new Set((r.items || []).map(i => i.snippet.channelId))].filter(c => !trustedIds.has(c));
      const info = chans.length ? await yt("channels", { part: "snippet,statistics", id: chans.join(",") }) : { items: [] };
      const subs = new Map((info.items || []).map(c => [c.id, { n: +c.statistics.subscriberCount || 0, t: c.snippet.title }]));
      for (const it of r.items || []) {
        const pl = it.id.playlistId, ch = subs.get(it.snippet.channelId);
        if (!pl || !ch || known.has(pl) || seenPending.has(pl)) continue;
        if (ch.n < (config.discoveryMinSubscribers || 50000) || SKIP_RE.test(it.snippet.title) || oldYear(it.snippet.title)) continue;
        const s = await sample(pl);
        if (s.total < 3 || s.full < Math.ceil(s.total * 0.6) || s.oldest) continue;
        const entry = { playlist: pl, title: it.snippet.title, channel: ch.t, channelId: it.snippet.channelId, subscribers: ch.n, found: today };
        cat.pending.push(entry);
        seenPending.add(pl);
        report.pending.push(entry);
      }
    } catch (e) { report.errors.push(`Search "${q}": ${e.message}`); if (/quota/i.test(e.message)) break; }
  }
  cat.pending = cat.pending.slice(-60);
  cat.updated = now.toISOString();
  cat.quotaUsed = quota;
  return { cat, report };
}

export function renderReport(cat, report) {
  const lines = [`# Rose Reel scout report`, ``, `Last run: ${cat.updated.slice(0, 16).replace("T", " ")} UTC · YouTube quota used: ${cat.quotaUsed} of 10,000`, ``];
  const sec = (title, items, empty) => { lines.push(`## ${title}`, ""); if (items.length) items.forEach(i => lines.push(`- ${i}`)); else lines.push(empty); lines.push(""); };
  sec("Added to the app this week: new seasons", report.newSeasons, "No new seasons this week.");
  sec("Added to the app this week: new shows from trusted channels", report.newShows, "No new shows this week.");
  sec("Removed: playlists that stopped working", report.broken, "Everything still works.");
  lines.push("## Waiting for your approval", "", "These look like full-episode series from channels the scout doesn't know yet. They are not in the app. To approve one, add its channel to `trusted` in `scripts/scout-config.json` (or ask Claude to).", "");
  if (cat.pending.length) cat.pending.slice().reverse().forEach(p => lines.push(`- **${p.title}** by ${p.channel} (${p.subscribers.toLocaleString("en")} subscribers) · https://www.youtube.com/playlist?list=${p.playlist}`));
  else lines.push("Nothing new to review.");
  lines.push("");
  if (report.errors.length) sec("Problems during the run", report.errors, "");
  lines.push(`_${report.skipped} playlists were skipped as clips, trailers, old (pre-2000) or not full episodes._`, "");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { cat, report } = await scout({ key: process.env.YT_SCOUT_KEY });
    await writeFile(path.join(ROOT, "catalogue.json"), JSON.stringify(cat, null, 2) + "\n");
    await writeFile(path.join(ROOT, "SCOUT_REPORT.md"), renderReport(cat, report));
    console.log(`Done. New seasons: ${report.newSeasons.length}, new shows: ${report.newShows.length}, broken: ${report.broken.length}, pending: ${report.pending.length}, quota: ${cat.quotaUsed}`);
  } catch (e) {
    console.error("Scout failed: " + e.message);
    process.exit(1);
  }
}
