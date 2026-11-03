'use strict';
/**
 * Kitchen Order Management System - server
 * Express (REST API) + ws (WebSocket live updates) + JSON file storage.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- tiny .env loader (no extra dependency) ----
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    if (line.trim().startsWith('#')) return;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env file, that's fine */ }

const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const STATUSES = ['preparing', 'ready', 'served'];

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */
const uid = () => crypto.randomBytes(6).toString('hex');
const nowMs = () => Date.now();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const a = crypto.scryptSync(String(password), user.salt, 64);
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const DEFAULT_SETTINGS = {
  restaurantName: 'Crave Yard',
  orangeAfterMin: 10,
  redAfterMin: 20,
  countryCode: '91',
  whatsappSenderPhone: '9778238561', // the number all WhatsApp messages are sent FROM
  whatsappCustomerReady: true,   // master switch for automatic customer messages
  reviewLink: '',                // e.g. your Google review link, used as {review_link}
  whatsappAdminNewOrder: false,
  whatsappAdminPhone: '',
};

function loadMenu() {
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
  return menu.map((m) => ({ id: uid(), name: m.name, category: m.category, price: m.price, available: true }));
}

const EVENTS = ['accepted', 'ready', 'served'];
const DEFAULT_TEMPLATES = [
  { name: 'Order accepted', event: 'accepted', enabled: true,
    text: 'Hi {name}, thank you for ordering from {restaurant}! \u2705 Your order {order} is accepted and being prepared.\n\n{items}\nTotal: {total}' },
  { name: 'Order ready', event: 'ready', enabled: true,
    text: 'Hi {name}, your order {order} at {restaurant} is ready! \ud83c\udf7d\ufe0f Please collect it. Thank you!' },
  { name: 'Order served + review', event: 'served', enabled: true,
    text: 'Hi {name}, we hope you enjoyed your meal at {restaurant}! \ud83d\ude0a\nWe would love your feedback, please leave a review: {review_link}' },
];
const newTemplates = () => DEFAULT_TEMPLATES.map((t) => ({ id: uid(), ...t }));

/* ---- passwords ---- */
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', 'admin', 'admin123', 'admin1234', 'kitchen', 'kitchen123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'abcd1234', 'abc12345', 'iloveyou', 'welcome1', 'welcome123', '11111111', '00000000', 'letmein123', 'craveyard', 'craveyard123', 'restaurant', 'restaurant123']);
function checkNewPassword(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(low) || /^(.)\1+$/.test(pw)) return 'That password is too common. Choose something unique.';
  if (/^\d+$/.test(pw)) return 'Use letters as well as numbers';
  if (username && low.includes(String(username).toLowerCase()) && String(username).length >= 4) return 'Password must not contain your username';
  return '';
}
function genPassword(len = 12) {   // easy to read out loud: no 0/O/1/l/I
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
}
const FIRST_LOGIN_FILE = path.join(path.dirname(DATA_FILE), 'FIRST-LOGIN.txt');
let initialPasswords = null;

function seed() {
  initialPasswords = { admin: process.env.ADMIN_PASSWORD || genPassword(), kitchen: process.env.KITCHEN_PASSWORD || genPassword() };
  const admin = hashPassword(initialPasswords.admin);
  const kitchen = hashPassword(initialPasswords.kitchen);
  return {
    meta: { day: '', counter: 0 },
    settings: { ...DEFAULT_SETTINGS },
    templates: newTemplates(),
    users: [
      { id: uid(), name: 'Administrator', username: 'admin', role: 'admin', active: true, mustChange: true, ...admin },
      { id: uid(), name: 'Head Chef', username: 'kitchen', role: 'kitchen', active: true, mustChange: true, ...kitchen },
    ],
    platforms: [
      { id: uid(), name: 'Table', color: '#2563eb', askTable: true },
      { id: uid(), name: 'Swiggy', color: '#fc8019', askTable: false },
      { id: uid(), name: 'Takeaway', color: '#16a34a', askTable: false },
      { id: uid(), name: 'Zomato', color: '#e23744', askTable: false },
    ],
    items: loadMenu(),
    orders: [],
    sessions: {},
  };
}

let db;
function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    db = seed();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    persistNow();
    console.log('\nCreated a fresh database. First-time logins (you must choose your own password on first sign-in):');
    console.log(`   admin    / ${initialPasswords.admin}    (Admin)`);
    console.log(`   kitchen  / ${initialPasswords.kitchen}    (Kitchen admin)`);
    try { fs.writeFileSync(FIRST_LOGIN_FILE, `Crave Yard first-time logins (this file is deleted after the admin sets a new password)\n\nadmin    / ${initialPasswords.admin}\nkitchen  / ${initialPasswords.kitchen}\n`); } catch (_) {}
  }
  // Databases from older versions used well-known default passwords: force a change at next login.
  let flagged = 0;
  for (const u of db.users || []) {
    if (!u.mustChange && ['admin123', 'kitchen123'].some((p) => { try { return checkPassword(p, u); } catch (_) { return false; } })) { u.mustChange = true; flagged++; }
  }
  if (flagged) { console.log(`Security: ${flagged} account(s) still use a default password. They must set a new one at next login.`); persistNow(); }
  db.menuOrder = db.menuOrder && typeof db.menuOrder === 'object' ? db.menuOrder : { cats: [], items: {} };
  db.sessions = db.sessions || {};
  db.meta = db.meta || { day: '', counter: 0 };
  if (!Array.isArray(db.templates)) db.templates = newTemplates();   // upgrade older databases
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) }; // fill in settings added in newer versions
  if (!db.settings.whatsappSenderPhone) db.settings.whatsappSenderPhone = DEFAULT_SETTINGS.whatsappSenderPhone;
}
let saveTimer = null;
function persistNow() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { persistNow(); } catch (e) { console.error('save failed', e); } }, 100);
}
load();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const httpErr = (message, status = 400) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active, mustChange: !!u.mustChange });
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey() { return new Date().toLocaleDateString('en-CA'); }
function nextOrderNo() {
  const d = dayKey();
  if (db.meta.day !== d) { db.meta.day = d; db.meta.counter = 0; }
  return ++db.meta.counter;
}
function normPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.length === 10) p = (db.settings.countryCode || '91') + p;
  return p;
}
const money = (n) => 'Rs. ' + Number(n).toFixed(2).replace(/\.00$/, '');

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
function sessionUser(token) {
  const s = token && db.sessions[token];
  if (!s) return null;
  if (nowMs() - s.createdAt > SESSION_TTL) { delete db.sessions[token]; return null; }
  const u = db.users.find((x) => x.id === s.userId);
  return u && u.active ? u : null;
}
function auth(roles) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = sessionUser(token);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    if (roles && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    const url = req.originalUrl.split('?')[0];
    if (user.mustChange && !['/api/me', '/api/me/password', '/api/logout'].includes(url)) return res.status(403).json({ error: 'Please set a new password first', mustChange: true });
    req.user = user; req.token = token;
    next();
  };
}

const attempts = new Map(); // ip -> { n, until }
function throttled(ip) { const a = attempts.get(ip); return a && a.until > nowMs(); }
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 10) { a.until = nowMs() + 5 * 60 * 1000; a.n = 0; }
  attempts.set(ip, a);
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  const user = sessionUser(token);
  if (!user) return ws.close(4001, 'unauthorized');
  ws.user = user; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'hello', role: user.role }));
});
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000).unref();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((ws) => { if (ws.readyState === 1) ws.send(data); });
}

/* ------------------------------------------------------------------ */
/* WhatsApp (Meta Cloud API). Works only when env vars are set.        */
/* ------------------------------------------------------------------ */
const GRAPH = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v20.0';
const waConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

// Option A: "linked phone" (scan a QR once, server sends from that WhatsApp account)
const link = require('./wa-link')({
  dir: path.join(path.dirname(DATA_FILE), 'wa-auth'),
  onChange: () => broadcast({ type: 'whatsapp' }),
});
if (link.hasSession()) link.start();

/** Sends through the linked phone if connected, otherwise through the Cloud API (Option B). */
async function sendWhatsApp(to, body) {
  const phone = normPhone(to);
  if (!phone) return { ok: false, error: 'No phone number' };
  if (link.connected()) return link.send(phone, body);
  if (waConfigured()) return sendViaApi(phone, body);
  return { ok: false, error: 'WhatsApp is not connected. Link your number in Admin > Settings.' };
}

/** Fill {placeholders} in a message template for an order. */
function renderTemplate(text, order) {
  const p = db.platforms.find((x) => x.id === order.platformId);
  const vars = {
    name: order.customerName || 'there',
    order: '#' + String(order.number).padStart(3, '0'),
    restaurant: db.settings.restaurantName,
    items: order.items.map((l) => `${l.qty} x ${l.name}`).join('\n'),
    total: money(order.total),
    platform: p ? p.name : '',
    table: order.tableNo || '',
    review_link: db.settings.reviewLink || '',
  };
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Automatic customer WhatsApp for an order event (accepted / ready / served).
 * Sends every enabled template for that event, once per order per event unless force=true.
 */
async function notifyCustomer(order, event, force = false) {
  if (!order.phone || !EVENTS.includes(event)) return;
  if (!force && !db.settings.whatsappCustomerReady) return;
  order.wa = order.wa || {};
  if (!force && order.wa[event] && order.wa[event].ok) return;
  const list = db.templates.filter((t) => t.event === event && t.enabled && String(t.text).trim());
  if (!list.length) return;
  let ok = true, error = '';
  for (const t of list) {
    const r = await sendWhatsApp(order.phone, renderTemplate(t.text, order));
    if (!r.ok) { ok = false; error = String(r.error || 'Failed'); break; }
  }
  order.wa[event] = { ok, error, at: nowMs() };
  save();
  broadcast({ type: 'orders', action: 'wa', order });
}

async function sendViaApi(phone, body) {
  try {
    const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('WhatsApp error:', JSON.stringify(j)); return { ok: false, error: (j.error && j.error.message) || 'WhatsApp error' }; }
    return { ok: true };
  } catch (e) {
    console.error('WhatsApp request failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Middleware & static                                                 */
/* ------------------------------------------------------------------ */
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- auth routes ---- */
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) throw httpErr('Too many attempts. Try again in a few minutes.', 429);
  const username = str(req.body.username, 60).toLowerCase();
  const user = db.users.find((u) => u.username.toLowerCase() === username);
  if (!user || !user.active || !checkPassword(req.body.password || '', user)) {
    noteFail(ip);
    throw httpErr('Invalid username or password', 401);
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId: user.id, createdAt: nowMs() };
  save();
  res.json({ token, user: publicUser(user) });
}));

app.post('/api/logout', auth(), (req, res) => { delete db.sessions[req.token]; save(); res.json({ ok: true }); });
app.get('/api/me', auth(), (req, res) => res.json(publicUser(req.user)));

app.put('/api/me/password', auth(), wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current || '', req.user)) throw httpErr('Current password is wrong');
  if (String(next) === String(current)) throw httpErr('Choose a different password from the current one');
  const bad = checkNewPassword(next, req.user.username); if (bad) throw httpErr(bad);
  Object.assign(req.user, hashPassword(next));
  delete req.user.mustChange;
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === req.user.id && t !== req.token) delete db.sessions[t]; });   // sign out other devices
  if (req.user.role === 'admin') { try { fs.rmSync(FIRST_LOGIN_FILE, { force: true }); } catch (_) {} }
  save();
  res.json({ ok: true });
}));

/* ---- settings ---- */
app.get('/api/settings', auth(), (req, res) => {
  const s = { ...db.settings };
  if (req.user.role !== 'admin') { delete s.whatsappAdminPhone; }
  res.json({ ...s, whatsappConfigured: waConfigured() || link.connected(), serverTime: nowMs() });
});
app.put('/api/settings', auth(['admin']), wrap(async (req, res) => {
  // Fields that are missing from the request keep their current value (a partial update must not reset toggles).
  const b = { ...db.settings, ...(req.body || {}) };
  const orange = Math.max(1, Math.min(600, parseInt(b.orangeAfterMin, 10) || 10));
  const red = Math.max(orange + 1, Math.min(1200, parseInt(b.redAfterMin, 10) || 20));
  db.settings = {
    restaurantName: str(b.restaurantName, 60) || 'My Kitchen',
    orangeAfterMin: orange,
    redAfterMin: red,
    countryCode: str(b.countryCode, 4).replace(/\D/g, '') || '91',
    whatsappSenderPhone: str(b.whatsappSenderPhone, 20).replace(/[^\d+ ]/g, '') || DEFAULT_SETTINGS.whatsappSenderPhone,
    whatsappCustomerReady: !!b.whatsappCustomerReady,
    reviewLink: str(b.reviewLink, 300),
    whatsappAdminNewOrder: !!b.whatsappAdminNewOrder,
    whatsappAdminPhone: str(b.whatsappAdminPhone, 20),
  };
  save();
  broadcast({ type: 'settings' });
  res.json(db.settings);
}));
/* ---- WhatsApp message templates (CRUD) ---- */
function templateFromBody(b) {
  const name = str(b.name, 60), text = String(b.text == null ? '' : b.text).trim().slice(0, 1000);
  if (!name) throw httpErr('Give the message a name');
  if (!EVENTS.includes(b.event)) throw httpErr('Choose when to send it (accepted, ready or served)');
  if (!text) throw httpErr('Message text is required');
  return { name, event: b.event, text, enabled: b.enabled !== false };
}
app.get('/api/templates', auth(['admin']), (req, res) => res.json(db.templates));
app.post('/api/templates', auth(['admin']), wrap(async (req, res) => {
  const t = { id: uid(), ...templateFromBody(req.body) };
  db.templates.push(t); save(); broadcast({ type: 'templates' });
  res.status(201).json(t);
}));
app.put('/api/templates/:id', auth(['admin']), wrap(async (req, res) => {
  const t = db.templates.find((x) => x.id === req.params.id);
  if (!t) throw httpErr('Not found', 404);
  Object.assign(t, templateFromBody({ ...t, ...req.body })); save(); broadcast({ type: 'templates' });
  res.json(t);
}));
app.delete('/api/templates/:id', auth(['admin']), wrap(async (req, res) => {
  const i = db.templates.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw httpErr('Not found', 404);
  db.templates.splice(i, 1); save(); broadcast({ type: 'templates' });
  res.json({ ok: true });
}));
app.post('/api/templates/reset', auth(['admin']), wrap(async (req, res) => {
  db.templates = newTemplates(); save(); broadcast({ type: 'templates' });
  res.json(db.templates);
}));

/* Linked-phone (QR) controls */
app.get('/api/whatsapp/link', auth(['admin']), (req, res) => res.json(link.state()));
app.post('/api/whatsapp/link/start', auth(['admin']), wrap(async (req, res) => { link.start(); res.json(link.state()); }));
app.post('/api/whatsapp/link/logout', auth(['admin']), wrap(async (req, res) => { await link.logout(); res.json(link.state()); }));

/** Checks which number the configured WhatsApp API credentials really send from. */
app.get('/api/whatsapp/status', auth(['admin']), wrap(async (req, res) => {
  const sender = normPhone(db.settings.whatsappSenderPhone);
  if (!waConfigured()) return res.json({ configured: false, sender });
  try {
    const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ configured: true, sender, error: (j.error && j.error.message) || 'Could not reach WhatsApp API' });
    const actual = String(j.display_phone_number || '').replace(/\D/g, '');
    res.json({ configured: true, sender, actual, name: j.verified_name || '', matches: !!actual && actual.endsWith(sender.slice(-10)) });
  } catch (e) { res.json({ configured: true, sender, error: e.message }); }
}));
app.post('/api/whatsapp/test',auth(['admin']), wrap(async (req, res) => {
  const to = req.body.phone || db.settings.whatsappAdminPhone;
  const r = await sendWhatsApp(to, `Test message from ${db.settings.restaurantName} kitchen system.`);
  if (!r.ok) throw httpErr(r.error);
  res.json({ ok: true });
}));

/* ---- kitchen admins (users with role=kitchen) ---- */
app.get('/api/users', auth(['admin']), (req, res) => res.json(db.users.filter((u) => u.role === 'kitchen').map(publicUser)));
app.post('/api/users', auth(['admin']), wrap(async (req, res) => {
  const name = str(req.body.name, 60); const username = str(req.body.username, 40).toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !username) throw httpErr('Name and username are required');
  const badPw = checkNewPassword(password, username); if (badPw) throw httpErr(badPw);
  if (db.users.some((u) => u.username.toLowerCase() === username)) throw httpErr('Username already exists');
  const user = { id: uid(), name, username, role: 'kitchen', active: req.body.active !== false, mustChange: true, ...hashPassword(password) };
  db.users.push(user); save();
  broadcast({ type: 'users' });
  res.status(201).json(publicUser(user));
}));
app.put('/api/users/:id', auth(['admin']), wrap(async (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id && u.role === 'kitchen');
  if (!user) throw httpErr('Not found', 404);
  const username = req.body.username !== undefined ? str(req.body.username, 40).toLowerCase() : user.username;
  if (!username) throw httpErr('Username is required');
  if (db.users.some((u) => u.id !== user.id && u.username.toLowerCase() === username)) throw httpErr('Username already exists');
  user.username = username;
  if (req.body.name !== undefined) user.name = str(req.body.name, 60) || user.name;
  if (req.body.active !== undefined) user.active = !!req.body.active;
  if (req.body.password) {
    const badPw = checkNewPassword(req.body.password, user.username); if (badPw) throw httpErr(badPw);
    Object.assign(user, hashPassword(req.body.password));
    user.mustChange = true;   // staff set their own password at next login
  }
  if (!user.active) Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === user.id) delete db.sessions[t]; });
  save();
  broadcast({ type: 'users' });
  res.json(publicUser(user));
}));
app.delete('/api/users/:id', auth(['admin']), wrap(async (req, res) => {
  const i = db.users.findIndex((u) => u.id === req.params.id && u.role === 'kitchen');
  if (i < 0) throw httpErr('Not found', 404);
  const [u] = db.users.splice(i, 1);
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].userId === u.id) delete db.sessions[t]; });
  save(); broadcast({ type: 'users' });
  res.json({ ok: true });
}));

/* ---- items ---- */
function itemFromBody(b) {
  const name = str(b.name, 80); const price = Number(b.price);
  if (!name) throw httpErr('Item name is required');
  if (!Number.isFinite(price) || price < 0) throw httpErr('Enter a valid price');
  return { name, category: str(b.category, 40) || 'General', price: Math.round(price * 100) / 100, available: b.available !== false };
}
app.get('/api/items', auth(), (req, res) => res.json(db.items));
app.post('/api/items', auth(['admin']), wrap(async (req, res) => {
  const item = { id: uid(), ...itemFromBody(req.body) };
  db.items.push(item); save(); broadcast({ type: 'items' });
  res.status(201).json(item);
}));
app.put('/api/items/:id', auth(['admin']), wrap(async (req, res) => {
  const item = db.items.find((i) => i.id === req.params.id);
  if (!item) throw httpErr('Not found', 404);
  Object.assign(item, itemFromBody({ ...item, ...req.body }));
  save(); broadcast({ type: 'items' });
  res.json(item);
}));
app.get('/api/menu-order', auth(), (req, res) => res.json(db.menuOrder));
app.put('/api/menu-order', auth(['admin']), wrap(async (req, res) => {
  const b = req.body || {}, mo = db.menuOrder;
  const names = (v) => (Array.isArray(v) ? v.map((x) => str(x, 40)).filter(Boolean).slice(0, 300) : null);
  if (b.cats) { const c = names(b.cats); if (!c) throw httpErr('Invalid order'); mo.cats = c; }
  if (b.items && typeof b.items === 'object') {
    Object.entries(b.items).slice(0, 300).forEach(([cat, ids]) => { const l = names(ids); if (l) mo.items[str(cat, 40)] = l; });
  }
  save(); broadcast({ type: 'items' });
  res.json(mo);
}));
app.put('/api/items-category', auth(['admin']), wrap(async (req, res) => {
  const category = str(req.body.category, 40), available = !!req.body.available;
  const list = db.items.filter((i) => i.category === category);
  if (!list.length) throw httpErr('Category not found', 404);
  list.forEach((i) => { i.available = available; });
  save(); broadcast({ type: 'items' });
  res.json({ ok: true, count: list.length });
}));
app.delete('/api/items/:id', auth(['admin']), wrap(async (req, res) => {
  const i = db.items.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw httpErr('Not found', 404);
  db.items.splice(i, 1); save(); broadcast({ type: 'items' });
  res.json({ ok: true });
}));

/* ---- platforms ---- */
function platformFromBody(b) {
  const name = str(b.name, 40);
  if (!name) throw httpErr('Platform name is required');
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#64748b';
  return { name, color, askTable: !!b.askTable };
}
app.get('/api/platforms', auth(), (req, res) => res.json(db.platforms));
app.post('/api/platforms', auth(['admin']), wrap(async (req, res) => {
  const p = { id: uid(), ...platformFromBody(req.body) };
  if (db.platforms.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) throw httpErr('Platform already exists');
  db.platforms.push(p); save(); broadcast({ type: 'platforms' });
  res.status(201).json(p);
}));
app.put('/api/platforms/:id', auth(['admin']), wrap(async (req, res) => {
  const p = db.platforms.find((x) => x.id === req.params.id);
  if (!p) throw httpErr('Not found', 404);
  const next = platformFromBody({ ...p, ...req.body });
  if (db.platforms.some((x) => x.id !== p.id && x.name.toLowerCase() === next.name.toLowerCase())) throw httpErr('Platform already exists');
  Object.assign(p, next); save(); broadcast({ type: 'platforms' });
  res.json(p);
}));
app.delete('/api/platforms/:id', auth(['admin']), wrap(async (req, res) => {
  const i = db.platforms.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw httpErr('Not found', 404);
  if (db.orders.some((o) => o.platformId === req.params.id)) throw httpErr('This platform has orders. Rename it instead of deleting.', 409);
  if (integ.usesPlatform(req.params.id)) throw httpErr('An integration sends orders to this platform. Change or delete the integration first.', 409);
  db.platforms.splice(i, 1); save(); broadcast({ type: 'platforms' });
  res.json({ ok: true });
}));

/* ---- orders ---- */
function buildOrderFields(body, existing) {
  const platform = db.platforms.find((p) => p.id === body.platformId);
  if (!platform) throw httpErr('Choose a platform');
  if (!Array.isArray(body.items) || !body.items.length) throw httpErr('Add at least one item');
  const lines = [];
  for (const l of body.items) {
    const qty = Math.min(99, Math.max(1, parseInt(l.qty, 10) || 0));
    const old = existing && existing.items.find((x) => x.itemId === l.itemId);
    const it = db.items.find((i) => i.id === l.itemId);
    if (old) lines.push({ ...old, qty });
    else if (it && it.available) lines.push({ itemId: it.id, name: it.name, price: it.price, qty });
    else throw httpErr(it ? `"${it.name}" is not available right now` : 'Unknown item in order');
  }
  const tableNo = str(body.tableNo, 20);
  if (platform.askTable && !tableNo) throw httpErr('Table number is required for ' + platform.name);
  return {
    platformId: platform.id,
    tableNo: platform.askTable ? tableNo : '',
    customerName: str(body.customerName, 60),
    phone: str(body.phone, 20),
    notes: str(body.notes, 300),
    items: lines,
    total: Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100,
  };
}
const platformOf = (o) => db.platforms.find((p) => p.id === o.platformId);

app.get('/api/orders', auth(), (req, res) => {
  const since = startOfToday();
  let list = db.orders;
  if (req.query.range !== 'all') list = list.filter((o) => o.createdAt >= since || o.status !== 'served');
  list = list.slice().sort((a, b) => a.createdAt - b.createdAt).slice(-500);
  res.json(list);
});

/** Shared by manual orders and integration orders: live update, customer "accepted" message, admin alert. */
function announceNewOrder(order, { customer = true } = {}) {
  broadcast({ type: 'orders', action: 'created', order });
  if (customer) notifyCustomer(order, 'accepted');            // "your order is accepted" to the customer
  if (db.settings.whatsappAdminNewOrder && db.settings.whatsappAdminPhone) {
    const p = platformOf(order);
    sendWhatsApp(db.settings.whatsappAdminPhone,
      `New order #${order.number} (${p ? p.name : ''}${order.tableNo ? ' / Table ' + order.tableNo : ''}) - ${order.items.length} item(s), ${money(order.total)}`);
  }
}

app.post('/api/orders', auth(['admin']), wrap(async (req, res) => {
  const fields = buildOrderFields(req.body);
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'preparing';
  const t = nowMs();
  const order = {
    id: uid(), number: nextOrderNo(), ...fields, status,
    createdAt: t, updatedAt: t, readyAt: status !== 'preparing' ? t : null, servedAt: status === 'served' ? t : null,
    createdBy: req.user.name,
  };
  db.orders.push(order); save();
  announceNewOrder(order, { customer: true });
  if (status !== 'preparing') notifyCustomer(order, status);   // order created already ready/served
  res.status(201).json(order);
}));

/** Edit the items of an order directly (change name, quantity or price, add or remove lines). Works for POS orders too. */
app.put('/api/orders/:id/items', auth(['admin']), wrap(async (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) throw httpErr('Not found', 404);
  const rows = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rows.length) throw httpErr('An order needs at least one item');
  if (rows.length > 60) throw httpErr('Too many items');
  const lines = rows.map((r) => {
    const name = str(r.name, 120);
    if (!name) throw httpErr('Every item needs a name');
    const qty = Math.round(Number(r.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) throw httpErr('Quantity must be between 1 and 99');
    const price = Number(r.price === '' || r.price == null ? 0 : r.price);
    if (!Number.isFinite(price) || price < 0 || price > 1000000) throw httpErr('Price must be a number, 0 or more');
    const old = order.items.find((x) => x.itemId === r.itemId);
    const menu = db.items.find((i) => i.id === r.itemId || i.name.toLowerCase() === name.toLowerCase());
    return { itemId: old ? old.itemId : menu ? menu.id : 'ext-' + uid(), name, price: Math.round(price * 100) / 100, qty };
  });
  order.items = lines;
  order.total = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
  order.updatedAt = nowMs(); save();
  broadcast({ type: 'orders', action: 'updated', order });
  res.json(order);
}));

app.put('/api/orders/:id', auth(['admin']), wrap(async (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) throw httpErr('Not found', 404);
  const oldPhone = order.phone;
  Object.assign(order, buildOrderFields(req.body, order), { updatedAt: nowMs() });
  if (order.phone !== oldPhone) delete order.wa;   // new number -> allow fresh messages
  let changedTo = null;
  if (STATUSES.includes(req.body.status) && req.body.status !== order.status) { applyStatus(order, req.body.status); changedTo = order.status; }
  save();
  broadcast({ type: 'orders', action: 'updated', order });
  if (changedTo) integ.onStatus(order);
  if (changedTo === 'ready' || changedTo === 'served') notifyCustomer(order, changedTo);
  res.json(order);
}));

function applyStatus(order, status) {
  const t = nowMs();
  order.status = status; order.updatedAt = t;
  if (status === 'preparing') { order.readyAt = null; order.servedAt = null; }
  if (status === 'ready') { order.readyAt = t; order.servedAt = null; }
  if (status === 'served') { order.readyAt = order.readyAt || t; order.servedAt = t; }
}

app.patch('/api/orders/:id/status', auth(['admin', 'kitchen']), wrap(async (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) throw httpErr('Not found', 404);
  const status = req.body.status;
  if (!STATUSES.includes(status)) throw httpErr('Invalid status');
  if (order.status !== status) {
    applyStatus(order, status);
    save();
    broadcast({ type: 'orders', action: 'status', order });
    integ.onStatus(order);                                 // tell Swiggy / POS (if this order came from one)
    if (status === 'ready' || status === 'served') notifyCustomer(order, status);   // automatic WhatsApp (not awaited)
  }
  res.json(order);
}));

/** Manually (re)send a customer WhatsApp. body.event = accepted | ready | served (default: matches current status). */
app.post('/api/orders/:id/whatsapp', auth(['admin', 'kitchen']), wrap(async (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) throw httpErr('Not found', 404);
  if (!order.phone) throw httpErr('This order has no WhatsApp number');
  const event = EVENTS.includes(req.body.event) ? req.body.event : (order.status === 'preparing' ? 'accepted' : order.status);
  if (!db.templates.some((t) => t.event === event && t.enabled)) throw httpErr(`No enabled "${event}" message. Turn one on in Settings > WhatsApp messages.`);
  await notifyCustomer(order, event, true);
  res.json(order);
}));

app.delete('/api/orders/:id',auth(['admin']), wrap(async (req, res) => {
  const i = db.orders.findIndex((o) => o.id === req.params.id);
  if (i < 0) throw httpErr('Not found', 404);
  const [order] = db.orders.splice(i, 1);
  save(); broadcast({ type: 'orders', action: 'deleted', order });
  res.json({ ok: true });
}));

/* ---- public: restaurant name for the sign-in page ---- */
app.get('/api/brand', (req, res) => res.json({ name: String((db.settings && db.settings.restaurantName) || '').slice(0, 60) }));

/* ---- overview ---- */
app.get('/api/overview', auth(['admin']), (req, res) => {
  const since = startOfToday();
  const today = db.orders.filter((o) => o.createdAt >= since);
  const byStatus = { preparing: 0, ready: 0, served: 0 };
  today.forEach((o) => { byStatus[o.status] += 1; });
  const byPlatform = db.platforms.map((p) => {
    const list = today.filter((o) => o.platformId === p.id);
    return { id: p.id, name: p.name, color: p.color, count: list.length, revenue: list.reduce((s, o) => s + o.total, 0) };
  });
  const qty = {};
  today.forEach((o) => o.items.forEach((l) => { qty[l.name] = (qty[l.name] || 0) + l.qty; }));
  const topItems = Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, q]) => ({ name, qty: q }));
  const prep = today.filter((o) => o.readyAt).map((o) => o.readyAt - o.createdAt);
  const redMs = (Number(db.settings.redAfterMin) || 20) * 60000, nowMs = Date.now();
  const lateList = db.orders.filter((o) => o.status !== 'served')
    .map((o) => ({ o, age: nowMs - (o.status === 'ready' ? (o.readyAt || o.updatedAt || o.createdAt) : o.createdAt) }))
    .filter((x) => x.age >= redMs).sort((a, b) => b.age - a.age);
  res.json({
    late: { count: lateList.length, redAfterMin: Number(db.settings.redAfterMin) || 20, oldest: lateList[0] ? { number: lateList[0].o.number, tableNo: lateList[0].o.tableNo || '', platformId: lateList[0].o.platformId, ageMs: lateList[0].age } : null },
    avgOrderValue: today.length ? Math.round(today.reduce((s, o) => s + o.total, 0) / today.length) : 0,
    totalOrders: today.length,
    revenue: Math.round(today.reduce((s, o) => s + o.total, 0) * 100) / 100,
    active: db.orders.filter((o) => o.status !== 'served').length,
    byStatus, byPlatform, topItems,
    avgPrepMinutes: prep.length ? Math.round((prep.reduce((a, b) => a + b, 0) / prep.length / 60000) * 10) / 10 : null,
    recent: today.slice(-6).reverse(),
  });
});

/* ---- integrations (Swiggy / Zomato / POS webhooks) ---- */
const plink = require('./wa-link')({
  dir: path.join(path.dirname(DATA_FILE), 'wa-auth-purchase'),
  onChange: () => broadcast({ type: 'purchase', action: 'wa' }),
});
if (plink.hasSession()) plink.start();
require('./purchase').install({ app, auth, wrap, httpErr, str, uid, nowMs, getDb: () => db, save, broadcast, sendWhatsApp, throttled, noteFail, hashPassword, checkPassword, plink, normPhone, mainStatus: () => ({ connected: link.connected() || waConfigured(), number: link.state().number || '' }) });
const integ = require('./integrations').install({ app, auth, wrap, httpErr, str, uid, nowMs, getDb: () => db, save, broadcast, nextOrderNo, announceNewOrder, throttled, noteFail, applyStatus, notifyCustomer });

/* ---- errors ---- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status !== 400 && !err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

server.listen(PORT, () => {
  console.log(`\nKitchen Order System running on http://localhost:${PORT}`);
  console.log(`WhatsApp: ${link.hasSession() ? 'linked phone session found, reconnecting' : waConfigured() ? 'Cloud API configured' : 'not connected (link your number in Admin > Settings)'}`);
});

function shutdown() { clearTimeout(saveTimer); try { persistNow(); } catch (_) {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
