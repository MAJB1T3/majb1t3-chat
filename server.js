'use strict';
// MAJB1T3 Chat server. Zero dependencies: Node 22.13+ only (built-in http, crypto, fs, node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PUBLIC_DIR = path.join(__dirname, 'public');
const EDIT_WINDOW_MS = 5 * 60 * 1000;
const STORY_MS = 24 * 3600 * 1000;
const STORY_MAX_VIDEO_SECONDS = 60;
const MAX_UPLOAD = { image: 12e6, voice: 40e6, video: 80e6, file: 80e6 };
const SESSION_DAYS = 365;
const USER_QUOTA = (Number(process.env.USER_QUOTA_MB) || 500) * 1e6;   // media each person may store on the server
const DECLINE_WAIT_MS = 24 * 3600 * 1000;                               // wait before asking again after a decline
const MAX_DECLINES = 3;                                                 // after this many declines they can't ask again
const INVITE_MAX_RESETS = 3, YEAR_MS = 365 * 86400e3;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

fs.mkdirSync(MEDIA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, nickname TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
  email_hash TEXT, avatar TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY, user_a INTEGER NOT NULL, user_b INTEGER NOT NULL, requester INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', blocked_by INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b));
CREATE TABLE IF NOT EXISTS chat_prefs (
  chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, cleared_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, sender INTEGER NOT NULL, type TEXT NOT NULL,
  text TEXT, media TEXT, mime TEXT, file_name TEXT, duration INTEGER, once INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER, reply_to INTEGER, created_at INTEGER NOT NULL, edited_at INTEGER, original_text TEXT,
  deleted_all INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER, seen_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS hidden_messages (
  message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(message_id, user_id));
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY(message_id, user_id));
CREATE TABLE IF NOT EXISTS stars (
  message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(message_id, user_id));
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY, reporter INTEGER NOT NULL, reported INTEGER NOT NULL, chat_id INTEGER, reason TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, bg TEXT, media TEXT, mime TEXT,
  duration INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL, viewer_id INTEGER NOT NULL, viewed_at INTEGER NOT NULL, PRIMARY KEY(story_id, viewer_id));
CREATE TABLE IF NOT EXISTS story_likes (
  story_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(story_id, user_id));
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
`);
function addColumn(table, col, def) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'email', 'TEXT');
addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'label', 'TEXT');
addColumn('sessions', 'last_used', 'INTEGER');
addColumn('users', 'invite_token', 'TEXT');
addColumn('users', 'invite_resets', 'TEXT');
addColumn('users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'limited', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'pin_salt', 'TEXT');
addColumn('users', 'pin_hash', 'TEXT');
addColumn('chats', 'declined_at', 'INTEGER');
addColumn('chats', 'decline_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'size', 'INTEGER NOT NULL DEFAULT 0');
addColumn('messages', 'cid', 'TEXT');
addColumn('stories', 'size', 'INTEGER NOT NULL DEFAULT 0');
addColumn('reports', 'status', "TEXT NOT NULL DEFAULT 'open'");
addColumn('reports', 'context', 'TEXT');
addColumn('reports', 'action', 'TEXT');
addColumn('reports', 'handled_at', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS contact_names (
  user_id INTEGER NOT NULL, contact_id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(user_id, contact_id));
CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, media TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, session_rowid INTEGER, created_at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_cid ON messages(chat_id, sender, cid) WHERE cid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite ON users(invite_token) WHERE invite_token IS NOT NULL;
`);
// older uploads did not record their size: fill it in once so storage limits count them
for (const m of db.prepare("SELECT id, media FROM messages WHERE media IS NOT NULL AND size = 0").all()) {
  try { db.prepare('UPDATE messages SET size = ? WHERE id = ?').run(fs.statSync(path.join(MEDIA_DIR, m.media)).size, m.id); } catch { /* file is gone */ }
}
for (const m of db.prepare("SELECT id, media FROM stories WHERE media IS NOT NULL AND size = 0").all()) {
  try { db.prepare('UPDATE stories SET size = ? WHERE id = ?').run(fs.statSync(path.join(MEDIA_DIR, m.media)).size, m.id); } catch { /* file is gone */ }
}

const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (s) => Buffer.from(String(s), 'base64url');

// ---------- error log (data/errors.log, rotates at 1 MB) ----------
const LOG_FILE = path.join(DATA_DIR, 'errors.log');
function logLine(kind, text) {
  try {
    try { if (fs.statSync(LOG_FILE).size > 1e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' [' + kind + '] ' + String(text).replace(/\s+/g, ' ').slice(0, 1500) + '\n');
  } catch { /* logging must never break the app */ }
}
process.on('uncaughtException', (e) => { console.error(e); logLine('crash', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error(e); logLine('rejection', e && e.stack || e); });

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const NICK_RE = /^[A-Za-z0-9_.\-]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normCode = (c) => String(c || '').trim();               // room codes are case-sensitive
const normNick = (n) => String(n || '').trim();
const normEmail = (e) => String(e || '').trim().toLowerCase();

// A strong room code: 8 to 32 keyboard characters with a letter, a number and a symbol.
function checkCode(code) {
  if (/\s/.test(code)) return 'Room code can’t contain spaces.';
  if (!/^[\x21-\x7E]+$/.test(code)) return 'Room code can only use letters, numbers and symbols from a normal keyboard.';
  if (code.length < 8) return 'Room code needs at least 8 characters.';
  if (code.length > 32) return 'Room code can be at most 32 characters.';
  if (!/[A-Za-z]/.test(code)) return 'Room code needs at least one letter.';
  if (!/[0-9]/.test(code)) return 'Room code needs at least one number.';
  if (!/[^A-Za-z0-9]/.test(code)) return 'Room code needs at least one symbol, like ! @ # $ % & * - _';
  if (new Set(code).size < 5) return 'Room code is too easy to guess. Use more different characters.';
  const low = code.toLowerCase();
  if (['password', '12345678', 'qwerty', 'letmein', 'abcdefgh'].some((w) => low.includes(w))) return 'Room code is too easy to guess.';
  return null;
}

function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] : u.slice(0, 2)) + '***@' + d;
}
function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return os + ' · ' + br;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function originOf(req) {
  const proto = isHttps(req) ? 'https' : 'http';
  return proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
}
function newSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const info = q('INSERT INTO sessions (token_hash, user_id, created_at, label, last_used) VALUES (?,?,?,?,?)')
    .run(sha(token), userId, now(), deviceLabel(req.headers['user-agent']), now());
  const attrs = ['b1t3=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + SESSION_DAYS * 86400];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  return Number(info.lastInsertRowid);
}
function clearSession(req, res) {
  const t = parseCookies(req).b1t3;
  if (t) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.setHeader('Set-Cookie', 'b1t3=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function authUser(req) {
  const t = parseCookies(req).b1t3;
  if (!t) return null;
  const th = sha(t);
  const row = q('SELECT u.*, s.last_used AS _lu FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(th);
  if (!row) return null;
  if (row.suspended) { req._suspended = true; return null; }
  if (!row._lu || now() - row._lu > 60000) q('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now(), th);
  return row;
}
function needUser(req) {
  const u = authUser(req);
  if (!u) fail(401, req._suspended ? 'Your account has been suspended.' : 'Please sign in again.');
  return u;
}
function currentSessionRowid(req) {
  const t = parseCookies(req).b1t3;
  const r = t ? q('SELECT rowid AS id FROM sessions WHERE token_hash = ?').get(sha(t)) : null;
  return r ? r.id : null;
}

const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Too many tries. Please wait a few minutes and try again.');
  arr.push(t);
  hits.set(key, arr);
}

function userLimit(user, bucket, max, windowMs) {
  const key = bucket + ':u' + user.id;
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) fail(429, 'You are doing that too fast. Please wait a moment.');
  arr.push(t); hits.set(key, arr);
}
function usedBytes(uid) {
  return q("SELECT COALESCE(SUM(size),0) n FROM messages WHERE sender = ? AND media IS NOT NULL AND deleted_all = 0").get(uid).n
    + q('SELECT COALESCE(SUM(size),0) n FROM stories WHERE user_id = ?').get(uid).n
    + q('SELECT COALESCE(SUM(size),0) n FROM stickers WHERE user_id = ?').get(uid).n;
}
function checkQuota(user, incoming) {
  if (usedBytes(user.id) + (incoming || 0) > USER_QUOTA) fail(413, 'You have used all of your ' + Math.round(USER_QUOTA / 1e6) + ' MB of storage. Delete some old photos or videos to free space.');
}

async function readJson(req, limit = 200e3) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'That is too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Bad request.'); }
}
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers));
  res.end(data);
}

// ---------- email (recovery codes) ----------
// Optional. Set BREVO_API_KEY or RESEND_API_KEY plus MAIL_FROM to turn on email codes.
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_ENABLED = !!(MAIL_FROM && (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY));
async function sendMail(to, subject, text) {
  if (!MAIL_ENABLED) return false;
  try {
    let r;
    if (process.env.BREVO_API_KEY) {
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: process.env.MAIL_FROM_NAME || 'MAJB1T3 Chat', email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text }),
        signal: AbortSignal.timeout(10000)
      });
    } else {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }), signal: AbortSignal.timeout(10000)
      });
    }
    if (!r.ok) console.error('mail send failed', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('mail send error', e.message); return false; }
}
const otps = new Map(); // "purpose:userId" -> {hash, exp, tries}
async function sendOtp(user, purpose, email) {
  const code = String(crypto.randomInt(100000, 1000000));
  otps.set(purpose + ':' + user.id, { hash: sha(code + ':' + user.id), exp: now() + 10 * 60000, tries: 0, email });
  const ok = await sendMail(email, 'Your MAJB1T3 code: ' + code,
    'Your MAJB1T3 Chat code is ' + code + '.\nIt works for 10 minutes. If you did not ask for it, ignore this email.');
  if (!ok) fail(502, 'We couldn’t send the email right now. Try again in a minute.');
}
function checkOtp(user, purpose, code) {
  const key = purpose + ':' + user.id;
  const o = otps.get(key);
  if (!o || o.exp < now()) fail(400, 'That code expired. Ask for a new one.');
  if (++o.tries > 5) { otps.delete(key); fail(429, 'Too many wrong codes. Ask for a new one.'); }
  const given = sha(String(code || '').trim() + ':' + user.id);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(o.hash))) fail(400, 'That code isn’t right.');
  otps.delete(key);
  return o;
}

// ---------- push alerts (Web Push, RFC 8291 + VAPID) ----------
let vapid;
(function loadVapid() {
  let jwk = null;
  if (process.env.VAPID_D && process.env.VAPID_X && process.env.VAPID_Y) jwk = { d: process.env.VAPID_D, x: process.env.VAPID_X, y: process.env.VAPID_Y };
  const file = path.join(DATA_DIR, 'vapid.json');
  if (!jwk) { try { jwk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* generate below */ } }
  if (!jwk) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const priv = kp.privateKey.export({ format: 'jwk' });
    jwk = { d: priv.d, x: priv.x, y: priv.y };
    try { fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 }); } catch { /* read-only disk: keys last until restart */ }
  }
  vapid = {
    publicKey: Buffer.concat([Buffer.from([4]), b64uDecode(jwk.x), b64uDecode(jwk.y)]),
    key: crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, format: 'jwk' })
  };
})();
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function encryptPush(sub, payload, test) {
  const ua = b64uDecode(sub.p256dh), auth = b64uDecode(sub.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (test && test.privateKey) ecdh.setPrivateKey(test.privateKey); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(ua);
  const salt = (test && test.salt) || crypto.randomBytes(16);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPub.length;
  return Buffer.concat([header, asPub, body]);
}
function vapidAuth(endpoint) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:admin@majb1t3.chat' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + b64u(vapid.publicKey);
}
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^updates\.push\.services\.mozilla\.com$/];
function validPushEndpoint(ep) {
  try { const u = new URL(ep); return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname)); } catch { return false; }
}
async function pushTo(sub, payloadObj) {
  try {
    const body = encryptPush(sub, Buffer.from(JSON.stringify(payloadObj)));
    const r = await fetch(sub.endpoint, {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapidAuth(sub.endpoint) }
    });
    if (r.status === 404 || r.status === 410) q('DELETE FROM push_subs WHERE id = ?').run(sub.id);
    else if (!r.ok) console.error('push failed', r.status);
  } catch (e) { console.error('push error', e.message); }
}
function pushPreview(m) {
  if (m.type === 'text') return m.text.slice(0, 140);
  const kind = { image: 'photo', voice: 'voice note', video: 'video', file: 'file', sticker: 'sticker' }[m.type] || 'message';
  return (m.once ? 'View once ' : 'Sent a ') + kind;
}
function notifyPush(recipientId, chat, sender, row) {
  const subs = q('SELECT * FROM push_subs WHERE user_id = ?').all(recipientId);
  if (!subs.length) return;
  if (prefsOf(chat.id, recipientId).muted) return;
  const isReq = chat.status === 'pending';
  const payload = { title: isReq ? 'New message request' : sender.nickname, body: isReq ? sender.nickname + ' wants to chat' : pushPreview(row), chatId: chat.id, tag: 'chat-' + chat.id };
  subs.forEach((s) => pushTo(s, payload));
}

// ---------- realtime (server-sent events) ----------
const conns = new Map(); // userId -> Set(res)
function isOnline(uid) { return (conns.get(uid) || new Set()).size > 0; }
function push(uid, event, data) {
  const set = conns.get(uid);
  if (!set) return;
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const r of set) r.write(payload);
}
function partners(uid) {
  return q("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS pid FROM chats WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'")
    .all(uid, uid, uid).map((r) => r.pid);
}
function broadcastPresence(uid) {
  const u = q('SELECT * FROM users WHERE id = ?').get(uid);
  if (!u) return;
  for (const pid of partners(uid)) push(pid, 'presence', Object.assign({ userId: uid }, presenceFor(pid, u, { status: 'accepted' })));
}
function markDeliveredFor(uid) {
  const rows = q(`SELECT m.id, m.chat_id, m.sender FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE m.delivered_at IS NULL AND m.sender != ? AND (c.user_a = ? OR c.user_b = ?)`).all(uid, uid, uid);
  const t = now();
  const by = new Map();
  for (const r of rows) {
    q('UPDATE messages SET delivered_at = ? WHERE id = ?').run(t, r.id);
    if (!by.has(r.sender)) by.set(r.sender, []);
    by.get(r.sender).push({ id: r.id, chatId: r.chat_id });
  }
  for (const [sender, list] of by) push(sender, 'delivered', { messages: list, at: t });
}
function handleEvents(req, res) {
  const user = needUser(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  const wasOnline = isOnline(user.id);
  if (!conns.has(user.id)) conns.set(user.id, new Set());
  conns.get(user.id).add(res);
  q('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
  markDeliveredFor(user.id);
  if (!wasOnline) broadcastPresence(user.id);
  res.write('event: hello\ndata: {}\n\n');
  const beat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(beat);
    const set = conns.get(user.id);
    if (set) { set.delete(res); if (!set.size) conns.delete(user.id); }
    q('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), user.id);
    if (!isOnline(user.id)) broadcastPresence(user.id);
  });
}

// ---------- data shaping ----------
const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
function getChatFor(user, chatId) {
  const c = q('SELECT * FROM chats WHERE id = ?').get(Number(chatId));
  if (!c || (c.user_a !== user.id && c.user_b !== user.id)) fail(404, 'Chat not found.');
  c.other = c.user_a === user.id ? c.user_b : c.user_a;
  return c;
}
function prefsOf(chatId, userId) {
  let p = q('SELECT * FROM chat_prefs WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  if (!p) {
    q('INSERT OR IGNORE INTO chat_prefs (chat_id, user_id) VALUES (?,?)').run(chatId, userId);
    p = q('SELECT * FROM chat_prefs WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  }
  return p;
}
function chatState(c, userId) {
  if (c.status === 'pending') return c.requester === userId ? 'waiting' : 'request';
  if (c.status === 'declined') return c.requester === userId ? 'declined' : 'declined-by-me';
  if (c.status === 'blocked') return c.blocked_by === userId ? 'blocked' : 'blocked-by-them';
  return c.status;
}
const receiptsOn = (uid) => { const r = q('SELECT read_receipts FROM users WHERE id = ?').get(uid); return !r || r.read_receipts !== 0; };
function vagueSeen(ts) {
  const age = now() - (ts || 0), day = 86400e3;
  return age < 7 * day ? 'recently' : age < 14 * day ? 'week' : age < 30 * day ? 'weeks' : 'long';
}
// exact last seen only when BOTH people keep read receipts on; otherwise a vague answer. "Online" is always shown to accepted friends.
function presenceFor(viewerId, u, chat) {
  if (!chat || chat.status !== 'accepted') return { online: false, lastSeen: null, lastSeenVague: null };
  const exact = receiptsOn(viewerId) && receiptsOn(u.id);
  return { online: isOnline(u.id), lastSeen: exact ? u.last_seen : null, lastSeenVague: exact ? null : vagueSeen(u.last_seen) };
}
function publicUser(u, chat, viewerId) {
  const nm = viewerId ? q('SELECT name FROM contact_names WHERE user_id = ? AND contact_id = ?').get(viewerId, u.id) : null;
  return Object.assign({ id: u.id, nickname: u.nickname, avatar: u.avatar || null, savedName: nm ? nm.name : null }, presenceFor(viewerId, u, chat));
}
function chatExtra(c, userId) {
  return {
    previouslyDeclined: (c.decline_count || 0) > 0,
    retryAt: c.status === 'declined' && c.requester === userId ? (c.declined_at || 0) + DECLINE_WAIT_MS : null,
    canRetry: c.status === 'declined' && c.requester === userId && (c.decline_count || 0) < MAX_DECLINES
  };
}
function previewOf(m) {
  if (!m) return '';
  if (m.deleted_all) return 'This message was deleted';
  const tag = m.once ? 'View once ' : '';
  if (m.type === 'text') return m.text;
  if (m.type === 'sticker') return 'Sticker';
  if (m.type === 'image') return tag + 'Photo';
  if (m.type === 'voice') return tag + 'Voice note';
  if (m.type === 'video') return tag + 'Video';
  return tag + (m.file_name || 'File');
}
function shapeMessage(m, viewerId) {
  const mine = m.sender === viewerId;
  const out = {
    id: m.id, chatId: m.chat_id, mine, type: m.type, createdAt: m.created_at,
    deleted: !!m.deleted_all, edited: !!m.edited_at, once: !!m.once, opened: !!m.opened_at,
    duration: m.duration || 0, fileName: m.file_name || null, mime: m.mime || null,
    delivered: !!m.delivered_at, seen: false,
    text: m.deleted_all ? '' : (m.text || ''),
    hasMedia: !m.deleted_all && !!m.media, replyTo: null, reactions: [], starred: false
  };
  out.seen = !!m.seen_at;
  if (out.seen && mine) { // blue ticks only when both people keep read receipts on
    const c = q('SELECT user_a, user_b FROM chats WHERE id = ?').get(m.chat_id);
    const other = c ? (c.user_a === viewerId ? c.user_b : c.user_a) : 0;
    out.seen = receiptsOn(viewerId) && receiptsOn(other);
  }
  if (m.edited_at && !m.deleted_all && mine) out.original = m.original_text;
  if (m.reply_to) {
    const r = q('SELECT id, sender, type, text, file_name, once, deleted_all FROM messages WHERE id = ?').get(m.reply_to);
    if (r) out.replyTo = { id: r.id, mine: r.sender === viewerId, preview: previewOf(r).slice(0, 120) };
  }
  if (!m.deleted_all) {
    const counts = new Map();
    for (const r of q('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(m.id)) {
      const c = counts.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
      c.count++; if (r.user_id === viewerId) c.mine = true;
      counts.set(r.emoji, c);
    }
    out.reactions = [...counts.values()];
    out.starred = !!q('SELECT 1 FROM stars WHERE message_id = ? AND user_id = ?').get(m.id, viewerId);
  }
  return out;
}
const VISIBLE_SQL = `m.chat_id = ? AND m.created_at > ? AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.user_id = ?)`;
function visibleMessages(user, chat, beforeId, limit) {
  const p = prefsOf(chat.id, user.id);
  const rows = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
    .all(chat.id, p.cleared_at, user.id, beforeId || 9e15, limit);
  return rows.reverse().map((m) => shapeMessage(m, user.id));
}
function messagesAround(user, chat, id) {
  const p = prefsOf(chat.id, user.id);
  const before = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id <= ? ORDER BY m.id DESC LIMIT 31`).all(chat.id, p.cleared_at, user.id, id);
  const after = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.id > ? ORDER BY m.id ASC LIMIT 30`).all(chat.id, p.cleared_at, user.id, id);
  return { messages: before.reverse().concat(after).map((m) => shapeMessage(m, user.id)), hasMore: before.length >= 31 };
}
function listChats(user) {
  const chats = q('SELECT * FROM chats WHERE user_a = ? OR user_b = ?').all(user.id, user.id);
  const out = [];
  for (const c of chats) {
    const otherId = c.user_a === user.id ? c.user_b : c.user_a;
    const p = prefsOf(c.id, user.id);
    if (p.hidden) continue;
    const other = q('SELECT * FROM users WHERE id = ?').get(otherId);
    const last = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} ORDER BY m.id DESC LIMIT 1`).get(c.id, p.cleared_at, user.id);
    const unread = q(`SELECT COUNT(*) n FROM messages m WHERE ${VISIBLE_SQL} AND m.sender != ? AND m.seen_at IS NULL AND m.deleted_all = 0`)
      .get(c.id, p.cleared_at, user.id, user.id).n;
    out.push({
      id: c.id, state: chatState(c, user.id), user: publicUser(other, c, user.id), ...chatExtra(c, user.id), pinned: !!p.pinned, muted: !!p.muted, unread,
      last: last ? { preview: previewOf(last), mine: last.sender === user.id, at: last.created_at } : null,
      updatedAt: last ? last.created_at : c.created_at
    });
  }
  return out;
}
function me(user) {
  return {
    id: user.id, nickname: user.nickname, code: user.code, avatar: user.avatar || null,
    hasEmail: !!user.email, emailMasked: maskEmail(user.email), emailVerified: !!user.email_verified, mailEnabled: MAIL_ENABLED,
    readReceipts: user.read_receipts !== 0, hasRecoveryPin: !!user.pin_hash, limited: !!user.limited,
    storageUsed: usedBytes(user.id), storageLimit: USER_QUOTA
  };
}

// ---------- message creation ----------
function createMessage(user, chat, fields) {
  const t = now();
  const info = q(`INSERT INTO messages (chat_id, sender, type, text, media, mime, file_name, duration, once, reply_to, created_at, size, cid)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(chat.id, user.id, fields.type, fields.text || null, fields.media || null,
    fields.mime || null, fields.fileName || null, fields.duration || null, fields.once ? 1 : 0, fields.replyTo || null, t, fields.size || 0, fields.cid || null);
  const id = Number(info.lastInsertRowid);
  // a new message brings a deleted/hidden chat back
  q('INSERT OR IGNORE INTO chat_prefs (chat_id, user_id) VALUES (?,?)').run(chat.id, chat.other);
  q('UPDATE chat_prefs SET hidden = 0 WHERE chat_id = ? AND user_id IN (?, ?)').run(chat.id, chat.other, user.id);
  const row = q('SELECT * FROM messages WHERE id = ?').get(id);
  if (isOnline(chat.other)) {
    q('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now(), id);
    row.delivered_at = now();
  }
  push(chat.other, 'message', { message: shapeMessage(row, chat.other), chatId: chat.id });
  push(user.id, 'message-echo', { message: shapeMessage(row, user.id), chatId: chat.id });
  notifyPush(chat.other, chat, user, row);
  return shapeMessage(row, user.id);
}
function assertCanSend(user, chat) {
  const o = q('SELECT suspended FROM users WHERE id = ?').get(chat.other);
  if (!o || o.suspended) fail(403, 'This person isn’t available right now.');
  if (chat.status === 'blocked') fail(403, chat.blocked_by === user.id ? 'You blocked this person. Unblock to send messages.' : 'You can’t send messages to this person.');
  if (chat.status === 'declined') fail(403, 'This person isn’t accepting messages from you.');
  if (chat.status === 'pending') fail(403, chat.requester === user.id ? 'Waiting for them to accept your request.' : 'Accept the request first to reply.');
}
function replyIdFor(chat, id) {
  if (!id) return null;
  const r = q('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(Number(id), chat.id);
  return r ? r.id : null;
}

// stream an upload straight to disk (no big buffers in memory)
async function receiveUpload(req, maxBytes) {
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > maxBytes) fail(413, 'That file is too large.');
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(MEDIA_DIR, id);
  const out = fs.createWriteStream(file);
  let size = 0, tooBig = false;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { tooBig = true; req.destroy(); out.destroy(); resolve(); }
    });
    req.on('error', reject);
    req.on('aborted', () => resolve());
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  if (tooBig || !size) { fs.rm(file, { force: true }, () => {}); fail(tooBig ? 413 : 400, tooBig ? 'That file is too large.' : 'Empty upload.'); }
  return { id, size };
}
const rmMedia = (id) => { if (id) fs.rm(path.join(MEDIA_DIR, id), { force: true }, () => {}); };

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/config', async (req, res) => {
  send(res, 200, { mailEnabled: MAIL_ENABLED, maxStoryVideoSeconds: STORY_MAX_VIDEO_SECONDS });
});

route('POST', '/api/create', async (req, res) => {
  rateLimit(req, 'create', 15, 3600e3);
  const b = await readJson(req);
  const nickname = normNick(b.nickname), code = normCode(b.code), email = normEmail(b.email);
  if (!NICK_RE.test(nickname)) fail(400, 'Nickname must be 2 to 24 letters, numbers, dots, dashes or underscores.');
  const bad = checkCode(code);
  if (bad) fail(400, bad);
  if (email && !EMAIL_RE.test(email)) fail(400, 'That Gmail address doesn’t look right.');
  if (q('SELECT 1 FROM users WHERE lower(code) = lower(?)').get(code)) fail(409, 'Someone else is already using this room code. Try another one.');
  const t = now();
  const info = q('INSERT INTO users (nickname, code, email, email_verified, avatar, created_at, last_seen) VALUES (?,?,?,?,?,?,?)')
    .run(nickname, code, email || null, 0, null, t, t);
  const user = q('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  newSession(req, res, user.id);
  logLine('signup', 'new account ' + user.id);
  if (email && MAIL_ENABLED) sendOtp(user, 'verify', email).catch(() => {});
  send(res, 200, { me: me(user) });
});

const pinFails = new Map(); // userId -> {n, until}
function pinLocked(uid) { const f = pinFails.get(uid); if (f && f.until > now()) fail(429, 'Too many wrong tries on this account. Wait 15 minutes and try again.'); }
function pinFailed(uid) { const f = pinFails.get(uid) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = now() + 15 * 60e3; f.n = 0; } pinFails.set(uid, f); }
function pinHash(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function pinOk(u, pin) {
  if (!u.pin_hash || !pin) return false;
  const a = Buffer.from(pinHash(pin, u.pin_salt)), b = Buffer.from(u.pin_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function addNotice(userId, kind, text, sessionRowid) {
  q('INSERT INTO notices (user_id, kind, text, session_rowid, created_at) VALUES (?,?,?,?,?)').run(userId, kind, text || null, sessionRowid || null, now());
  push(userId, 'notice', {});
}

route('POST', '/api/recover', async (req, res) => {
  rateLimit(req, 'recover', 10, 600e3);
  const b = await readJson(req);
  const nickname = normNick(b.nickname).toLowerCase(), code = normCode(b.code), email = normEmail(b.email);
  const u = q('SELECT * FROM users WHERE code = ?').get(code);
  const ok = u && u.nickname.toLowerCase() === nickname && u.email && email && u.email === email;
  if (!ok) fail(401, 'Those details don’t match. Check the nickname, room code and Gmail.');
  if (u.suspended) fail(403, 'This account has been suspended.');
  pinLocked(u.id);
  // Your nickname and room code are known to your friends, so recovery needs something only you have.
  if (!MAIL_ENABLED && !u.pin_hash) fail(403, 'Recovery isn’t switched on for this account. While you’re signed in, open Settings and set a recovery PIN. Without one, this account can’t be recovered.');
  if (u.pin_hash) {
    if (!b.pin) { send(res, 200, { needPin: true }); return; }
    if (!pinOk(u, b.pin)) { pinFailed(u.id); fail(401, 'That recovery PIN isn’t right.'); }
  }
  if (MAIL_ENABLED) {
    if (!u.email_verified) fail(403, 'That Gmail was never confirmed, so it can’t be used to recover this room.');
    if (!b.otp) { await sendOtp(u, 'recover', u.email); send(res, 200, { needCode: true, sentTo: maskEmail(u.email) }); return; }
    try { checkOtp(u, 'recover', b.otp); } catch (e) { pinFailed(u.id); throw e; }
  }
  const rowid = newSession(req, res, u.id);
  const label = deviceLabel(req.headers['user-agent']);
  addNotice(u.id, 'device', label, rowid);
  q('SELECT * FROM push_subs WHERE user_id = ?').all(u.id).forEach((sub) => pushTo(sub, { title: 'New device signed in', body: label + '. If this wasn’t you, remove it in Settings.', tag: 'device' }));
  logLine('recover', 'user ' + u.id + ' signed in on ' + label);
  send(res, 200, { me: me(u) });
});

route('POST', '/api/recovery-pin', async (req, res) => {
  const u = needUser(req);
  rateLimit(req, 'pin', 20, 600e3);
  const b = await readJson(req);
  if (u.pin_hash) { pinLocked(u.id); if (!pinOk(u, b.current)) { pinFailed(u.id); fail(401, 'Your current recovery PIN isn’t right.'); } }
  if (b.remove) {
    if (!u.pin_hash) fail(400, 'No recovery PIN is set.');
    q('UPDATE users SET pin_hash = NULL, pin_salt = NULL WHERE id = ?').run(u.id);
  } else {
    if (!/^\d{6,12}$/.test(String(b.pin || ''))) fail(400, 'Use 6 to 12 digits.');
    const salt = crypto.randomBytes(16).toString('hex');
    q('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, pinHash(b.pin, salt), u.id);
  }
  send(res, 200, { me: me(q('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

route('GET', '/api/notices', async (req, res) => {
  const u = needUser(req);
  const cur = currentSessionRowid(req);
  const rows = q('SELECT id, kind, text, created_at FROM notices WHERE user_id = ? AND acked = 0 AND (session_rowid IS NULL OR session_rowid != ?) ORDER BY id DESC LIMIT 20').all(u.id, cur || -1);
  send(res, 200, { notices: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: r.created_at })) });
});
route('POST', '/api/notices/ack', async (req, res) => {
  const u = needUser(req);
  const b = await readJson(req);
  for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 50)) q('UPDATE notices SET acked = 1 WHERE id = ? AND user_id = ?').run(Number(id), u.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/privacy', async (req, res) => {
  const u = needUser(req);
  const b = await readJson(req);
  if (typeof b.readReceipts === 'boolean') q('UPDATE users SET read_receipts = ? WHERE id = ?').run(b.readReceipts ? 1 : 0, u.id);
  broadcastPresence(u.id);
  for (const pid of partners(u.id)) push(pid, 'chat', {});
  send(res, 200, { me: me(q('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

// ----- invite link: a separate token, so the room code is never inside the link -----
function userResets(user) {
  let arr = []; try { arr = JSON.parse(user.invite_resets || '[]'); } catch { arr = []; }
  arr = arr.filter((x) => now() - x < YEAR_MS);
  return { arr, left: Math.max(0, INVITE_MAX_RESETS - arr.length), nextAt: arr.length >= INVITE_MAX_RESETS ? Math.min(...arr) + YEAR_MS : null };
}
function inviteInfo(req, user) {
  let token = user.invite_token;
  if (!token) { token = crypto.randomBytes(12).toString('base64url'); q('UPDATE users SET invite_token = ? WHERE id = ?').run(token, user.id); }
  const r = userResets(user);
  return { token, url: originOf(req) + '/#add=' + token, resetsLeft: r.left, maxResets: INVITE_MAX_RESETS, nextResetAt: r.nextAt };
}
route('GET', '/api/invite', async (req, res) => { send(res, 200, inviteInfo(req, needUser(req))); });
route('POST', '/api/invite/reset', async (req, res) => {
  const user = needUser(req);
  const r = userResets(user);
  if (!r.left) fail(429, 'You have used all ' + INVITE_MAX_RESETS + ' invite resets for this year. You can reset again on ' + new Date(r.nextAt).toDateString() + '.');
  r.arr.push(now());
  q('UPDATE users SET invite_token = ?, invite_resets = ? WHERE id = ?').run(crypto.randomBytes(12).toString('base64url'), JSON.stringify(r.arr), user.id);
  send(res, 200, inviteInfo(req, q('SELECT * FROM users WHERE id = ?').get(user.id)));
});
route('GET', '/api/invite/preview', async (req, res, params, url) => {
  rateLimit(req, 'invprev', 60, 600e3);
  const t = String(url.searchParams.get('token') || '');
  const f = t ? q('SELECT * FROM users WHERE invite_token = ?').get(t) : null;
  if (!f || f.suspended) fail(404, 'This invite is no longer valid. Ask your friend for a new one.');
  send(res, 200, { nickname: f.nickname, avatar: f.avatar || null });
});

// ----- contact (saved) names -----
route('POST', '/api/chats/:id/contact-name', async (req, res, params) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) q('DELETE FROM contact_names WHERE user_id = ? AND contact_id = ?').run(user.id, chat.other);
  else q('INSERT INTO contact_names (user_id, contact_id, name) VALUES (?,?,?) ON CONFLICT(user_id, contact_id) DO UPDATE SET name = excluded.name').run(user.id, chat.other, name);
  send(res, 200, { savedName: name || null });
});

route('POST', '/api/logout', async (req, res) => { clearSession(req, res); send(res, 200, { ok: true }); });

route('GET', '/api/me', async (req, res) => {
  const u = authUser(req);
  send(res, 200, { me: u ? me(u) : null, suspended: !!req._suspended, config: { mailEnabled: MAIL_ENABLED, maxStoryVideoSeconds: STORY_MAX_VIDEO_SECONDS } });
});

route('POST', '/api/avatar', async (req, res) => {
  const u = needUser(req);
  const b = await readJson(req, 400e3);
  if (b.avatar === null) q('UPDATE users SET avatar = NULL WHERE id = ?').run(u.id);
  else {
    if (typeof b.avatar !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.avatar) || b.avatar.length > 300e3) fail(400, 'That photo could not be used.');
    q('UPDATE users SET avatar = ? WHERE id = ?').run(b.avatar, u.id);
  }
  send(res, 200, { me: me(q('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

route('POST', '/api/email', async (req, res) => {
  const u = needUser(req);
  const b = await readJson(req);
  const email = normEmail(b.email);
  if (!EMAIL_RE.test(email)) fail(400, 'That Gmail address doesn’t look right.');
  rateLimit(req, 'email', 10, 3600e3);
  q('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email, u.id);
  const user = q('SELECT * FROM users WHERE id = ?').get(u.id);
  if (MAIL_ENABLED) await sendOtp(user, 'verify', email);
  send(res, 200, { me: me(user) });
});
route('POST', '/api/email/resend', async (req, res) => {
  const u = needUser(req);
  rateLimit(req, 'email', 10, 3600e3);
  if (!u.email) fail(400, 'Add a Gmail first.');
  if (!MAIL_ENABLED) fail(400, 'Email codes are not set up on this server.');
  await sendOtp(u, 'verify', u.email);
  send(res, 200, { ok: true });
});
route('POST', '/api/email/verify', async (req, res) => {
  const u = needUser(req);
  const b = await readJson(req);
  checkOtp(u, 'verify', b.code);
  q('UPDATE users SET email_verified = 1 WHERE id = ?').run(u.id);
  send(res, 200, { me: me(q('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

route('GET', '/api/events', async (req, res) => { handleEvents(req, res); });

route('GET', '/api/chats', async (req, res) => { send(res, 200, { chats: listChats(needUser(req)) }); });

route('POST', '/api/join', async (req, res) => {
  const user = needUser(req);
  rateLimit(req, 'join', 30, 3600e3);
  const b = await readJson(req);
  const text = String(b.text || '').trim().slice(0, 4000);
  let friend;
  if (b.chatId) { // asking again inside an existing chat
    const c0 = getChatFor(user, b.chatId);
    friend = q('SELECT * FROM users WHERE id = ?').get(c0.other);
    if (!friend || friend.suspended) fail(404, 'This person isn’t available right now.');
  } else if (b.invite) {
    friend = q('SELECT * FROM users WHERE invite_token = ?').get(String(b.invite));
    if (!friend || friend.suspended) fail(404, 'This invite is no longer valid. Ask your friend for a new one.');
  } else {
    const nickname = normNick(b.nickname).toLowerCase(), code = normCode(b.code);
    friend = q('SELECT * FROM users WHERE code = ?').get(code);
    if (!friend || friend.suspended || friend.nickname.toLowerCase() !== nickname) fail(404, 'No one found with that nickname and room code.');
  }
  if (friend.id === user.id) fail(400, 'That is your own invite.');
  const [a, bb] = pairKey(user.id, friend.id);
  let chat = q('SELECT * FROM chats WHERE user_a = ? AND user_b = ?').get(a, bb);
  if (chat) {
    chat.other = friend.id;
    if (chat.status === 'blocked') fail(403, 'This person isn’t accepting messages from you.');
    if (chat.status === 'declined') {
      if (chat.requester !== user.id) { // you declined them before; reaching out yourself accepts them
        q("UPDATE chats SET status = 'accepted' WHERE id = ?").run(chat.id);
        push(friend.id, 'chat', { chatId: chat.id });
        chat.status = 'accepted';
      } else {
        if (chat.decline_count >= MAX_DECLINES) fail(403, 'This person isn’t accepting requests from you.');
        const wait = (chat.declined_at || 0) + DECLINE_WAIT_MS - now();
        if (wait > 0) fail(403, 'They declined your request. You can ask again in ' + Math.max(1, Math.ceil(wait / 3600e3)) + ' hour(s).');
        if (!text) fail(400, 'Write a message so they know it’s you.');
        if (user.limited) fail(403, 'Your account is limited while we review reports, so you can’t send new requests.');
        q("UPDATE chats SET status = 'pending', requester = ? WHERE id = ?").run(user.id, chat.id);
        chat.status = 'pending'; chat.requester = user.id;
        userLimit(user, 'msg', 120, 60e3);
        createMessage(user, chat, { type: 'text', text });
        push(friend.id, 'chat', { chatId: chat.id });
        send(res, 200, { chatId: chat.id, state: 'waiting' });
        return;
      }
    }
    prefsOf(chat.id, user.id);
    q('UPDATE chat_prefs SET hidden = 0 WHERE chat_id = ? AND user_id = ?').run(chat.id, user.id);
    send(res, 200, { chatId: chat.id, state: chatState(chat, user.id) });
    return;
  }
  if (user.limited) fail(403, 'Your account is limited while we review reports, so you can’t send new requests.');
  if (!text) fail(400, 'Write a first message. Your friend sees it as a request.');
  const info = q("INSERT INTO chats (user_a, user_b, requester, status, created_at) VALUES (?,?,?,'pending',?)").run(a, bb, user.id, now());
  chat = q('SELECT * FROM chats WHERE id = ?').get(Number(info.lastInsertRowid));
  chat.other = friend.id;
  createMessage(user, chat, { type: 'text', text });
  push(friend.id, 'chat', { chatId: chat.id });
  send(res, 200, { chatId: chat.id, state: 'waiting' });
});

function chatAction(name, fn) {
  route('POST', '/api/chats/:id/' + name, async (req, res, params) => {
    const user = needUser(req);
    const chat = getChatFor(user, params.id);
    const body = await readJson(req);
    fn(user, chat, body);
    push(chat.other, 'chat', { chatId: chat.id });
    send(res, 200, { ok: true });
  });
}
chatAction('accept', (user, chat) => {
  if (!['pending', 'declined'].includes(chat.status) || chat.requester === user.id) fail(400, 'Nothing to accept.');
  q("UPDATE chats SET status = 'accepted' WHERE id = ?").run(chat.id);
});
chatAction('decline', (user, chat) => {
  if (chat.status !== 'pending' || chat.requester === user.id) fail(400, 'Nothing to decline.');
  q("UPDATE chats SET status = 'declined', declined_at = ?, decline_count = decline_count + 1 WHERE id = ?").run(now(), chat.id);
});
chatAction('block', (user, chat, body) => {
  if (body.on === false) {
    if (chat.status === 'blocked' && chat.blocked_by === user.id) q("UPDATE chats SET status = 'accepted', blocked_by = NULL WHERE id = ?").run(chat.id);
  } else {
    q("UPDATE chats SET status = 'blocked', blocked_by = ? WHERE id = ?").run(user.id, chat.id);
  }
});
chatAction('prefs', (user, chat, body) => {
  prefsOf(chat.id, user.id);
  if (typeof body.pinned === 'boolean') q('UPDATE chat_prefs SET pinned = ? WHERE chat_id = ? AND user_id = ?').run(body.pinned ? 1 : 0, chat.id, user.id);
  if (typeof body.muted === 'boolean') q('UPDATE chat_prefs SET muted = ? WHERE chat_id = ? AND user_id = ?').run(body.muted ? 1 : 0, chat.id, user.id);
});
chatAction('delete', (user, chat) => {
  prefsOf(chat.id, user.id);
  q('UPDATE chat_prefs SET hidden = 1, cleared_at = ? WHERE chat_id = ? AND user_id = ?').run(now(), chat.id, user.id);
});
route('POST', '/api/chats/:id/report', async (req, res, params) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  userLimit(user, 'report', 20, 86400e3);
  const b = await readJson(req);
  const reason = String(b.reason || '').trim().slice(0, 300) || 'Not specified';
  let context = null;
  if (b.includeMessages) { // only if the reporter chose to share their recent messages from this person
    const rows = q("SELECT type, text, file_name, created_at FROM messages WHERE chat_id = ? AND sender = ? AND deleted_all = 0 ORDER BY id DESC LIMIT 10").all(chat.id, chat.other);
    context = JSON.stringify(rows.reverse().map((r) => ({ at: r.created_at, type: r.type, text: r.type === 'text' ? String(r.text || '').slice(0, 500) : (r.file_name || r.type) })));
  }
  q('INSERT INTO reports (reporter, reported, chat_id, reason, created_at, context) VALUES (?,?,?,?,?,?)').run(user.id, chat.other, chat.id, reason, now(), context);
  if (chat.status === 'accepted' || chat.status === 'pending') q("UPDATE chats SET status = 'blocked', blocked_by = ? WHERE id = ?").run(user.id, chat.id);
  const n = q('SELECT COUNT(DISTINCT reporter) n FROM reports WHERE reported = ? AND created_at > ?').get(chat.other, now() - 7 * 86400e3).n;
  if (n >= 3) { q('UPDATE users SET limited = 1 WHERE id = ?').run(chat.other); logLine('auto-limit', 'user ' + chat.other + ' limited after ' + n + ' reports'); }
  send(res, 200, { ok: true, blocked: true });
});
chatAction('seen', (user, chat) => {
  const rows = q('SELECT id FROM messages WHERE chat_id = ? AND sender != ? AND seen_at IS NULL').all(chat.id, user.id);
  if (!rows.length) return;
  const t = now();
  q('UPDATE messages SET seen_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE chat_id = ? AND sender != ? AND seen_at IS NULL').run(t, t, chat.id, user.id);
  if (receiptsOn(user.id) && receiptsOn(chat.other)) push(chat.other, 'seen', { chatId: chat.id, ids: rows.map((r) => r.id), at: t });
});

route('GET', '/api/chats/:id/messages', async (req, res, params, url) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  const other = q('SELECT * FROM users WHERE id = ?').get(chat.other);
  const p = prefsOf(chat.id, user.id);
  const around = Number(url.searchParams.get('around')) || 0;
  let messages, hasMore;
  if (around) ({ messages, hasMore } = messagesAround(user, chat, around));
  else { messages = visibleMessages(user, chat, Number(url.searchParams.get('before')) || 0, 60); hasMore = messages.length >= 60; }
  send(res, 200, {
    chat: Object.assign({ id: chat.id, state: chatState(chat, user.id), user: publicUser(other, chat, user.id), prefs: { pinned: !!p.pinned, muted: !!p.muted } }, chatExtra(chat, user.id)),
    messages, hasMore
  });
});

route('GET', '/api/chats/:id/search', async (req, res, params, url) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  const term = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!term) { send(res, 200, { results: [] }); return; }
  const p = prefsOf(chat.id, user.id);
  const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.deleted_all = 0 AND m.type != 'sticker'
    AND (m.text LIKE ? ESCAPE '\\' OR m.file_name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT 50`).all(chat.id, p.cleared_at, user.id, like, like);
  send(res, 200, { results: rows.map((m) => shapeMessage(m, user.id)) });
});

route('GET', '/api/chats/:id/media', async (req, res, params, url) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  const p = prefsOf(chat.id, user.id);
  const kind = url.searchParams.get('kind') === 'files' ? "('file')" : "('image','video')";
  const rows = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} AND m.deleted_all = 0 AND m.once = 0 AND m.type IN ${kind} ORDER BY m.id DESC LIMIT 200`)
    .all(chat.id, p.cleared_at, user.id);
  send(res, 200, { items: rows.map((m) => shapeMessage(m, user.id)) });
});

route('POST', '/api/chats/:id/messages', async (req, res, params) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  assertCanSend(user, chat);
  userLimit(user, 'msg', 120, 60e3);
  const b = await readJson(req);
  const cid = b.cid ? String(b.cid).slice(0, 40) : null; // lets the app safely retry a message that may have gone through
  if (cid) {
    const ex = q('SELECT * FROM messages WHERE chat_id = ? AND sender = ? AND cid = ?').get(chat.id, user.id, cid);
    if (ex) { send(res, 200, { message: shapeMessage(ex, user.id) }); return; }
  }
  if (b.type === 'sticker') {
    const id = String(b.text || '');
    if (/^c:\d+$/.test(id)) { // one of your own saved stickers
      const st = q('SELECT * FROM stickers WHERE id = ? AND user_id = ?').get(Number(id.slice(2)), user.id);
      if (!st) fail(404, 'That sticker isn’t available.');
      checkQuota(user, st.size);
      const media = crypto.randomBytes(16).toString('hex');
      try { fs.copyFileSync(path.join(MEDIA_DIR, st.media), path.join(MEDIA_DIR, media)); } catch { fail(410, 'That sticker is no longer available.'); }
      send(res, 200, { message: createMessage(user, chat, { type: 'sticker', text: id, media, mime: st.mime, size: st.size, replyTo: replyIdFor(chat, b.replyTo), cid }) });
      return;
    }
    if (!/^(e:.{1,16}|t:[a-z0-9]{1,16})$/u.test(id)) fail(400, 'That sticker isn’t available.');
    send(res, 200, { message: createMessage(user, chat, { type: 'sticker', text: id, replyTo: replyIdFor(chat, b.replyTo), cid }) });
    return;
  }
  const text = String(b.text || '').trim();
  if (!text) fail(400, 'Write something first.');
  if (text.length > 4000) fail(400, 'That message is too long.');
  send(res, 200, { message: createMessage(user, chat, { type: 'text', text, replyTo: replyIdFor(chat, b.replyTo), cid }) });
});

route('POST', '/api/chats/:id/media', async (req, res, params, url) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  assertCanSend(user, chat);
  const type = url.searchParams.get('type');
  if (!MAX_UPLOAD[type]) fail(400, 'Unknown media type.');
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (type === 'image' && !/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(mime)) fail(400, 'That image type is not supported.');
  if (type === 'voice' && !/^audio\//.test(mime)) fail(400, 'That audio type is not supported.');
  if (type === 'video' && !/^video\//.test(mime)) fail(400, 'That video type is not supported.');
  userLimit(user, 'media', 60, 60e3);
  const cid = url.searchParams.get('cid') ? String(url.searchParams.get('cid')).slice(0, 40) : null;
  if (cid) {
    const ex = q('SELECT * FROM messages WHERE chat_id = ? AND sender = ? AND cid = ?').get(chat.id, user.id, cid);
    if (ex) { send(res, 200, { message: shapeMessage(ex, user.id) }); return; }
  }
  checkQuota(user, Number(req.headers['content-length']) || 0);
  const { id, size } = await receiveUpload(req, MAX_UPLOAD[type]);
  const fileName = String(url.searchParams.get('name') || '').replace(/[\r\n\\/]/g, '').slice(0, 120) || null;
  const msg = createMessage(user, chat, {
    type, media: id, mime, size, cid, fileName, duration: Math.min(Number(url.searchParams.get('dur')) || 0, 86400),
    once: url.searchParams.get('once') === '1', replyTo: replyIdFor(chat, url.searchParams.get('reply')),
    text: String(url.searchParams.get('caption') || '').slice(0, 1000)
  });
  send(res, 200, { message: msg });
});

route('POST', '/api/chats/:id/forward', async (req, res, params) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  assertCanSend(user, chat);
  const b = await readJson(req);
  const src = q('SELECT * FROM messages WHERE id = ?').get(Number(b.messageId));
  if (!src) fail(404, 'Message not found.');
  getChatFor(user, src.chat_id);
  if (src.deleted_all || q('SELECT 1 FROM hidden_messages WHERE message_id = ? AND user_id = ?').get(src.id, user.id)) fail(404, 'Message not found.');
  if (src.once) fail(400, 'View once messages can’t be forwarded.');
  if (src.media) checkQuota(user, src.size || 0);
  let media = null;
  if (src.media) {
    media = crypto.randomBytes(16).toString('hex');
    try { fs.copyFileSync(path.join(MEDIA_DIR, src.media), path.join(MEDIA_DIR, media)); } catch { fail(410, 'That file is no longer available.'); }
  }
  send(res, 200, { message: createMessage(user, chat, { type: src.type, text: src.text, media, size: src.size, mime: src.mime, fileName: src.file_name, duration: src.duration }) });
});

function getMessageFor(user, id) {
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(id));
  if (!m) fail(404, 'Message not found.');
  const chat = getChatFor(user, m.chat_id);
  return { m, chat };
}

route('PATCH', '/api/messages/:id', async (req, res, params) => {
  const user = needUser(req);
  const { m, chat } = getMessageFor(user, params.id);
  if (m.sender !== user.id) fail(403, 'You can only edit your own messages.');
  if (m.type !== 'text' || m.deleted_all) fail(400, 'This message can’t be edited.');
  if (now() - m.created_at > EDIT_WINDOW_MS) fail(403, 'Messages can only be edited for 5 minutes after sending.');
  assertCanSend(user, chat);
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text || text.length > 4000) fail(400, 'Write something first.');
  if (text === m.text) { send(res, 200, { message: shapeMessage(m, user.id) }); return; }
  q('UPDATE messages SET text = ?, edited_at = ?, original_text = COALESCE(original_text, ?) WHERE id = ?').run(text, now(), m.text, m.id);
  const row = q('SELECT * FROM messages WHERE id = ?').get(m.id);
  push(chat.other, 'edit', { message: shapeMessage(row, chat.other) });
  send(res, 200, { message: shapeMessage(row, user.id) });
});

route('DELETE', '/api/messages/:id', async (req, res, params, url) => {
  const user = needUser(req);
  const { m, chat } = getMessageFor(user, params.id);
  if (url.searchParams.get('scope') === 'all') {
    if (m.sender !== user.id) fail(403, 'You can only delete your own messages for everyone.');
    rmMedia(m.media);
    q('UPDATE messages SET deleted_all = 1, text = NULL, media = NULL, original_text = NULL WHERE id = ?').run(m.id);
    q('DELETE FROM reactions WHERE message_id = ?').run(m.id);
    const row = q('SELECT * FROM messages WHERE id = ?').get(m.id);
    push(chat.other, 'edit', { message: shapeMessage(row, chat.other) });
    send(res, 200, { message: shapeMessage(row, user.id) });
  } else {
    q('INSERT OR IGNORE INTO hidden_messages (message_id, user_id) VALUES (?,?)').run(m.id, user.id);
    send(res, 200, { ok: true, id: m.id });
  }
});

route('POST', '/api/messages/:id/react', async (req, res, params) => {
  const user = needUser(req);
  const { m, chat } = getMessageFor(user, params.id);
  if (m.deleted_all) fail(400, 'This message was deleted.');
  if (chat.status !== 'accepted') fail(403, 'You can’t react in this chat.');
  const b = await readJson(req);
  const emoji = b.emoji == null ? null : String(b.emoji);
  if (emoji !== null && (emoji.length < 1 || emoji.length > 16)) fail(400, 'That reaction isn’t available.');
  const cur = q('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?').get(m.id, user.id);
  if (!emoji || (cur && cur.emoji === emoji)) q('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
  else q('INSERT OR REPLACE INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)').run(m.id, user.id, emoji);
  const row = q('SELECT * FROM messages WHERE id = ?').get(m.id);
  push(chat.other, 'edit', { message: shapeMessage(row, chat.other) });
  send(res, 200, { message: shapeMessage(row, user.id) });
});

route('POST', '/api/messages/:id/star', async (req, res, params) => {
  const user = needUser(req);
  const { m } = getMessageFor(user, params.id);
  const b = await readJson(req);
  if (b.on === false) q('DELETE FROM stars WHERE message_id = ? AND user_id = ?').run(m.id, user.id);
  else q('INSERT OR IGNORE INTO stars (message_id, user_id) VALUES (?,?)').run(m.id, user.id);
  send(res, 200, { message: shapeMessage(m, user.id) });
});

route('GET', '/api/starred', async (req, res) => {
  const user = needUser(req);
  const rows = q(`SELECT m.* FROM stars s JOIN messages m ON m.id = s.message_id JOIN chats c ON c.id = m.chat_id
    WHERE s.user_id = ? AND (c.user_a = ? OR c.user_b = ?) AND m.deleted_all = 0
    AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.user_id = ?)
    ORDER BY m.id DESC LIMIT 200`).all(user.id, user.id, user.id, user.id);
  const items = rows.map((m) => {
    const chat = getChatFor(user, m.chat_id);
    const other = q('SELECT * FROM users WHERE id = ?').get(chat.other);
    return { message: shapeMessage(m, user.id), chatId: chat.id, user: publicUser(other, chat, user.id) };
  });
  send(res, 200, { items });
});

// ----- stories -----
function storyShape(s, viewerId) {
  const out = {
    id: s.id, userId: s.user_id, kind: s.kind, text: s.text || '', bg: s.bg || '#4DE3A2', hasMedia: !!s.media, mime: s.mime || null,
    duration: s.duration || 0, createdAt: s.created_at, expiresAt: s.expires_at,
    liked: !!q('SELECT 1 FROM story_likes WHERE story_id = ? AND user_id = ?').get(s.id, viewerId),
    seen: s.user_id === viewerId || !!q('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?').get(s.id, viewerId)
  };
  if (s.user_id === viewerId) {
    out.viewCount = q('SELECT COUNT(*) n FROM story_views WHERE story_id = ?').get(s.id).n;
    out.likeCount = q('SELECT COUNT(*) n FROM story_likes WHERE story_id = ?').get(s.id).n;
  }
  return out;
}
function canSeeStory(user, s) {
  return s && s.expires_at > now() && (s.user_id === user.id || partners(user.id).includes(s.user_id));
}
function storyFor(user, id) {
  const s = q('SELECT * FROM stories WHERE id = ?').get(Number(id));
  if (!canSeeStory(user, s)) fail(404, 'This story is no longer available.');
  return s;
}
function announceStory(user) { partners(user.id).forEach((pid) => push(pid, 'story', { userId: user.id })); }

route('GET', '/api/stories', async (req, res) => {
  const user = needUser(req);
  const t = now();
  const mine = q('SELECT * FROM stories WHERE user_id = ? AND expires_at > ? ORDER BY id ASC').all(user.id, t).map((s) => storyShape(s, user.id));
  const friends = [];
  for (const pid of partners(user.id)) {
    const rows = q('SELECT * FROM stories WHERE user_id = ? AND expires_at > ? ORDER BY id ASC').all(pid, t);
    if (!rows.length) continue;
    const u = q('SELECT * FROM users WHERE id = ?').get(pid);
    const stories = rows.map((s) => storyShape(s, user.id));
    friends.push({ user: { id: u.id, nickname: u.nickname, avatar: u.avatar || null, savedName: (q('SELECT name FROM contact_names WHERE user_id = ? AND contact_id = ?').get(user.id, u.id) || {}).name || null }, stories, allSeen: stories.every((s) => s.seen), latest: rows[rows.length - 1].created_at });
  }
  friends.sort((a, b) => (a.allSeen - b.allSeen) || (b.latest - a.latest));
  send(res, 200, { mine, friends });
});

route('POST', '/api/stories', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  const text = String(b.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'Write something for your story.');
  const bg = /^#[0-9a-fA-F]{6}$/.test(b.bg || '') ? b.bg : '#4DE3A2';
  const t = now();
  const info = q("INSERT INTO stories (user_id, kind, text, bg, created_at, expires_at) VALUES (?, 'text', ?, ?, ?, ?)").run(user.id, text, bg, t, t + STORY_MS);
  announceStory(user);
  send(res, 200, { story: storyShape(q('SELECT * FROM stories WHERE id = ?').get(Number(info.lastInsertRowid)), user.id) });
});

route('POST', '/api/stories/media', async (req, res, params, url) => {
  const user = needUser(req);
  const type = url.searchParams.get('type');
  if (type !== 'image' && type !== 'video') fail(400, 'Stories can be a photo or a video.');
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'image' && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) fail(400, 'That image type is not supported.');
  if (type === 'video' && !/^video\//.test(mime)) fail(400, 'That video type is not supported.');
  const dur = Math.round(Number(url.searchParams.get('dur')) || 0);
  if (type === 'video' && (dur < 1 || dur > STORY_MAX_VIDEO_SECONDS)) fail(400, 'Story videos can be up to ' + STORY_MAX_VIDEO_SECONDS + ' seconds.');
  checkQuota(user, Number(req.headers['content-length']) || 0);
  const { id, size } = await receiveUpload(req, MAX_UPLOAD[type]);
  const caption = String(url.searchParams.get('caption') || '').trim().slice(0, 300);
  const t = now();
  const info = q('INSERT INTO stories (user_id, kind, text, media, mime, duration, created_at, expires_at, size) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(user.id, type, caption || null, id, mime, type === 'video' ? dur : null, t, t + STORY_MS, size);
  announceStory(user);
  send(res, 200, { story: storyShape(q('SELECT * FROM stories WHERE id = ?').get(Number(info.lastInsertRowid)), user.id) });
});

route('POST', '/api/stories/:id/view', async (req, res, params) => {
  const user = needUser(req);
  const s = storyFor(user, params.id);
  if (s.user_id !== user.id) {
    const r = q('INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?,?,?)').run(s.id, user.id, now());
    if (r.changes) push(s.user_id, 'story-activity', { storyId: s.id });
  }
  send(res, 200, { ok: true });
});

route('POST', '/api/stories/:id/like', async (req, res, params) => {
  const user = needUser(req);
  const s = storyFor(user, params.id);
  const b = await readJson(req);
  if (b.on === false) q('DELETE FROM story_likes WHERE story_id = ? AND user_id = ?').run(s.id, user.id);
  else {
    q('INSERT OR IGNORE INTO story_views (story_id, viewer_id, viewed_at) VALUES (?,?,?)').run(s.id, user.id, now());
    q('INSERT OR IGNORE INTO story_likes (story_id, user_id, created_at) VALUES (?,?,?)').run(s.id, user.id, now());
  }
  if (s.user_id !== user.id) push(s.user_id, 'story-activity', { storyId: s.id });
  send(res, 200, { story: storyShape(s, user.id) });
});

route('GET', '/api/stories/:id/viewers', async (req, res, params) => {
  const user = needUser(req);
  const s = storyFor(user, params.id);
  if (s.user_id !== user.id) fail(403, 'Only the person who posted can see this.');
  const rows = q(`SELECT u.id, u.nickname, u.avatar, v.viewed_at,
    EXISTS (SELECT 1 FROM story_likes l WHERE l.story_id = v.story_id AND l.user_id = v.viewer_id) AS liked
    FROM story_views v JOIN users u ON u.id = v.viewer_id WHERE v.story_id = ? ORDER BY v.viewed_at DESC`).all(s.id);
  send(res, 200, { viewers: rows.map((r) => ({ user: { id: r.id, nickname: r.nickname, avatar: r.avatar || null }, viewedAt: r.viewed_at, liked: !!r.liked })) });
});

route('DELETE', '/api/stories/:id', async (req, res, params) => {
  const user = needUser(req);
  const s = q('SELECT * FROM stories WHERE id = ?').get(Number(params.id));
  if (!s || s.user_id !== user.id) fail(404, 'Story not found.');
  removeStory(s);
  send(res, 200, { ok: true });
});
function removeStory(s) {
  rmMedia(s.media);
  q('DELETE FROM story_views WHERE story_id = ?').run(s.id);
  q('DELETE FROM story_likes WHERE story_id = ?').run(s.id);
  q('DELETE FROM stories WHERE id = ?').run(s.id);
}

// ----- device linking (code or QR) -----
const links = new Map(); // code -> {userId, exp, status, claim:{token,label}, session}
route('POST', '/api/link/start', async (req, res) => {
  const user = needUser(req);
  for (const [k, v] of links) if (v.userId === user.id) links.delete(k);
  let code;
  do { code = String(crypto.randomInt(10000000, 100000000)); } while (links.has(code));
  links.set(code, { userId: user.id, exp: now() + 5 * 60000, status: 'waiting', claim: null });
  send(res, 200, { code, url: originOf(req) + '/#link=' + code, expiresIn: 300 });
});
route('POST', '/api/link/claim', async (req, res) => {
  rateLimit(req, 'link', 20, 600e3);
  const b = await readJson(req);
  const code = String(b.code || '').replace(/\D/g, '');
  const l = links.get(code);
  if (!l || l.exp < now() || l.status !== 'waiting') fail(404, 'That link code isn’t valid or has expired. Make a new one on your other phone.');
  l.status = 'claimed';
  l.claim = { token: crypto.randomBytes(24).toString('hex'), label: deviceLabel(req.headers['user-agent']) };
  push(l.userId, 'link-claim', { code, device: l.claim.label });
  send(res, 200, { claimToken: l.claim.token });
});
route('POST', '/api/link/decide', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  const l = links.get(String(b.code || ''));
  if (!l || l.userId !== user.id || l.status !== 'claimed') fail(404, 'That request is no longer waiting.');
  l.status = b.approve ? 'approved' : 'denied';
  send(res, 200, { ok: true });
});
route('GET', '/api/link/status', async (req, res, params, url) => {
  const token = String(url.searchParams.get('token') || '');
  for (const [code, l] of links) {
    if (!l.claim || l.claim.token !== token) continue;
    if (l.exp < now()) { links.delete(code); fail(410, 'That link code expired. Make a new one on your other phone.'); }
    if (l.status === 'approved') {
      links.delete(code);
      newSession(req, res, l.userId);
      send(res, 200, { status: 'approved', me: me(q('SELECT * FROM users WHERE id = ?').get(l.userId)) });
      return;
    }
    if (l.status === 'denied') { links.delete(code); send(res, 200, { status: 'denied' }); return; }
    send(res, 200, { status: 'waiting' });
    return;
  }
  fail(404, 'That link request wasn’t found.');
});

route('GET', '/api/devices', async (req, res) => {
  const user = needUser(req);
  const cur = currentSessionRowid(req);
  const rows = q('SELECT rowid AS id, label, created_at, last_used FROM sessions WHERE user_id = ? ORDER BY last_used DESC').all(user.id);
  send(res, 200, { devices: rows.map((r) => ({ id: r.id, label: r.label || 'Device', createdAt: r.created_at, lastUsed: r.last_used || r.created_at, current: r.id === cur })) });
});
route('DELETE', '/api/devices/:id', async (req, res, params) => {
  const user = needUser(req);
  q('DELETE FROM sessions WHERE rowid = ? AND user_id = ?').run(Number(params.id), user.id);
  send(res, 200, { ok: true });
});

// ----- push subscriptions -----
route('GET', '/api/push/key', async (req, res) => { send(res, 200, { key: b64u(vapid.publicKey) }); });
route('POST', '/api/push/subscribe', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  const ep = String(b.endpoint || ''), k = b.keys || {};
  if (!validPushEndpoint(ep) || !k.p256dh || !k.auth) fail(400, 'That device can’t receive alerts.');
  q('INSERT INTO push_subs (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
    .run(user.id, ep, String(k.p256dh), String(k.auth), now());
  send(res, 200, { ok: true });
});
route('POST', '/api/push/unsubscribe', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  q('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(b.endpoint || ''), user.id);
  send(res, 200, { ok: true });
});

// ----- delete account -----
function deleteUserData(user) {
  for (const c of q('SELECT id FROM chats WHERE user_a = ? OR user_b = ?').all(user.id, user.id)) {
    for (const m of q('SELECT id, media FROM messages WHERE chat_id = ?').all(c.id)) {
      rmMedia(m.media);
      q('DELETE FROM reactions WHERE message_id = ?').run(m.id);
      q('DELETE FROM stars WHERE message_id = ?').run(m.id);
      q('DELETE FROM hidden_messages WHERE message_id = ?').run(m.id);
    }
    q('DELETE FROM messages WHERE chat_id = ?').run(c.id);
    q('DELETE FROM chat_prefs WHERE chat_id = ?').run(c.id);
    q('DELETE FROM chats WHERE id = ?').run(c.id);
  }
  for (const s of q('SELECT * FROM stories WHERE user_id = ?').all(user.id)) removeStory(s);
  for (const st of q('SELECT media FROM stickers WHERE user_id = ?').all(user.id)) rmMedia(st.media);
  q('DELETE FROM stickers WHERE user_id = ?').run(user.id);
  q('DELETE FROM story_views WHERE viewer_id = ?').run(user.id);
  q('DELETE FROM story_likes WHERE user_id = ?').run(user.id);
  q('DELETE FROM reactions WHERE user_id = ?').run(user.id);
  q('DELETE FROM stars WHERE user_id = ?').run(user.id);
  q('DELETE FROM contact_names WHERE user_id = ? OR contact_id = ?').run(user.id, user.id);
  q('DELETE FROM notices WHERE user_id = ?').run(user.id);
  q('DELETE FROM push_subs WHERE user_id = ?').run(user.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  q('DELETE FROM users WHERE id = ?').run(user.id);
  const set = conns.get(user.id); if (set) { for (const r of set) r.end(); conns.delete(user.id); }
}
route('POST', '/api/account/delete', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  if (String(b.nickname || '').trim().toLowerCase() !== user.nickname.toLowerCase()) fail(400, 'Type your nickname exactly to confirm.');
  deleteUserData(user);
  res.setHeader('Set-Cookie', 'b1t3=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  send(res, 200, { ok: true });
});

// ----- your own stickers (made from photos, cropped on the phone) -----
const MAX_STICKERS = 100, MAX_STICKER_BYTES = 300e3;
route('GET', '/api/stickers', async (req, res) => {
  const user = needUser(req);
  send(res, 200, { stickers: q('SELECT id, created_at FROM stickers WHERE user_id = ? ORDER BY id DESC').all(user.id).map((r) => ({ id: r.id, createdAt: r.created_at })), max: MAX_STICKERS });
});
route('POST', '/api/stickers', async (req, res) => {
  const user = needUser(req);
  userLimit(user, 'sticker', 30, 3600e3);
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|webp|jpeg)$/.test(mime)) fail(400, 'Stickers must be a PNG, WebP or JPEG image.');
  if (q('SELECT COUNT(*) n FROM stickers WHERE user_id = ?').get(user.id).n >= MAX_STICKERS) fail(400, 'You can keep up to ' + MAX_STICKERS + ' stickers. Delete some to add more.');
  checkQuota(user, Number(req.headers['content-length']) || 0);
  const { id, size } = await receiveUpload(req, MAX_STICKER_BYTES);
  const info = q('INSERT INTO stickers (user_id, media, mime, size, created_at) VALUES (?,?,?,?,?)').run(user.id, id, mime, size, now());
  send(res, 200, { sticker: { id: Number(info.lastInsertRowid) } });
});
route('DELETE', '/api/stickers/:id', async (req, res, params) => {
  const user = needUser(req);
  const st = q('SELECT * FROM stickers WHERE id = ? AND user_id = ?').get(Number(params.id), user.id);
  if (st) { rmMedia(st.media); q('DELETE FROM stickers WHERE id = ?').run(st.id); }
  send(res, 200, { ok: true });
});
route('POST', '/api/messages/:id/save-sticker', async (req, res, params) => { // save a sticker someone sent you
  const user = needUser(req);
  const { m } = getMessageFor(user, params.id);
  if (m.type !== 'sticker' || !m.media || m.deleted_all) fail(400, 'That isn’t a saved-able sticker.');
  if (q('SELECT COUNT(*) n FROM stickers WHERE user_id = ?').get(user.id).n >= MAX_STICKERS) fail(400, 'You can keep up to ' + MAX_STICKERS + ' stickers. Delete some to add more.');
  checkQuota(user, m.size || 0);
  const media = crypto.randomBytes(16).toString('hex');
  try { fs.copyFileSync(path.join(MEDIA_DIR, m.media), path.join(MEDIA_DIR, media)); } catch { fail(410, 'That sticker is no longer available.'); }
  const info = q('INSERT INTO stickers (user_id, media, mime, size, created_at) VALUES (?,?,?,?,?)').run(user.id, media, m.mime || 'image/png', m.size || 0, now());
  send(res, 200, { sticker: { id: Number(info.lastInsertRowid) } });
});
function serveStickerMedia(req, res, id) {
  const user = needUser(req);
  const st = q('SELECT * FROM stickers WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!st) fail(404, 'Sticker not found.');
  sendStoredFile(req, res, st.media, st.mime, 'sticker', {});
}

// ----- errors seen on phones (so "it broke" can be investigated) -----
route('POST', '/api/clientlog', async (req, res) => {
  rateLimit(req, 'clog', 30, 600e3);
  const b = await readJson(req, 20e3);
  const u = authUser(req);
  logLine('client' + (u ? ' u' + u.id : ''), [b.screen, b.message, b.stack, String(req.headers['user-agent'] || '').slice(0, 120)].map((x) => String(x || '').slice(0, 400)).join(' | '));
  send(res, 200, { ok: true });
});

// ----- admin: reports and accounts (set ADMIN_KEY on the server to switch it on) -----
function needAdmin(req) {
  rateLimit(req, 'admin', 60, 600e3);
  const k = String(req.headers['x-admin-key'] || '');
  if (!ADMIN_KEY || k.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY))) fail(403, 'Not allowed.');
}
function suspendUser(id, on) {
  q('UPDATE users SET suspended = ? WHERE id = ?').run(on ? 1 : 0, id);
  if (!on) return;
  q('DELETE FROM sessions WHERE user_id = ?').run(id);
  q('DELETE FROM push_subs WHERE user_id = ?').run(id);
  for (const st of q('SELECT * FROM stories WHERE user_id = ?').all(id)) removeStory(st);
  const set = conns.get(id); if (set) { for (const r of set) r.end(); conns.delete(id); }
  broadcastPresence(id);
}
route('GET', '/api/admin/reports', async (req, res, params, url) => {
  needAdmin(req);
  const all = url.searchParams.get('status') === 'all';
  const rows = q(`SELECT r.*, a.nickname AS reporter_nick, b.nickname AS reported_nick, b.suspended, b.limited
    FROM reports r LEFT JOIN users a ON a.id = r.reporter LEFT JOIN users b ON b.id = r.reported
    ${all ? '' : "WHERE r.status = 'open'"} ORDER BY r.id DESC LIMIT 200`).all();
  send(res, 200, { reports: rows.map((r) => ({
    id: r.id, status: r.status, action: r.action, reason: r.reason, createdAt: r.created_at,
    reporter: { id: r.reporter, nickname: r.reporter_nick || '(deleted)' }, reported: { id: r.reported, nickname: r.reported_nick || '(deleted)', suspended: !!r.suspended, limited: !!r.limited },
    distinctReporters7d: q('SELECT COUNT(DISTINCT reporter) n FROM reports WHERE reported = ? AND created_at > ?').get(r.reported, now() - 7 * 86400e3).n,
    reportsByReporter30d: q('SELECT COUNT(*) n FROM reports WHERE reporter = ? AND created_at > ?').get(r.reporter, now() - 30 * 86400e3).n,
    context: r.context ? JSON.parse(r.context) : null
  })) });
});
route('POST', '/api/admin/reports/:id', async (req, res, params) => {
  needAdmin(req);
  const b = await readJson(req);
  const r = q('SELECT * FROM reports WHERE id = ?').get(Number(params.id));
  if (!r) fail(404, 'Report not found.');
  const action = String(b.action || '');
  const target = q('SELECT * FROM users WHERE id = ?').get(r.reported);
  let note = 'We reviewed your report. Thank you for letting us know.';
  if (action === 'warn' && target) { addNotice(target.id, 'warn', 'We received a report about your behavior. Please follow the community rules. Repeated reports can lead to your account being suspended.'); note = 'We took action on your report. Thank you.'; }
  else if (action === 'suspend' && target) { suspendUser(target.id, true); note = 'We took action on your report. Thank you.'; }
  else if (action === 'delete' && target) { deleteUserData(target); note = 'We took action on your report. Thank you.'; }
  else if (action !== 'dismiss') fail(400, 'Unknown action.');
  q("UPDATE reports SET status = 'closed', action = ?, handled_at = ? WHERE reported = ? AND status = 'open' AND (id = ? OR ? != 'dismiss')").run(action, now(), r.reported, r.id, action);
  addNotice(r.reporter, 'report-update', note);
  logLine('admin', action + ' on user ' + r.reported + ' (report ' + r.id + ')');
  send(res, 200, { ok: true });
});
route('GET', '/api/admin/users', async (req, res, params, url) => {
  needAdmin(req);
  const term = '%' + String(url.searchParams.get('q') || '').replace(/[\\%_]/g, '\\$&') + '%';
  const rows = q("SELECT id, nickname, created_at, last_seen, suspended, limited FROM users WHERE nickname LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50").all(term);
  send(res, 200, { users: rows.map((u) => ({ id: u.id, nickname: u.nickname, createdAt: u.created_at, lastSeen: u.last_seen, suspended: !!u.suspended, limited: !!u.limited, storageUsed: usedBytes(u.id) })) });
});
route('POST', '/api/admin/users/:id', async (req, res, params) => {
  needAdmin(req);
  const b = await readJson(req);
  const u = q('SELECT * FROM users WHERE id = ?').get(Number(params.id));
  if (!u) fail(404, 'No such account.');
  if (b.action === 'suspend') suspendUser(u.id, true);
  else if (b.action === 'unsuspend') suspendUser(u.id, false);
  else if (b.action === 'unlimit') q('UPDATE users SET limited = 0 WHERE id = ?').run(u.id);
  else fail(400, 'Unknown action.');
  logLine('admin', b.action + ' on user ' + u.id);
  send(res, 200, { ok: true });
});
route('GET', '/api/admin/stats', async (req, res) => {
  needAdmin(req);
  send(res, 200, { users: q('SELECT COUNT(*) n FROM users').get().n, chats: q('SELECT COUNT(*) n FROM chats').get().n, messages: q('SELECT COUNT(*) n FROM messages').get().n,
    mediaBytes: q('SELECT COALESCE(SUM(size),0) n FROM messages').get().n, online: conns.size, openReports: q("SELECT COUNT(*) n FROM reports WHERE status = 'open'").get().n });
});
route('GET', '/api/admin/logs', async (req, res) => {
  needAdmin(req);
  let text = ''; try { text = fs.readFileSync(LOG_FILE, 'utf8'); } catch { /* none yet */ }
  send(res, 200, { lines: text.split('\n').filter(Boolean).slice(-200) });
});

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MAJB1T3 admin</title>
<style>body{font-family:system-ui,sans-serif;background:#0B1210;color:#E8F5EF;margin:0;padding:16px;max-width:760px;margin:auto}h1{font-size:20px}h2{font-size:15px;color:#4DE3A2;margin-top:28px}
input,button{font:inherit;border-radius:10px;border:1px solid #25382F;background:#121E1A;color:inherit;padding:10px 12px}button{cursor:pointer}button.go{background:#4DE3A2;color:#06130E;border:0;font-weight:700}button.bad{color:#FF8F7A}
.card{border:1px solid #1E2E29;background:#0F1916;border-radius:14px;padding:14px;margin:10px 0}.muted{color:#9DB5AB;font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}pre{white-space:pre-wrap;background:#121E1A;padding:10px;border-radius:10px;font-size:12px;max-height:200px;overflow:auto}</style></head><body>
<h1>MAJB1T3 admin</h1><div id="login"><input id="key" type="password" placeholder="Admin key" autocomplete="off"> <button class="go" id="enter">Open</button><div class="muted" id="msg"></div></div>
<div id="main" hidden><div class="card" id="stats"></div><h2>Open reports</h2><div id="reports"></div><h2>Find an account</h2><input id="uq" placeholder="Nickname"> <button id="find">Search</button><div id="users"></div><h2>Recent errors</h2><pre id="logs"></pre></div>
<script>
const $=(i)=>document.getElementById(i);let KEY=sessionStorage.getItem('k')||'';
async function api(m,p,b){const r=await fetch(p,{method:m,headers:{'x-admin-key':KEY,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d}
function el(t,txt,c){const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e}
function btn(l,fn,c){const b=el('button',l,c);b.onclick=async()=>{try{await fn();load()}catch(e){alert(e.message)}};return b}
async function load(){try{const st=await api('GET','/api/admin/stats');$('login').hidden=true;$('main').hidden=false;sessionStorage.setItem('k',KEY);
$('stats').textContent=st.users+' accounts · '+st.chats+' chats · '+st.messages+' messages · '+Math.round(st.mediaBytes/1e6)+' MB media · '+st.online+' online · '+st.openReports+' open reports';
const rp=await api('GET','/api/admin/reports');const box=$('reports');box.replaceChildren();if(!rp.reports.length)box.append(el('div','No open reports.','muted'));
for(const r of rp.reports){const c=el('div',null,'card');c.append(el('b',r.reported.nickname+(r.reported.suspended?' (suspended)':'')+(r.reported.limited?' (limited)':'')),el('div','Reported by '+r.reporter.nickname+' · '+new Date(r.createdAt).toLocaleString(),'muted'),el('div','Reason: '+r.reason),
el('div',r.distinctReporters7d+' different people reported this account in 7 days · '+r.reporter.nickname+' made '+r.reportsByReporter30d+' report(s) in 30 days','muted'));
if(r.context){const t=r.context.map(x=>new Date(x.at).toLocaleString()+'  '+x.text).join('\\n');c.append(el('pre',t))}
const row=el('div',null,'row');row.append(btn('Dismiss',()=>api('POST','/api/admin/reports/'+r.id,{action:'dismiss'})),btn('Warn',()=>api('POST','/api/admin/reports/'+r.id,{action:'warn'})),btn('Suspend',()=>api('POST','/api/admin/reports/'+r.id,{action:'suspend'}),'bad'),btn('Delete account',()=>confirm('Delete this account and all its data?')&&api('POST','/api/admin/reports/'+r.id,{action:'delete'}),'bad'));c.append(row);box.append(c)}
const lg=await api('GET','/api/admin/logs');$('logs').textContent=lg.lines.slice(-60).join('\\n')||'No errors logged.'}catch(e){$('login').hidden=false;$('main').hidden=true;$('msg').textContent=KEY?e.message:''}}
$('enter').onclick=()=>{KEY=$('key').value;load()};$('key').onkeydown=(e)=>{if(e.key==='Enter')$('enter').click()};
$('find').onclick=async()=>{try{const d=await api('GET','/api/admin/users?q='+encodeURIComponent($('uq').value));const b=$('users');b.replaceChildren();for(const u of d.users){const c=el('div',null,'card');c.append(el('b',u.nickname+' (#'+u.id+')'),el('div',(u.suspended?'suspended · ':'')+(u.limited?'limited · ':'')+Math.round(u.storageUsed/1e6)+' MB · joined '+new Date(u.createdAt).toLocaleDateString(),'muted'));const row=el('div',null,'row');
row.append(u.suspended?btn('Unsuspend',()=>api('POST','/api/admin/users/'+u.id,{action:'unsuspend'})):btn('Suspend',()=>api('POST','/api/admin/users/'+u.id,{action:'suspend'}),'bad'));if(u.limited)row.append(btn('Remove limit',()=>api('POST','/api/admin/users/'+u.id,{action:'unlimit'})));c.append(row);b.append(c)}}catch(e){alert(e.message)}};
if(KEY)load();
</script></body></html>`;

// ---------- files ----------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function sendStoredFile(req, res, mediaId, mime, fileName, opts) {
  const file = path.join(MEDIA_DIR, mediaId);
  let stat;
  try { stat = fs.statSync(file); } catch { fail(404, 'This file is no longer available.'); }
  const inline = /^(image\/(jpeg|png|webp|gif|heic|heif)|audio\/|video\/)/.test(mime || '');
  const headers = {
    'Content-Type': inline ? mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': opts.noStore ? 'no-store' : 'private, max-age=3600', 'Accept-Ranges': opts.noStore ? 'none' : 'bytes',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(fileName || 'file') + '"'
  };
  const range = !opts.noStore && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 }));
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign(headers, { 'Content-Length': stat.size }));
    fs.createReadStream(file).pipe(res);
  }
}
function serveMedia(req, res, id) {
  const user = needUser(req);
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(id));
  if (!m || !m.media || m.deleted_all) fail(404, 'This file is no longer available.');
  getChatFor(user, m.chat_id);
  if (q('SELECT 1 FROM hidden_messages WHERE message_id = ? AND user_id = ?').get(m.id, user.id)) fail(404, 'This file is no longer available.');
  if (m.once) {
    if (m.sender === user.id) fail(403, 'View once files can’t be opened by the sender.');
    if (m.opened_at) fail(410, 'This was view once and has already been opened.');
    q('UPDATE messages SET opened_at = ? WHERE id = ?').run(now(), m.id);
    push(m.sender, 'opened', { id: m.id, chatId: m.chat_id });
  }
  sendStoredFile(req, res, m.media, m.mime, m.file_name, { noStore: !!m.once });
}
function serveStoryMedia(req, res, id) {
  const user = needUser(req);
  const s = storyFor(user, id);
  if (!s.media) fail(404, 'This file is no longer available.');
  sendStoredFile(req, res, s.media, s.mime, 'story', {});
}

let EMBEDDED = null;
try { EMBEDDED = require('./assets.js'); } catch { /* no bundle: serve from the public folder */ }
const embeddedCache = new Map();
function serveEmbedded(req, res, rel) {
  if (!EMBEDDED[rel]) rel = '/index.html'; // single-page app fallback
  let buf = embeddedCache.get(rel);
  if (!buf) { buf = Buffer.from(EMBEDDED[rel], 'base64'); embeddedCache.set(rel, buf); }
  const ext = path.extname(rel).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Content-Length': buf.length,
    'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600'
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (EMBEDDED && !process.env.USE_PUBLIC_DIR) { serveEmbedded(req, res, rel); return; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/media/')) { serveMedia(req, res, url.pathname.slice(7)); return; }
    if (url.pathname.startsWith('/story-media/')) { serveStoryMedia(req, res, url.pathname.slice(13)); return; }
    if (url.pathname.startsWith('/sticker-media/')) { serveStickerMedia(req, res, url.pathname.slice(15)); return; }
    if (url.pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      res.end(ADMIN_HTML); return;
    }
    if (url.pathname === '/health') { send(res, 200, 'ok'); return; }
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { await r.handler(req, res, m.groups || {}, url); return; }
      }
      fail(404, 'Not found.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Not allowed.');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) { console.error(e); logLine('error', req.method + ' ' + url.pathname + ' ' + (e && e.stack || e)); }
    if (res.headersSent) { res.end(); return; }
    send(res, status, { error: e instanceof HttpError ? e.message : 'Something went wrong on our side.' });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 30000;

// housekeeping: expired stories (24 hours), old link codes, old rate-limit entries, old codes
setInterval(() => {
  const t = now();
  for (const s of q('SELECT * FROM stories WHERE expires_at <= ?').all(t)) removeStory(s);
  for (const [k, v] of links) if (v.exp < t) links.delete(k);
  for (const [k, v] of otps) if (v.exp < t) otps.delete(k);
  for (const [k, v] of hits) if (!v.some((x) => t - x < 3600e3)) hits.delete(k);
}, 60e3).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('MAJB1T3 Chat running on port ' + PORT + ' (data: ' + DATA_DIR + ', email codes: ' + (MAIL_ENABLED ? 'on' : 'off') + ')'));
}
module.exports = server;
module.exports._test = { encryptPush, checkCode, vagueSeen };
