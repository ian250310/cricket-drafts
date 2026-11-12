/* Cricket Drafts server: zero dependencies (Node 18+).
 * - serves the game (public/) with gzip/brotli, SEO routes (robots, sitemap)
 * - hosts multiplayer rooms: REST for writes, Server-Sent Events for live updates
 * Env: PORT, SITE_URL (e.g. https://cricketdrafts.com), DATA_DIR (optional snapshot dir), TRUST_PROXY=1 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR || "";
const PUB = path.join(__dirname, "public");

/* ---------------- limits ---------------- */
const MAX_ROOMS = 5000, MAX_PLAYERS = 16, ROOM_TTL = 12 * 3600e3, MAX_BODY = 4096, MAX_SSE_PER_IP = 12;
const CODE_RE = /^[A-Z]{4}$/, UID_RE = /^[a-f0-9]{16}$/;

/* ---------------- state ---------------- */
const rooms = new Map();            // code -> { meta, players:{uid:data}, subs:Set<res>, touched, timer }
const sseByIp = new Map();

const hashUid = secret => crypto.createHash("sha256").update(String(secret)).digest("hex").slice(0, 16);
const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f<>]/g, "").slice(0, n) : "");
const num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; };

function cleanMeta(m, host, old) {
  const o = old || {};
  return {
    host,
    hostName: str(m.hostName ?? o.hostName, 20),
    edition: m.edition === null ? null : (typeof m.edition === "string" ? str(m.edition, 40) : (o.edition ?? null)),
    status: m.status === "draft" || m.status === "lobby" ? m.status : (o.status || "lobby"),
    round: m.round !== undefined ? Math.round(num(m.round, 0, 100000)) : (o.round || 0),
    created: o.created || Date.now(),
  };
}
function cleanPlayer(p) {
  return {
    name: str(p.name, 20) || "Player", phase: str(p.phase, 12), detail: str(p.detail, 60),
    avg: Math.round(num(p.avg, 0, 100)), score: num(p.score, -1, 5000), t: Date.now(),
  };
}

function push(room) {
  if (room.timer) return;
  room.timer = setTimeout(() => {      // coalesce bursts of writes
    room.timer = null;
    const msg = "event: state\ndata: " + JSON.stringify({ room: room.meta, players: room.players }) + "\n\n";
    for (const res of room.subs) res.write(msg);
  }, 60);
}
function closeRoom(code) {
  const room = rooms.get(code); if (!room) return;
  rooms.delete(code);
  for (const res of room.subs) { res.write("event: state\ndata: " + JSON.stringify({ room: null, players: {} }) + "\n\n"); }
}

/* ---------------- snapshot (survives restarts when DATA_DIR is persistent) ---------------- */
function save() {
  if (!DATA_DIR) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {}; for (const [c, r] of rooms) out[c] = { meta: r.meta, players: r.players, touched: r.touched };
    fs.writeFileSync(path.join(DATA_DIR, "rooms.json.tmp"), JSON.stringify(out));
    fs.renameSync(path.join(DATA_DIR, "rooms.json.tmp"), path.join(DATA_DIR, "rooms.json"));
  } catch (e) { console.warn("snapshot failed", e.message); }
}
function load() {
  if (!DATA_DIR) return;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "rooms.json"), "utf8"));
    for (const [c, r] of Object.entries(d)) if (Date.now() - r.touched < ROOM_TTL) rooms.set(c, { meta: r.meta, players: r.players, subs: new Set(), touched: r.touched, timer: null });
  } catch (e) { /* first run */ }
}
setInterval(() => {                    // expire idle rooms
  const now = Date.now();
  for (const [c, r] of rooms) if (now - r.touched > ROOM_TTL && r.subs.size === 0) rooms.delete(c);
  save();
}, 5 * 60e3).unref();

/* ---------------- rate limit ---------------- */
const buckets = new Map();
function allow(ip, cost = 1) {
  const now = Date.now(); let b = buckets.get(ip);
  if (!b) b = { t: 60, ts: now };
  b.t = Math.min(60, b.t + (now - b.ts) / 1000 * 8); b.ts = now;   // 8 req/s sustained, burst 60
  buckets.set(ip, b);
  if (b.t < cost) return false; b.t -= cost; return true;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.ts > 60e3) buckets.delete(k); }, 60e3).unref();

const clientIp = req => (process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

/* ---------------- helpers ---------------- */
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(b); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error("too big"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
function parsePath(p) {
  let m = /^rooms\/([A-Z]{4})$/.exec(p || ""); if (m) return { kind: "room", code: m[1] };
  m = /^rooms\/([A-Z]{4})\/players\/([a-f0-9]{16})$/.exec(p || ""); if (m) return { kind: "player", code: m[1], uid: m[2] };
  return null;
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const ip = clientIp(req);
  if (!allow(ip, url.pathname === "/api/stream" ? 5 : 1)) return json(res, 429, { error: "slow down" });

  if (url.pathname === "/api/health") return json(res, 200, { ok: true, rooms: rooms.size });

  const secret = String(req.headers["x-token"] || "");
  if (url.pathname === "/api/me") {
    if (secret.length < 16 || secret.length > 128) return json(res, 400, { error: "token" });
    return json(res, 200, { uid: hashUid(secret) });
  }

  if (url.pathname === "/api/stream") {
    const code = (url.searchParams.get("code") || "").toUpperCase();
    if (!CODE_RE.test(code)) return json(res, 400, { error: "code" });
    if ((sseByIp.get(ip) || 0) >= MAX_SSE_PER_IP) return json(res, 429, { error: "too many streams" });
    sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    const room = rooms.get(code);
    res.write("event: state\ndata: " + JSON.stringify({ room: room ? room.meta : null, players: room ? room.players : {} }) + "\n\n");
    if (!room) { res.end(); sseByIp.set(ip, Math.max(0, (sseByIp.get(ip) || 1) - 1)); return; }
    room.subs.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20e3);
    req.on("close", () => { clearInterval(ping); room.subs.delete(res); sseByIp.set(ip, Math.max(0, (sseByIp.get(ip) || 1) - 1)); });
    return;
  }

  if (url.pathname === "/api/doc") {
    const target = parsePath(url.searchParams.get("path"));
    if (!target) return json(res, 400, { error: "path" });
    const room = rooms.get(target.code);
    const who = secret.length >= 16 && secret.length <= 128 ? hashUid(secret) : null;

    if (req.method === "GET") {
      if (target.kind === "room") return json(res, 200, { exists: !!room, data: room ? room.meta : null });
      const p = room && room.players[target.uid]; return json(res, 200, { exists: !!p, data: p || null });
    }
    if (!who) return json(res, 401, { error: "token" });
    let body = {}; if (req.method !== "DELETE") body = await readBody(req);
    if (body && typeof body === "object" && body.data) body = body.data;

    if (target.kind === "room") {
      if (req.method === "DELETE") {
        if (!room) return json(res, 200, { ok: true });
        if (room.meta.host !== who) return json(res, 403, { error: "host only" });
        closeRoom(target.code); return json(res, 200, { ok: true });
      }
      if (!room) {                                  // create
        if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: "busy" });
        const meta = cleanMeta(Object.assign({}, body, { edition: null, status: "lobby", round: 0 }), who, null);
        rooms.set(target.code, { meta, players: {}, subs: new Set(), touched: Date.now(), timer: null });
        return json(res, 200, { ok: true });
      }
      if (room.meta.host !== who) return json(res, 403, { error: "host only" });
      room.meta = cleanMeta(body, who, room.meta); room.touched = Date.now(); push(room);
      return json(res, 200, { ok: true });
    }

    /* player doc: only your own */
    if (!room) return json(res, 404, { error: "no room" });
    if (target.uid !== who) return json(res, 403, { error: "not yours" });
    if (req.method === "DELETE") { delete room.players[who]; room.touched = Date.now(); push(room); return json(res, 200, { ok: true }); }
    if (!room.players[who] && Object.keys(room.players).length >= MAX_PLAYERS) return json(res, 409, { error: "room full" });
    room.players[who] = cleanPlayer(body); room.touched = Date.now(); push(room);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}

/* ---------------- static + SEO ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };
const cache = new Map();   // key -> { raw, gz, br, type, etag }
function baseUrl(req) {
  if (SITE_URL) return SITE_URL;
  const proto = (process.env.TRUST_PROXY && req.headers["x-forwarded-proto"]) || "http";
  return proto + "://" + (req.headers.host || "localhost");
}
function entry(key, buf, type) {
  let e = cache.get(key);
  if (!e) {
    const compress = /text|json|xml|svg/.test(type);
    e = { raw: buf, type, etag: '"' + crypto.createHash("sha1").update(buf).digest("base64url").slice(0, 16) + '"',
          gz: compress ? zlib.gzipSync(buf, { level: 9 }) : null, br: compress ? zlib.brotliCompressSync(buf) : null };
    cache.set(key, e);
  }
  return e;
}
function send(req, res, e, maxAge) {
  const h = { "Content-Type": e.type, ETag: e.etag, "Cache-Control": maxAge ? "public, max-age=" + maxAge : "no-cache", Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === e.etag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers["accept-encoding"] || ""); let body = e.raw;
  if (e.br && /\bbr\b/.test(ae)) { h["Content-Encoding"] = "br"; body = e.br; } else if (e.gz && /\bgzip\b/.test(ae)) { h["Content-Encoding"] = "gzip"; body = e.gz; }
  h["Content-Length"] = body.length; res.writeHead(200, h); res.end(req.method === "HEAD" ? undefined : body);
}
const SEC = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};
const PAGES = ["/"];

function serve(req, res, url) {
  const base = baseUrl(req);
  if (url.pathname === "/robots.txt")
    return send(req, res, entry("robots" + base, Buffer.from(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${base}/sitemap.xml\n`), MIME[".txt"]), 3600);
  if (url.pathname === "/sitemap.xml") {
    const d = new Date().toISOString().slice(0, 10);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map(p => `  <url><loc>${base}${p}</loc><lastmod>${d}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`).join("\n")}\n</urlset>\n`;
    return send(req, res, entry("sitemap" + base + d, Buffer.from(xml), MIME[".xml"]), 3600);
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8").replace(/__SITE_URL__/g, base);
    return send(req, res, entry("index" + base, Buffer.from(html), MIME[".html"]), 0);
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found");
  }
  const ext = path.extname(file).toLowerCase();
  let buf = fs.readFileSync(file);
  if (ext === ".webmanifest" || ext === ".svg") buf = Buffer.from(buf.toString().replace(/__SITE_URL__/g, base));
  send(req, res, entry("f:" + file + base, buf, MIME[ext] || "application/octet-stream"), ext === ".html" ? 0 : 86400);
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  for (const k in SEC) res.setHeader(k, SEC[k]);
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    serve(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "server error" });
    else res.end();
    if (!e.status) console.error(e);
  }
});
server.keepAliveTimeout = 65e3;
load();
server.listen(PORT, () => console.log("Cricket Drafts listening on :" + PORT));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { save(); process.exit(0); });
