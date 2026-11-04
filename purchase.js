'use strict';
/**
 * Purchase: the team (kitchen master, juice master ...) orders supplies from a private link, and the
 * purchase list is sent on WhatsApp to the receiver numbers the admin chose.
 *
 *   Admin  : /api/purchase/...      (people + secure links, items, receivers, orders, message)
 *   Public : /buy/:token  (page)    /api/shop/:token  (items)   /api/shop/:token/order  (place order)
 */
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');

const CATS = ['kitchen', 'juice'];
const CAT_LABEL = { kitchen: 'Kitchen master', juice: 'Juice master' };
const DEFAULT_TEMPLATE = [
  '🛒 *Purchase order {number}*',
  'From: {label} ({person})',
  'Date: {date}',
  '',
  '{items}',
  '',
  'Note: {note}',
  'Needed: {deliverBy}',
  '',
  'Thank you, {restaurant}',
].join('\n');

const STARTER = {
  kitchen: [
    ['🧅', 'Onion', 'Vegetables', 'kg'], ['🍅', 'Tomato', 'Vegetables', 'kg'], ['🥔', 'Potato', 'Vegetables', 'kg'], ['🌶️', 'Green chilli', 'Vegetables', 'kg'],
    ['🧄', 'Garlic', 'Vegetables', 'kg'], ['🫚', 'Ginger', 'Vegetables', 'kg'], ['🍗', 'Chicken', 'Meat', 'kg'], ['🥚', 'Eggs', 'Meat', 'tray'],
    ['🛢️', 'Sunflower oil', 'Grocery', 'L'], ['🍚', 'Rice', 'Grocery', 'kg'], ['🧂', 'Salt', 'Grocery', 'kg'], ['🫓', 'Wheat flour', 'Grocery', 'kg'],
  ],
  juice: [
    ['🍋', 'Lemon', 'Fruits', 'kg'], ['🍊', 'Orange', 'Fruits', 'kg'], ['🥭', 'Mango pulp', 'Fruits', 'kg'], ['🍉', 'Watermelon', 'Fruits', 'kg'],
    ['🍌', 'Banana', 'Fruits', 'kg'], ['🥛', 'Milk', 'Dairy', 'L'], ['🍬', 'Sugar', 'Grocery', 'kg'], ['🌿', 'Mint', 'Grocery', 'bunch'], ['🧊', 'Ice', 'Grocery', 'kg'],
  ],
};

function install(ctx) {
  const { app, auth, wrap, httpErr, str, uid, nowMs, getDb, save, broadcast, sendWhatsApp, throttled, noteFail, hashPassword, checkPassword, plink, normPhone, mainStatus } = ctx;
  const newToken = () => crypto.randomBytes(24).toString('base64url');

  /* ------------------------------ data ------------------------------ */
  function P() {
    const d = getDb();
    if (!d.purchase) {
      const t = nowMs();
      d.purchase = {
        people: CATS.map((c) => ({ id: uid(), label: CAT_LABEL[c], name: '', phone: '', category: c, token: newToken(), enabled: true, pin: null, createdAt: t, lastOrderAt: null, orders: 0 })),
        items: [], receivers: [], orders: [], counter: 0, autoSend: true, useMainSender: false, template: DEFAULT_TEMPLATE,
      };
      CATS.forEach((c) => STARTER[c].forEach(([emoji, name, group, unit]) => d.purchase.items.push({ id: uid(), emoji, name, group, unit, forCat: c, available: true })));
      save();
    }
    return d.purchase;
  }
  P();   // create the starter data at start-up

  /** Purchase orders go out from their own linked WhatsApp, unless the admin chose to share the main one. */
  function waStatus() {
    const st = plink.state(), shared = !!P().useMainSender, main = mainStatus();
    return { shared, connected: shared ? main.connected : plink.connected(), number: shared ? main.number : st.number, link: { status: st.status, qr: st.qr, number: st.number, error: st.error } };
  }
  async function sendVia(phone, text) {
    if (P().useMainSender) return sendWhatsApp(phone, text);
    const n = normPhone(phone); if (!n) return { ok: false, error: 'No phone number' };
    if (!plink.connected()) return { ok: false, error: 'Purchase WhatsApp is not linked. Link it in Purchase > WhatsApp.' };
    return plink.send(n, text);
  }
  const stepOf = (unit) => (/^(kg|l|litre|liter)$/i.test(unit) ? 0.5 : 1);
  const origin = (req) => (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  const publicPerson = (p) => ({ id: p.id, label: p.label, name: p.name, phone: p.phone, category: p.category, enabled: p.enabled, pinOn: !!p.pin, token: p.token, createdAt: p.createdAt, lastOrderAt: p.lastOrderAt, orders: p.orders || 0 });
  const cleanPhone = (v) => String(v == null ? '' : v).replace(/[^\d+]/g, '').slice(0, 20);
  const cat = (v) => { if (!CATS.includes(v)) throw httpErr('Choose Kitchen master or Juice master'); return v; };
  const touch = (action, extra = {}) => { save(); broadcast({ type: 'purchase', action, ...extra }); };

  /* ------------------------------ admin: everything in one call ------------------------------ */
  app.get('/api/purchase', auth(['admin']), (req, res) => {
    const p = P();
    res.json({
      people: p.people.map(publicPerson), items: p.items, receivers: p.receivers,
      orders: p.orders.slice(-200).reverse(), autoSend: p.autoSend, useMainSender: !!p.useMainSender, template: p.template,
      sender: waStatus(), origin: origin(req), cats: CAT_LABEL,
    });
  });

  /* ---- people + secure links ---- */
  function personFrom(b, existing) {
    const label = str(b.label, 40) || (existing ? existing.label : CAT_LABEL[b.category]);
    return { label, name: str(b.name, 60), phone: cleanPhone(b.phone), category: existing ? existing.category : cat(b.category), enabled: b.enabled !== false };
  }
  app.post('/api/purchase/people', auth(['admin']), wrap(async (req, res) => {
    const p = P();
    if (p.people.length >= 40) throw httpErr('That is plenty of people already');
    const person = { id: uid(), ...personFrom(req.body), token: newToken(), pin: null, createdAt: nowMs(), lastOrderAt: null, orders: 0 };
    p.people.push(person); touch('people'); res.status(201).json(publicPerson(person));
  }));
  app.put('/api/purchase/people/:id', auth(['admin']), wrap(async (req, res) => {
    const person = P().people.find((x) => x.id === req.params.id);
    if (!person) throw httpErr('Not found', 404);
    Object.assign(person, personFrom(req.body, person)); touch('people'); res.json(publicPerson(person));
  }));
  app.post('/api/purchase/people/:id/reset', auth(['admin']), wrap(async (req, res) => {
    const person = P().people.find((x) => x.id === req.params.id);
    if (!person) throw httpErr('Not found', 404);
    person.token = newToken(); touch('people'); res.json(publicPerson(person));   // the old link stops working at once
  }));
  app.post('/api/purchase/people/:id/pin', auth(['admin']), wrap(async (req, res) => {
    const person = P().people.find((x) => x.id === req.params.id);
    if (!person) throw httpErr('Not found', 404);
    const pin = str(req.body.pin, 12);
    if (!pin) person.pin = null;
    else { if (!/^\d{4,8}$/.test(pin)) throw httpErr('The PIN must be 4 to 8 digits'); person.pin = hashPassword(pin); }
    touch('people'); res.json(publicPerson(person));
  }));
  app.delete('/api/purchase/people/:id', auth(['admin']), wrap(async (req, res) => {
    const p = P(), i = p.people.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpErr('Not found', 404);
    p.people.splice(i, 1); touch('people'); res.json({ ok: true });
  }));
  app.post('/api/purchase/qr', auth(['admin']), wrap(async (req, res) => {
    const text = str(req.body.text, 400);
    if (!/^https?:\/\//i.test(text)) throw httpErr('Nothing to make a QR code from');
    res.json({ dataUrl: await QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: '#0a4f55', light: '#ffffff' } }) });
  }));

  /* ---- items ---- */
  function itemFrom(b) {
    const name = str(b.name, 80); if (!name) throw httpErr('Give the item a name');
    const unit = str(b.unit, 12) || 'kg';
    const forCat = b.forCat === 'both' || CATS.includes(b.forCat) ? b.forCat : 'both';
    return { emoji: str(b.emoji, 8) || '📦', name, group: str(b.group, 40) || 'General', unit, forCat, available: b.available !== false };
  }
  app.post('/api/purchase/items', auth(['admin']), wrap(async (req, res) => {
    const p = P(); if (p.items.length >= 1500) throw httpErr('Too many items');
    const it = { id: uid(), ...itemFrom(req.body) }; p.items.push(it); touch('items'); res.status(201).json(it);
  }));
  app.put('/api/purchase/items/:id', auth(['admin']), wrap(async (req, res) => {
    const it = P().items.find((x) => x.id === req.params.id); if (!it) throw httpErr('Not found', 404);
    Object.assign(it, itemFrom(req.body)); touch('items'); res.json(it);
  }));
  app.delete('/api/purchase/items/:id', auth(['admin']), wrap(async (req, res) => {
    const p = P(), i = p.items.findIndex((x) => x.id === req.params.id); if (i < 0) throw httpErr('Not found', 404);
    p.items.splice(i, 1); touch('items'); res.json({ ok: true });
  }));

  /* ---- WhatsApp receivers + message ---- */
  function receiverFrom(b) {
    const name = str(b.name, 60); if (!name) throw httpErr('Give the receiver a name');
    const phone = cleanPhone(b.phone); if (phone.replace(/\D/g, '').length < 8) throw httpErr('Enter a valid WhatsApp number');
    const cats = (Array.isArray(b.cats) ? b.cats : []).filter((c) => CATS.includes(c));
    if (!cats.length) throw httpErr('Choose which orders this person receives');
    return { name, phone, cats };
  }
  app.post('/api/purchase/receivers', auth(['admin']), wrap(async (req, res) => {
    const p = P(); if (p.receivers.length >= 30) throw httpErr('Too many receivers');
    const r = { id: uid(), ...receiverFrom(req.body) }; p.receivers.push(r); touch('receivers'); res.status(201).json(r);
  }));
  app.put('/api/purchase/receivers/:id', auth(['admin']), wrap(async (req, res) => {
    const r = P().receivers.find((x) => x.id === req.params.id); if (!r) throw httpErr('Not found', 404);
    Object.assign(r, receiverFrom(req.body)); touch('receivers'); res.json(r);
  }));
  app.delete('/api/purchase/receivers/:id', auth(['admin']), wrap(async (req, res) => {
    const p = P(), i = p.receivers.findIndex((x) => x.id === req.params.id); if (i < 0) throw httpErr('Not found', 404);
    p.receivers.splice(i, 1); touch('receivers'); res.json({ ok: true });
  }));
  app.put('/api/purchase/settings', auth(['admin']), wrap(async (req, res) => {
    const p = P();
    if (req.body.autoSend != null) p.autoSend = !!req.body.autoSend;
    if (req.body.useMainSender != null) p.useMainSender = !!req.body.useMainSender;
    if (req.body.template != null) { const t = String(req.body.template).slice(0, 2000); if (!t.trim()) throw httpErr('The message cannot be empty'); p.template = t; }
    if (req.body.resetTemplate) p.template = DEFAULT_TEMPLATE;
    touch('settings'); res.json({ autoSend: p.autoSend, useMainSender: p.useMainSender, template: p.template, sender: waStatus() });
  }));

  app.get('/api/purchase/wa', auth(['admin']), (req, res) => res.json(waStatus()));
  app.post('/api/purchase/wa/start', auth(['admin']), wrap(async (req, res) => { plink.start(); res.json(waStatus()); }));
  app.post('/api/purchase/wa/logout', auth(['admin']), wrap(async (req, res) => { await plink.logout(); res.json(waStatus()); }));
  app.post('/api/purchase/receivers/:id/test', auth(['admin']), wrap(async (req, res) => {
    const r = P().receivers.find((x) => x.id === req.params.id); if (!r) throw httpErr('Not found', 404);
    const out = await sendVia(r.phone, 'Test message from ' + ((getDb().settings && getDb().settings.restaurantName) || 'the kitchen') + ' purchase system.');
    if (!out.ok) throw httpErr(out.error || 'Could not send');
    res.json({ ok: true });
  }));

  /* ---- order text + sending ---- */
  function render(order) {
    const d = getDb(), p = P();
    const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n));
    const items = order.lines.map((l) => `• ${l.name} — ${fmt(l.qty)} ${l.unit}`).join('\n');
    const vals = { number: order.number, label: order.label, person: order.personName || order.label, category: CAT_LABEL[order.category] || order.category,
      date: new Date(order.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }),
      items, note: order.note, deliverBy: order.deliverBy, restaurant: (d.settings && d.settings.restaurantName) || 'Kitchen' };
    const lines = p.template.split('\n').filter((ln) => !((/\{note\}/.test(ln) && !vals.note) || (/\{deliverBy\}/.test(ln) && !vals.deliverBy)));
    return lines.join('\n').replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m)).replace(/\n{3,}/g, '\n\n').trim();
  }
  async function sendOrder(order) {
    const p = P(), text = render(order);
    const to = p.receivers.filter((r) => r.cats.includes(order.category));
    order.wa = [];
    for (const r of to) {
      let out; try { out = await sendVia(r.phone, text); } catch (e) { out = { ok: false, error: e.message }; }
      order.wa.push({ name: r.name, phone: r.phone, ok: !!(out && out.ok), error: out && out.ok ? '' : String((out && out.error) || 'Could not send').slice(0, 160), at: nowMs() });
    }
    order.waNote = to.length ? '' : 'No receiver number is set for this category';
    save(); broadcast({ type: 'purchase', action: 'sent', id: order.id });
  }
  app.patch('/api/purchase/orders/:id', auth(['admin']), wrap(async (req, res) => {
    const o = P().orders.find((x) => x.id === req.params.id); if (!o) throw httpErr('Not found', 404);
    if (!['sent', 'received'].includes(req.body.status)) throw httpErr('Invalid status');
    o.status = req.body.status; o.receivedAt = o.status === 'received' ? nowMs() : null; touch('orders'); res.json(o);
  }));
  app.post('/api/purchase/orders/:id/resend', auth(['admin']), wrap(async (req, res) => {
    const o = P().orders.find((x) => x.id === req.params.id); if (!o) throw httpErr('Not found', 404);
    await sendOrder(o); res.json(o);
  }));
  app.delete('/api/purchase/orders/:id', auth(['admin']), wrap(async (req, res) => {
    const p = P(), i = p.orders.findIndex((x) => x.id === req.params.id); if (i < 0) throw httpErr('Not found', 404);
    p.orders.splice(i, 1); touch('orders'); res.json({ ok: true });
  }));

  /* ------------------------------ public: the mini supermarket ------------------------------ */
  const page = path.join(__dirname, 'public', 'shop.html');
  app.get('/buy/:token', (req, res) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Robots-Tag', 'noindex'); res.sendFile(page); });

  function personFor(req) {
    const ip = req.ip;
    if (throttled(ip)) throw httpErr('Too many attempts. Please try again in a few minutes.', 429);
    const person = P().people.find((x) => x.token === req.params.token);
    if (!person || !person.enabled) { noteFail(ip); throw httpErr('This link is not valid any more. Ask for a new one.', 404); }
    return person;
  }
  function checkPin(req, person) {
    if (!person.pin) return;
    const pin = String(req.get('x-pin') || '');
    let ok = false; try { ok = /^\d{4,8}$/.test(pin) && checkPassword(pin, person.pin); } catch (_) {}
    if (!ok) { if (pin) noteFail(req.ip); const e = httpErr(pin ? 'Wrong PIN' : 'Enter your PIN', 401); e.pinRequired = true; throw e; }
  }
  const visible = (it, person) => it.available && (it.forCat === 'both' || it.forCat === person.category);

  app.get('/api/shop/:token', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const person = personFor(req);
    const d = getDb(), restaurant = (d.settings && d.settings.restaurantName) || 'Kitchen';
    try { checkPin(req, person); }
    catch (e) { if (e.pinRequired) return res.status(200).json({ pinRequired: true, label: person.label, name: person.name, restaurant, wrong: e.message === 'Wrong PIN' }); throw e; }
    const p = P();
    const last = p.orders.filter((o) => o.personId === person.id).slice(-1)[0];
    res.json({
      label: person.label, name: person.name, category: person.category, restaurant,
      items: p.items.filter((it) => visible(it, person)).map((it) => ({ id: it.id, emoji: it.emoji, name: it.name, group: it.group, unit: it.unit, step: stepOf(it.unit) })),
      last: last ? { number: last.number, at: last.createdAt, lines: last.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) } : null,
    });
  }));

  app.post('/api/shop/:token/order', wrap(async (req, res) => {
    const person = personFor(req); checkPin(req, person);
    const p = P(), t = nowMs();
    if (p.orders.filter((o) => o.personId === person.id && t - o.createdAt < 3600000).length >= 20) throw httpErr('Too many orders in the last hour. Please wait a little.', 429);
    const rows = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!rows.length) throw httpErr('Pick at least one item');
    if (rows.length > 100) throw httpErr('That is too many items for one order');
    const lines = [], seen = new Set();
    for (const r of rows) {
      const it = p.items.find((x) => x.id === r.itemId);
      if (!it || !visible(it, person)) throw httpErr('One of the items is no longer available. Please refresh the page.');
      if (seen.has(it.id)) continue; seen.add(it.id);
      const step = stepOf(it.unit), qty = Math.round(Number(r.qty) / step) * step;
      if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) throw httpErr(`Check the quantity for ${it.name}`);
      lines.push({ itemId: it.id, name: it.name, unit: it.unit, qty });
    }
    p.counter = (p.counter || 0) + 1;
    const order = {
      id: uid(), number: 'P-' + String(p.counter).padStart(3, '0'), personId: person.id, label: person.label, personName: person.name, category: person.category,
      lines, note: str(req.body.note, 200), deliverBy: str(req.body.deliverBy, 40), status: 'sent', createdAt: t, receivedAt: null, wa: [],
    };
    p.orders.push(order); if (p.orders.length > 2000) p.orders.splice(0, p.orders.length - 2000);
    person.lastOrderAt = t; person.orders = (person.orders || 0) + 1;
    touch('order', { number: order.number, label: person.label, count: lines.length });
    if (p.autoSend) sendOrder(order).catch(() => {});      // not awaited: the person sees "Order placed" straight away
    res.status(201).json({ ok: true, number: order.number, items: lines.length });
  }));

  return { render };
}

module.exports = { install };
