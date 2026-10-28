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

const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (s) => Buffer.from(String(s), 'base64url');

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
  q('INSERT INTO sessions (token_hash, user_id, created_at, label, last_used) VALUES (?,?,?,?,?)')
    .run(sha(token), userId, now(), deviceLabel(req.headers['user-agent']), now());
  const attrs = ['b1t3=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + SESSION_DAYS * 86400];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
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
  if (!row._lu || now() - row._lu > 60000) q('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now(), th);
  return row;
}
function needUser(req) {
  const u = authUser(req);
  if (!u) fail(401, 'Please sign in again.');
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
  const u = q('SELECT last_seen FROM users WHERE id = ?').get(uid);
  for (const pid of partners(uid)) push(pid, 'presence', { userId: uid, online: isOnline(uid), lastSeen: u ? u.last_seen : 0 });
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
  if (c.status === 'blocked') return c.blocked_by === userId ? 'blocked' : 'blocked-by-them';
  return c.status;
}
function publicUser(u, chat) {
  // last seen and online are always visible to accepted friends; strangers see nothing
  const friend = chat && chat.status === 'accepted';
  return { id: u.id, nickname: u.nickname, avatar: u.avatar || null, online: friend ? isOnline(u.id) : false, lastSeen: friend ? u.last_seen : null };
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
    delivered: !!m.delivered_at, seen: !!m.seen_at,
    text: m.deleted_all ? '' : (m.text || ''),
    hasMedia: !m.deleted_all && !!m.media, replyTo: null, reactions: [], starred: false
  };
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
    if (c.status === 'declined' && c.requester !== user.id) continue;
    const other = q('SELECT * FROM users WHERE id = ?').get(otherId);
    const last = q(`SELECT m.* FROM messages m WHERE ${VISIBLE_SQL} ORDER BY m.id DESC LIMIT 1`).get(c.id, p.cleared_at, user.id);
    const unread = q(`SELECT COUNT(*) n FROM messages m WHERE ${VISIBLE_SQL} AND m.sender != ? AND m.seen_at IS NULL AND m.deleted_all = 0`)
      .get(c.id, p.cleared_at, user.id, user.id).n;
    out.push({
      id: c.id, state: chatState(c, user.id), user: publicUser(other, c), pinned: !!p.pinned, muted: !!p.muted, unread,
      last: last ? { preview: previewOf(last), mine: last.sender === user.id, at: last.created_at } : null,
      updatedAt: last ? last.created_at : c.created_at
    });
  }
  return out;
}
function me(user) {
  return {
    id: user.id, nickname: user.nickname, code: user.code, avatar: user.avatar || null,
    hasEmail: !!user.email, emailMasked: maskEmail(user.email), emailVerified: !!user.email_verified, mailEnabled: MAIL_ENABLED
  };
}

// ---------- message creation ----------
function createMessage(user, chat, fields) {
  const t = now();
  const info = q(`INSERT INTO messages (chat_id, sender, type, text, media, mime, file_name, duration, once, reply_to, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(chat.id, user.id, fields.type, fields.text || null, fields.media || null,
    fields.mime || null, fields.fileName || null, fields.duration || null, fields.once ? 1 : 0, fields.replyTo || null, t);
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
  if (email && MAIL_ENABLED) sendOtp(user, 'verify', email).catch(() => {});
  send(res, 200, { me: me(user) });
});

route('POST', '/api/recover', async (req, res) => {
  rateLimit(req, 'recover', 10, 600e3);
  const b = await readJson(req);
  const nickname = normNick(b.nickname).toLowerCase(), code = normCode(b.code), email = normEmail(b.email);
  const u = q('SELECT * FROM users WHERE code = ?').get(code);
  const ok = u && u.nickname.toLowerCase() === nickname && u.email && email && u.email === email;
  if (!ok) fail(401, 'Those details don’t match. Check the nickname, room code and Gmail.');
  if (MAIL_ENABLED) {
    if (!u.email_verified) fail(403, 'That Gmail was never confirmed, so it can’t be used to recover this room.');
    if (!b.otp) { await sendOtp(u, 'recover', u.email); send(res, 200, { needCode: true, sentTo: maskEmail(u.email) }); return; }
    checkOtp(u, 'recover', b.otp);
  }
  newSession(req, res, u.id);
  send(res, 200, { me: me(u) });
});

route('POST', '/api/logout', async (req, res) => { clearSession(req, res); send(res, 200, { ok: true }); });

route('GET', '/api/me', async (req, res) => {
  const u = authUser(req);
  send(res, 200, { me: u ? me(u) : null, config: { mailEnabled: MAIL_ENABLED, maxStoryVideoSeconds: STORY_MAX_VIDEO_SECONDS } });
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
  const nickname = normNick(b.nickname).toLowerCase(), code = normCode(b.code);
  const text = String(b.text || '').trim().slice(0, 4000);
  const friend = q('SELECT * FROM users WHERE code = ?').get(code);
  if (!friend || friend.nickname.toLowerCase() !== nickname) fail(404, 'No one found with that nickname and room code.');
  if (friend.id === user.id) fail(400, 'That is your own room code.');
  const [a, bb] = pairKey(user.id, friend.id);
  let chat = q('SELECT * FROM chats WHERE user_a = ? AND user_b = ?').get(a, bb);
  if (chat) {
    chat.other = friend.id;
    if (chat.status === 'declined' || chat.status === 'blocked') fail(403, 'This person isn’t accepting messages from you.');
    prefsOf(chat.id, user.id);
    q('UPDATE chat_prefs SET hidden = 0 WHERE chat_id = ? AND user_id = ?').run(chat.id, user.id);
    send(res, 200, { chatId: chat.id, state: chatState(chat, user.id) });
    return;
  }
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
  if (chat.status !== 'pending' || chat.requester === user.id) fail(400, 'Nothing to accept.');
  q("UPDATE chats SET status = 'accepted' WHERE id = ?").run(chat.id);
});
chatAction('decline', (user, chat) => {
  if (chat.status !== 'pending' || chat.requester === user.id) fail(400, 'Nothing to decline.');
  q("UPDATE chats SET status = 'declined' WHERE id = ?").run(chat.id);
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
chatAction('report', (user, chat, body) => {
  const reason = String(body.reason || '').trim().slice(0, 300) || 'Not specified';
  q('INSERT INTO reports (reporter, reported, chat_id, reason, created_at) VALUES (?,?,?,?,?)').run(user.id, chat.other, chat.id, reason, now());
});
chatAction('seen', (user, chat) => {
  const rows = q('SELECT id FROM messages WHERE chat_id = ? AND sender != ? AND seen_at IS NULL').all(chat.id, user.id);
  if (!rows.length) return;
  const t = now();
  q('UPDATE messages SET seen_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE chat_id = ? AND sender != ? AND seen_at IS NULL').run(t, t, chat.id, user.id);
  push(chat.other, 'seen', { chatId: chat.id, ids: rows.map((r) => r.id), at: t });
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
    chat: { id: chat.id, state: chatState(chat, user.id), user: publicUser(other, chat), prefs: { pinned: !!p.pinned, muted: !!p.muted } },
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
  const b = await readJson(req);
  if (b.type === 'sticker') {
    const id = String(b.text || '');
    if (!/^(e:.{1,16}|t:[a-z0-9]{1,16})$/u.test(id)) fail(400, 'That sticker isn’t available.');
    send(res, 200, { message: createMessage(user, chat, { type: 'sticker', text: id, replyTo: replyIdFor(chat, b.replyTo) }) });
    return;
  }
  const text = String(b.text || '').trim();
  if (!text) fail(400, 'Write something first.');
  if (text.length > 4000) fail(400, 'That message is too long.');
  send(res, 200, { message: createMessage(user, chat, { type: 'text', text, replyTo: replyIdFor(chat, b.replyTo) }) });
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
  const { id } = await receiveUpload(req, MAX_UPLOAD[type]);
  const fileName = String(url.searchParams.get('name') || '').replace(/[\r\n\\/]/g, '').slice(0, 120) || null;
  const msg = createMessage(user, chat, {
    type, media: id, mime, fileName, duration: Math.min(Number(url.searchParams.get('dur')) || 0, 86400),
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
  let media = null;
  if (src.media) {
    media = crypto.randomBytes(16).toString('hex');
    try { fs.copyFileSync(path.join(MEDIA_DIR, src.media), path.join(MEDIA_DIR, media)); } catch { fail(410, 'That file is no longer available.'); }
  }
  send(res, 200, { message: createMessage(user, chat, { type: src.type, text: src.text, media, mime: src.mime, fileName: src.file_name, duration: src.duration }) });
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
    return { message: shapeMessage(m, user.id), chatId: chat.id, user: publicUser(other, chat) };
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
    friends.push({ user: { id: u.id, nickname: u.nickname, avatar: u.avatar || null }, stories, allSeen: stories.every((s) => s.seen), latest: rows[rows.length - 1].created_at });
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
  const { id } = await receiveUpload(req, MAX_UPLOAD[type]);
  const caption = String(url.searchParams.get('caption') || '').trim().slice(0, 300);
  const t = now();
  const info = q('INSERT INTO stories (user_id, kind, text, media, mime, duration, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(user.id, type, caption || null, id, mime, type === 'video' ? dur : null, t, t + STORY_MS);
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
route('POST', '/api/account/delete', async (req, res) => {
  const user = needUser(req);
  const b = await readJson(req);
  if (String(b.nickname || '').trim().toLowerCase() !== user.nickname.toLowerCase()) fail(400, 'Type your nickname exactly to confirm.');
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
  q('DELETE FROM story_views WHERE viewer_id = ?').run(user.id);
  q('DELETE FROM story_likes WHERE user_id = ?').run(user.id);
  q('DELETE FROM reactions WHERE user_id = ?').run(user.id);
  q('DELETE FROM stars WHERE user_id = ?').run(user.id);
  q('DELETE FROM push_subs WHERE user_id = ?').run(user.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  q('DELETE FROM users WHERE id = ?').run(user.id);
  res.setHeader('Set-Cookie', 'b1t3=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  send(res, 200, { ok: true });
});

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
    if (!(e instanceof HttpError)) console.error(e);
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
module.exports._test = { encryptPush, checkCode };
