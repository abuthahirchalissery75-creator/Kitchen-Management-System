'use strict';
/* Admin > Purchase: orders, suppliers & secure links, items, WhatsApp. Loaded after admin.js */

const PUR = { tab: 'orders', data: null, q: '', cat: 'all', fresh: new Set(), prevTok: {} };
const pAPI = '/api/purchase';
const CATN = { kitchen: 'Kitchen master', juice: 'Juice master' };
const loadPurchase = async () => { PUR.data = await api.get(pAPI); };
const shopUrl = (p) => PUR.data.origin + '/buy/' + p.token;
const qtyTxt = (l) => `${l.qty} ${l.unit}`;
const PHN = (v) => String(v || '').replace(/\D/g, '');
const pIcon = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const PI = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  reset: '<path d="M20 11a8 8 0 10-2.3 6.1M20 4v7h-7"/>',
  wa: '<path d="M20 12a8 8 0 01-11.8 7L3.5 20.5 5 16.2A8 8 0 1120 12z"/><path d="M9 9c0 3 3 6 6 6l1.2-1.4-2-1-1 .6c-.8-.4-1.6-1.2-2-2l.6-1-1-2z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M17 20h4M20 17v3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
};

function renderPurchase() {
  const d = PUR.data, newCount = d.orders.filter((o) => o.status === 'sent').length;
  main.innerHTML = head('Purchase', `<span class="pur-wa ${d.sender.connected ? 'ok' : 'off'}"><i></i>${d.sender.connected ? 'WhatsApp ready' : 'WhatsApp not linked'}</span>`) + `
  <div class="pur-tabs" role="tablist">
    ${[['orders', 'Purchase orders', newCount], ['people', 'Suppliers & links', 0], ['items', 'Items', 0], ['wa', 'WhatsApp', 0]].map(([k, t, n]) =>
      `<button class="pur-tab ${PUR.tab === k ? 'on' : ''}" data-t="${k}">${t}${n ? `<b class="pur-n">${n}</b>` : ''}</button>`).join('')}
    <span class="pur-ink"></span>
  </div>
  <div id="purBody" class="pur-body"></div>`;
  const tabs = main.querySelectorAll('.pur-tab');
  tabs.forEach((b) => { b.onclick = () => { PUR.tab = b.dataset.t; tabs.forEach((x) => x.classList.toggle('on', x === b)); moveInk(); drawTab(); }; });
  moveInk(); drawTab();
  if (!d.sender.connected) $('.pur-wa').onclick = () => { location.hash = '#settings'; };
}
function moveInk() {
  const on = main.querySelector('.pur-tab.on'), ink = main.querySelector('.pur-ink'); if (!on || !ink) return;
  ink.style.width = on.offsetWidth + 'px'; ink.style.transform = `translateX(${on.offsetLeft}px)`;
}
function drawTab() {
  const el = $('#purBody'); el.classList.remove('pur-in'); void el.offsetWidth; el.classList.add('pur-in');
  ({ orders: tabOrders, people: tabPeople, items: tabItems, wa: tabWA })[PUR.tab](el);
  el.querySelectorAll('[data-stagger]').forEach((n, i) => n.style.setProperty('--i', Math.min(i, 14)));
}
function countUp(el, to) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
  const t0 = performance.now(); (function f(t) { const k = Math.min(1, (t - t0) / 700); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); })(t0);
}

/* ---------------------------- orders ---------------------------- */
function tabOrders(el) {
  const o = PUR.data.orders, pending = o.filter((x) => x.status === 'sent').length, week = o.filter((x) => Date.now() - x.createdAt < 7 * 864e5).length;
  el.innerHTML = `<div class="pur-stats">
      <div class="pur-stat" data-stagger><span>Waiting to arrive</span><b data-n="${pending}">0</b></div>
      <div class="pur-stat" data-stagger><span>Orders this week</span><b data-n="${week}">0</b></div>
      <div class="pur-stat" data-stagger><span>All orders</span><b data-n="${o.length}">0</b></div></div>
    ${o.length ? `<div class="pur-list">${o.map(orderCard).join('')}</div>` : `<div class="pur-empty" data-stagger><div class="pur-bounce">🛒</div><b>No purchase orders yet</b><p>When your kitchen master or juice master places an order from their link, it shows up here and is sent to your WhatsApp receivers.</p></div>`}`;
  el.querySelectorAll('[data-n]').forEach((n) => countUp(n, +n.dataset.n));
  el.querySelectorAll('.pur-order').forEach((c) => {
    const id = c.dataset.id;
    c.querySelector('[data-a=toggle]').onclick = () => c.classList.toggle('open');
    c.querySelector('[data-a=recv]').onclick = async () => { const ord = o.find((x) => x.id === id); await api.patch(`${pAPI}/orders/${id}`, { status: ord.status === 'sent' ? 'received' : 'sent' }); await loadPurchase(); renderPurchase(); };
    c.querySelector('[data-a=resend]').onclick = async (e) => { e.currentTarget.classList.add('spin'); try { const r = await api.post(`${pAPI}/orders/${id}/resend`); toast(r.wa.length ? `Sent to ${r.wa.filter((w) => w.ok).length} of ${r.wa.length} number(s)` : (r.waNote || 'No receiver set'), r.wa.some((w) => w.ok) ? 'success' : 'error'); } catch (ex) { toast(ex.message, 'error'); } await loadPurchase(); renderPurchase(); };
    c.querySelector('[data-a=del]').onclick = async () => { if (!confirm('Delete this purchase order?')) return; c.classList.add('pur-out'); await new Promise((r) => setTimeout(r, 260)); await api.del(`${pAPI}/orders/${id}`); await loadPurchase(); renderPurchase(); };
  });
}
function orderCard(o) {
  const ok = o.wa.filter((w) => w.ok).length, bad = o.wa.length - ok;
  const wa = o.wa.length ? (bad ? `<span class="pur-pill bad">WhatsApp: ${bad} failed</span>` : `<span class="pur-pill ok">WhatsApp sent to ${ok}</span>`) : `<span class="pur-pill mute">${esc(o.waNote || 'Not sent')}</span>`;
  return `<div class="pur-order ${PUR.fresh.has(o.id) ? 'fresh' : ''}" data-id="${o.id}" data-stagger>
    <div class="po-top" data-a="toggle">
      <span class="po-cat ${o.category}">${o.category === 'juice' ? '🍹' : '🍳'}</span>
      <div class="po-main"><b>${esc(o.number)} · ${esc(o.label)}</b><small>${esc(o.personName || '')} ${o.personName ? '· ' : ''}${esc(fmtDateTime(o.createdAt))} · ${o.lines.length} item${o.lines.length > 1 ? 's' : ''}</small></div>
      ${wa}<span class="pur-pill ${o.status}">${o.status === 'received' ? 'Received ✓' : 'Sent'}</span><span class="po-caret">›</span></div>
    <div class="po-more"><div>
      <ul class="po-lines">${o.lines.map((l) => `<li><span>${esc(l.name)}</span><b>${esc(qtyTxt(l))}</b></li>`).join('')}</ul>
      ${o.note ? `<p class="po-note">📝 ${esc(o.note)}</p>` : ''}${o.deliverBy ? `<p class="po-note">⏰ Needed: ${esc(o.deliverBy)}</p>` : ''}
      ${o.wa.filter((w) => !w.ok).map((w) => `<p class="po-err">${esc(w.name)}: ${esc(w.error)}</p>`).join('')}
      <div class="po-act"><button class="btn primary" data-a="recv">${o.status === 'sent' ? 'Mark received' : 'Mark as not received'}</button>
        <button class="btn" data-a="resend">${pIcon(PI.send)} Send again</button><button class="btn danger" data-a="del">Delete</button></div></div></div></div>`;
}

/* ---------------------------- people ---------------------------- */
function tabPeople(el) {
  el.innerHTML = `<div class="pur-hint" data-stagger>Each person gets their <b>own private link</b>. Send it on WhatsApp once. If a link is ever shared by mistake, press <b>Reset link</b>: the old one stops working immediately.</div>
  <div class="pur-people">${PUR.data.people.map(personCard).join('')}</div>
  <button class="btn pur-add" id="addPerson" data-stagger>+ Add another person</button>`;
  $('#addPerson').onclick = () => personModal();
  el.querySelectorAll('.pur-person').forEach((c) => {
    const p = PUR.data.people.find((x) => x.id === c.dataset.id), url = shopUrl(p);
    c.querySelector('[data-a=copy]').onclick = (e) => { const b = e.currentTarget; copyText(url); b.classList.add('done'); b.innerHTML = pIcon(PI.check) + ' Copied'; setTimeout(() => { b.classList.remove('done'); b.innerHTML = pIcon(PI.copy) + ' Copy link'; }, 1600); };
    c.querySelector('[data-a=wa]').onclick = () => {
      const msg = `Hi${p.name ? ' ' + p.name : ''}, this is your private link to order supplies for ${S.settings.restaurantName || 'the restaurant'}:\n${url}\n\nOpen it on your phone, pick the items and press Place order. Please do not share this link.`;
      window.open('https://wa.me/' + (PHN(p.phone) ? (PHN(p.phone).length === 10 ? '91' : '') + PHN(p.phone) : '') + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
    };
    c.querySelector('[data-a=reset]').onclick = async (e) => {
      if (!confirm(`Make a new link for ${p.label}? The old link will stop working.`)) return;
      const b = e.currentTarget, tokEl = c.querySelector('.pp-url span'); b.classList.add('spin');
      const old = p.token, r = await api.post(`${pAPI}/people/${p.id}/reset`); p.token = r.token;
      const full = shopUrl(p), pre = full.slice(0, full.length - p.token.length); let n = 0; const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const tm = setInterval(() => { n++; const done = Math.floor(p.token.length * n / 14); tokEl.textContent = pre + p.token.slice(0, done) + Array.from({ length: p.token.length - done }, () => chars[(Math.random() * chars.length) | 0]).join(''); if (n >= 14) { clearInterval(tm); tokEl.textContent = full; b.classList.remove('spin'); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1200); toast('New link made. The old one no longer works.', 'success'); } }, 45);
      PUR.prevTok[p.id] = old;
    };
    c.querySelector('[data-a=qr]').onclick = async () => { const r = await api.post(`${pAPI}/qr`, { text: url }); openModal({ title: p.label + ' · QR code', body: `<div class="pur-qr"><img alt="QR code" src="${r.dataUrl}"><p>Scan with the phone camera to open the shop.</p></div>`, submitLabel: 'Done' }); };
    c.querySelector('[data-a=pin]').onclick = () => pinModal(p);
    c.querySelector('[data-a=edit]').onclick = () => personModal(p);
    c.querySelector('[data-a=on]').onchange = async (e) => { await api.put(`${pAPI}/people/${p.id}`, { ...p, enabled: e.target.checked }); await loadPurchase(); renderPurchase(); };
  });
}
function personCard(p) {
  const url = shopUrl(p);
  return `<div class="pur-person ${p.enabled ? '' : 'dim'}" data-id="${p.id}" data-stagger>
    <div class="pp-top"><span class="po-cat ${p.category}">${p.category === 'juice' ? '🍹' : '🍳'}</span>
      <div class="po-main"><b>${esc(p.label)}</b><small>${esc(p.name || 'No name yet')}${p.phone ? ' · ' + esc(p.phone) : ''}</small></div>
      <label class="pur-sw" title="Link on or off"><input type="checkbox" data-a="on" ${p.enabled ? 'checked' : ''}><i></i></label></div>
    <div class="pp-url">${pIcon(PI.lock)}<span>${esc(url)}</span></div>
    <div class="pp-meta"><span>${p.orders} order${p.orders === 1 ? '' : 's'}</span><span>Last: ${esc(ago(p.lastOrderAt))}</span>${p.pinOn ? '<span class="pur-pill ok">PIN on</span>' : ''}</div>
    <div class="pp-act"><button class="btn primary" data-a="copy">${pIcon(PI.copy)} Copy link</button><button class="btn wa" data-a="wa">${pIcon(PI.wa)} WhatsApp</button>
      <button class="btn" data-a="qr" title="QR code">${pIcon(PI.qr)}</button><button class="btn" data-a="reset">${pIcon(PI.reset)} Reset link</button>
      <button class="btn" data-a="pin" title="PIN">${pIcon(PI.lock)} PIN</button><button class="btn" data-a="edit">${pIcon(PI.edit)}</button></div></div>`;
}
function personModal(p) {
  openModal({
    title: p ? 'Edit ' + p.label : 'Add a person', submitLabel: p ? 'Save' : 'Add',
    body: `<label>Which shop do they order from?<select name="category" ${p ? 'disabled' : ''}>${Object.entries(CATN).map(([k, v]) => `<option value="${k}" ${p && p.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Title shown to them<input name="label" maxlength="40" value="${esc(p ? p.label : '')}" placeholder="e.g. Kitchen master"></label>
      <label>Person's name<input name="name" maxlength="60" value="${esc(p ? p.name : '')}" placeholder="e.g. Ramesh"></label>
      <label>Their WhatsApp number (to send the link)<input name="phone" inputmode="tel" value="${esc(p ? p.phone : '')}" placeholder="98xxxxxxxx"></label>`,
    footerLeft: p ? '<button type="button" class="btn danger" id="delP" style="margin-right:auto">Delete</button>' : '',
    onOpen(form, root) { const b = $('#delP', root); if (b) b.onclick = async () => { if (!confirm('Delete this person and their link?')) return; await api.del(`${pAPI}/people/${p.id}`); root.innerHTML = ''; await loadPurchase(); renderPurchase(); }; },
    async onSubmit(form, fd) {
      const body = { category: p ? p.category : fd.get('category'), label: fd.get('label'), name: fd.get('name'), phone: fd.get('phone'), enabled: p ? p.enabled : true };
      if (p) await api.put(`${pAPI}/people/${p.id}`, body); else await api.post(`${pAPI}/people`, body);
      await loadPurchase(); renderPurchase();
    },
  });
}
function pinModal(p) {
  openModal({
    title: 'PIN for ' + p.label, submitLabel: 'Save PIN',
    body: `<p class="dr-hint">A PIN is a second lock. Even if someone gets the link, they cannot order without it. Leave empty to switch the PIN off.</p>
      <label>PIN (4 to 8 digits)<input name="pin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="${p.pinOn ? 'Type a new PIN, or empty to remove' : 'e.g. 4821'}"></label>`,
    async onSubmit(form, fd) { await api.post(`${pAPI}/people/${p.id}/pin`, { pin: fd.get('pin') }); toast(fd.get('pin') ? 'PIN saved. Tell it to them.' : 'PIN removed', 'success'); await loadPurchase(); renderPurchase(); },
  });
}

/* ---------------------------- items ---------------------------- */
function tabItems(el) {
  const all = PUR.data.items;
  el.innerHTML = `<div class="pur-bar" data-stagger><input id="pq" type="search" placeholder="Search items…" value="${esc(PUR.q)}">
    <div class="chips" style="margin:0">${[['all', 'All'], ['kitchen', 'Kitchen master'], ['juice', 'Juice master']].map(([k, t]) => `<button class="chip ${PUR.cat === k ? 'on' : ''}" data-c="${k}">${t}</button>`).join('')}</div>
    <button class="btn primary" id="addItem">+ Add item</button></div><div id="itemList"></div>`;
  const draw = () => {
    const q = PUR.q.toLowerCase(), list = all.filter((i) => (PUR.cat === 'all' || i.forCat === PUR.cat || i.forCat === 'both') && (!q || (i.name + i.group).toLowerCase().includes(q)));
    const groups = {}; list.forEach((i) => (groups[i.group] = groups[i.group] || []).push(i));
    $('#itemList').innerHTML = list.length ? Object.entries(groups).map(([g, its]) => `<div class="pur-group"><h4>${esc(g)} <small>${its.length}</small></h4><div class="pur-items">${its.map((i, n) =>
      `<div class="pur-item ${i.available ? '' : 'dim'}" data-id="${i.id}" style="--i:${Math.min(n, 12)}"><span class="pi-e">${esc(i.emoji)}</span><div class="po-main"><b>${esc(i.name)}</b><small>per ${esc(i.unit)} · ${i.forCat === 'both' ? 'Both shops' : CATN[i.forCat]}</small></div>
      <label class="pur-sw" title="In stock at the shop"><input type="checkbox" data-a="av" ${i.available ? 'checked' : ''}><i></i></label><button class="btn" data-a="edit">${pIcon(PI.edit)}</button></div>`).join('')}</div></div>`).join('') : `<div class="pur-empty"><div class="pur-bounce">🥕</div><b>No items found</b></div>`;
    $('#itemList').querySelectorAll('.pur-item').forEach((c) => {
      const it = all.find((x) => x.id === c.dataset.id);
      c.querySelector('[data-a=edit]').onclick = () => purItemModal(it);
      c.querySelector('[data-a=av]').onchange = async (e) => { c.classList.toggle('dim', !e.target.checked); await api.put(`${pAPI}/items/${it.id}`, { ...it, available: e.target.checked }); it.available = e.target.checked; };
    });
  };
  draw();
  $('#pq').oninput = (e) => { PUR.q = e.target.value; draw(); };
  el.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { PUR.cat = b.dataset.c; el.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b)); draw(); }; });
  $('#addItem').onclick = () => purItemModal();
}
function purItemModal(it) {
  const groups = [...new Set(PUR.data.items.map((i) => i.group))];
  openModal({
    title: it ? 'Edit item' : 'Add item', submitLabel: it ? 'Save' : 'Add item',
    body: `<div class="pur-row2"><label style="max-width:5rem">Emoji<input name="emoji" maxlength="4" value="${esc(it ? it.emoji : '📦')}" style="text-align:center;font-size:1.4em"></label>
      <label>Item name<input name="name" required maxlength="80" value="${esc(it ? it.name : '')}" placeholder="e.g. Onion"></label></div>
      <div class="pur-row2"><label>Section<input name="group" list="pgroups" maxlength="40" value="${esc(it ? it.group : '')}" placeholder="Vegetables"><datalist id="pgroups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label style="max-width:7rem">Unit<input name="unit" list="punits" maxlength="12" value="${esc(it ? it.unit : 'kg')}"><datalist id="punits">${['kg', 'g', 'L', 'ml', 'pcs', 'packet', 'tray', 'box', 'bunch', 'bag'].map((u) => `<option>${u}</option>`).join('')}</datalist></label></div>
      <label>Who can order it<select name="forCat">${[['both', 'Both shops'], ['kitchen', 'Kitchen master only'], ['juice', 'Juice master only']].map(([k, t]) => `<option value="${k}" ${it && it.forCat === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`,
    footerLeft: it ? '<button type="button" class="btn danger" id="delI" style="margin-right:auto">Delete</button>' : '',
    onOpen(form, root) { const b = $('#delI', root); if (b) b.onclick = async () => { if (!confirm('Delete ' + it.name + '?')) return; await api.del(`${pAPI}/items/${it.id}`); root.innerHTML = ''; await loadPurchase(); renderPurchase(); }; },
    async onSubmit(form, fd) {
      const body = { emoji: fd.get('emoji'), name: fd.get('name'), group: fd.get('group'), unit: fd.get('unit'), forCat: fd.get('forCat'), available: it ? it.available : true };
      if (it) await api.put(`${pAPI}/items/${it.id}`, body); else await api.post(`${pAPI}/items`, body);
      await loadPurchase(); renderPurchase();
    },
  });
}

/* ---------------------------- whatsapp ---------------------------- */
const PUR_SAMPLE = { number: 'P-014', label: 'Kitchen master', person: 'Ramesh', category: 'Kitchen master', date: '3 Nov, 9:41 am', items: '• Onion — 10 kg\n• Tomato — 6 kg\n• Sunflower oil — 2 L', note: 'Please send fresh stock', deliverBy: 'Before 4 pm', restaurant: '' };
function purPreview(tpl) {
  const v = { ...PUR_SAMPLE, restaurant: S.settings.restaurantName || 'Kitchen' };
  return tpl.split('\n').filter((l) => !((/\{note\}/.test(l) && !v.note) || (/\{deliverBy\}/.test(l) && !v.deliverBy))).join('\n').replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
}
function tabWA(el) {
  const d = PUR.data;
  el.innerHTML = `<div class="pur-grid2">
   <div>
    <div class="card-box pur-card" data-stagger><h3>Purchase sender number</h3>
      <p class="pur-mute" style="margin:-.4rem 0 .8rem">Separate from the number that messages your customers (Settings). Purchase orders are sent from this one.</p>
      <div id="waSender"></div>
      <label class="pur-auto"><span><b>Use the customer-messages number instead</b><small>Only if you have just one WhatsApp number</small></span><span class="pur-sw"><input type="checkbox" id="sameNum" ${d.useMainSender ? 'checked' : ''}><i></i></span></label>
      <label class="pur-auto"><span><b>Send automatically</b><small>As soon as an order is placed</small></span><span class="pur-sw"><input type="checkbox" id="autoSend" ${d.autoSend ? 'checked' : ''}><i></i></span></label></div>
    <div class="card-box pur-card" data-stagger><div class="pur-h"><h3>Receivers</h3><button class="btn primary" id="addRecv">+ Add number</button></div>
      <div class="pur-recvs">${d.receivers.length ? d.receivers.map((r) => `<div class="pur-recv" data-id="${r.id}"><span class="pi-e">📱</span><div class="po-main"><b>${esc(r.name)}</b><small>${esc(r.phone)}</small><div class="chips" style="margin:.3rem 0 0">${r.cats.map((c) => `<span class="pur-pill ${c}">${CATN[c]}</span>`).join('')}</div></div>
        <button class="btn" data-a="test" title="Send a test">${pIcon(PI.send)}</button><button class="btn" data-a="edit">${pIcon(PI.edit)}</button></div>`).join('') : '<p class="pur-mute">No receiver yet. Add the number of the person who buys the supplies.</p>'}</div></div>
   </div>
   <div class="card-box pur-card" data-stagger><h3>Message</h3>
    <div class="pur-phone"><div class="pur-bubble" id="bubble"></div></div>
    <label>Edit message<textarea id="tpl" rows="9" maxlength="2000">${esc(d.template)}</textarea></label>
    <div class="chips pur-ph">${['number', 'label', 'person', 'category', 'date', 'items', 'note', 'deliverBy', 'restaurant'].map((k) => `<button type="button" class="chip" data-ph="{${k}}">{${k}}</button>`).join('')}</div>
    <div class="pur-act"><button class="btn primary" id="saveTpl">Save message</button><button class="btn" id="resetTpl">Use default</button></div></div></div>`;
  const tpl = $('#tpl'), bub = $('#bubble'), draw = () => { bub.textContent = purPreview(tpl.value); };
  draw(); tpl.oninput = draw;
  el.querySelectorAll('[data-ph]').forEach((b) => { b.onclick = () => { const a = tpl.selectionStart; tpl.setRangeText(b.dataset.ph, a, tpl.selectionEnd, 'end'); tpl.focus(); draw(); }; });
  $('#saveTpl').onclick = async (e) => { await api.put(`${pAPI}/settings`, { template: tpl.value }); d.template = tpl.value; const b = e.currentTarget; b.textContent = 'Saved ✓'; setTimeout(() => (b.textContent = 'Save message'), 1500); };
  $('#resetTpl').onclick = async () => { const r = await api.put(`${pAPI}/settings`, { resetTemplate: true }); d.template = r.template; tpl.value = r.template; draw(); };
  drawSender(d.sender);
  $('#sameNum').onchange = async (e) => { const r = await api.put(`${pAPI}/settings`, { useMainSender: e.target.checked }); d.useMainSender = r.useMainSender; d.sender = r.sender; drawSender(r.sender); $('.pur-wa') && updatePill(r.sender); toast(e.target.checked ? 'Purchase orders will use the customer-messages number' : 'Purchase orders will use their own number', 'success'); };
  $('#waSender').onclick = async (e) => {
    const id = e.target.id; try {
      if (id === 'pwaStart') drawSender(await api.post(`${pAPI}/wa/start`));
      if (id === 'pwaUnlink' && confirm('Unlink the Purchase WhatsApp? Purchase orders will not be sent until you link again.')) drawSender(await api.post(`${pAPI}/wa/logout`));
    } catch (ex) { toast(ex.message, 'error'); }
  };
  $('#autoSend').onchange = async (e) => { await api.put(`${pAPI}/settings`, { autoSend: e.target.checked }); d.autoSend = e.target.checked; toast(e.target.checked ? 'Orders will be sent automatically' : 'Automatic sending is off', 'success'); };
  $('#addRecv').onclick = () => receiverModal();
  el.querySelectorAll('.pur-recv').forEach((c) => {
    const r = d.receivers.find((x) => x.id === c.dataset.id);
    c.querySelector('[data-a=edit]').onclick = () => receiverModal(r);
    c.querySelector('[data-a=test]').onclick = async () => { try { const x = await api.post(`${pAPI}/receivers/${r.id}/test`); toast('Test message sent', 'success'); } catch (ex) { toast(ex.message, 'error'); } };
  });
}
function updatePill(sn) { const p = $('.pur-wa'); if (!p) return; p.className = 'pur-wa ' + (sn.connected ? 'ok' : 'off'); p.innerHTML = `<i></i>${sn.connected ? 'WhatsApp ready' : 'WhatsApp not linked'}`; }
function drawSender(sn) {
  PUR.data.sender = sn; updatePill(sn);
  const el = $('#waSender'); if (!el) return; const l = sn.link || {};
  if (sn.shared) {
    el.innerHTML = `<div class="pur-sender ${sn.connected ? 'ok' : 'off'}"><span class="pulse"></span><div><b>${sn.connected ? '+' + esc(String(sn.number || '').replace(/^\+/, '')) : 'Customer-messages number is not linked'}</b><small>Using the same number as customer messages. Link it in Settings.</small></div>${sn.connected ? '' : '<a class="btn primary" href="#settings">Open Settings</a>'}</div>`;
  } else if (l.status === 'connected') {
    el.innerHTML = `<div class="pur-sender ok"><span class="pulse"></span><div><b>+${esc(String(l.number).replace(/^\+/, ''))}</b><small>Linked. Purchase orders are sent from this number.</small></div><button type="button" class="btn danger" id="pwaUnlink">Unlink</button></div>`;
  } else if (l.status === 'qr' && l.qr) {
    el.innerHTML = `<div class="pur-qrbox"><img src="${l.qr}" alt="WhatsApp QR code" width="200" height="200"><ol><li>Open WhatsApp on the <b>purchase phone</b></li><li>Settings → <b>Linked devices</b> → <b>Link a device</b></li><li>Scan this code</li></ol></div>`;
  } else if (l.status === 'starting') {
    el.innerHTML = `<div class="pur-sender off"><span class="pulse"></span><div><b>Connecting to WhatsApp…</b><small>The QR code appears here in a few seconds.</small></div></div>`;
  } else {
    el.innerHTML = `${l.error ? `<div class="err-line">${esc(l.error)}</div>` : ''}<div class="pur-sender off"><span class="pulse"></span><div><b>No purchase number linked</b><small>Scan a QR code once with the phone that should send purchase orders.</small></div><button type="button" class="btn primary" id="pwaStart">Link number</button></div>`;
  }
}
function receiverModal(r) {
  openModal({
    title: r ? 'Edit receiver' : 'Add receiver', submitLabel: r ? 'Save' : 'Add',
    body: `<label>Name<input name="name" required maxlength="60" value="${esc(r ? r.name : '')}" placeholder="e.g. Purchase manager"></label>
      <label>WhatsApp number<input name="phone" required inputmode="tel" value="${esc(r ? r.phone : '')}" placeholder="98xxxxxxxx"></label>
      <div class="dr-hint" style="margin:.4rem 0 .2rem">Sends them orders from:</div>
      <div class="chips" id="rc">${Object.entries(CATN).map(([k, v]) => `<label class="chip ${!r || r.cats.includes(k) ? 'on' : ''}" data-k="${k}"><input type="checkbox" hidden ${!r || r.cats.includes(k) ? 'checked' : ''}>${v}</label>`).join('')}</div>`,
    footerLeft: r ? '<button type="button" class="btn danger" id="delR" style="margin-right:auto">Delete</button>' : '',
    onOpen(form, root) {
      root.querySelectorAll('#rc .chip').forEach((c) => c.addEventListener('click', (e) => { e.preventDefault(); const i = c.querySelector('input'); i.checked = !i.checked; c.classList.toggle('on', i.checked); }));
      const b = $('#delR', root); if (b) b.onclick = async () => { if (!confirm('Remove this number?')) return; await api.del(`${pAPI}/receivers/${r.id}`); root.innerHTML = ''; await loadPurchase(); renderPurchase(); };
    },
    async onSubmit(form, fd) {
      const cats = [...form.querySelectorAll('#rc input:checked')].map((i) => i.closest('.chip').dataset.k);
      const body = { name: fd.get('name'), phone: fd.get('phone'), cats };
      if (r) await api.put(`${pAPI}/receivers/${r.id}`, body); else await api.post(`${pAPI}/receivers`, body);
      await loadPurchase(); renderPurchase();
    },
  });
}

/* live: a new order arrives */
function purchaseMessage(msg) {
  if (msg.action === 'wa') { if (route === 'purchase' && PUR.tab === 'wa' && $('#waSender')) api.get(`${pAPI}/wa`).then(drawSender).catch(() => {}); else if (route === 'purchase') api.get(`${pAPI}/wa`).then(updatePill).catch(() => {}); return; }
  if (msg.action === 'order') { Sound.play('new'); toast(`🛒 New purchase order ${msg.number} from ${msg.label}`, 'success'); }
  if (route !== 'purchase') return;
  loadPurchase().then(() => {
    if (msg.action === 'order') { const f = PUR.data.orders[0]; if (f) PUR.fresh.add(f.id); setTimeout(() => PUR.fresh.clear(), 4000); }
    if (!document.querySelector('.overlay')) renderPurchase();
  });
}
