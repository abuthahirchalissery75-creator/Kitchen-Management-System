'use strict';
/**
 * Integrations: receive orders from Swiggy / Zomato / a POS (or anything that can send a webhook),
 * and optionally send status updates (preparing / ready / served) back to them.
 *
 *   IN : POST /hook/:id   with the integration's API key  ->  creates an order in "Preparing"
 *   OUT: on every status change of such an order, POST/PUT to the integration's callback URL
 *
 * Swiggy and Zomato do not hand restaurants a public order API directly: orders normally reach you through a
 * POS / aggregator that does ("Petpooja", "UrbanPiper", ...). This module therefore speaks plain JSON webhooks and
 * lets you map ANY payload shape with simple field paths (or leave them blank to auto-detect common names).
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const WebSocket = require('ws');

const TYPES = ['swiggy', 'zomato', 'pos', 'custom'];
const MAP_KEYS = ['externalId', 'customerName', 'phone', 'notes', 'tableNo', 'total', 'items', 'itemName', 'itemQty', 'itemPrice'];
const STATUSES = ['preparing', 'ready', 'served'];
const LOG_CAP = 300;

// Auto-detect: first of these paths that exists in the payload is used (only when the mapping field is blank).
const CANDIDATES = {
  externalId: ['id', 'order_id', 'orderId', 'orderID', 'order.id', 'order.order_id', 'order.orderId', 'data.order_id', 'data.id', 'data.orderId', 'order_number', 'orderNumber', 'order.order_number', 'order.orderNumber', 'reference', 'ref'],
  customerName: ['customer.name', 'customer_name', 'customerName', 'order.customer.name', 'order.customer_name', 'data.customer.name', 'customer.first_name', 'name'],
  phone: ['customer.phone', 'customer_phone', 'customerPhone', 'customer.mobile', 'phone', 'mobile', 'order.customer.phone', 'data.customer.phone'],
  notes: ['notes', 'instructions', 'special_instructions', 'specialInstructions', 'cooking_instructions', 'order.instructions', 'order.notes', 'order_instructions', 'customer_notes', 'data.instructions', 'comment', 'remarks'],
  tableNo: ['table', 'table_no', 'tableNo', 'table_number', 'tableNumber', 'order.table', 'order.table_no'],
  total: ['total', 'order_total', 'orderTotal', 'grand_total', 'grandTotal', 'amount', 'order.total', 'order.order_total', 'data.total', 'bill_amount'],
  items: ['items', 'order_items', 'orderItems', 'line_items', 'lineItems', 'products', 'cart.items', 'order.items', 'order.order_items', 'order.line_items', 'data.items', 'data.order_items', 'order_details.items'],
  itemName: ['name', 'item_name', 'itemName', 'title', 'product_name', 'productName', 'item.name', 'product.name', 'dish'],
  itemQty: ['quantity', 'qty', 'count', 'item_quantity', 'itemQuantity', 'units'],
  itemPrice: ['price', 'unit_price', 'unitPrice', 'rate', 'item_price', 'itemPrice', 'selling_price', 'sellingPrice', 'item.price'],
};

/** a.b[0].c or a.b.0.c -> value (never walks into prototypes) */
function getPath(obj, p) {
  if (!p) return undefined;
  const parts = String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
    cur = cur[k];
  }
  return cur;
}
function pickValue(obj, custom, key) {
  const paths = custom ? [custom] : CANDIDATES[key];
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v != null && v !== '' && typeof v !== 'object') return v;
  }
  return undefined;
}
function pickArray(obj, custom) {
  const paths = custom ? [custom] : CANDIDATES.items;
  for (const p of paths) { const v = getPath(obj, p); if (Array.isArray(v) && v.length) return v; }
  return null;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/* ---------- outbound safety: block calls into private networks ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function assertSafeUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new Error('That address is not valid'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://');
  if (process.env.ALLOW_PRIVATE_CALLBACKS === '1') return u;
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address points to a private/internal address (blocked for safety)');
  return u;
}

function install(ctx) {
  const { app, auth, wrap, httpErr, str, uid, nowMs, getDb, save, broadcast, nextOrderNo, announceNewOrder, throttled, noteFail, applyStatus, notifyCustomer } = ctx;
  const D = () => { const d = getDb(); d.integrations = d.integrations || []; d.integrationLogs = d.integrationLogs || []; return d; };
  const newKey = () => 'kos_' + crypto.randomBytes(24).toString('hex');
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  function log(integ, kind, ok, message, extra = {}) {
    const d = D();
    d.integrationLogs.push({ id: uid(), integrationId: integ.id, integrationName: integ.name, at: nowMs(), kind, ok, message: clean(message, 300), ...extra });
    if (d.integrationLogs.length > LOG_CAP) d.integrationLogs.splice(0, d.integrationLogs.length - LOG_CAP);
    save(); broadcast({ type: 'integrations' });
  }

  /* ------------------------------ validation ------------------------------ */
  function fromBody(b, existing) {
    const d = D();
    const name = str(b.name, 60);
    if (!name) throw httpErr('Give this integration a name');
    const type = TYPES.includes(b.type) ? b.type : (existing ? existing.type : 'custom');
    if (!d.platforms.some((p) => p.id === b.platformId)) throw httpErr('Choose which platform these orders belong to');
    const mapping = {};
    MAP_KEYS.forEach((k) => { const v = str(b.mapping && b.mapping[k], 120); if (v) { if (!/^[A-Za-z0-9_.\[\]$-]+$/.test(v)) throw httpErr(`Field path for "${k}" can only contain letters, numbers and . _ [ ] -`); mapping[k] = v; } });
    const c = b.callback || {};
    const callback = { enabled: !!c.enabled, url: str(c.url, 500), method: c.method === 'PUT' ? 'PUT' : 'POST', headerName: str(c.headerName, 40), headerValue: str(c.headerValue, 300), statusMap: {} };
    STATUSES.forEach((s) => { callback.statusMap[s] = str(c.statusMap && c.statusMap[s], 40) || s; });
    if (callback.enabled) {
      if (!callback.url) throw httpErr('Enter the URL to send status updates to, or turn that option off');
      try { if (!/^https?:$/.test(new URL(callback.url).protocol)) throw new Error('x'); } catch (_) { throw httpErr('Status update URL must start with http:// or https://'); }
    }
    if (callback.headerName && (!/^[A-Za-z0-9-]+$/.test(callback.headerName) || /^(host|content-length|connection|transfer-encoding)$/i.test(callback.headerName))) throw httpErr('That header name is not allowed');
    callback.headerValue = callback.headerValue.replace(/[\r\n]/g, '');
    const mode = b.mode === 'pull' ? 'pull' : 'push';
    let pull = (existing && existing.pull) || { url: '', key: '', headerName: '', intervalSec: 10 };
    if (mode === 'pull') {
      const p = b.pull || {};
      const channel = str(p.channel, 300).replace(/[^\w:.,\-\[\]\/ ]/g, '');
      const url = str(p.url, 500);
      if (!url && !channel) throw httpErr('Enter the address your POS gave you (or the channel name if it is an Ably key)');
      if (url) { try { if (!/^(https?|wss?):$/.test(new URL(url).protocol)) throw new Error('x'); } catch (_) { throw httpErr('The address must start with https:// or wss://'); } }
      const key = str(p.key, 400).replace(/[\r\n"']/g, '').replace(/^\s*\w*API_KEY\s*=\s*/i, '').trim() || pull.key;
      if (!key) throw httpErr('Paste the API key your POS gave you');
      const headerName = str(p.headerName, 40);
      if (headerName && (!/^[A-Za-z0-9-]+$/.test(headerName) || /^(host|content-length|connection|transfer-encoding)$/i.test(headerName))) throw httpErr('That header name is not allowed');
      pull = { url, channel, key, headerName, hello: str(p.hello, 500), intervalSec: Math.min(300, Math.max(5, parseInt(p.intervalSec, 10) || 10)) };
    }
    return { name, type, mode, pull, waitAccept: !!b.waitAccept, platformId: b.platformId, enabled: b.enabled !== false, whatsapp: !!b.whatsapp, mapping, callback };
  }
  const withStats = (i) => {
    const o = { ...i }; delete o.heldList; delete o.recent;
    const m = i.mapping || {};
    o.held = [...heldOf(i)].map(([id, v]) => ({ id, at: v.at, table: clean(pickValue(v.payload, m.tableNo, 'tableNo'), 20), customer: clean(pickValue(v.payload, m.customerName, 'customerName'), 60),
      items: (pickArray(v.payload, m.items) || []).slice(0, 4).map((r) => clean(pickValue(r, m.itemName, 'itemName'), 40)).filter(Boolean) }));
    return o;
  };

  /* ------------------------------ admin CRUD ------------------------------ */
  app.get('/api/integrations', auth(['admin']), (req, res) => res.json(D().integrations.map(withStats)));
  app.post('/api/integrations', auth(['admin']), wrap(async (req, res) => {
    const i = { id: uid(), ...fromBody(req.body), apiKey: newKey(), createdAt: nowMs(), lastReceivedAt: null, received: 0, lastError: '' };
    D().integrations.push(i); save(); broadcast({ type: 'integrations' });
    res.status(201).json(i);
  }));
  app.put('/api/integrations/:id', auth(['admin']), wrap(async (req, res) => {
    const i = D().integrations.find((x) => x.id === req.params.id);
    if (!i) throw httpErr('Not found', 404);
    const before = i.pull && i.pull.url;
    Object.assign(i, fromBody(req.body, i));
    if (i.mode === 'pull' && (before !== i.pull.url)) { i.seen = []; i.baselined = false; }
    closeSocket(i.id);
    save(); broadcast({ type: 'integrations' });
    res.json(i);
  }));
  /** Ably only: list the channels that are active right now, so the admin does not have to know the channel name. */
  app.post('/api/integrations/find-channels', auth(['admin']), wrap(async (req, res) => {
    let key = str(req.body.key, 400).replace(/[\r\n"']/g, '').replace(/^\s*\w*API_KEY\s*=\s*/i, '').trim();
    if (!key && req.body.id) { const i = D().integrations.find((x) => x.id === req.body.id); key = i && i.pull ? i.pull.key : ''; }
    if (!/^[\w-]+\.[\w-]+:\S+$/.test(key)) throw httpErr('Paste the Ably API key first (it looks like xxxx.yyyy:zzzz)');
    const base = process.env.ABLY_REST_BASE || 'https://rest.ably.io';
    let r;
    try { r = await fetch(base + '/channels?limit=100', { headers: { Authorization: 'Basic ' + Buffer.from(key).toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); }
    catch (_) { throw httpErr('Could not reach Ably. Check the internet connection.'); }
    if (r.status === 401) throw httpErr('Ably did not accept this key');
    if (r.status === 403) throw httpErr('This key is not allowed to list channels. Ask your POS company for the channel name.');
    if (!r.ok) throw httpErr('Ably replied HTTP ' + r.status);
    const data = await r.json().catch(() => []);
    const names = (Array.isArray(data) ? data : []).map((c) => (typeof c === 'string' ? c : c && c.channelId)).filter(Boolean).slice(0, 100);
    res.json({ channels: names });
  }));
  /** An order that is still "waiting" in the POS: send it to the kitchen anyway, or forget it. */
  app.post('/api/integrations/:id/held/:oid/:what', auth(['admin']), wrap(async (req, res) => {
    const i = D().integrations.find((x) => x.id === req.params.id);
    if (!i) throw httpErr('Not found', 404);
    const h = heldOf(i), v = h.get(req.params.oid);
    if (!v) throw httpErr('That order is no longer waiting', 404);
    h.delete(req.params.oid);
    if (req.params.what === 'release') createFrom(i, v.payload, 'You sent a waiting order to the kitchen');
    else log(i, 'in', true, 'You dropped a waiting order', { externalId: req.params.oid });
    saveHeld(i);
    res.json({ ok: true });
  }));
  app.get('/api/integrations/:id/recent', auth(['admin']), (req, res) => {
    const i = D().integrations.find((x) => x.id === req.params.id);
    if (!i) throw httpErr('Not found', 404);
    res.json((i.recent || []).slice().reverse());
  });
  app.post('/api/integrations/:id/regenerate-key', auth(['admin']), wrap(async (req, res) => {
    const i = D().integrations.find((x) => x.id === req.params.id);
    if (!i) throw httpErr('Not found', 404);
    i.apiKey = newKey(); save(); log(i, 'in', true, 'API key was regenerated. The old key no longer works.');
    res.json(i);
  }));
  app.delete('/api/integrations/:id', auth(['admin']), wrap(async (req, res) => {
    const d = D(), n = d.integrations.findIndex((x) => x.id === req.params.id);
    if (n < 0) throw httpErr('Not found', 404);
    closeSocket(req.params.id); d.integrations.splice(n, 1); d.integrationLogs = d.integrationLogs.filter((l) => l.integrationId !== req.params.id);
    save(); broadcast({ type: 'integrations' });
    res.json({ ok: true });
  }));
  app.get('/api/integrations/logs', auth(['admin']), (req, res) => {
    let list = D().integrationLogs;
    if (req.query.integrationId) list = list.filter((l) => l.integrationId === req.query.integrationId);
    res.json(list.slice(-100).reverse());
  });

  /* ------------------------------ ingest ------------------------------ */
  function buildLines(payload, integ) {
    const d = D(), m = integ.mapping || {};
    const rows = pickArray(payload, m.items);
    if (!rows) throw httpErr(m.items ? `No items found at "${m.items}"` : 'No items found in the order. Set the "items" field in the integration\'s field mapping.');
    const lines = [];
    for (const r of rows.slice(0, 60)) {
      if (!r || typeof r !== 'object') continue;
      const name = clean(pickValue(r, m.itemName, 'itemName'), 120);
      if (!name) continue;
      const qty = Math.min(99, Math.max(1, parseInt(pickValue(r, m.itemQty, 'itemQty'), 10) || 1));
      const sent = Number(pickValue(r, m.itemPrice, 'itemPrice'));
      const menu = d.items.find((i) => norm(i.name) === norm(name));
      const price = Number.isFinite(sent) && sent > 0 ? sent : (menu ? menu.price : 0);
      lines.push(menu ? { itemId: menu.id, name: menu.name, price, qty } : { itemId: 'ext-' + crypto.randomBytes(4).toString('hex'), name, price, qty });
    }
    if (!lines.length) throw httpErr('The items list had no usable item names');
    let total = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
    const sentTotal = Number(pickValue(payload, m.total, 'total'));
    if (!total && Number.isFinite(sentTotal) && sentTotal > 0) total = Math.round(sentTotal * 100) / 100;
    return { lines, total };
  }
  function ingest(integ, payload, { test = false } = {}) {
    const d = D();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpErr('Send a JSON object as the request body');
    const m = integ.mapping || {};
    const platform = d.platforms.find((p) => p.id === integ.platformId);
    if (!platform) throw httpErr('The platform for this integration was deleted. Edit the integration and choose another.');

    let externalId = pickValue(payload, m.externalId, 'externalId');
    externalId = externalId == null ? '' : clean(externalId, 80);
    if (test) externalId = 'test-' + crypto.randomBytes(3).toString('hex');
    if (externalId) {
      const dup = d.orders.find((o) => o.source && o.source.integrationId === integ.id && o.source.externalId === externalId);
      if (dup) return { order: dup, duplicate: true };
    }

    const { lines, total } = buildLines(payload, integ);

    const t = nowMs();
    const tableRaw = clean(pickValue(payload, m.tableNo, 'tableNo'), 20);
    const phone = integ.whatsapp ? clean(pickValue(payload, m.phone, 'phone'), 20) : '';
    const order = {
      id: uid(), number: nextOrderNo(), platformId: platform.id,
      tableNo: platform.askTable ? tableRaw : '',
      customerName: clean(pickValue(payload, m.customerName, 'customerName'), 60),
      phone, notes: clean(pickValue(payload, m.notes, 'notes'), 300),
      items: lines, total, status: 'preparing',
      createdAt: t, updatedAt: t, readyAt: null, servedAt: null,
      createdBy: test ? 'Test (' + integ.name + ')' : integ.name,
      source: { integrationId: integ.id, name: integ.name, externalId, test },
    };
    d.orders.push(order);
    integ.lastReceivedAt = t; integ.received = (integ.received || 0) + 1; integ.lastError = '';
    save();
    announceNewOrder(order, { customer: !!integ.whatsapp });
    return { order, duplicate: false, warn: externalId ? '' : 'No order id found, so repeated sends cannot be detected' };
  }

  /* ------------------------------ public webhook ------------------------------ */
  const rate = new Map();
  function authenticate(req) {
    const ip = req.ip;
    if (throttled(ip)) throw httpErr('Too many failed attempts. Try again later.', 429);
    const supplied = req.get('x-api-key') || ((req.get('authorization') || '').match(/^Bearer\s+(.+)$/i) || [])[1] || (req.query.key ? String(req.query.key) : '');
    const integ = D().integrations.find((x) => x.id === req.params.id);
    if (!integ || !supplied || !safeEq(supplied.trim(), integ.apiKey)) { noteFail(ip); throw httpErr('Invalid integration or API key', 401); }
    return integ;
  }
  app.get('/hook/:id', wrap(async (req, res) => {
    const integ = authenticate(req);
    res.json({ ok: true, name: integ.name, enabled: integ.enabled });
  }));
  app.post('/hook/:id', wrap(async (req, res) => {
    const integ = authenticate(req);
    if (!integ.enabled) throw httpErr('This integration is turned off', 403);
    const r = rate.get(integ.id) || { start: nowMs(), n: 0 };
    if (nowMs() - r.start > 60000) { r.start = nowMs(); r.n = 0; }
    if (++r.n > 120) { rate.set(integ.id, r); throw httpErr('Too many orders per minute', 429); }
    rate.set(integ.id, r);
    remember(integ, JSON.stringify(req.body || {}));
    try {
      const out = ingest(integ, req.body);
      if (out.duplicate) { log(integ, 'in', true, `Duplicate ignored (order ${out.order.source.externalId} already received)`, { orderNumber: out.order.number, externalId: out.order.source.externalId }); return res.json({ ok: true, duplicate: true, orderNumber: out.order.number, orderId: out.order.id }); }
      log(integ, 'in', true, 'Order received' + (out.warn ? ' (' + out.warn + ')' : ''), { orderNumber: out.order.number, externalId: out.order.source.externalId });
      res.status(201).json({ ok: true, orderNumber: out.order.number, orderId: out.order.id });
    } catch (e) {
      integ.lastError = e.message; log(integ, 'in', false, e.message);
      throw e.status ? e : httpErr(e.message);
    }
  }));

  /** Admin "Test": runs a payload through exactly the same code as the real webhook. */
  app.post('/api/integrations/:id/test', auth(['admin']), wrap(async (req, res) => {
    const integ = D().integrations.find((x) => x.id === req.params.id);
    if (!integ) throw httpErr('Not found', 404);
    let payload = req.body.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { throw httpErr('That is not valid JSON'); } }
    try {
      const out = ingest(integ, payload, { test: true });
      log(integ, 'in', true, 'Test order received', { orderNumber: out.order.number, externalId: out.order.source.externalId });
      res.status(201).json({ ok: true, order: out.order });
    } catch (e) { log(integ, 'in', false, 'Test failed: ' + e.message); throw e.status ? e : httpErr(e.message); }
  }));


  /* ------------------------------ pull mode: we ask the POS for new orders using its API key ------------------------------ */
  function pullHeaders(integ) {
    const p = integ.pull, h = { Accept: 'application/json', 'User-Agent': 'CraveYard-KOMS/1.0' };
    const name = p.headerName || 'Authorization';
    h[name] = /^authorization$/i.test(name) && !/^(bearer|basic|token)\s/i.test(p.key) ? 'Bearer ' + p.key : p.key;
    return h;
  }
  async function fetchRemote(integ) {
    const u = await assertSafeUrl(integ.pull.url);
    const r = await fetch(u, { headers: pullHeaders(integ), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (r.status === 401 || r.status === 403) throw new Error('The POS did not accept the API key (HTTP ' + r.status + ')');
    if (r.status >= 300) throw new Error('The POS replied HTTP ' + r.status);
    let data; try { data = await r.json(); } catch (_) { throw new Error('The POS did not reply with order data (JSON)'); }
    let list = Array.isArray(data) ? data : null;
    if (!list && data && typeof data === 'object') {
      for (const k of ['orders', 'data', 'results', 'items', 'order_list', 'data.orders', 'data.items', 'result.orders']) { const v = getPath(data, k); if (Array.isArray(v)) { list = v; break; } }
    }
    if (!list) throw new Error('Could not find a list of orders in the reply');
    return list.filter((o) => o && typeof o === 'object' && !Array.isArray(o));
  }
  const orderKey = (integ, o) => { const v = pickValue(o, (integ.mapping || {}).externalId, 'externalId'); return v == null ? '' : clean(v, 80); };
  const polling = new Set();
  async function pollOne(integ) {
    if (polling.has(integ.id)) return; polling.add(integ.id);
    try {
      const list = await fetchRemote(integ);
      integ.seen = Array.isArray(integ.seen) ? integ.seen : [];
      const seen = new Set(integ.seen);
      integ.lastCheckAt = nowMs(); integ.lastError = '';
      if (!integ.baselined) {   // first successful check: remember what is already there, only bring in NEW orders from now on
        list.forEach((o) => { const k = orderKey(integ, o); if (k) seen.add(k); });
        integ.baselined = true; integ.seen = [...seen].slice(-3000); save();
        log(integ, 'in', true, `Connected. ${list.length} existing order${list.length === 1 ? '' : 's'} ignored; new orders will appear from now on.`);
        return;
      }
      let added = 0;
      for (const o of list) {
        const k = orderKey(integ, o);
        if (k && seen.has(k)) continue;
        try {
          const out = ingest(integ, o);
          if (k) seen.add(k);
          if (!out.duplicate) { added++; log(integ, 'in', true, 'Order received', { orderNumber: out.order.number, externalId: out.order.source.externalId }); }
        } catch (e) { if (k) seen.add(k); log(integ, 'in', false, 'Skipped an order: ' + e.message); }
      }
      if (added || list.length) { integ.seen = [...seen].slice(-3000); save(); }
    } catch (e) {
      if (integ.lastError !== e.message) log(integ, 'in', false, e.message);
      integ.lastError = e.message; integ.lastCheckAt = nowMs(); save();
    } finally { polling.delete(integ.id); }
  }
  setInterval(() => {
    const t = nowMs();
    D().integrations.filter((i) => i.mode === 'pull' && !isWs(i) && i.enabled && i.pull && i.pull.url && t - (i.lastCheckAt || 0) >= (i.pull.intervalSec || 10) * 1000 - 500).forEach((i) => { pollOne(i); });
  }, 3000).unref();

  /* ------------------------------ pull mode via WebSocket (address starts with ws:// or wss://) ------------------------------ */
  const isWs = (integ) => integ.mode === 'pull' && integ.pull && (!!integ.pull.channel || /^wss?:/i.test(integ.pull.url));
  const socks = new Map();   // integrationId -> { ws, nextTryAt, fails }
  function closeSocket(id) { const e = socks.get(id); if (e && e.ws) { try { e.ws.terminate(); } catch (_) {} } socks.delete(id); }
  const fill = (txt, key) => String(txt || '').replace(/\{key\}/g, key);
  function ordersIn(msg) {   // find order objects in any reasonable message shape
    if (Array.isArray(msg)) return msg.flatMap(ordersIn);
    if (!msg || typeof msg !== 'object') return [];
    if (pickArray(msg, null)) return [msg];
    for (const k of ['orders', 'data', 'order', 'payload', 'result', 'message', 'data.orders', 'data.order']) {
      const v = getPath(msg, k); if (v && typeof v === 'object') { const r = ordersIn(v); if (r.length) return r; }
    }
    return [];
  }
  /* words that describe what happened, taken from the message (status / event / type / Ably message name ...) */
  function wordsOf(msg, evName) {
    const out = [];
    const keys = ['status', 'state', 'event', 'type', 'action', 'order_status', 'orderStatus', 'eventType', 'event_type', 'name', 'order_state'];
    const scan = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) keys.forEach((k) => { if (typeof o[k] === 'string') out.push(o[k]); }); };
    scan(msg); ['data', 'order', 'payload', 'message', 'result'].forEach((k) => scan(msg && msg[k]));
    if (evName) out.push(String(evName));
    return out.join(' ').toLowerCase();
  }
  const READY_RE = /ready|prepared|packed/;
  const SERVED_RE = /\bserved\b|delivered|complet|closed|settled|dispatched|picked/;
  const CANCEL_RE = /cancel|reject|declin|delet|remov|void|discard/;
  const ACCEPT_RE = /accept|confirm|approv|kot|preparing|cooking|in[_ -]?progress|started/;
  function idOf(integ, msg) {
    const m = (integ.mapping || {}).externalId;
    for (const o of [msg, msg && msg.data, msg && msg.order, msg && msg.payload, msg && msg.message, msg && msg.result]) {
      if (o && typeof o === 'object') { const v = pickValue(o, m, 'externalId'); if (v != null && v !== '') return clean(v, 80); }
    }
    return '';
  }
  const held = new Map();   // integrationId -> Map(externalId -> {payload, at})  (orders waiting for the POS to accept them; also kept in the database)
  const heldOf = (integ) => { let h = held.get(integ.id); if (!h) { h = new Map((integ.heldList || []).map((x) => [x.id, { payload: x.payload, at: x.at }])); held.set(integ.id, h); } return h; };
  const saveHeld = (integ) => { integ.heldList = [...heldOf(integ)].map(([id, v]) => ({ id, payload: v.payload, at: v.at })); save(); broadcast({ type: 'integrations' }); };
  const mine = (integ, id) => D().orders.find((o) => o.source && o.source.integrationId === integ.id && o.source.externalId === id);
  function remember(integ, text) {
    integ.recent = Array.isArray(integ.recent) ? integ.recent : [];
    integ.recent.push({ at: nowMs(), text: String(text).slice(0, 2500) });
    if (integ.recent.length > 15) integ.recent.shift();
  }
  function removeOrder(integ, o, why) {
    const d = D(), i = d.orders.indexOf(o);
    if (i < 0) return;
    d.orders.splice(i, 1); save();
    broadcast({ type: 'orders', action: 'deleted', order: o });
    log(integ, 'in', true, why, { orderNumber: o.number, externalId: o.source.externalId });
  }
  function updateOrder(integ, o, payload) {
    if (o.status === 'served') return false;
    let b; try { b = buildLines(payload, integ); } catch (_) { return false; }
    const sig = (ls) => ls.map((l) => norm(l.name) + 'x' + l.qty + '@' + l.price).sort().join('|');
    const m = integ.mapping || {};
    const notes = clean(pickValue(payload, m.notes, 'notes'), 300);
    const priced = b.lines.map((l) => { const old = o.items.find((x) => norm(x.name) === norm(l.name)); return old && !l.price && old.price ? { ...l, price: old.price, itemId: old.itemId } : l; });
    const same = sig(priced) === sig(o.items) && (notes || '') === (o.notes || '');
    if (same) return false;
    o.items = priced; o.total = Math.round(priced.reduce((t, l) => t + l.price * l.qty, 0) * 100) / 100 || b.total;
    if (notes) o.notes = notes;
    o.updatedAt = nowMs(); save();
    broadcast({ type: 'orders', action: 'updated', order: o });
    log(integ, 'in', true, 'Order changed in the POS and updated here', { orderNumber: o.number, externalId: o.source.externalId });
    return true;
  }
  function createFrom(integ, payload, why) {
    try {
      const out = ingest(integ, payload);
      if (!out.duplicate) log(integ, 'in', true, why || 'Order received', { orderNumber: out.order.number, externalId: out.order.source.externalId });
    } catch (err) { log(integ, 'in', false, 'Skipped an order: ' + err.message); }
  }
  function handleSocketText(integ, text, e, evName) {
    remember(integ, (evName ? '[' + evName + '] ' : '') + text);
    let msg; try { msg = JSON.parse(text); } catch (_) { return; }
    const words = wordsOf(msg, evName), id = idOf(integ, msg), hold = heldOf(integ);
    const list = ordersIn(msg);

    // 1. cancelled / rejected / deleted in the POS -> remove it here too
    if (CANCEL_RE.test(words) && id) {
      if (hold.delete(id)) { saveHeld(integ); log(integ, 'in', true, 'Waiting order was rejected in the POS', { externalId: id }); return; }
      const o = mine(integ, id);
      if (o && o.status !== 'served') return removeOrder(integ, o, 'Order was cancelled in the POS and removed here');
      return;
    }
    // 2. accepted in the POS -> release an order we were holding
    if (integ.waitAccept && id && hold.has(id) && ACCEPT_RE.test(words)) {
      const h = hold.get(id); hold.delete(id); saveHeld(integ);
      return createFrom(integ, list[0] || h.payload, 'Accepted in the POS, sent to the kitchen');
    }
    // 2b. the POS says the order is ready / served -> follow it (forward only, never backwards)
    if (id) {
      const o = mine(integ, id);
      if (o && !integ.noFollow) {
        const to = READY_RE.test(words) ? 'ready' : SERVED_RE.test(words) ? 'served' : null;
        const rank = { preparing: 0, ready: 1, served: 2 };
        if (to && rank[to] > rank[o.status]) {
          applyStatus(o, to); save(); broadcast({ type: 'orders', action: 'status', order: o });
          log(integ, 'in', true, `Order marked ${to} in the POS and updated here`, { orderNumber: o.number, externalId: id });
          if (o.phone) notifyCustomer(o, to);
          return;
        }
        if (!list.length) { const wo = o; if (wo) return; }   // an update about an order we have, nothing to change
      }
    }
    if (!list.length) {
      if (nowMs() - (e.lastUnknownAt || 0) > 10000 && !(msg && (msg.type === 'ping' || msg.action === 0))) {
        e.lastUnknownAt = nowMs();
        log(integ, 'in', false, 'A message arrived but no order was found in it: ' + text.slice(0, 220));
      }
      return;
    }
    const snapshot = !integ.baselined && nowMs() - e.openedAt < 3000;   // very first connection: what the POS sends right away is old data
    integ.seen = Array.isArray(integ.seen) ? integ.seen : [];
    for (const o of list) {
      const k = orderKey(integ, o);
      const old = k ? mine(integ, k) : null;
      if (old) { updateOrder(integ, old, o); continue; }                 // 3. same order again = it was edited in the POS
      if (snapshot) { if (k) integ.seen.push(k); continue; }
      if (integ.waitAccept && k && !ACCEPT_RE.test(words)) {            // 4. not accepted yet: keep it aside
        if (!hold.has(k)) { hold.set(k, { payload: o, at: nowMs() }); if (hold.size > 100) hold.delete(hold.keys().next().value); saveHeld(integ); log(integ, 'in', true, 'New order waiting for the POS to accept it', { externalId: k }); }
        else { hold.get(k).payload = o; saveHeld(integ); }
        continue;
      }
      if (k) { integ.seen.push(k); if (integ.seen.length > 3000) integ.seen.shift(); }
      createFrom(integ, o);
    }
    save();
  }
  async function openSocket(integ) {
    const e = socks.get(integ.id) || { fails: 0, nextTryAt: 0 };
    socks.set(integ.id, e);
    e.nextTryAt = nowMs() + 60000;   // placeholder while connecting
    const p = integ.pull, key = p.key;
    const ably = !!p.channel;
    let url;
    try {
      url = ably ? (p.url && /^wss?:/i.test(p.url) ? p.url : 'wss://realtime.ably.io/') : fill(p.url, encodeURIComponent(key));
      if (ably) url += (url.includes('?') ? '&' : '?') + 'format=json&v=2&key=' + encodeURIComponent(key);
      await assertSafeUrl(url.replace(/^ws/i, 'http'));
    } catch (err) { return fail(integ, e, err.message); }
    const headers = { 'User-Agent': 'CraveYard-KOMS/1.0' };
    const hn = p.headerName || 'Authorization';
    if (!ably) headers[hn] = /^authorization$/i.test(hn) && !/^(bearer|basic|token)\s/i.test(key) ? 'Bearer ' + key : key;
    const sock = new WebSocket(url, { headers, handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024 });
    e.ws = sock;
    sock.on('open', () => {
      if (ably) return;   // Ably: wait for its CONNECTED message first
      e.fails = 0; e.openedAt = nowMs(); integ.live = true; integ.lastError = ''; integ.lastCheckAt = nowMs(); save(); broadcast({ type: 'integrations' });
      if (p.hello) { try { sock.send(fill(p.hello, key)); } catch (_) {} }
      log(integ, 'in', true, 'Connected to the POS');
      setTimeout(() => { if (e.ws === sock && !integ.baselined) { integ.baselined = true; save(); } }, 3200);
    });
    sock.on('message', (data) => {
      if (!ably) return handleSocketText(integ, data.toString(), e);
      let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (m.action === 4) {   // CONNECTED -> join the channel(s)
        e.fails = 0; e.openedAt = nowMs();
        p.channel.split(',').map((c) => c.trim()).filter(Boolean).forEach((c) => sock.send(JSON.stringify({ action: 10, channel: c })));
      } else if (m.action === 11) {   // ATTACHED
        if (!integ.live) { integ.live = true; integ.lastError = ''; integ.lastCheckAt = nowMs(); integ.baselined = true; save(); broadcast({ type: 'integrations' }); log(integ, 'in', true, 'Connected to the POS (Ably channel ' + m.channel + ')'); }
      } else if (m.action === 15 && Array.isArray(m.messages)) {   // MESSAGE
        for (const x of m.messages) { let d = x && x.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) {} } if (d && typeof d === 'object') handleSocketText(integ, JSON.stringify(d), e, x.name); else if (nowMs() - (e.lastUnknownAt || 0) > 10000) { e.lastUnknownAt = nowMs(); log(integ, 'in', false, 'A message arrived but it was not order data: ' + String(d).slice(0, 220)); } }
      } else if (m.action === 9 || m.action === 6) {   // ERROR / DISCONNECTED
        const code = m.error && m.error.code, msg = (m.error && m.error.message) || 'The POS closed the connection';
        fail(integ, e, code >= 40100 && code < 40200 ? 'The POS did not accept the API key' : code === 40160 || code === 40161 ? 'This key is not allowed to read that channel' : msg);
        try { sock.terminate(); } catch (_) {}
      }
    });
    sock.on('unexpected-response', (req, res) => { fail(integ, e, res.statusCode === 401 || res.statusCode === 403 ? 'The POS did not accept the API key (HTTP ' + res.statusCode + ')' : 'The POS refused the connection (HTTP ' + res.statusCode + ')'); try { sock.terminate(); } catch (_) {} });
    sock.on('error', (err) => { if (e.ws === sock) fail(integ, e, 'Could not connect: ' + (err.message || 'error')); });
    sock.on('close', () => { if (e.ws !== sock) return; e.ws = null; integ.live = false; broadcast({ type: 'integrations' }); if (!integ.lastError) { integ.lastError = 'Disconnected. Trying again…'; } e.nextTryAt = Math.min(e.nextTryAt, nowMs() + Math.min(60000, 2000 * 2 ** Math.min(e.fails, 5))); });
  }
  function fail(integ, e, message) {
    e.fails = (e.fails || 0) + 1; e.nextTryAt = nowMs() + Math.min(60000, 2000 * 2 ** Math.min(e.fails, 5));
    if (integ.lastError !== message) log(integ, 'in', false, message);
    integ.lastError = message; integ.live = false; integ.lastCheckAt = nowMs(); save(); broadcast({ type: 'integrations' });
  }
  function maintainSockets() {
    const t = nowMs(), list = D().integrations;
    for (const [id] of socks) { const i = list.find((x) => x.id === id); if (!i || !i.enabled || !isWs(i)) closeSocket(id); }
    list.filter((i) => isWs(i) && i.enabled).forEach((i) => { const e = socks.get(i.id); if (!e || (!e.ws && t >= e.nextTryAt)) openSocket(i).catch(() => {}); });
  }
  setInterval(maintainSockets, 3000).unref(); setTimeout(maintainSockets, 500).unref();
  D().integrations.forEach((i) => { i.live = false; });
  function testSocket(integ) {
    return new Promise((resolve, reject) => {
      const p = integ.pull;
      const hn = p.headerName || 'Authorization', headers = {};
      headers[hn] = /^authorization$/i.test(hn) && !/^(bearer|basic|token)\s/i.test(p.key) ? 'Bearer ' + p.key : p.key;
      const ably = !!p.channel;
      const target = ably ? ((p.url && /^wss?:/i.test(p.url) ? p.url : 'wss://realtime.ably.io/') + ((p.url || '').includes('?') ? '&' : '?') + 'format=json&v=2&key=' + encodeURIComponent(p.key)) : fill(p.url, encodeURIComponent(p.key));
      if (ably) delete headers[hn];
      assertSafeUrl(target.replace(/^ws/i, 'http')).then(() => {
        const s = new WebSocket(target, { headers, handshakeTimeout: 8000 });
        if (ably) { s.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch (_) { return; } if (m.action === 4) done(resolve, true); else if (m.action === 9 || m.action === 6) done(reject, new Error(m.error && m.error.code >= 40100 && m.error.code < 40200 ? 'The POS did not accept the API key' : (m.error && m.error.message) || 'The POS closed the connection')); }); }
        const done = (fn, v) => { clearTimeout(tm); try { s.terminate(); } catch (_) {} fn(v); };
        const tm = setTimeout(() => done(reject, new Error('The POS did not answer in time')), 9000);
        if (!ably) s.on('open', () => done(resolve, true));
        s.on('unexpected-response', (rq, rs) => done(reject, new Error(rs.statusCode === 401 || rs.statusCode === 403 ? 'The POS did not accept the API key (HTTP ' + rs.statusCode + ')' : 'The POS refused the connection (HTTP ' + rs.statusCode + ')')));
        s.on('error', (err) => done(reject, new Error('Could not connect: ' + err.message)));
      }).catch(reject);
    });
  }
  app.post('/api/integrations/:id/check', auth(['admin']), wrap(async (req, res) => {
    const integ = D().integrations.find((x) => x.id === req.params.id);
    if (!integ || integ.mode !== 'pull') throw httpErr('Not found', 404);
    if (isWs(integ)) { try { await testSocket(integ); return res.json({ ok: true, live: true }); } catch (e) { throw httpErr(e.message); } }
    try { const list = await fetchRemote(integ); res.json({ ok: true, count: list.length }); }
    catch (e) { throw httpErr(e.message); }
  }));

  /* ------------------------------ outbound status ------------------------------ */
  async function post(integ, order, attempt) {
    const c = integ.callback;
    const url = await assertSafeUrl(c.url);
    const body = { event: 'order.status', externalId: order.source.externalId, orderNumber: order.number, status: (c.statusMap && c.statusMap[order.status]) || order.status, kitchenStatus: order.status, at: new Date().toISOString() };
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'CraveYard-KOMS/1.0' };
    if (c.headerName && c.headerValue) headers[c.headerName] = c.headerValue;
    const r = await fetch(url, { method: c.method === 'PUT' ? 'PUT' : 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (r.status >= 300) throw Object.assign(new Error('Their server replied HTTP ' + r.status), { retry: r.status >= 500 });
    log(integ, 'out', true, `Sent "${body.status}" for ${order.source.externalId || '#' + order.number}`, { orderNumber: order.number, externalId: order.source.externalId });
  }
  async function sendStatus(order) {
    const integ = order.source && D().integrations.find((x) => x.id === order.source.integrationId);
    if (!integ || order.source.test || !integ.callback || !integ.callback.enabled || !integ.callback.url) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await post(integ, order, attempt); return; } catch (e) {
        const retry = attempt === 0 && e.retry !== false && !/^(That|The) address/.test(e.message);
        if (!retry) { log(integ, 'out', false, `Could not send "${order.status}": ${e.message}`, { orderNumber: order.number, externalId: order.source.externalId }); return; }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    log(integ, 'out', false, `Could not send "${order.status}" (their server did not respond)`, { orderNumber: order.number, externalId: order.source.externalId });
  }
  /** Called by the server after an order's status changed. Never throws. */
  function onStatus(order) { if (order && order.source) sendStatus(order).catch(() => {}); }
  const usesPlatform = (platformId) => D().integrations.some((i) => i.platformId === platformId);

  return { onStatus, usesPlatform };
}

module.exports = { install, getPath };
