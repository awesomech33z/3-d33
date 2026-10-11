// Steam Wishlist Analyzer, lokale App (Node.js 18 oder neuer, keine Pakete nötig).
// Holt Wunschliste, Besitz und Preise von Steam und sucht Mods auf trainsimcommunity.com.
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, "data"); // DATA_DIR: Ausgabeordner (GitHub-Version)
const PUB = path.join(ROOT, "public");
const UA = "SteamWishlistAnalyzer/1.0 (privater lokaler Gebrauch)";
const BASE_GAME = 4678800; // Train Sim World 7
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
if (typeof fetch !== "function") { console.error("Bitte Node.js 18 oder neuer installieren: https://nodejs.org"); process.exit(1); }
mkdirSync(DATA, { recursive: true });

/* ---------- Konfiguration (Schlüssel bleibt in config.json auf diesem Rechner) ---------- */
const cfgPath = path.join(ROOT, "config.json");
function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p, obj) { const tmp = p + ".tmp"; writeFileSync(tmp, JSON.stringify(obj, null, 1)); renameSync(tmp, p); }
function cfg() {
  const c = readJson(cfgPath, {});
  return {
    key: process.env.STEAM_API_KEY || c.steamApiKey || "",
    steamId: process.env.STEAMID64 || c.steamId64 || "76561198765454534",
    port: +(process.env.PORT || c.port || 3000),
    cc: c.country || "de",
  };
}
const safe = (u) => String(u).replace(/key=[^&]+/g, "key=***");

/* ---------- HTTP ---------- */
async function get(url, asJson) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept: asJson ? "application/json" : "text/html,application/xml" } });
      if (r.status === 429 || r.status >= 500) { last = new Error("HTTP " + r.status + " bei " + safe(url)); await sleep(4000 * i); continue; }
      if (!r.ok) { const e = new Error("HTTP " + r.status + " bei " + safe(url)); e.fatal = true; throw e; }
      return asJson ? await r.json() : await r.text();
    } catch (e) { if (e.fatal) throw e; last = e; await sleep(1500 * i); }
  }
  throw new Error(String(last && last.message || last).replace(/key=[^&\s]+/g, "key=***"));
}
const getJson = (u) => get(u, true);
const getText = (u) => get(u, false);
const details = (ids, filters, cc) => getJson("https://store.steampowered.com/api/appdetails?appids=" + ids.join(",") + "&cc=" + cc + "&l=english" + (filters ? "&filters=" + filters : ""));

/* ---------- Zustand ---------- */
const seed = readJson(path.join(ROOT, "data", "catalog-seed.json"), []);
const seedMap = new Map(seed.map((e) => [e.id, e]));
const statePath = path.join(DATA, "state.json");
let state = readJson(statePath, null) || { swa: 2, stand: null, refreshedAt: null, wishlist: null, ownedGames: null, ownedApps: [], catalog: {}, prices: {}, history: {} };
for (const e of seed) { // Startverlauf aus den gemessenen Seed-Punkten
  if (!state.history[e.id]) state.history[e.id] = (e.h || []).filter((p) => p.k === "obs").map((p) => ({ d: p.d, p: p.p, o: p.o }));
}
const save = () => writeJson(statePath, state);
const inferType = (t) => (/Route Add-On|Bahnstrecke|Corridor|Line:|Branches|Network:/i.test(t) && !/Loco|EMU|DMU|Pack/i.test(t) ? "route" : "other");
const num = (x) => (Number.isFinite(+x) ? +x : null);

/* ---------- Aktualisierung ---------- */
const job = { running: false, step: "", done: 0, total: 0, log: [], error: null, finished: null };
const jlog = (m) => { job.log.push(m); if (job.log.length > 80) job.log.shift(); };

async function runRefresh() {
  const c = cfg(), t0 = today();
  Object.assign(job, { running: true, step: "Start", done: 0, total: 1, log: [], error: null, finished: null });
  try {
    // 1) DLC-Liste des Basisspiels
    job.step = "DLC-Liste von Train Sim World 7";
    let dlcIds = [];
    try {
      const j = await details([BASE_GAME], "", c.cc);
      const d = j && j[BASE_GAME] && j[BASE_GAME].data;
      dlcIds = (d && Array.isArray(d.dlc) ? d.dlc : []).map(Number);
      jlog("DLC laut Steam-Seite des Basisspiels: " + dlcIds.length);
    } catch (e) { jlog("DLC-Liste nicht abrufbar, nutze bekannte Liste: " + e.message); }
    // 2) Wunschliste
    job.step = "Wunschliste";
    try {
      let url = "https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=" + c.steamId;
      if (c.key) url += "&key=" + encodeURIComponent(c.key);
      const j = await getJson(url), r = j && j.response;
      if (!r || typeof r !== "object") throw new Error("Unerwartete Antwort der Wunschlisten-Schnittstelle");
      if (!Array.isArray(r.items)) { state.wishlist = state.wishlist || []; jlog("Wunschliste leer oder Format unbekannt (Felder: " + Object.keys(r).join(", ") + ")"); }
      else { state.wishlist = r.items.map((x) => +x.appid).filter(Boolean); jlog("Wunschliste: " + state.wishlist.length + " Einträge"); }
    } catch (e) { jlog("Wunschliste fehlgeschlagen: " + e.message); }
    // 3) Besitz (Spiele) mit Schlüssel
    job.step = "Besitz";
    if (c.key) {
      try {
        const j = await getJson("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=" + encodeURIComponent(c.key) + "&steamid=" + c.steamId + "&include_appinfo=1&include_played_free_games=1&format=json");
        const r = j && j.response;
        if (r && Array.isArray(r.games)) { state.ownedGames = r.games.map((g) => ({ id: +g.appid, name: g.name || "", hours: Math.round((g.playtime_forever || 0) / 6) / 10 })); jlog("Besitz: " + state.ownedGames.length + " Spiele"); }
        else jlog("Keine Spieleliste erhalten. Ist in Steam unter Datenschutz „Spieldetails“ auf öffentlich gestellt?");
      } catch (e) { jlog("Besitz fehlgeschlagen: " + e.message); }
    } else jlog("Kein Steam-Schlüssel hinterlegt: Besitz wird nicht gelesen.");
    // 4) alle bekannten IDs
    const ids = new Set([...seedMap.keys(), ...Object.keys(state.catalog).map(Number), ...dlcIds, ...(state.wishlist || [])]);
    const unknown = [...ids].filter((id) => !seedMap.has(id) && !state.catalog[id]);
    job.total = unknown.length + Math.ceil(ids.size / 10) + 2;
    for (const id of unknown) { // Namen neuer Einträge
      job.step = "Neuer Eintrag " + id;
      try {
        const j = await details([id], "basic,release_date", c.cc), e = j && j[id];
        if (e && e.success && e.data && e.data.name) {
          const m = String(e.data.name).replace(/[®™]/g, "").match(/^Train Sim World\s*(\d)?:\s*(.*)$/);
          const rd = e.data.release_date && Date.parse(e.data.release_date.date);
          state.catalog[id] = { t: m ? m[2] : String(e.data.name), pre: m && m[1] ? "TSW" + m[1] : m ? "TSW" : "Steam", d: rd ? new Date(rd).toISOString().slice(0, 10) : "", ty: inferType(e.data.name) };
          jlog("Neu: " + state.catalog[id].t);
        }
      } catch (e) { jlog("Name zu " + id + " nicht abrufbar: " + e.message); }
      job.done++; await sleep(1500);
    }
    // 5) Preise
    const list = [...ids];
    for (let i = 0; i < list.length; i += 10) {
      const chunk = list.slice(i, i + 10);
      job.step = "Preise " + Math.min(i + 10, list.length) + " von " + list.length;
      let j = null;
      try { j = await details(chunk, "price_overview", c.cc); } catch (e) { jlog("Preisblock fehlgeschlagen: " + e.message); }
      for (const id of chunk) {
        const e = j && j[id], p = e && e.success && e.data && e.data.price_overview;
        if (p && p.currency === "EUR" && num(p.final) != null) {
          const pr = { p: p.final / 100, o: p.initial / 100 };
          state.prices[id] = pr;
          const h = state.history[id] || (state.history[id] = []), last = h[h.length - 1];
          if (!last || last.p !== pr.p || last.o !== pr.o) h.push({ d: t0, p: pr.p, o: pr.o });
        }
      }
      job.done++; await sleep(1500);
    }
    state.stand = t0; state.refreshedAt = new Date().toISOString(); state.steamId = c.steamId;
    save(); job.step = "Fertig"; job.done = job.total; jlog("Fertig: " + Object.keys(state.prices).length + " Preise gespeichert.");
  } catch (e) { job.error = e.message; jlog("Abbruch: " + e.message); }
  job.running = false; job.finished = new Date().toISOString();
}

/* ---------- Mods (Sitemap von trainsimcommunity.com) ---------- */
const MODS_BASE = "https://www.trainsimcommunity.com";
const idxPath = path.join(DATA, "mods-index.json"), detPath = path.join(DATA, "mods-detail.json");
let modsIdx = readJson(idxPath, null), modsDet = readJson(detPath, {});
const words = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
async function refreshMods() {
  const xml = await getText(MODS_BASE + "/sitemap.xml");
  const items = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>(?:\s*<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/g)) {
    const url = m[1], at = url.indexOf("/mods/c3-train-sim-world/");
    if (at < 0) continue;
    const segs = url.slice(at + "/mods/c3-train-sim-world/".length).split("/").filter(Boolean);
    const last = segs[segs.length - 1] || "", mm = last.match(/^i(\d+)-(.+)$/);
    if (!mm) continue; // nur einzelne Mods, keine Kategorien
    const cats = segs.slice(0, -1).map((s) => s.replace(/^c\d+-/, ""));
    items.push({ id: +mm[1], url, slug: mm[2], cats, lastmod: m[2] || "" });
  }
  if (!items.length) throw new Error("In der Sitemap wurden keine Train-Sim-World-Mods gefunden.");
  modsIdx = { fetchedAt: new Date().toISOString(), count: items.length, items };
  writeJson(idxPath, modsIdx);
  return modsIdx;
}
const SYN = {
  skin: ["reskins", "livery"], skins: ["reskins", "livery"], reskin: ["reskins"], lackierung: ["reskins", "livery"], farbschema: ["reskins", "livery"],
  sound: ["sounds", "sound"], ton: ["sounds"], klang: ["sounds"], fahrplan: ["timetables", "timetable"], fahrplaene: ["timetables"], timetable: ["timetables"],
  szenario: ["scenario", "scenarios"], szenarien: ["scenario", "scenarios"], lok: ["locomotives", "loco"], lokomotive: ["locomotives", "loco"], triebzug: ["emu", "multiple", "units"],
  wagen: ["wagons", "coaches", "rolling"], fahrzeug: ["rolling", "stock"], fahrzeuge: ["rolling", "stock"],
  deutsch: ["german", "germany", "db", "deutsche"], deutsche: ["german", "germany", "db", "deutsche"], oesterreich: ["austrian", "austria", "obb"], osterreich: ["austrian", "austria", "obb"],
  britisch: ["british", "uk", "britain"], englisch: ["british", "uk"], amerikanisch: ["north", "american"], schweiz: ["swiss", "sbb"],
  patch: ["patches"], werkzeug: ["utilities"], tool: ["utilities"], tools: ["utilities"],
};
const STOP = new Set(["ich", "suche", "suchen", "ein", "eine", "einen", "fuer", "fur", "für", "zu", "zum", "zur", "mit", "und", "oder", "der", "die", "das", "den", "mod", "mods", "gibt", "es", "was", "welche", "passend", "passende", "passt", "bitte", "danke", "mir", "meine", "meiner", "nach", "von", "im", "in", "auf", "the", "for", "a", "an", "of", "route", "add", "on", "addon", "train", "sim", "world", "tsw"]);
function parseQuery(q) {
  const raw = words(String(q || "")), tokens = [], syn = [];
  let ver = null;
  const lower = String(q || "").toLowerCase();
  const vm = lower.match(/tsw\s*(\d)/); if (vm) ver = +vm[1];
  for (const w of raw) {
    if (STOP.has(w)) continue;
    if (SYN[w]) syn.push(...SYN[w]); else tokens.push(w);
  }
  return { tokens: [...new Set(tokens)], syn: [...new Set(syn)], ver };
}
const WEAK = new Set(["br", "class", "db", "ice", "obb", "sbb", "re", "ec"]);
function searchMods(q, limit = 20) {
  if (!modsIdx) return { total: 0, results: [], query: parseQuery(q) };
  const P = parseQuery(q);
  if (!P.tokens.length && !P.syn.length) return { total: 0, results: [], query: P };
  const strongTokens = P.tokens.filter((t) => !WEAK.has(t));
  const out = [];
  for (const m of modsIdx.items) {
    const sw = words(m.slug), cw = words(m.cats.join(" "));
    let s = 0, hit = 0;
    const matched = [];
    for (const t of P.tokens) {
      const weak = WEAK.has(t);
      let v = 0;
      if (sw.includes(t)) v = 3; else if (sw.some((w) => w.startsWith(t) && t.length >= 3)) v = 2; else if (cw.includes(t)) v = 1.5; else if (t.length >= 4 && m.slug.includes(t)) v = 1;
      if (v) { s += weak ? 0.5 : v; if (!weak) hit++; matched.push(t); }
    }
    let sh = 0;
    for (const t of P.syn) if (cw.includes(t) || sw.includes(t)) { sh++; matched.push(t); }
    if (P.syn.length) s += sh ? 1.5 + 0.5 * sh : 0;
    if (strongTokens.length && !hit) continue;                       // mindestens ein Suchwort muss treffen
    if (!strongTokens.length && P.tokens.length && !matched.length) continue;
    if (!P.tokens.length && !sh) continue;                           // reine Kategoriesuche
    if (P.syn.length && !sh && P.tokens.length) s -= 0.5;
    if (strongTokens.length > 1 && hit === strongTokens.length) s += 2; // alle Wörter getroffen
    out.push({ ...m, score: s, matched });
  }
  out.sort((a, b) => b.score - a.score || (b.lastmod > a.lastmod ? 1 : -1));
  return { total: out.length, results: out.slice(0, limit), query: P };
}
function decode(s) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim(); }
async function modDetail(m) {
  if (modsDet[m.url] && Date.now() - modsDet[m.url].at < 7 * 864e5) return modsDet[m.url];
  const html = await getText(m.url);
  const tm = html.match(/<title>([^<]*)<\/title>/i);
  const title = tm ? decode(tm[1]).replace(/\s*[-–|]\s*Train Sim Community\s*$/i, "") : "";
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const fm = text.match(/for\s+tsw\s*(\d)(\s+or\s+newer)?/i);
  const vers = [...new Set([...text.matchAll(/\bTSW\s?(\d)\b/gi)].map((x) => +x[1]))].sort();
  const d = { title, forVer: fm ? +fm[1] : null, orNewer: !!(fm && fm[2]), mentions: vers, at: Date.now() };
  modsDet[m.url] = d; writeJson(detPath, modsDet);
  return d;
}

/* ---------- Server ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const send = (res, code, body, type = "application/json; charset=utf-8") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 5e6) { no(new Error("zu groß")); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", no); });

async function api(req, res, url) {
  const c = cfg(), p = url.pathname;
  if (p === "/api/state" && req.method === "GET")
    return send(res, 200, { swa: 2, version: "1.0", config: { hasKey: !!c.key, steamId: c.steamId }, state, mods: modsIdx ? { count: modsIdx.count, fetchedAt: modsIdx.fetchedAt } : null });
  if (p === "/api/job" && req.method === "GET") return send(res, 200, job);
  if (p === "/api/refresh" && req.method === "POST") {
    if (job.running) return send(res, 409, { error: "Läuft schon." });
    runRefresh(); return send(res, 202, { started: true });
  }
  if (p === "/api/config" && req.method === "POST") {
    const b = JSON.parse((await readBody(req)) || "{}"), old = readJson(cfgPath, {});
    if (typeof b.steamApiKey === "string") old.steamApiKey = b.steamApiKey.trim();
    if (typeof b.steamId64 === "string" && /^\d{17}$/.test(b.steamId64.trim())) old.steamId64 = b.steamId64.trim();
    writeJson(cfgPath, old); try { chmodSync(cfgPath, 0o600); } catch {}
    return send(res, 200, { ok: true, hasKey: !!cfg().key, steamId: cfg().steamId });
  }
  if (p === "/api/owned" && req.method === "POST") { // Besitz aus dynamicstore/userdata
    const raw = (await readBody(req)).trim(); let j;
    try { j = JSON.parse(raw); } catch { return send(res, 400, { error: "Das ist kein gültiges JSON." }); }
    const arr = Array.isArray(j) ? j : j && j.rgOwnedApps;
    if (!Array.isArray(arr)) return send(res, 400, { error: "Feld rgOwnedApps nicht gefunden." });
    state.ownedApps = arr.map(Number).filter(Boolean); save();
    const known = new Set([...seedMap.keys(), ...Object.keys(state.catalog).map(Number)]);
    return send(res, 200, { ok: true, total: state.ownedApps.length, inCatalog: state.ownedApps.filter((id) => known.has(id)).length });
  }
  if (p === "/api/mods/refresh" && req.method === "POST") {
    try { const i = await refreshMods(); return send(res, 200, { count: i.count, fetchedAt: i.fetchedAt }); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === "/api/mods/search" && req.method === "GET") {
    const q = url.searchParams.get("q") || "", limit = Math.min(30, +(url.searchParams.get("limit") || 12)), withDetail = url.searchParams.get("detail") !== "0";
    let note = "";
    if (!modsIdx || Date.now() - Date.parse(modsIdx.fetchedAt) > 864e5) {
      try { await refreshMods(); } catch (e) { note = "Mod-Liste konnte nicht aktualisiert werden: " + e.message; }
    }
    if (!modsIdx) return send(res, 502, { error: note || "Keine Mod-Liste vorhanden." });
    const r = searchMods(q, limit);
    if (withDetail) for (const m of r.results.slice(0, 8)) { try { m.detail = await modDetail(m); } catch (e) { m.detailError = e.message; } await sleep(400); }
    return send(res, 200, { ...r, note, indexCount: modsIdx.count, fetchedAt: modsIdx.fetchedAt });
  }
  return send(res, 404, { error: "Unbekannte Adresse" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const host = String(req.headers.host || ""); // nur Zugriff vom eigenen Rechner
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, "Nur lokal erreichbar", "text/plain");
    if (req.method === "POST") { const o = req.headers.origin; if (o && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return send(res, 403, "Fremde Herkunft", "text/plain"); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    let rel = decodeURIComponent(url.pathname); if (rel === "/") rel = "/index.html";
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB) || !existsSync(file)) return send(res, 404, "Nicht gefunden", "text/plain");
    return send(res, 200, readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) { return send(res, 500, { error: e.message }); }
});
/* ---------- Einmal-Modus für GitHub Actions: alles holen, Dateien schreiben, beenden ---------- */
async function once() {
  console.log("Einmaliger Abruf: Steam und trainsimcommunity.com");
  await runRefresh();
  job.log.forEach((l) => console.log(" - " + l));
  if (job.error) console.log("Hinweis: Der Steam-Abruf wurde abgebrochen: " + job.error);
  try { const i = await refreshMods(); console.log(" - Mod-Liste: " + i.count + " Mods"); } catch (e) { console.log(" - Mod-Liste fehlgeschlagen: " + e.message); }
  if (modsIdx) {
    let n = 0, fail = 0;
    for (const m of modsIdx.items) {
      if (n >= 400) break;
      if (modsDet[m.url] && Date.now() - modsDet[m.url].at < 7 * 864e5) continue;
      n++;
      try { await modDetail(m); } catch (e) { fail++; modsDet[m.url] = { title: "", forVer: null, orNewer: false, mentions: [], at: Date.now() - 6 * 864e5, failed: true }; }
      await sleep(300);
    }
    writeJson(detPath, modsDet);
    console.log(" - Mod-Seiten gelesen: " + (n - fail) + ", nicht lesbar: " + fail);
  }
  const c = cfg();
  writeJson(path.join(DATA, "api-state.json"), { swa: 2, version: "1.0-github", config: { hasKey: !!c.key, steamId: c.steamId }, state, mods: modsIdx ? { count: modsIdx.count, fetchedAt: modsIdx.fetchedAt } : null });
  console.log("Fertig.");
}
const { port } = cfg();
if (process.argv.includes("--once")) { await once(); process.exit(0); }
server.listen(port, "127.0.0.1", () => {
  const u = "http://localhost:" + port + "/";
  console.log("Steam Wishlist Analyzer läuft: " + u + "\nZum Beenden dieses Fenster schließen oder Strg+C drücken.");
  if (process.argv.includes("--open")) {
    const cmd = process.platform === "win32" ? 'start "" "' + u + '"' : process.platform === "darwin" ? 'open "' + u + '"' : 'xdg-open "' + u + '"';
    exec(cmd, () => {});
  }
});
server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? "Der Port " + port + " ist belegt. Läuft die App schon? Sonst PORT=3001 setzen." : e.message); process.exit(1); });
