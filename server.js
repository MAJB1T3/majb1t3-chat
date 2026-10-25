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
`);

const q = (sql) => db.prepare(sql);
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const NICK_RE = /^[A-Za-z0-9_.\-]{2,24}$/;
const CODE_RE = /^[A-Z0-9\-]{4,24}$/;
const normCode = (c) => String(c || '').trim().toUpperCase();
const normNick = (n) => String(n || '').trim();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function setSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)').run(sha(token), userId, now());
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
  const row = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(t));
  return row || null;
}
function needUser(req) {
  const u = authUser(req);
  if (!u) fail(401, 'Please sign in again.');
  return u;
}

// simple per-IP rate limiter
const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) fail(429, 'Too many tries. Please wait a few minutes and try again.');
  arr.push(t);
  hits.set(key, arr);
}
setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();

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
function publicUser(u, viewer, chat) {
  // last seen and online are always visible to accepted friends; strangers see nothing
  const friend = chat && chat.status === 'accepted';
  return {
    id: u.id, nickname: u.nickname, avatar: u.avatar || null,
    online: friend ? isOnline(u.id) : false, lastSeen: friend ? u.last_seen : null
  };
}
function previewOf(m) {
  if (!m) return '';
  if (m.deleted_all) return 'This message was deleted';
  const tag = m.once ? 'View once ' : '';
  if (m.type === 'text') return m.text;
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
    text: m.deleted_all ? '' : (m.type === 'text' ? m.text : (m.text || '')),
    hasMedia: !m.deleted_all && !!m.media, replyTo: null
  };
  if (m.edited_at && !m.deleted_all && mine) out.original = m.original_text;
  if (m.reply_to) {
    const r = q('SELECT id, sender, type, text, file_name, once, deleted_all FROM messages WHERE id = ?').get(m.reply_to);
    if (r) out.replyTo = { id: r.id, mine: r.sender === viewerId, preview: previewOf(r).slice(0, 120) };
  }
  return out;
}
function visibleMessages(user, chat, beforeId, limit) {
  const p = prefsOf(chat.id, user.id);
  const rows = q(`SELECT m.* FROM messages m WHERE m.chat_id = ? AND m.created_at > ? AND m.id < ?
    AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.user_id = ?)
    ORDER BY m.id DESC LIMIT ?`).all(chat.id, p.cleared_at, beforeId || 9e15, user.id, limit);
  return rows.reverse().map((m) => shapeMessage(m, user.id));
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
    const last = q(`SELECT m.* FROM messages m WHERE m.chat_id = ? AND m.created_at > ?
      AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.user_id = ?)
      ORDER BY m.id DESC LIMIT 1`).get(c.id, p.cleared_at, user.id);
    const unread = q(`SELECT COUNT(*) n FROM messages m WHERE m.chat_id = ? AND m.sender != ? AND m.seen_at IS NULL
      AND m.created_at > ? AND m.deleted_all = 0
      AND NOT EXISTS (SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.user_id = ?)`)
      .get(c.id, user.id, p.cleared_at, user.id).n;
    let state = c.status;
    if (c.status === 'pending') state = c.requester === user.id ? 'waiting' : 'request';
    if (c.status === 'blocked') state = c.blocked_by === user.id ? 'blocked' : 'blocked-by-them';
    out.push({
      id: c.id, state, user: publicUser(other, user, c), pinned: !!p.pinned, muted: !!p.muted,
      unread, last: last ? { preview: previewOf(last), mine: last.sender === user.id, at: last.created_at } : null,
      updatedAt: last ? last.created_at : c.created_at
    });
  }
  return out;
}
function me(user) {
  return { id: user.id, nickname: user.nickname, code: user.code, avatar: user.avatar || null, hasEmail: !!user.email_hash };
}

// ---------- message creation ----------
function createMessage(user, chat, fields) {
  const t = now();
  const info = q(`INSERT INTO messages (chat_id, sender, type, text, media, mime, file_name, duration, once, reply_to, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(chat.id, user.id, fields.type, fields.text || null, fields.media || null,
    fields.mime || null, fields.fileName || null, fields.duration || null, fields.once ? 1 : 0, fields.replyTo || null, t);
  const id = Number(info.lastInsertRowid);
  // a new message brings a deleted/hidden chat back for the person receiving it
  q('INSERT OR IGNORE INTO chat_prefs (chat_id, user_id) VALUES (?,?)').run(chat.id, chat.other);
  q('UPDATE chat_prefs SET hidden = 0 WHERE chat_id = ? AND user_id = ?').run(chat.id, chat.other);
  q('UPDATE chat_prefs SET hidden = 0 WHERE chat_id = ? AND user_id = ?').run(chat.id, user.id);
  const row = q('SELECT * FROM messages WHERE id = ?').get(id);
  if (isOnline(chat.other)) {
    q('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now(), id);
    row.delivered_at = now();
  }
  push(chat.other, 'message', { message: shapeMessage(row, chat.other), chatId: chat.id });
  push(user.id, 'message-echo', { message: shapeMessage(row, user.id), chatId: chat.id });
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

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('POST', '/api/create', async (req, res) => {
  rateLimit(req, 'create', 15, 3600e3);
  const b = await readJson(req);
  const nickname = normNick(b.nickname), code = normCode(b.code), email = normEmail(b.email);
  if (!NICK_RE.test(nickname)) fail(400, 'Nickname must be 2 to 24 letters, numbers, dots, dashes or underscores.');
  if (!CODE_RE.test(code)) fail(400, 'Room code must be 4 to 24 characters: letters, numbers or dashes.');
  if (email && !EMAIL_RE.test(email)) fail(400, 'That Gmail address doesn’t look right.');
  if (q('SELECT 1 FROM users WHERE code = ?').get(code)) fail(409, 'Someone else is already using this room code. Try another one.');
  const t = now();
  const info = q('INSERT INTO users (nickname, code, email_hash, avatar, created_at, last_seen) VALUES (?,?,?,?,?,?)')
    .run(nickname, code, email ? sha(email) : null, null, t, t);
  const user = q('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  setSession(req, res, user.id);
  send(res, 200, { me: me(user) });
});

route('POST', '/api/recover', async (req, res) => {
  rateLimit(req, 'recover', 10, 600e3);
  const b = await readJson(req);
  const nickname = normNick(b.nickname).toLowerCase(), code = normCode(b.code), email = normEmail(b.email);
  const u = q('SELECT * FROM users WHERE code = ?').get(code);
  const ok = u && u.nickname.toLowerCase() === nickname && u.email_hash && email && u.email_hash === sha(email);
  if (!ok) fail(401, 'Those details don’t match. Check the nickname, room code and Gmail.');
  setSession(req, res, u.id);
  send(res, 200, { me: me(u) });
});

route('POST', '/api/logout', async (req, res) => { clearSession(req, res); send(res, 200, { ok: true }); });

route('GET', '/api/me', async (req, res) => {
  const u = authUser(req);
  send(res, 200, { me: u ? me(u) : null });
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
  q('UPDATE users SET email_hash = ? WHERE id = ?').run(sha(email), u.id);
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
    send(res, 200, { chatId: chat.id, state: chat.status });
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
  const before = Number(url.searchParams.get('before')) || 0;
  const other = q('SELECT * FROM users WHERE id = ?').get(chat.other);
  let state = chat.status;
  if (chat.status === 'pending') state = chat.requester === user.id ? 'waiting' : 'request';
  if (chat.status === 'blocked') state = chat.blocked_by === user.id ? 'blocked' : 'blocked-by-them';
  send(res, 200, {
    chat: { id: chat.id, state, user: publicUser(other, user, chat), prefs: (({ pinned, muted }) => ({ pinned: !!pinned, muted: !!muted }))(prefsOf(chat.id, user.id)) },
    messages: visibleMessages(user, chat, before, 60)
  });
});

route('POST', '/api/chats/:id/messages', async (req, res, params) => {
  const user = needUser(req);
  const chat = getChatFor(user, params.id);
  assertCanSend(user, chat);
  const b = await readJson(req);
  const text = String(b.text || '').trim();
  if (!text) fail(400, 'Write something first.');
  if (text.length > 4000) fail(400, 'That message is too long.');
  const msg = createMessage(user, chat, { type: 'text', text, replyTo: replyIdFor(chat, b.replyTo) });
  send(res, 200, { message: msg });
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
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_UPLOAD[type]) fail(413, 'That file is too large.');
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(MEDIA_DIR, id);
  const out = fs.createWriteStream(file);
  let size = 0, tooBig = false;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD[type]) { tooBig = true; req.destroy(); out.destroy(); resolve(); }
    });
    req.on('error', reject);
    req.on('aborted', () => resolve());
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  if (tooBig || !size) { fs.rm(file, { force: true }, () => {}); fail(tooBig ? 413 : 400, tooBig ? 'That file is too large.' : 'Empty upload.'); }
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
  const srcChat = getChatFor(user, src.chat_id);
  if (src.deleted_all || q('SELECT 1 FROM hidden_messages WHERE message_id = ? AND user_id = ?').get(src.id, user.id)) fail(404, 'Message not found.');
  if (src.once) fail(400, 'View once messages can’t be forwarded.');
  void srcChat;
  let media = null;
  if (src.media) {
    media = crypto.randomBytes(16).toString('hex');
    try { fs.copyFileSync(path.join(MEDIA_DIR, src.media), path.join(MEDIA_DIR, media)); } catch { fail(410, 'That file is no longer available.'); }
  }
  const msg = createMessage(user, chat, { type: src.type, text: src.text, media, mime: src.mime, fileName: src.file_name, duration: src.duration });
  send(res, 200, { message: msg });
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
  const scope = url.searchParams.get('scope');
  if (scope === 'all') {
    if (m.sender !== user.id) fail(403, 'You can only delete your own messages for everyone.');
    if (m.media) fs.rm(path.join(MEDIA_DIR, m.media), { force: true }, () => {});
    q('UPDATE messages SET deleted_all = 1, text = NULL, media = NULL, original_text = NULL WHERE id = ?').run(m.id);
    const row = q('SELECT * FROM messages WHERE id = ?').get(m.id);
    push(chat.other, 'edit', { message: shapeMessage(row, chat.other) });
    send(res, 200, { message: shapeMessage(row, user.id) });
  } else {
    q('INSERT OR IGNORE INTO hidden_messages (message_id, user_id) VALUES (?,?)').run(m.id, user.id);
    send(res, 200, { ok: true, id: m.id });
  }
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function serveMedia(req, res, id) {
  const user = needUser(req);
  const m = q('SELECT * FROM messages WHERE id = ?').get(Number(id));
  if (!m || !m.media || m.deleted_all) fail(404, 'This file is no longer available.');
  getChatFor(user, m.chat_id);
  if (q('SELECT 1 FROM hidden_messages WHERE message_id = ? AND user_id = ?').get(m.id, user.id)) fail(404, 'This file is no longer available.');
  const mine = m.sender === user.id;
  if (m.once) {
    if (mine) fail(403, 'View once files can’t be opened by the sender.');
    if (m.opened_at) fail(410, 'This was view once and has already been opened.');
    q('UPDATE messages SET opened_at = ? WHERE id = ?').run(now(), m.id);
    push(m.sender, 'opened', { id: m.id, chatId: m.chat_id });
  }
  const file = path.join(MEDIA_DIR, m.media);
  let stat;
  try { stat = fs.statSync(file); } catch { fail(404, 'This file is no longer available.'); }
  const inline = /^(image\/(jpeg|png|webp|gif|heic|heif)|audio\/|video\/)/.test(m.mime || '');
  const headers = {
    'Content-Type': inline ? m.mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': m.once ? 'no-store' : 'private, max-age=3600', 'Accept-Ranges': m.once ? 'none' : 'bytes',
    'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(m.file_name || 'file') + '"'
  };
  const range = !m.once && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 }));
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, Object.assign(headers, { 'Content-Length': stat.size }));
    fs.createReadStream(file).pipe(res);
  }
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
    // single-page app fallback
    const idx = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(idx).pipe(res);
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

if (require.main === module) {
  server.listen(PORT, () => console.log('MAJB1T3 Chat running on port ' + PORT + ' (data: ' + DATA_DIR + ')'));
}
module.exports = server;
