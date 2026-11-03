'use strict';
/* Admin dashboard: overview, orders, items, platforms, kitchen admins, settings */

const S = {
  drawerId: null, templates: [], items: [], platforms: [], orders: [], users: [], settings: {}, overview: null,
  filters: { range: 'today', platform: '', status: '' },
};
const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');
let me = null, route = 'overview';

const platformById = (id) => S.platforms.find((p) => p.id === id) || { name: '(deleted)', color: '#64748b', askTable: false };
const badge = (p) => `<span class="badge" style="--c:${esc(p.color)}">${esc(p.name)}</span>`;
const head = (title, actions = '') => `<div class="page-head"><h1>${title}</h1><div class="toolbar" style="margin:0">${actions}</div></div>`;

/* ------------------------------------------------------------------ */
/* Modal helper                                                        */
/* ------------------------------------------------------------------ */
function openModal({ title, body, submitLabel = 'Save', wide = false, onOpen, onSubmit, footerLeft = '' }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal ${wide ? 'wide' : ''}">
    <header><h2>${esc(title)}</h2><button type="button" class="x" aria-label="Close">×</button></header>
    <form><div class="body">${body}<div class="error" id="mErr" hidden></div></div>
    <footer>${footerLeft}<button type="button" class="btn" id="mCancel">Cancel</button><button class="btn primary" id="mSave">${esc(submitLabel)}</button></footer></form></div></div>`;
  const close = () => { root.innerHTML = ''; };
  const form = $('form', root);
  $('.x', root).onclick = close; $('#mCancel', root).onclick = close;
  $('.overlay', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('overlay')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#mSave', root), err = $('#mErr', root);
    err.hidden = true; btn.disabled = true;
    try { await onSubmit(form, new FormData(form)); close(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  onOpen && onOpen(form, root);
  const first = $('input:not([type=hidden]), select', form); first && first.focus();
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */
async function loadBase() {
  const [items, platforms, settings, mo] = await Promise.all([api.get('/api/items'), api.get('/api/platforms'), api.get('/api/settings'), api.get('/api/menu-order').catch(() => ({ cats: [], items: {} }))]);
  S.menuOrder = mo; S.items = items; S.platforms = platforms; S.settings = settings; setServerTime(settings.serverTime);
  $('#brandName').textContent = settings.restaurantName;
}
const loadOrders = async () => { S.orders = (await api.get('/api/orders?range=' + S.filters.range)).reverse(); };
const loadOverview = async () => { S.overview = await api.get('/api/overview'); };
const loadUsers = async () => { S.users = await api.get('/api/users'); };

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const routes = { overview: renderOverview, orders: renderOrders, items: renderItems, platforms: renderPlatforms, integrations: renderIntegrations, purchase: () => renderPurchase(), staff: renderStaff, messages: renderMessages, settings: renderSettings };
async function go() {
  route = (location.hash.slice(1) in routes) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === route));
  if (route !== 'orders' && route !== 'overview' && S.drawerId) { S.drawerId = null; const dr = $('#drawer-root'); if (dr) dr.innerHTML = ''; }
  try {
    if (route === 'overview') await loadOverview();
    if (route === 'orders') await loadOrders();
    if (route === 'integrations') await loadIntegrations();
    if (route === 'purchase') await loadPurchase();
    if (route === 'staff') await loadUsers();
    if (route === 'messages') S.templates = await api.get('/api/templates');
    if (route !== 'items') main.dataset.pg = route;
    routes[route]();
  } catch (e) { toast(e.message, 'error'); }
}
window.addEventListener('hashchange', go);

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
const ICON = {
  table: '<path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M17 3c-2 1.5-3 4-3 7h3v11"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8a3 3 0 016 0"/>',
  ride: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17h5l3-8h3M14 9l-1-3h-2"/>',
  rupee: '<path d="M6 4h12M6 9h12M9 4c5 0 7 2.5 7 5s-2 5-7 5l7 6"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  fire: '<path d="M12 3c1 3 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>',
};
const svg = (k, size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const platIcon = (name) => (/table|dine/i.test(name) ? 'table' : /take|pick|counter/i.test(name) ? 'bag' : 'ride');
const mmss = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

function renderOverview() {
  const o = S.overview, bs = o.byStatus, tot = Math.max(1, o.totalOrders);
  const topMax = Math.max(1, ...o.topItems.map((t) => t.qty));
  const first = ((me && me.name) || 'Admin').split(' ')[0];
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const late = o.late || { count: 0, redAfterMin: 20, oldest: null };
  const ol = late.oldest;
  const banner = late.count
    ? `<small>Needs attention</small><h4>${late.count} order${late.count === 1 ? ' is' : 's are'} past ${late.redAfterMin} minutes</h4>
       <p>The oldest, ${orderNo(ol.number)}${ol.tableNo ? ' (Table ' + esc(ol.tableNo) + ')' : ''}, has been waiting ${mmss(ol.ageMs)}. Open the board to clear the queue.</p>`
    : `<small>All good</small><h4>Nothing is running late</h4><p>No order has waited more than ${late.redAfterMin} minutes. The kitchen is on track.</p>`;
  main.innerHTML = `
  <div class="ov-top">
    <div><div class="ov-hello">Welcome back, ${esc(first)}</div><h1>Overview<small>${esc(today)}</small></h1></div>
    <div class="ov-tools"><span class="ov-user"><b>${esc(first.charAt(0).toUpperCase())}</b>${esc((me && me.name) || '')}</span></div>
  </div>
  <div class="ov-grid">
    <div class="ov-col">
      <div class="card-box"><div class="ov-ch"><h3>Orders by platform</h3><span>Today</span></div>
        <div class="ov-plat">${o.byPlatform.map((p) => `
          <div class="ov-pf" style="--c:${esc(p.color)}"><div class="ov-pt">${svg(platIcon(p.name), 22)}</div>
          <div><b>${p.count}</b><span>${esc(p.name)}</span><em>${money(p.revenue)}</em></div></div>`).join('') || '<div class="empty">No platforms yet</div>'}</div></div>
      <div class="card-box"><div class="ov-ch"><h3>Latest orders</h3><span>Click an order for full details</span></div>
        ${o.recent.length ? `<table class="latest-t"><thead><tr><th>Order</th><th>Platform</th><th>Items</th><th>Total</th><th>Time</th><th>Status</th></tr></thead><tbody>${o.recent.map((r) => {
          const q = r.items.reduce((n, l) => n + l.qty, 0), p = platformById(r.platformId);
          return `<tr data-oid="${r.id}" tabindex="0" title="Open order ${orderNo(r.number)}">
          <td class="no">${orderNo(r.number)}</td><td><span class="ov-tag" style="--c:${esc(p.color)}"><i></i>${esc(p.name)}</span></td>
          <td><button type="button" class="items-btn" data-oitems><b>${q}</b> ${q === 1 ? 'item' : 'items'}<span class="chev">›</span></button></td>
          <td class="money">${money(r.total)}</td>
          <td class="when">${fmtClock(r.createdAt)}<small>${new Date(r.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</small></td>
          <td><span class="status-pill ${r.status}">${r.status}</span></td></tr>`;
        }).join('')}</tbody></table>` : '<div class="empty">No orders yet today</div>'}</div>
      <div class="card-box"><div class="ov-ch"><h3>Top items today</h3><span>Sold</span></div>
        ${o.topItems.length ? `<div class="ov-top-items">${o.topItems.map((t) => `<div class="ov-it"><div class="r"><span>${esc(t.name)}</span><b>${t.qty}</b></div><div class="bar"><i style="width:${(t.qty / topMax) * 100}%"></i></div></div>`).join('')}</div>` : '<div class="empty">Nothing yet</div>'}</div>
    </div>
    <div class="ov-col">
      <div class="card-box"><div class="ov-ch"><h3>Order status</h3><span>Today</span></div>
        <div class="ov-sbar"><i class="s-served" style="width:${(bs.served / tot) * 100}%"></i><i class="s-ready" style="width:${(bs.ready / tot) * 100}%"></i><i class="s-preparing" style="width:${(bs.preparing / tot) * 100}%"></i></div>
        <div class="ov-sg"><div><span><i class="s-total"></i>Total</span><b>${o.totalOrders}</b></div><div><span><i class="s-preparing"></i>Preparing</span><b>${bs.preparing}</b></div><div><span><i class="s-ready"></i>Ready</span><b>${bs.ready}</b></div><div><span><i class="s-served"></i>Served</span><b>${bs.served}</b></div></div></div>
      <div class="ov-tiles">
        <div class="card-box ov-tile t1"><div class="tt">${svg('rupee', 26)}</div><div><span>Revenue</span><b>${money(o.revenue)}</b></div></div>
        <div class="card-box ov-tile t2"><div class="tt">${svg('clock', 26)}</div><div><span>Avg. prep time</span><b>${o.avgPrepMinutes == null ? '–' : o.avgPrepMinutes + '<small>min</small>'}</b></div></div>
        <div class="card-box ov-tile t3"><div class="tt">${svg('bag', 26)}</div><div><span>Avg. order value</span><b>${money(o.avgOrderValue)}</b></div></div>
        <div class="card-box ov-tile t4"><div class="tt">${svg('fire', 26)}</div><div><span>Open orders</span><b>${o.active}</b></div></div>
      </div>
      <div class="ov-ban ${late.count ? 'warn' : ''}">${banner}<a class="ov-btn" href="/kitchen.html" target="_blank">Open kitchen board</a>
        <i class="b-base"></i><i class="b-sun"></i><i class="b-lime"></i><i class="b-cube"></i><i class="b-ring"></i></div>
    </div>
  </div>`;
  main.querySelectorAll('tr[data-oid]').forEach((tr) => {
    const open = () => openDrawer(tr.dataset.oid);
    tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  if (S.drawerId) openDrawer(S.drawerId, true);
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */
function renderOrders() {
  const f = S.filters;
  let list = S.orders;
  if (f.platform) list = list.filter((o) => o.platformId === f.platform);
  if (f.status) list = list.filter((o) => o.status === f.status);
  main.innerHTML = head('Orders', `<button class="btn primary" id="newOrder">+ New order</button>`) + `
  <div class="ord-filters">
    <div class="seg2" id="fRange"><button type="button" data-v="today" class="${f.range === 'today' ? 'on' : ''}">Today &amp; open</button><button type="button" data-v="all" class="${f.range === 'all' ? 'on' : ''}">All orders</button></div>
    <div class="chips" id="fPlatform" style="margin:0"><button type="button" class="chip ${f.platform ? '' : 'on'}" data-v="">All platforms</button>${S.platforms.map((p) => `<button type="button" class="chip ${f.platform === p.id ? 'on' : ''}" data-v="${p.id}" style="--c:${esc(p.color)}"><i></i>${esc(p.name)}</button>`).join('')}</div>
    <select id="fStatus"><option value="">All statuses</option>${['preparing', 'ready', 'served'].map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <span class="small">${list.length} order${list.length === 1 ? '' : 's'}</span>
  </div>
  <div class="table-wrap premium">${list.length ? `<table class="orders-t"><thead><tr><th>Order</th><th>Platform</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((o) => {
      const p = platformById(o.platformId);
      const who = o.customerName || (o.tableNo ? '' : '–');
      const qty = o.items.reduce((n, l) => n + l.qty, 0);
      return `<tr data-id="${o.id}">
      <td data-l="Order"><div class="ord-no">${orderNo(o.number)}</div><div class="ord-time">${fmtDateTime(o.createdAt)}</div></td>
      <td data-l="Platform">${badge(p)}</td>
      <td data-l="Customer">${o.tableNo ? `<div class="cust-main">Table ${esc(o.tableNo)}</div>` : ''}${who ? `<div class="${o.tableNo ? 'cust-sub' : 'cust-main'}">${esc(who)}</div>` : ''}</td>
      <td data-l="Items"><button type="button" class="items-btn" data-items title="View all items in this order"><b>${qty}</b> ${qty === 1 ? 'item' : 'items'}<span class="chev">›</span></button>${o.notes ? '<span class="note-dot" title="Has a kitchen note">📝</span>' : ''}</td>
      <td data-l="Total" class="num money">${money(o.total)}</td>
      <td data-l="Status"><select class="status ${o.status}" data-status>${['preparing', 'ready', 'served'].map((s) => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td class="actions"><button class="btn sm" data-edit>Edit</button><button class="btn sm danger" data-del>Delete</button></td></tr>`;
    }).join('')}</tbody></table>` : (f.platform || f.status || f.range === 'all' && S.orders.length ? emptyState('🔎', 'No orders match these filters', 'Try another platform or status.', '<button type="button" class="btn primary" id="clearF">Clear filters</button>') : emptyState('🍽️', 'No orders yet today', 'New orders show up here the moment they arrive.', '<button type="button" class="btn primary" id="emptyNew">+ New order</button>'))}</div>`;

  $('#newOrder').onclick = () => orderModal();
  const cf = $('#clearF'); if (cf) cf.onclick = () => { S.filters.platform = ''; S.filters.status = ''; renderOrders(); };
  const en = $('#emptyNew'); if (en) en.onclick = () => orderModal();
  main.querySelectorAll('#fRange button').forEach((b) => { b.onclick = async () => { S.filters.range = b.dataset.v; await loadOrders(); renderOrders(); }; });
  main.querySelectorAll('#fPlatform .chip').forEach((b) => { b.onclick = () => { S.filters.platform = b.dataset.v; renderOrders(); }; });
  $('#fStatus').onchange = (e) => { S.filters.status = e.target.value; renderOrders(); };
  main.querySelectorAll('tr[data-id]').forEach((tr) => {
    const order = S.orders.find((o) => o.id === tr.dataset.id);
    $('[data-items]', tr).onclick = () => openDrawer(order.id);
    $('.ord-no', tr).onclick = () => openDrawer(order.id);
    $('[data-edit]', tr).onclick = () => orderModal(order);
    $('[data-del]', tr).onclick = () => deleteOrder(order);
    $('[data-status]', tr).onchange = async (e) => {
      try { await api.patch(`/api/orders/${order.id}/status`, { status: e.target.value }); } catch (ex) { toast(ex.message, 'error'); }
    };
  });
  if (S.drawerId) openDrawer(S.drawerId, true);   // keep an open order panel in sync with live updates
}

async function deleteOrder(order) {
  if (!confirm(`Delete order ${orderNo(order.number)}?`)) return;
  try { await api.del('/api/orders/' + order.id); closeDrawer(); toast('Order deleted', 'success'); } catch (e) { toast(e.message, 'error'); }
}

/* ------------------------------------------------------------------ */
/* Order details drawer (slide-over panel)                             */
/* ------------------------------------------------------------------ */
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under 1 min' : m + ' min'; };
function closeDrawer() {
  S.editItems = null; S.editRows = null; S.editRowsFor = null;
  S.drawerId = null;
  const root = $('#drawer-root'); if (!root) return;
  const d = $('.drawer', root);
  if (!d) { root.innerHTML = ''; return; }
  root.classList.add('closing');
  setTimeout(() => { root.innerHTML = ''; root.classList.remove('closing'); }, 180);
}
function openDrawer(id, silent) {
  const o = S.orders.find((x) => x.id === id) || (S.overview && S.overview.recent.find((x) => x.id === id));
  if (!o) return closeDrawer();
  if (silent && S.editItems === id && S.editRows) return;   // do not wipe what is being typed
  S.drawerId = id;
  let root = $('#drawer-root');
  if (!root) { root = document.createElement('div'); root.id = 'drawer-root'; document.body.appendChild(root); }
  const keep = $('.dr-body', root); const scroll = keep ? keep.scrollTop : 0;
  const p = platformById(o.platformId);
  const qty = o.items.reduce((n, l) => n + l.qty, 0);
  const steps = [
    ['Order placed', o.createdAt, ''],
    ['Marked ready', o.status !== 'preparing' ? o.readyAt : null, o.readyAt ? 'after ' + fmtDur(o.readyAt - o.createdAt) : ''],
    ['Served', o.status === 'served' ? o.servedAt : null, o.servedAt && o.readyAt ? fmtDur(o.servedAt - o.readyAt) + ' after ready' : ''],
  ];
  root.innerHTML = `<div class="dr-back ${silent ? 'no-anim' : ''}"></div>
  <aside class="drawer ${silent ? 'no-anim' : ''}" role="dialog" aria-modal="true" aria-label="Order ${orderNo(o.number)}">
    <header class="dr-head">
      <div><div class="dr-eyebrow">Order</div><h2>${orderNo(o.number)}</h2></div>
      <div class="dr-head-r"><span class="status-pill ${o.status}">${o.status}</span><button type="button" class="dr-x" aria-label="Close">×</button></div>
    </header>
    <div class="dr-body">
      <div class="dr-meta">
        <div><span class="lbl">Platform</span>${badge(p)}</div>
        <div><span class="lbl">Placed</span><b>${fmtDateTime(o.createdAt)}</b></div>
        ${o.tableNo ? `<div><span class="lbl">Table</span><b>${esc(o.tableNo)}</b></div>` : ''}
        <div><span class="lbl">Customer</span><b>${esc(o.customerName || '–')}</b></div>
        ${o.phone ? `<div><span class="lbl">WhatsApp</span><b>${esc(o.phone)}</b></div>` : ''}
        ${o.createdBy ? `<div><span class="lbl">${o.source ? 'Received from' : 'Taken by'}</span><b>${esc(o.createdBy)}</b></div>` : ''}
        ${o.source && o.source.externalId ? `<div><span class="lbl">Their order ID</span><b>${esc(o.source.externalId)}</b></div>` : ''}
      </div>
      <h3 class="dr-sec">Items <span class="dr-count">${qty} total</span><button type="button" class="dr-link" data-eitems>✎ Edit items &amp; prices</button></h3>
      ${o.items.some((l) => !(l.price > 0)) ? `<p class="dr-hint">Some prices are ₹0 (the POS did not send them). Press <b>Edit items &amp; prices</b> to change a name, quantity or price, add an item, or remove one.</p>` : ''}
      <div id="itemsBox"><ul class="dr-items">${o.items.map((l) => `<li><span class="q">${l.qty}×</span><span class="n">${esc(l.name)}<small>${money(l.price)} each</small></span><span class="p">${money(l.price * l.qty)}</span></li>`).join('')}</ul>
      <div class="dr-total"><span>Total</span><b>${money(o.total)}</b></div></div>
      ${o.notes ? `<div class="dr-note"><span>Kitchen note</span>${esc(o.notes)}</div>` : ''}
      <h3 class="dr-sec">Progress</h3>
      <ol class="dr-time">${steps.map(([label, ts, extra]) => `<li class="${ts ? 'done' : ''}"><i></i><div><b>${label}</b><small>${ts ? fmtDateTime(ts) + (extra ? ' · ' + extra : '') : 'Pending'}</small></div></li>`).join('')}</ol>
      ${o.phone ? `<h3 class="dr-sec">WhatsApp messages</h3>${waBadge(o)}<p class="small" style="margin:6px 0 0">Click a message to send it again.</p>` : ''}
    </div>
    <footer class="dr-foot">
      <div class="seg" role="group" aria-label="Change status">${['preparing', 'ready', 'served'].map((s) => `<button type="button" class="${o.status === s ? 'on ' + s : ''}" data-st="${s}">${s}</button>`).join('')}</div>
      <div class="dr-actions">
        <button type="button" class="btn" data-dedit>Edit order</button>
        <button type="button" class="btn danger" data-ddel>Delete</button>
      </div>
    </footer>
  </aside>`;
  const body = $('.dr-body', root); if (body) body.scrollTop = scroll;
  $('.dr-back', root).onclick = closeDrawer; $('.dr-x', root).onclick = closeDrawer;
  $('[data-dedit]', root).onclick = () => { closeDrawer(); orderModal(o); };
  $('[data-eitems]', root).onclick = () => itemsEditor(o, root);
  if (S.editItems === o.id) itemsEditor(o, root);
  $('[data-ddel]', root).onclick = () => deleteOrder(o);
  root.querySelectorAll('[data-st]').forEach((b) => { b.onclick = async () => { if (b.dataset.st === o.status) return; try { await api.patch(`/api/orders/${o.id}/status`, { status: b.dataset.st }); } catch (e) { toast(e.message, 'error'); } }; });
  root.querySelectorAll('[data-wa]').forEach((btn) => { btn.onclick = async () => {
    btn.disabled = true; const ev = btn.dataset.wa;
    try { const r = await api.post(`/api/orders/${o.id}/whatsapp`, { event: ev }); const st = r.wa && r.wa[ev]; toast(st && st.ok ? 'WhatsApp message sent' : 'Not sent: ' + ((st && st.error) || 'unknown error'), st && st.ok ? 'success' : 'error'); }
    catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }; });
}
/* Add, change or remove the items of an order (also for orders that came from a POS) */
function itemsEditor(o, root) {
  const box = $('#itemsBox', root); if (!box) return;
  S.editItems = o.id;
  const rows = S.editRows = S.editRows && S.editItems === o.id && S.editRowsFor === o.id ? S.editRows : o.items.map((l) => ({ itemId: l.itemId, name: l.name, qty: l.qty, price: l.price }));
  S.editRowsFor = o.id;
  const total = () => rows.reduce((t, r) => t + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
  const draw = () => {
    box.innerHTML = `<datalist id="menuNames">${S.items.map((i) => `<option value="${esc(i.name)}"></option>`).join('')}</datalist>
    <div class="ie-head"><span>Qty</span><span>Item</span><span>Price each</span><span></span></div>
    <div class="ie-rows">${rows.map((r, n) => `<div class="ie-row" data-n="${n}"><input class="ie-q" type="number" min="1" max="99" value="${esc(r.qty)}" aria-label="Quantity"><input class="ie-n" list="menuNames" value="${esc(r.name)}" maxlength="120" aria-label="Item name" placeholder="Item name"><input class="ie-p" type="number" min="0" step="0.01" value="${esc(r.price)}" aria-label="Price each"><button type="button" class="ie-x" aria-label="Remove item" ${rows.length < 2 ? 'disabled' : ''}>×</button></div>`).join('')}</div>
    <button type="button" class="btn sm" id="ieAdd">+ Add item</button>
    <div class="dr-total"><span>Total</span><b id="ieTot">${money(total())}</b></div>
    <div class="error" id="ieErr" hidden></div>
    <div class="ie-act"><button type="button" class="btn" id="ieCancel">Cancel</button><button type="button" class="btn primary" id="ieSave">Save items</button></div>`;
    box.querySelectorAll('.ie-row').forEach((row) => {
      const r = rows[+row.dataset.n];
      $('.ie-q', row).oninput = (e) => { r.qty = e.target.value; $('#ieTot', box).textContent = money(total()); };
      $('.ie-p', row).oninput = (e) => { r.price = e.target.value; $('#ieTot', box).textContent = money(total()); };
      $('.ie-n', row).oninput = (e) => {
        r.name = e.target.value;
        const m = S.items.find((i) => i.name.toLowerCase() === r.name.trim().toLowerCase());
        if (m && !(Number(r.price) > 0)) { r.price = m.price; r.itemId = m.id; $('.ie-p', row).value = m.price; $('#ieTot', box).textContent = money(total()); }
      };
      $('.ie-x', row).onclick = () => { rows.splice(+row.dataset.n, 1); draw(); };
    });
    $('#ieAdd', box).onclick = () => { rows.push({ itemId: '', name: '', qty: 1, price: 0 }); draw(); const ins = box.querySelectorAll('.ie-n'); ins[ins.length - 1].focus(); };
    $('#ieCancel', box).onclick = () => { S.editItems = null; S.editRows = null; S.editRowsFor = null; openDrawer(o.id, false); };
    $('#ieSave', box).onclick = async () => {
      const btn = $('#ieSave', box), err = $('#ieErr', box); btn.disabled = true; err.hidden = true;
      try {
        const saved = await api.put(`/api/orders/${o.id}/items`, { items: rows.map((r) => ({ itemId: r.itemId, name: r.name, qty: r.qty, price: r.price })) });
        const i = S.orders.findIndex((x) => x.id === o.id); if (i >= 0) S.orders[i] = saved;
        S.editItems = null; S.editRows = null; S.editRowsFor = null; toast('Items saved', 'success'); openDrawer(o.id, false);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
  };
  draw();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.drawerId && !$('#modal-root').innerHTML) closeDrawer(); });

/** Compact WhatsApp chips under an order's status: Accepted / Ready / Served. Click a chip to (re)send. */
const WA_EVENTS = [['accepted', 'Accepted'], ['ready', 'Ready'], ['served', 'Served']];
function waBadge(o) {
  if (!o.phone) return '';
  const wa = o.wa || {};
  const rank = { preparing: 0, ready: 1, served: 2 }[o.status];
  const chips = WA_EVENTS.map(([ev, label]) => {
    const r = wa[ev];
    const reached = ev === 'accepted' || (ev === 'ready' && rank >= 1) || (ev === 'served' && rank >= 2);
    if (r && r.ok) return `<button type="button" class="wa-chip ok" data-wa="${ev}" title="${label} message sent ${fmtClock(r.at)}. Click to send again">✓ ${label}</button>`;
    if (r) return `<button type="button" class="wa-chip bad" data-wa="${ev}" title="${esc(r.error)}. Click to retry">✕ ${label}</button>`;
    if (reached) return `<button type="button" class="wa-chip" data-wa="${ev}" title="Not sent yet. Click to send">${label}</button>`;
    return `<span class="wa-chip off" title="Sent automatically when the order is ${ev}">${label}</span>`;
  });
  return `<div class="wa-row"><span class="wa-lbl">WhatsApp</span>${chips.join('')}</div>`;
}

function orderModal(order) {
  const qty = {};
  (order ? order.items : []).forEach((l) => { qty[l.itemId] = l.qty; });
  // available items + anything already in the order (even if since removed/unavailable)
  const catalog = menuFlat().filter((i) => i.available || qty[i.id]);
  if (order) order.items.forEach((l) => { if (!S.items.find((i) => i.id === l.itemId)) catalog.push({ id: l.itemId, name: l.name, price: l.price, category: '(removed from menu)' }); });
  const v = (k) => esc(order ? order[k] : '');

  openModal({
    title: order ? `Edit order ${orderNo(order.number)}` : 'New order', wide: true, submitLabel: order ? 'Save changes' : 'Create order',
    footerLeft: '<span class="total">Total: <span id="oTotal">₹0</span></span>',
    body: `<div class="g2">
      <label>Platform<select name="platformId" required>${S.platforms.map((p) => `<option value="${p.id}" ${order && order.platformId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label id="tableWrap">Table number<input name="tableNo" value="${v('tableNo')}" maxlength="20"></label>
      <label>Customer name (optional)<input name="customerName" value="${v('customerName')}" maxlength="60"></label>
      <label>WhatsApp number (auto-message when ready)<input name="phone" value="${v('phone')}" inputmode="tel" placeholder="9876543210" maxlength="20"></label>
    </div>
    <label>Notes for kitchen<textarea name="notes" maxlength="300" placeholder="e.g. less spicy, no onion">${v('notes')}</textarea></label>
    ${order ? `<label>Status<select name="status">${['preparing', 'ready', 'served'].map((s) => `<option ${order.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>` : ''}
    <div class="picker"><div class="ss-wrap"><input class="search" id="pSearch" placeholder="Search items… try “peri shawai”, “2 mandi” or a misspelling" autocomplete="off" spellcheck="false"><span class="ss-kbd" id="ssKbd" hidden>↵ add</span></div><div class="ss-hint" id="ssHint"></div><div class="list" id="pList">
      ${catalog.length ? catalog.map((i) => `<div class="pick ${qty[i.id] ? 'has' : ''}" data-id="${i.id}" data-name="${esc(i.name.toLowerCase())}" data-cat="${esc(i.category.toLowerCase())}"><div><b data-n0="${esc(i.name)}">${esc(i.name)}</b><small>${esc(i.category)} · ${money(i.price)}</small></div>
        <div class="stepper"><button type="button" data-d="-1">−</button><span>${qty[i.id] || 0}</span><button type="button" data-d="1">+</button></div></div>`).join('') + '<div class="empty" id="pNone" hidden>No items match your search</div>' : '<div class="empty">Add items first (Items page).</div>'}
    </div></div>`,
    onOpen(form, root) {
      const platformSel = $('[name=platformId]', form), tableWrap = $('#tableWrap', root);
      const syncTable = () => { tableWrap.hidden = !platformById(platformSel.value).askTable; };
      platformSel.onchange = syncTable; syncTable();
      const updateTotal = () => { $('#oTotal', root).textContent = money(catalog.reduce((s, i) => s + (qty[i.id] || 0) * i.price, 0)); };
      updateTotal();
      $('#pList', root).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-d]'); if (!b) return;
        const row = b.closest('.pick'), id = row.dataset.id;
        qty[id] = Math.max(0, Math.min(99, (qty[id] || 0) + Number(b.dataset.d)));
        $('span', row).textContent = qty[id]; row.classList.toggle('has', qty[id] > 0); updateTotal(); if (b.dataset.d === '1') SmartSearch.learn(id);
      });
      // ---- smart search: order-independent, typo tolerant, sound-alike, ranked, learns your favourites ----
      const entries = SmartSearch.index(catalog), rowOf = {}, box = $('#pSearch', root), hint = $('#ssHint', root), kbd = $('#ssKbd', root), listEl = $('#pList', root);
      root.querySelectorAll('.pick').forEach((r) => { rowOf[r.dataset.id] = r; });
      const rows = () => [...root.querySelectorAll('.pick:not([hidden])')];
      let focusId = null;
      const setFocus = (id) => { focusId = id; root.querySelectorAll('.pick.focus').forEach((r) => r.classList.remove('focus')); const r = id && rowOf[id]; if (r) { r.classList.add('focus'); r.scrollIntoView({ block: 'nearest' }); } kbd.hidden = !r || !box.value.trim(); };
      const flash = (row) => { row.classList.remove('added'); void row.offsetWidth; row.classList.add('added'); };
      const bump = (id, n) => {
        const row = rowOf[id]; qty[id] = Math.max(0, Math.min(99, (qty[id] || 0) + n));
        $('span', row).textContent = qty[id]; row.classList.toggle('has', qty[id] > 0); updateTotal(); flash(row); if (n > 0) SmartSearch.learn(id, n);
      };
      const quick = () => {
        const fav = SmartSearch.favourites(catalog.map((i) => i.id));
        hint.innerHTML = fav.length ? `<span class="ss-q">⚡ Quick add</span>${fav.map((id) => `<button type="button" class="ss-chip" data-q="${id}">${esc(catalog.find((i) => i.id === id).name)}</button>`).join('')}` : '';
      };
      const draw = () => {
        const raw = box.value, r = SmartSearch.search(entries, raw);
        if (!r.q) {
          entries.forEach((e) => { const row = rowOf[e.it.id]; row.hidden = false; $('b', row).textContent = e.it.name; listEl.appendChild(row); });
          listEl.appendChild($('#pNone', root)); $('#pNone', root).hidden = true; quick(); setFocus(null); return;
        }
        const seen = new Set();
        r.results.forEach((x, n) => {
          const row = rowOf[x.e.it.id]; seen.add(x.e.it.id); row.hidden = false; $('b', row).innerHTML = SmartSearch.highlight(x.e.it.name, r.words, esc);
          row.style.setProperty('--i', Math.min(n, 8)); listEl.insertBefore(row, $('#pNone', root));
        });
        entries.forEach((e) => { if (!seen.has(e.it.id)) rowOf[e.it.id].hidden = true; });
        const none = $('#pNone', root); none.hidden = r.results.length > 0;
        if (r.mode === 'match') hint.innerHTML = `<span class="ss-ok">${r.results.length} match${r.results.length > 1 ? 'es' : ''}</span>${r.qty > 1 ? `<span class="ss-qty">× ${r.qty}</span>` : ''}<span class="ss-keys">↑ ↓ choose · ↵ add${r.qty > 1 ? ' ' + r.qty : ''}</span>`;
        else if (r.mode === 'close') hint.innerHTML = `<span class="ss-warn">No exact match. Showing closest items</span>`;
        else { hint.innerHTML = r.suggestion ? `<span class="ss-warn">Nothing found. Did you mean</span><button type="button" class="ss-chip" data-fix="${esc(r.suggestion.name)}">${esc(r.suggestion.name)}</button>?` : `<span class="ss-warn">Nothing found for “${esc(raw.trim())}”</span>`; }
        setFocus(r.results.length ? r.results[0].e.it.id : null); listEl.scrollTop = 0;
      };
      box.addEventListener('input', draw);
      box.addEventListener('keydown', (e) => {
        const vis = rows(), i = vis.findIndex((r) => r.dataset.id === focusId);
        if (e.key === 'ArrowDown') { e.preventDefault(); if (vis.length) setFocus(vis[Math.min(vis.length - 1, i + 1)].dataset.id); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (vis.length) setFocus(vis[Math.max(0, i - 1)].dataset.id); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (focusId && box.value.trim()) { bump(focusId, SmartSearch.parse(box.value).qty); const nm = catalog.find((x) => x.id === focusId).name; box.value = ''; draw(); hint.innerHTML = `<span class="ss-ok">✓ Added ${esc(nm)}</span>`; setTimeout(() => { if (!box.value) quick(); }, 1400); }
        } else if (e.key === 'Escape' && box.value) { e.stopPropagation(); box.value = ''; draw(); }
      });
      hint.addEventListener('click', (e) => {
        const q = e.target.closest('[data-q]'), f = e.target.closest('[data-fix]');
        if (q) { bump(q.dataset.q, 1); const row = rowOf[q.dataset.q]; row.scrollIntoView({ block: 'nearest' }); }
        if (f) { box.value = f.dataset.fix; draw(); box.focus(); }
      });
      listEl.addEventListener('click', (e) => { const r = e.target.closest('.pick'); if (r && !e.target.closest('button')) { setFocus(r.dataset.id); } });
      quick();
    },
    async onSubmit(form, fd) {
      const items = Object.entries(qty).filter(([, q]) => q > 0).map(([itemId, q]) => ({ itemId, qty: q }));
      if (!items.length) throw new Error('Add at least one item');
      const body = { platformId: fd.get('platformId'), tableNo: fd.get('tableNo'), customerName: fd.get('customerName'), phone: fd.get('phone'), notes: fd.get('notes'), items };
      if (order) { body.status = fd.get('status'); await api.put('/api/orders/' + order.id, body); toast('Order updated', 'success'); }
      else { await api.post('/api/orders', body); }
    },
  });
}

/* ------------------------------------------------------------------ */
/* Integrations (Swiggy / Zomato / POS webhooks)                       */
/* ------------------------------------------------------------------ */
ICON.plug = '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 01-12 0zM12 17v5"/>';
const INTEG_TYPES = { swiggy: 'Swiggy', zomato: 'Zomato', pos: 'POS software', custom: 'Other' };
const loadIntegrations = async () => { [S.integrations, S.integLogs] = await Promise.all([api.get('/api/integrations'), api.get('/api/integrations/logs')]); };
const hookUrl = (i) => location.origin + '/hook/' + i.id;
const maskKey = (k) => k.slice(0, 4) + '••••••••' + k.slice(-4);
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (_) { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast('Copied', 'success');
}
const ago = (ts) => { if (!ts) return 'never'; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : fmtDateTime(ts); };

function renderIntegrations() {
  const list = S.integrations || [];
  main.innerHTML = head('Integrations', `<button class="btn primary" id="addInteg">+ Connect POS</button>`) + `
  <div class="card-box int-intro"><b>Get Swiggy, Zomato and POS orders here automatically.</b>
    <p>Press <b>+ Connect POS</b> and pick <u>one</u> way: paste the <b>API key</b> your POS gave you, or let your POS <b>send orders to us</b>. New orders appear in <b>Preparing</b> on the kitchen board.</p></div>
  <div class="int-grid">${list.map((i) => {
    const p = platformById(i.platformId), cb = i.callback || {}, pull = i.mode === 'pull';
    const wsMode = pull && (i.pull.channel || /^wss?:/i.test(i.pull.url));
    const state = pull ? (i.lastError ? `<span class="int-bad">Not connected</span>` : (wsMode ? i.live : i.baselined) ? `<span class="int-ok">Connected</span>` : `Connecting…`) : '';
    return `<div class="card-box int-card ${i.enabled ? '' : 'off'}" data-id="${i.id}">
      <div class="int-top"><span class="int-ic t-${esc(i.type)}">${svg('plug', 22)}</span>
        <div class="int-title"><b>${esc(i.name)}</b><small>${pull ? 'API key' : 'POS sends orders to us'} → ${badge(p)}</small></div>
        <label class="sw" title="${i.enabled ? 'Receiving orders' : 'Turned off'}"><input type="checkbox" data-toggle ${i.enabled ? 'checked' : ''}><i></i></label></div>
      ${pull ? `<div class="int-row"><span>Orders from</span><code>${esc(i.pull.channel ? 'Ably · ' + i.pull.channel : (() => { try { return new URL(i.pull.url).host; } catch (_) { return i.pull.url; } })())}</code><span></span></div>`
        : `<div class="int-row"><span>Address</span><code>${esc(hookUrl(i))}</code><button class="btn sm" data-copy="${esc(hookUrl(i))}">Copy</button></div>
      <div class="int-row"><span>API key</span><code>${esc(maskKey(i.apiKey))}</code><button class="btn sm" data-copy="${esc(i.apiKey)}">Copy</button></div>`}
      <div class="int-meta">${state ? `<span>${state}</span>` : ''}<span>Last order: <b>${ago(i.lastReceivedAt)}</b></span><span><b>${i.received || 0}</b> received</span></div>
      ${i.lastError ? `<div class="int-err">${esc(i.lastError)}</div>` : ''}
      ${(i.held || []).length ? `<div class="int-held"><b>${i.held.length} waiting for the POS to accept</b><small>They show on the kitchen board as soon as the POS accepts them.</small>${i.held.map((h) => `<div class="held-row" data-hid="${esc(h.id)}"><span>${h.table ? 'Table ' + esc(h.table) + ' · ' : ''}${esc(h.customer || '')}${h.customer ? ' · ' : ''}${esc(h.items.join(', '))}</span><button type="button" class="btn sm" data-hrel>Send to kitchen</button><button type="button" class="btn sm" data-hdrop>Drop</button></div>`).join('')}</div>` : ''}
      <div class="int-actions">${pull ? '<button class="btn sm" data-check>Check connection</button>' : '<button class="btn sm" data-connect>How to connect</button>'}<button class="btn sm" data-sent>What the POS sent</button><button class="btn sm" data-edit>Edit</button><button class="btn sm danger" data-del>Delete</button></div></div>`;
  }).join('') || '<div class="card-box empty">Nothing connected yet. Press "+ Connect POS" to start.</div>'}</div>
  ${(S.integLogs || []).length ? `<div class="card-box" style="margin-top:20px"><div class="ov-ch"><h3>Recent activity</h3><span>updates live</span></div>
    <table class="int-log"><thead><tr><th>Time</th><th>Integration</th><th></th><th>What happened</th><th>Order</th></tr></thead><tbody>${S.integLogs.slice(0, 30).map((l) => `<tr>
      <td class="when">${fmtDateTime(l.at)}</td><td>${esc(l.integrationName)}</td>
      <td><span class="status-pill ${l.ok ? 'ready' : 'bad'}">${l.kind === 'out' ? '↑ sent' : '↓ received'}${l.ok ? '' : ' · failed'}</span></td>
      <td>${esc(l.message)}</td><td>${l.orderNumber ? orderNo(l.orderNumber) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;

  $('#addInteg').onclick = () => chooseModal();
  main.querySelectorAll('.int-card').forEach((card) => {
    const i = S.integrations.find((x) => x.id === card.dataset.id);
    card.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy); });
    $('[data-toggle]', card).onchange = async (e) => { try { await api.put('/api/integrations/' + i.id, { ...i, enabled: e.target.checked }); toast(e.target.checked ? 'Receiving orders' : 'Turned off', 'success'); } catch (ex) { toast(ex.message, 'error'); e.target.checked = !e.target.checked; } };
    const cn = $('[data-connect]', card); if (cn) cn.onclick = () => connectModal(i);
    const ck = $('[data-check]', card); if (ck) ck.onclick = async () => { ck.disabled = true; try { const r = await api.post(`/api/integrations/${i.id}/check`, {}); toast(r.live ? 'Connected. The POS accepted the key.' : `Connected. The POS shows ${r.count} order${r.count === 1 ? '' : 's'}.`, 'success'); } catch (ex) { toast(ex.message, 'error'); } ck.disabled = false; };
    card.querySelectorAll('.held-row').forEach((row) => {
      const act = (what, msg) => async () => { try { await api.post(`/api/integrations/${i.id}/held/${encodeURIComponent(row.dataset.hid)}/${what}`, {}); toast(msg, 'success'); } catch (ex) { toast(ex.message, 'error'); } };
      $('[data-hrel]', row).onclick = act('release', 'Sent to the kitchen');
      $('[data-hdrop]', row).onclick = act('drop', 'Dropped');
    });
    $('[data-edit]', card).onclick = () => integrationModal(i);
    $('[data-sent]', card).onclick = () => sentModal(i);
    $('[data-del]', card).onclick = async () => { if (!confirm(`Delete "${i.name}"? It will stop receiving orders. Orders already received stay.`)) return; try { await api.del('/api/integrations/' + i.id); toast('Deleted', 'success'); } catch (ex) { toast(ex.message, 'error'); } };
  });
}

/* step 1: pick ONE way to connect */
function chooseModal() {
  openModal({
    title: 'How do you want to connect your POS?', submitLabel: 'Next',
    body: `<div class="choice-grid">
      <label class="choice"><input type="radio" name="mode" value="pull" checked><div><b>I have an API key</b><span>Your POS gave you an API key (for example an <b>Ably</b> key, or a key with a wss:// / https:// address). Paste it here and new orders arrive by themselves.</span><em>Easiest. Works on any computer.</em></div></label>
      <label class="choice"><input type="radio" name="mode" value="push"><div><b>My POS sends orders to us</b><span>We give you an address and a key. You enter them in your POS settings.</span><em>Needs this app to be online (hosted or a tunnel).</em></div></label></div>`,
    async onSubmit(form, fd) { const m = fd.get('mode'); setTimeout(() => integrationModal(null, m), 200); },
  });
}

function integrationModal(i, newMode) {
  const mode = i ? (i.mode || 'push') : newMode, pull = (i && i.pull) || {};
  const m = (i && i.mapping) || {}, c = (i && i.callback) || { statusMap: {} }, sm = c.statusMap || {};
  const mv = (k) => esc(m[k] || '');
  const f = (k, label, ph) => `<label>${label}<input name="m_${k}" value="${mv(k)}" placeholder="${esc(ph)}" maxlength="120" autocomplete="off"></label>`;
  const defaultPlat = i ? i.platformId : (S.platforms.find((p) => /swiggy/i.test(p.name)) || S.platforms[0] || {}).id;
  openModal({
    title: (i ? 'Edit: ' : 'Connect POS: ') + (mode === 'pull' ? 'API key' : 'POS sends orders to us'), wide: true, submitLabel: i ? 'Save' : (mode === 'pull' ? 'Connect' : 'Create'),
    body: `<input type="hidden" name="mode" value="${mode}">
    <div class="g2">
      <label>Name<input name="name" required maxlength="60" value="${esc(i ? i.name : '')}" placeholder="e.g. My POS"></label>
      <label>Show these orders under<select name="platformId" required>${S.platforms.map((p) => `<option value="${p.id}" ${p.id === defaultPlat ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      ${mode === 'pull' ? `<label>Address (https:// or wss://)<input name="p_url" ${pull.channel ? '' : 'required'} value="${esc(pull.url || '')}" placeholder="wss://api.yourpos.com/orders  or  https://…" maxlength="500" autocomplete="off"></label>
      <label>API key<input name="p_key" ${i ? '' : 'required'} value="" placeholder="${i ? 'Leave empty to keep the current key' : 'Paste the key from your POS'}" maxlength="400" autocomplete="off"></label>
      <label id="chWrap" style="grid-column:1/-1" ${pull.channel ? '' : 'hidden'}>Channel name (your POS gives this with an Ably key; several can be separated by commas)<input name="p_channel" value="${esc(pull.channel || '')}" placeholder="e.g. orders" maxlength="300" autocomplete="off"></label>
      <div id="chFind" style="grid-column:1/-1" ${pull.channel ? 'hidden' : ''}><button type="button" class="btn sm" id="chBtn">I don't know it: find channel names</button> <span class="small" id="chMsg">Place a new order in your POS first, then press this.</span><div id="chList" class="chips"></div></div>` : ''}
    </div>
    <label class="check"><input type="checkbox" name="enabled" ${!i || i.enabled ? 'checked' : ''}>Receive orders</label>
    ${mode === 'pull' ? `<label class="check" style="margin-top:8px"><input type="checkbox" name="waitAccept" ${!i || i.waitAccept ? 'checked' : ''}>Wait until my POS accepts the order <span class="small">(orders still "waiting" in the POS stay out of the kitchen)</span></label>` : ''}
    <label class="check" style="margin-top:8px"><input type="checkbox" name="whatsapp" ${i && i.whatsapp ? 'checked' : ''}>Send WhatsApp messages to these customers</label>
    <details class="int-adv" style="margin-top:14px"><summary>Advanced <span class="small">(you can skip this)</span></summary>
      ${mode === 'pull' ? `<div class="g2"><label>Check every (seconds, for https:// only)<input name="p_int" type="number" min="5" max="300" value="${pull.intervalSec || 10}"></label>
        <label>Key header name<input name="p_hn" value="${esc(pull.headerName || '')}" placeholder="Authorization" maxlength="40"></label>
        <label style="grid-column:1/-1">Message to send after connecting (only if your POS asks for it; use <code>{key}</code> for the key)<input name="p_hello" value="${esc(pull.hello || '')}" placeholder='{"action":"login","key":"{key}"}' maxlength="500" autocomplete="off"></label></div>` : ''}
      <p class="small"><b>Where is each value?</b> Leave blank and we find common names ourselves. Use dots to go deeper, e.g. <code>order.customer.name</code>.</p>
      <div class="g2">${f('externalId', 'Order ID', 'order.id')}${f('items', 'Items list', 'order.items')}
      ${f('itemName', 'Item name', 'name')}${f('itemQty', 'Quantity', 'quantity')}
      ${f('itemPrice', 'Unit price', 'price')}${f('total', 'Order total', 'total')}
      ${f('customerName', 'Customer name', 'customer.name')}${f('phone', 'Customer phone', 'customer.phone')}
      ${f('notes', 'Kitchen note', 'instructions')}${f('tableNo', 'Table number', 'table')}</div>
      <p class="small" style="margin-top:14px"><b>Tell the POS when an order is Ready or Served</b> (only if your POS asks for it)</p>
      <label class="check"><input type="checkbox" name="cb_enabled" ${c.enabled ? 'checked' : ''}>Send status updates to the POS</label>
      <div class="g2"><label>Their URL<input name="cb_url" value="${esc(c.url || '')}" placeholder="https://pos.example.com/api/order-status" maxlength="500"></label>
      <label>Method<select name="cb_method"><option>POST</option><option ${c.method === 'PUT' ? 'selected' : ''}>PUT</option></select></label>
      <label>Header name<input name="cb_hn" value="${esc(c.headerName || '')}" placeholder="Authorization" maxlength="40"></label>
      <label>Header value<input name="cb_hv" value="${esc(c.headerValue || '')}" placeholder="Bearer their-api-key" maxlength="300" autocomplete="off"></label></div>
      <div class="g3"><label>Word for Preparing<input name="sm_preparing" value="${esc(sm.preparing && sm.preparing !== 'preparing' ? sm.preparing : '')}" placeholder="preparing"></label>
      <label>Word for Ready<input name="sm_ready" value="${esc(sm.ready && sm.ready !== 'ready' ? sm.ready : '')}" placeholder="ready"></label>
      <label>Word for Served<input name="sm_served" value="${esc(sm.served && sm.served !== 'served' ? sm.served : '')}" placeholder="served"></label></div></details>`,
    onOpen(form) {
      const key = form.querySelector('[name=p_key]'), url = form.querySelector('[name=p_url]'), wrap = form.querySelector('#chWrap');
      if (!key || !wrap) return;
      const find = form.querySelector('#chFind'), chBtn = form.querySelector('#chBtn'), chMsg = form.querySelector('#chMsg'), chList = form.querySelector('#chList'), chIn = form.querySelector('[name=p_channel]');
      chBtn.onclick = async () => {
        chBtn.disabled = true; chMsg.textContent = 'Looking…'; chList.innerHTML = '';
        try {
          const r = await api.post('/api/integrations/find-channels', { key: key.value, id: i ? i.id : '' });
          chMsg.textContent = r.channels.length ? 'Tap the one that looks like your orders:' : 'No active channels found. Place a new order in your POS and try again, or ask your POS company for the channel name.';
          r.channels.forEach((c) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = c; b.onclick = () => { chIn.value = c; chList.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); }; chList.appendChild(b); });
        } catch (ex) { chMsg.textContent = ex.message; }
        chBtn.disabled = false;
      };
      const look = () => { const ably = /^[\w-]+\.[\w-]+:\S+/.test(key.value.replace(/^\s*\w*API_KEY\s*=\s*/i, '').trim()); if (ably) { wrap.hidden = false; find.hidden = false; url.required = false; url.placeholder = 'Not needed for Ably keys'; } };
      key.addEventListener('input', look);
      key.addEventListener('blur', () => { key.value = key.value.replace(/^\s*\w*API_KEY\s*=\s*/i, '').trim(); });
    },
    async onSubmit(form, fd) {
      const mapping = {}; ['externalId', 'items', 'itemName', 'itemQty', 'itemPrice', 'total', 'customerName', 'phone', 'notes', 'tableNo'].forEach((k) => { mapping[k] = fd.get('m_' + k); });
      const body = { name: fd.get('name'), type: i ? i.type : 'custom', mode, platformId: fd.get('platformId'), enabled: fd.get('enabled') === 'on', waitAccept: fd.get('waitAccept') === 'on', whatsapp: fd.get('whatsapp') === 'on', mapping,
        pull: mode === 'pull' ? { url: fd.get('p_url'), channel: fd.get('p_channel'), key: fd.get('p_key'), headerName: fd.get('p_hn'), hello: fd.get('p_hello'), intervalSec: fd.get('p_int') } : undefined,
        callback: { enabled: fd.get('cb_enabled') === 'on', url: fd.get('cb_url'), method: fd.get('cb_method'), headerName: fd.get('cb_hn'), headerValue: fd.get('cb_hv'), statusMap: { preparing: fd.get('sm_preparing'), ready: fd.get('sm_ready'), served: fd.get('sm_served') } } };
      if (i) { await api.put('/api/integrations/' + i.id, body); toast('Saved', 'success'); }
      else { const made = await api.post('/api/integrations', body); if (mode === 'push') { toast('Created. Now enter these two things in your POS.', 'success'); setTimeout(() => connectModal(made), 250); } else toast('Connecting… new orders will appear here.', 'success'); }
    },
  });
}

function connectModal(i) {
  const url = hookUrl(i);
  const sample = `curl -X POST "${url}" \\\n  -H "x-api-key: ${i.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"order_id":"A100","customer":{"name":"Asha"},"items":[{"name":"Fresh Lime","quantity":2,"price":60}]}'`;
  openModal({
    title: 'Enter these in your POS: ' + i.name, wide: true, submitLabel: 'Done',
    body: `<ol class="int-steps"><li>Open your POS settings and find where it asks for an <b>order address</b> (also called webhook or order-push URL).</li>
    <li>Paste the <b>address</b> and the <b>API key</b> below.</li><li>Place a test order in your POS. It will show up in Preparing.</li></ol>
    <label>Address<div class="copy-line"><input readonly value="${esc(url)}"><button type="button" class="btn" data-c="${esc(url)}">Copy</button></div></label>
    <label>API key<div class="copy-line"><input readonly value="${esc(i.apiKey)}"><button type="button" class="btn" data-c="${esc(i.apiKey)}">Copy</button></div></label>
    <p class="small">Your POS must be able to reach this app over the internet. If this app runs on a normal PC, use a tunnel (Cloudflare Tunnel or ngrok) or host it online.</p>
    <details class="int-adv"><summary>For your POS technician</summary>
      <p class="small">Send orders as JSON with <b>POST</b>. Send the key in the header <code>x-api-key</code> (or <code>Authorization: Bearer …</code>), or add <code>?key=YOUR_KEY</code> to the address.</p>
      <textarea readonly rows="5" class="mono">${esc(sample)}</textarea>
      <div style="margin-top:10px"><button type="button" class="btn sm" id="tst">Send a test order</button> <button type="button" class="btn danger sm" id="regen">Make a new API key</button></div></details>`,
    onOpen(form, root) {
      root.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => copyText(b.dataset.c); });
      $('#tst', root).onclick = () => { $('#modal-root').innerHTML = ''; testModal(i); };
      $('#regen', root).onclick = async () => { if (!confirm('Make a new key? Your POS will stop working until you paste the new key into it.')) return; try { const n = await api.post(`/api/integrations/${i.id}/regenerate-key`); $('#modal-root').innerHTML = ''; toast('New key created', 'success'); setTimeout(() => connectModal(n), 200); } catch (ex) { toast(ex.message, 'error'); } };
    },
    async onSubmit() {},
  });
}

/* shows the last messages the POS sent, so you can see exactly what arrives */
async function sentModal(i) {
  let list = [];
  try { list = await api.get(`/api/integrations/${i.id}/recent`); } catch (ex) { toast(ex.message, 'error'); return; }
  const text = list.map((m) => `${fmtDateTime(m.at)}\n${m.text}`).join('\n\n');
  openModal({
    title: 'What the POS sent: ' + i.name, wide: true, submitLabel: 'Close',
    body: `<p class="small">The last ${list.length || 0} messages from your POS. If an order is not behaving right, press <b>Copy</b> and send this to your developer.</p>
    ${list.length ? `<textarea readonly rows="14" class="mono" id="sentTxt">${esc(text)}</textarea><div><button type="button" class="btn sm" id="sentCopy">Copy</button></div>` : '<div class="empty">Nothing received yet. Place an order in your POS and open this again.</div>'}`,
    onOpen(form, root) { const b = $('#sentCopy', root); if (b) b.onclick = () => copyText(text); },
    async onSubmit() {},
  });
}

function testModal(i) {
  const names = S.items.slice(0, 2).map((x) => x.name);
  const sample = { order_id: 'TEST-' + Math.floor(Math.random() * 9000 + 1000), customer: { name: 'Test customer' }, instructions: 'Test order, safe to delete', items: [{ name: names[0] || 'Sample item', quantity: 2, price: 100 }, { name: names[1] || 'Another item', quantity: 1, price: 60 }] };
  openModal({
    title: 'Send a test order: ' + i.name, wide: true, submitLabel: 'Send test order',
    body: `<p class="small">This runs through the same path as a real order from your POS, so it checks your field mapping too. <b>Paste a real order from your POS here</b> if you have one. The test order appears in Preparing; delete it from Orders afterwards.</p>
    <label>Order data (JSON)<textarea name="payload" rows="12" class="mono" spellcheck="false">${esc(JSON.stringify(sample, null, 2))}</textarea></label>`,
    async onSubmit(form, fd) { const r = await api.post(`/api/integrations/${i.id}/test`, { payload: fd.get('payload') }); toast(`Test order ${orderNo(r.order.number)} created (${r.order.items.length} item${r.order.items.length === 1 ? '' : 's'}, ${money(r.order.total)})`, 'success'); },
  });
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

/* Menu order: the admin drags categories and items; the saved order is used everywhere */
function menuGroups() {
  const mo = S.menuOrder || { cats: [], items: {} }, groups = new Map(), at = (arr, v) => { const i = (arr || []).indexOf(v); return i < 0 ? 1e6 : i; };
  S.items.forEach((i) => { if (!groups.has(i.category)) groups.set(i.category, []); groups.get(i.category).push(i); });
  const cats = [...groups.keys()].sort((a, b) => at(mo.cats, a) - at(mo.cats, b) || a.localeCompare(b));
  return new Map(cats.map((c) => [c, groups.get(c).sort((a, b) => at((mo.items || {})[c], a.id) - at((mo.items || {})[c], b.id) || a.name.localeCompare(b.name))]));
}
const menuFlat = () => [...menuGroups().values()].flat();

/** Drag to reorder (mouse + touch). Children slide out of the way, the dragged one follows the pointer. */
function sortable(box, itemSel, handleSel, { collapse = false, onDone }) {
  box.addEventListener('pointerdown', (e) => {
    const h = e.target.closest(handleSel); if (!h || e.button > 0) return;
    const el = h.closest(itemSel); if (!el || el.parentElement !== box) return;
    e.preventDefault();
    const kids = () => [...box.children].filter((c) => c.matches(itemSel));
    const scroller = document.getElementById('main') || document.scrollingElement;
    if (collapse) box.classList.add('sorting-cats');
    void box.offsetHeight;
    const r0 = el.getBoundingClientRect(), grab = collapse ? Math.min(r0.height / 2, 30) : e.clientY - r0.top;
    let y = e.clientY, before = kids().indexOf(el), raf = 0;
    el.classList.add('drag'); box.classList.add('sorting'); document.body.classList.add('is-sorting');
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    const place = () => {
      el.style.transform = 'none'; el.style.transition = 'none';
      const lay = el.getBoundingClientRect(), others = kids().filter((k) => k !== el), c = y - grab + lay.height / 2;
      let idx = 0; others.forEach((k) => { const r = k.getBoundingClientRect(); if (r.top + r.height / 2 < c) idx++; });
      if (idx !== kids().indexOf(el)) {
        const rects = new Map(others.map((k) => [k, k.getBoundingClientRect().top]));
        box.insertBefore(el, others[idx] || null);
        el.style.transform = 'none';
        others.forEach((k) => { const dy = rects.get(k) - k.getBoundingClientRect().top; if (dy) { k.style.transition = 'none'; k.style.transform = `translateY(${dy}px)`; void k.offsetHeight; k.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)'; k.style.transform = ''; } });
      }
      const l2 = el.getBoundingClientRect(); el.style.transform = `translateY(${y - grab - l2.top}px) scale(1.015)`;
    };
    const tick = () => { const b = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight }; if (y < b.top + 70) scroller.scrollTop -= 14; else if (y > b.bottom - 70) scroller.scrollTop += 14; place(); raf = requestAnimationFrame(tick); };
    const move = (ev) => { y = ev.clientY; };
    const end = () => {
      cancelAnimationFrame(raf); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', end); h.removeEventListener('pointercancel', end);
      const l = el.getBoundingClientRect(); el.style.transform = 'none'; const l2 = el.getBoundingClientRect();
      el.style.transform = `translateY(${l.top - l2.top}px) scale(1.015)`; void el.offsetHeight;
      el.style.transition = 'transform .25s cubic-bezier(.34,1.4,.5,1)'; el.style.transform = '';
      setTimeout(() => { el.classList.remove('drag'); el.style.transition = ''; box.classList.remove('sorting', 'sorting-cats'); document.body.classList.remove('is-sorting'); kids().forEach((k) => { k.style.transform = ''; k.style.transition = ''; }); }, 260);
      if (kids().indexOf(el) !== before) onDone(kids());
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    place(); raf = requestAnimationFrame(tick);
  });
}
const GRIP = '<svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor"><circle cx="4" cy="4" r="1.7"/><circle cx="10" cy="4" r="1.7"/><circle cx="4" cy="10" r="1.7"/><circle cx="10" cy="10" r="1.7"/><circle cx="4" cy="16" r="1.7"/><circle cx="10" cy="16" r="1.7"/></svg>';
const emptyState = (icon, title, text, btn = '') => `<div class="empty-state"><div class="es-ico">${icon}</div><b>${title}</b><p>${text}</p>${btn}</div>`;
const IT = { open: new Set(), q: '', f: 'all' };
function renderItems() {
  const anim = main.dataset.pg !== 'items'; main.dataset.pg = 'items';
  const total = S.items.length, outN = S.items.filter((i) => !i.available).length;
  main.innerHTML = head('Menu items', `<button class="btn primary" id="add">+ Add item</button>`) + (total ? `
  <div class="mn-tools"><div class="mn-search"><input id="mq" type="search" placeholder="Search items or category…" value="${esc(IT.q)}"></div>
    <div class="chips" style="margin:0">${[['all', 'All', total], ['in', 'In stock', total - outN], ['out', 'Out of stock', outN]].map(([k, t, n]) => `<button class="chip ${IT.f === k ? 'on' : ''}" data-f="${k}">${t} <b data-n="${n}">${anim ? 0 : n}</b></button>`).join('')}</div></div>
  <p class="mn-tip">Drag the <b>⠿</b> handle to change the order of categories and items. This order is used on the New order screen too.</p>
  <div id="mnList" class="${anim ? 'mn-anim' : ''}"></div>` : '<div class="empty">No items yet. Add your first menu item.</div>');
  $('#add').onclick = () => itemModal();
  if (!total) return;
  if (anim) main.querySelectorAll('[data-n]').forEach((el) => { const to = +el.dataset.n, t0 = performance.now(); (function f(t) { const k = Math.min(1, (t - t0) / 700); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); })(t0); });
  $('#mq').oninput = (e) => { IT.q = e.target.value.trim(); drawMenu(false); };
  main.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { IT.f = b.dataset.f; main.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); drawMenu(false); }; });
  drawMenu(anim);
}
function drawMenu(anim) {
  const q = IT.q.toLowerCase(), groups = menuGroups(), canDrag = !q && IT.f === 'all';
  let html = '', n = 0;
  groups.forEach((all, cat) => {
    const catHit = q && cat.toLowerCase().includes(q);
    const rows = all.filter((i) => (IT.f === 'all' || (IT.f === 'in') === i.available) && (!q || catHit || i.name.toLowerCase().includes(q)));
    if ((q || IT.f !== 'all') && !rows.length) return;
    const allOn = all.every((i) => i.available), someOn = all.some((i) => i.available);
    const open = IT.open.has(cat) || !!q || IT.f !== 'all';
    html += `<div class="mn-cat ${open ? 'open' : ''} ${someOn ? '' : 'dim'}" data-cat="${esc(cat)}" style="--i:${Math.min(n++, 14)}">
      <div class="mn-head" data-a="open">${canDrag ? '<span class="mn-grip cat" title="Drag to change the order" aria-label="Drag to reorder">' + GRIP + '</span>' : ''}<b>${esc(cat)} <small>(${all.length})</small></b><span class="sp"></span>
        <span class="mn-sum">${allOn ? '' : someOn ? all.filter((i) => !i.available).length + ' out' : ''}</span>
        <label class="mn-sw ${allOn ? '' : someOn ? 'part' : 'off'}" title="Turn the whole category on or off"><input type="checkbox" data-a="cat" ${someOn ? 'checked' : ''}><i></i></label>
        <span class="mn-st">${allOn ? 'In stock' : someOn ? 'Partly' : 'Out of stock'}</span>
        <svg class="mn-car" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 9l7 7 7-7"/></svg></div>
      <div class="mn-body"><div><div class="mn-rows">${rows.map((i, k) => `<div class="mn-row ${i.available ? '' : 'out'}" data-id="${i.id}" style="--k:${Math.min(k, 12)}">${canDrag ? '<span class="mn-grip" title="Drag to change the order" aria-label="Drag to reorder">' + GRIP + '</span>' : '<span></span>'}<b>${esc(i.name)}</b><span class="mn-pr">${money(i.price)}</span>
          <label class="mn-sw sm ${i.available ? '' : 'off'}"><input type="checkbox" data-a="one" ${i.available ? 'checked' : ''}><i></i></label><span class="pill ${i.available ? 'on' : 'off'}">${i.available ? 'Available' : 'Out of stock'}</span>
          <span class="mn-act"><button class="btn sm" data-a="edit">Edit</button><button class="btn sm danger" data-a="del">Delete</button></span></div>`).join('')}</div>
        <button class="mn-add" data-a="addin">+ Add item to ${esc(cat)}</button></div></div></div>`;
  });
  const list = $('#mnList'); list.innerHTML = html || '<div class="empty">Nothing found.</div>';
  list.classList.toggle('mn-anim', !!anim);
  if (!list._sort) {
    list._sort = true;
    sortable(list, '.mn-cat', '.mn-grip.cat', { collapse: true, onDone: async (kids) => { const cats = kids.map((k) => k.dataset.cat); S.menuOrder = { ...(S.menuOrder || { items: {} }), cats }; try { await api.put('/api/menu-order', { cats }); toast('Category order saved', 'success'); } catch (ex) { toast(ex.message, 'error'); } } });
  }
  list.querySelectorAll('.mn-cat').forEach((card) => {
    const cat = card.dataset.cat;
    const rowsBox = $('.mn-rows', card);
    sortable(rowsBox, '.mn-row', '.mn-grip', { onDone: async (kids) => { const ids = kids.map((k) => k.dataset.id); S.menuOrder = { cats: [], ...(S.menuOrder || {}), items: { ...((S.menuOrder || {}).items || {}), [cat]: ids } }; try { await api.put('/api/menu-order', { items: { [cat]: ids } }); toast(`${cat}: order saved`, 'success'); } catch (ex) { toast(ex.message, 'error'); } } });
    $('[data-a=open]', card).onclick = (e) => { if (e.target.closest('.mn-sw, .mn-grip')) return; const o = card.classList.toggle('open'); o ? IT.open.add(cat) : IT.open.delete(cat); };
    $('[data-a=cat]', card).onchange = async (e) => {
      const on = e.target.checked; card.classList.toggle('dim', !on);
      try { const r = await api.put('/api/items-category', { category: cat, available: on }); toast(`${cat}: ${r.count} item${r.count > 1 ? 's' : ''} ${on ? 'back in stock' : 'marked out of stock'}`, 'success'); } catch (ex) { toast(ex.message, 'error'); }
    };
    $('[data-a=addin]', card).onclick = () => itemModal(null, cat);
    card.querySelectorAll('.mn-row').forEach((row) => {
      const item = S.items.find((i) => i.id === row.dataset.id);
      $('[data-a=edit]', row).onclick = () => itemModal(item);
      $('[data-a=one]', row).onchange = async (e) => { try { await api.put('/api/items/' + item.id, { available: e.target.checked }); } catch (ex) { toast(ex.message, 'error'); } };
      $('[data-a=del]', row).onclick = async () => {
        if (!confirm(`Delete "${item.name}"? Past orders keep their copy of the item.`)) return;
        row.classList.add('mn-out'); await new Promise((r) => setTimeout(r, 280));
        try { await api.del('/api/items/' + item.id); } catch (ex) { row.classList.remove('mn-out'); toast(ex.message, 'error'); }
      };
    });
  });
}
function itemModal(item, presetCat) {
  const cats = [...new Set(S.items.map((i) => i.category))];
  openModal({
    title: item ? 'Edit item' : 'Add item',
    body: `<label>Name<input name="name" required maxlength="80" value="${esc(item ? item.name : '')}"></label>
      <div class="g2"><label>Category<input name="category" list="cats" maxlength="40" value="${esc(item ? item.category : (presetCat || ''))}" placeholder="Main Course"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label>Price (₹)<input name="price" type="number" min="0" step="0.5" required value="${item ? item.price : ''}"></label></div>
      <label class="check"><input type="checkbox" name="available" ${!item || item.available ? 'checked' : ''}> Available for ordering</label>`,
    async onSubmit(form, fd) {
      const body = { name: fd.get('name'), category: fd.get('category'), price: fd.get('price'), available: fd.get('available') === 'on' };
      if (item) await api.put('/api/items/' + item.id, body); else await api.post('/api/items', body);
      toast('Item saved', 'success');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Platforms                                                           */
/* ------------------------------------------------------------------ */
function renderPlatforms() {
  main.innerHTML = head('Order platforms', `<button class="btn primary" id="add">+ Add platform</button>`) +
    `<div class="pf-grid">${S.platforms.map((p, n) => `<div class="pf-card" data-id="${p.id}" style="--c:${esc(p.color)};--i:${n}"><b>${esc(p.name)}</b><small>${p.askTable ? 'Asks for a table number' : 'No table number'}</small>
      <div class="pf-act"><button class="btn sm" data-edit>Edit</button><button class="btn sm danger" data-del>Delete</button></div></div>`).join('')}
      <button type="button" class="pf-add" id="add2" style="--i:${S.platforms.length}"><big>+</big>Add platform</button></div>
    <p class="small" style="margin-top:.9rem">Examples: Table, Swiggy, Takeaway, Zomato. The colour shows on order cards.</p>`;
  $('#add').onclick = $('#add2').onclick = () => platformModal();
  main.querySelectorAll('.pf-card[data-id]').forEach((tr) => {
    const p = S.platforms.find((x) => x.id === tr.dataset.id);
    $('[data-edit]', tr).onclick = () => platformModal(p);
    $('[data-del]', tr).onclick = async () => {
      if (!confirm(`Delete platform "${p.name}"?`)) return;
      try { await api.del('/api/platforms/' + p.id); } catch (e) { toast(e.message, 'error'); }
    };
  });
}
function platformModal(p) {
  openModal({
    title: p ? 'Edit platform' : 'Add platform',
    body: `<label>Name<input name="name" required maxlength="40" value="${esc(p ? p.name : '')}" placeholder="Swiggy"></label>
      <label>Colour<input type="color" name="color" value="${esc(p ? p.color : '#64748b')}"></label>
      <label class="check"><input type="checkbox" name="askTable" ${p && p.askTable ? 'checked' : ''}> Ask for a table number (dine-in)</label>`,
    async onSubmit(form, fd) {
      const body = { name: fd.get('name'), color: fd.get('color'), askTable: fd.get('askTable') === 'on' };
      if (p) await api.put('/api/platforms/' + p.id, body); else await api.post('/api/platforms', body);
      toast('Platform saved', 'success');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Kitchen admins                                                      */
/* ------------------------------------------------------------------ */
function renderStaff() {
  main.innerHTML = head('Kitchen admins', `<button class="btn primary" id="add">+ Add kitchen admin</button>`) +
    `<div class="pf-grid">${S.users.map((u, n) => `<div class="pf-card" data-id="${u.id}" style="--c:${u.active ? '#2fb383' : '#c8d6d8'};--i:${n}"><div class="pf-top"><span class="pf-av">${esc((u.name || '?').charAt(0).toUpperCase())}</span><div style="flex:1"><b>${esc(u.name)}</b><small style="margin:0">@${esc(u.username)}</small></div><span class="pill ${u.active ? 'on' : 'off'}">${u.active ? 'Active' : 'Disabled'}</span></div>
      <div class="pf-act"><button class="btn sm" data-edit>Edit</button><button class="btn sm danger" data-del>Delete</button></div></div>`).join('')}
      <button type="button" class="pf-add" id="add2" style="--i:${S.users.length}"><big>+</big>Add kitchen admin</button></div>
    <p class="small" style="margin-top:.9rem">Kitchen admins can only open the kitchen board and change order status.</p>`;
  $('#add').onclick = $('#add2').onclick = () => staffModal();
  main.querySelectorAll('.pf-card[data-id]').forEach((tr) => {
    const u = S.users.find((x) => x.id === tr.dataset.id);
    $('[data-edit]', tr).onclick = () => staffModal(u);
    $('[data-del]', tr).onclick = async () => {
      if (!confirm(`Delete kitchen admin "${u.name}"?`)) return;
      try { await api.del('/api/users/' + u.id); } catch (e) { toast(e.message, 'error'); }
    };
  });
}
function staffModal(u) {
  openModal({
    title: u ? 'Edit kitchen admin' : 'Add kitchen admin',
    body: `<div class="g2"><label>Name<input name="name" required maxlength="60" value="${esc(u ? u.name : '')}"></label>
      <label>Username<input name="username" required maxlength="40" autocomplete="off" value="${esc(u ? u.username : '')}"></label></div>
      <label>${u ? 'New password (leave blank to keep)' : 'Password'}<input name="password" type="password" autocomplete="new-password" minlength="8" ${u ? '' : 'required'} placeholder="min 8 characters (staff sets their own at first login)"></label>
      <label class="check"><input type="checkbox" name="active" ${!u || u.active ? 'checked' : ''}> Active (can log in)</label>`,
    async onSubmit(form, fd) {
      const body = { name: fd.get('name'), username: fd.get('username'), active: fd.get('active') === 'on' };
      if (fd.get('password')) body.password = fd.get('password');
      if (u) await api.put('/api/users/' + u.id, body); else await api.post('/api/users', body);
      toast('Kitchen admin saved', 'success');
    },
  });
}

/* ------------------------------------------------------------------ */
/* WhatsApp message templates                                          */
/* ------------------------------------------------------------------ */
const EVENT_LABEL = { accepted: 'New order accepted', ready: 'Order ready', served: 'Order served (review)' };
const PLACEHOLDERS = ['name', 'order', 'restaurant', 'items', 'total', 'platform', 'table', 'review_link'];
function previewText(text) {
  const sample = { name: 'Ravi', order: '#012', restaurant: S.settings.restaurantName || 'Crave Yard', items: '2 x Masala Shawai (Kubboos)\n1 x Fresh Lime', total: '₹370',
    platform: 'Swiggy', table: '5', review_link: S.settings.reviewLink || '(set your review link in Settings)' };
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in sample ? sample[k] : m));
}
function renderMessages() {
  const order = ['accepted', 'ready', 'served'];
  const list = S.templates.slice().sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event));
  main.innerHTML = head('WhatsApp messages', `<button class="btn" id="reset">Restore defaults</button><button class="btn primary" id="add">+ Add message</button>`) + `
  <p class="small" style="margin-top:-6px">Sent to the customer automatically from your linked WhatsApp number when an order changes status (only for orders that have a WhatsApp number).
    ${S.settings.whatsappCustomerReady ? '' : '<b style="color:#b91c1c">Automatic sending is switched off in Settings.</b>'}</p>
  <div class="grid" style="gap:14px">${list.length ? list.map((t, n) => `
    <div class="card-box wm-card ${t.enabled ? '' : 'off'}" data-id="${t.id}" style="--i:${n}"><div class="wm-top"><b>${esc(t.name)}</b>
      <span class="badge" style="--c:#6366f1">${esc(EVENT_LABEL[t.event])}</span><span class="sp"></span>
      <label class="pur-sw" title="${t.enabled ? 'Turn off' : 'Turn on'}"><input type="checkbox" data-toggle ${t.enabled ? 'checked' : ''}><i></i></label>
      <button class="btn sm" data-edit>Edit</button><button class="btn sm danger" data-del>Delete</button></div>
      <div class="wa-chat"><div class="wa-bub">${esc(previewText(t.text))}</div></div></div>`).join('')
    : emptyState('💬', 'No messages yet', 'Add one, or restore the defaults.')}</div>`;
  $('#add').onclick = () => templateModal();
  $('#reset').onclick = async () => { if (!confirm('Replace all messages with the 3 default ones?')) return; try { await api.post('/api/templates/reset'); toast('Defaults restored', 'success'); } catch (e) { toast(e.message, 'error'); } };
  main.querySelectorAll('[data-id]').forEach((el) => {
    const t = S.templates.find((x) => x.id === el.dataset.id);
    $('[data-edit]', el).onclick = () => templateModal(t);
    $('[data-toggle]', el).onchange = async (e) => { el.classList.toggle('off', !e.target.checked); try { await api.put('/api/templates/' + t.id, { enabled: e.target.checked }); } catch (ex) { toast(ex.message, 'error'); } };
    $('[data-del]', el).onclick = async () => { if (!confirm(`Delete message "${t.name}"?`)) return; try { await api.del('/api/templates/' + t.id); } catch (e) { toast(e.message, 'error'); } };
  });
}
function templateModal(t) {
  openModal({
    title: t ? 'Edit message' : 'Add message', wide: true,
    body: `<div class="g2"><label>Name<input name="name" required maxlength="60" value="${esc(t ? t.name : '')}" placeholder="Order accepted"></label>
      <label>Send when<select name="event">${Object.entries(EVENT_LABEL).map(([k, v]) => `<option value="${k}" ${t && t.event === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <label>Message<textarea name="text" required rows="6" maxlength="1000" id="tText">${esc(t ? t.text : '')}</textarea></label>
      <div class="small">Click to insert: ${PLACEHOLDERS.map((p) => `<button type="button" class="btn sm" data-ph="${p}">{${p}}</button>`).join(' ')}</div>
      <div><div class="small" style="margin-bottom:4px">Preview</div><div id="tPrev" style="white-space:pre-wrap;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;font-size:14px"></div></div>
      <label class="check"><input type="checkbox" name="enabled" ${!t || t.enabled ? 'checked' : ''}> Send this message automatically</label>`,
    onOpen(form, root) {
      const ta = $('#tText', root), prev = $('#tPrev', root);
      const upd = () => { prev.textContent = previewText(ta.value); };
      ta.addEventListener('input', upd); upd();
      root.querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => {
        const at = ta.selectionStart == null ? ta.value.length : ta.selectionStart, ins = '{' + b.dataset.ph + '}';
        ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd == null ? at : ta.selectionEnd);
        ta.focus(); ta.selectionStart = ta.selectionEnd = at + ins.length; upd();
      }));
    },
    async onSubmit(form, fd) {
      const body = { name: fd.get('name'), event: fd.get('event'), text: fd.get('text'), enabled: fd.get('enabled') === 'on' };
      if (t) await api.put('/api/templates/' + t.id, body); else await api.post('/api/templates', body);
      toast('Message saved', 'success');
    },
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
function renderSettings() {
  const s = S.settings;
  main.innerHTML = head('Settings') + `
  <div class="set-grid">
    <form id="sForm">
      <div class="card-box set-card" style="--i:0"><h3>Kitchen &amp; alerts</h3>
        <label class="set-field">Restaurant name<input name="restaurantName" value="${esc(s.restaurantName)}" maxlength="60"></label>
        <div class="set-row"><span class="ic">🟠</span><div class="t"><b>Turn orange after</b><small>Order card colour while waiting (minutes)</small></div><input name="orangeAfterMin" type="number" min="1" value="${s.orangeAfterMin}"></div>
        <div class="set-row"><span class="ic">🔴</span><div class="t"><b>Turn red after</b><small>When the kitchen should hurry (minutes)</small></div><input name="redAfterMin" type="number" min="2" value="${s.redAfterMin}"></div>
        <p class="small" style="margin:.2rem 0 0">Cards go green → orange → red as they wait. Preparing is counted from order time, Ready from when it was marked ready.</p>
        <div class="set-row"><span class="ic">🔔</span><div class="t"><b>Alert sound</b><small>Plays when a new order arrives</small></div><button type="button" class="btn sm" id="sndTest">Play sound</button></div></div>
      <div class="card-box set-card" style="--i:1"><h3>WhatsApp to customers</h3>
        <label class="set-row sw-row"><span class="ic">💬</span><div class="t"><b>Message customers automatically</b><small>When an order is accepted, ready and served</small></div><span class="pur-sw"><input type="checkbox" name="whatsappCustomerReady" ${s.whatsappCustomerReady ? 'checked' : ''}><i></i></span></label>
        <label class="set-field">Customer messages: your WhatsApp number (the sender)<input name="whatsappSenderPhone" value="${esc(s.whatsappSenderPhone || '')}" inputmode="tel" maxlength="20"></label>
        <div class="card-box" style="background:rgba(255,255,255,.6);margin-top:.9rem"><h3 style="margin-bottom:8px">Link your phone</h3><p class="small" style="margin:0 0 8px">Purchase orders use their own number. Set it in Purchase → WhatsApp.</p><div id="waLink" class="small">Loading…</div></div>
        <div class="small" id="waCheck"></div>
        <label class="set-field">Default country code<input name="countryCode" value="${esc(s.countryCode)}" maxlength="4"></label>
        <label class="set-field">Review link (used as <code>{review_link}</code> in messages)<input name="reviewLink" value="${esc(s.reviewLink || '')}" placeholder="https://g.page/r/your-review-link" maxlength="300"></label>
        <p class="small" style="margin:.7rem 0 0">Edit the message texts in <a href="#messages">WhatsApp messages</a>.</p></div>
      <div class="card-box set-card" style="--i:2"><h3>Alerts to me</h3>
        <label class="set-row sw-row"><span class="ic">📲</span><div class="t"><b>Message me on every new order</b><small>A WhatsApp to your own number</small></div><span class="pur-sw"><input type="checkbox" name="whatsappAdminNewOrder" ${s.whatsappAdminNewOrder ? 'checked' : ''}><i></i></span></label>
        <label class="set-field">My WhatsApp number<input name="whatsappAdminPhone" value="${esc(s.whatsappAdminPhone || '')}" inputmode="tel"></label>
        <div style="margin-top:.8rem"><button type="button" class="btn" id="waTest">Send test message</button></div></div>
      <div class="save-bar" id="saveBar"><span><i></i>You have unsaved changes</span><span class="acts"><button type="button" class="ghost" id="discard">Discard</button><button class="btn primary">Save settings</button></span></div>
    </form>
    <form class="card-box grid set-card" id="pwForm" style="--i:3">
      <h3>Change my password</h3>
      <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="next" autocomplete="new-password" minlength="8" required><span class="small" style="font-weight:400">At least 8 characters. Use a password you do not use anywhere else.</span></label>
      <div><button class="btn primary">Update password</button></div>
    </form>
  </div>`;
  const bar = $('#saveBar'); ['input', 'change'].forEach((ev) => $('#sForm').addEventListener(ev, (e) => { if (e.target.closest('#waLink')) return; bar.classList.add('show'); }));
  $('#discard').onclick = () => renderSettings();
  $('#sForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api.put('/api/settings', {
        restaurantName: fd.get('restaurantName'), orangeAfterMin: fd.get('orangeAfterMin'), redAfterMin: fd.get('redAfterMin'),
        countryCode: fd.get('countryCode'), whatsappSenderPhone: fd.get('whatsappSenderPhone'), reviewLink: fd.get('reviewLink'), whatsappCustomerReady: fd.get('whatsappCustomerReady') === 'on',
        whatsappAdminNewOrder: fd.get('whatsappAdminNewOrder') === 'on', whatsappAdminPhone: fd.get('whatsappAdminPhone'),
      });
      toast('Settings saved', 'success'); bar.classList.remove('show');
    } catch (ex) { toast(ex.message, 'error'); }
  };
  loadWaLink();
  $('#waLink').onclick = async (e) => {
    const id = e.target.id;
    try {
      if (id === 'waStart') renderWaLink(await api.post('/api/whatsapp/link/start'));
      if (id === 'waUnlink' && confirm('Unlink WhatsApp? Automatic messages will stop until you link again.')) renderWaLink(await api.post('/api/whatsapp/link/logout'));
    } catch (ex) { toast(ex.message, 'error'); }
  };
  api.get('/api/whatsapp/status').then((w) => {
    const el = $('#waCheck'); if (!el || !w.configured) return;   // Cloud API is optional
    if (w.error) el.innerHTML = '❌ WhatsApp API error: ' + esc(w.error);
    else if (w.matches) el.innerHTML = `✅ Connected. Sending from +${esc(w.actual)} ${w.name ? '(' + esc(w.name) + ')' : ''}`;
    else el.innerHTML = `⚠️ The API credentials send from +${esc(w.actual)}, not from your sender number. Register your number in WhatsApp Cloud API or update the credentials.`;
  }).catch(() => {});
  $('#waTest').onclick = async () => {
    try { await api.post('/api/whatsapp/test', { phone: $('[name=whatsappAdminPhone]').value }); toast('Test message sent', 'success'); } catch (ex) { toast(ex.message, 'error'); }
  };
  $('#sndTest').onclick = () => { Sound.on = true; Sound.unlock(); Sound.play('new'); };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api.put('/api/me/password', { current: fd.get('current'), next: fd.get('next') }); e.target.reset(); toast('Password updated', 'success'); }
    catch (ex) { toast(ex.message, 'error'); }
  };
}

async function loadWaLink() { try { renderWaLink(await api.get('/api/whatsapp/link')); } catch (_) { /* not on settings page */ } }
function renderWaLink(l) {
  const el = $('#waLink'); if (!el) return;
  const want = String(($('[name=whatsappSenderPhone]') || {}).value || S.settings.whatsappSenderPhone || '').replace(/\D/g, '').slice(-10);
  if (l.status === 'connected') {
    const mismatch = want && !String(l.number).endsWith(want);
    el.innerHTML = `✅ Linked as <b>+${esc(l.number)}</b>. When you mark an order <b>Ready</b>, the customer is messaged automatically from this number.
      ${mismatch ? `<div class="error" style="margin:8px 0">This is not your number (…${esc(want)}). Unlink and scan again with the right phone.</div>` : ''}
      <div style="margin-top:8px"><button type="button" class="btn sm danger" id="waUnlink">Unlink</button></div>`;
  } else if (l.status === 'qr' && l.qr) {
    el.innerHTML = `<ol style="margin:0 0 8px 18px;padding:0"><li>On the phone with <b>${esc(S.settings.whatsappSenderPhone || 'your number')}</b>, open WhatsApp</li><li>Settings (or ⋮) → <b>Linked devices</b> → <b>Link a device</b></li><li>Scan this code</li></ol><img src="${l.qr}" alt="WhatsApp QR code" width="240" height="240" style="border:1px solid #e5e7eb;border-radius:10px">`;
  } else if (l.status === 'starting') {
    el.innerHTML = '⏳ Connecting to WhatsApp… the QR code appears here in a few seconds.';
  } else {
    el.innerHTML = `${l.error ? `<div class="error" style="margin-bottom:8px">${esc(l.error)}</div>` : ''}Not linked. Scan a QR code once and the server sends messages from your WhatsApp automatically.
      <div style="margin-top:8px"><button type="button" class="btn sm primary" id="waStart">Link WhatsApp number</button></div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Live updates                                                        */
/* ------------------------------------------------------------------ */
let refreshTimer = null;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(go, 150); }

function onMessage(msg) {
  switch (msg.type) {
    case 'orders': {
      if (msg.action === 'status' && msg.order.status === 'ready') { Sound.play('ready'); toast(`Order ${orderNo(msg.order.number)} is ready`, 'success'); }
      if (msg.action === 'created') { Sound.play('new'); toast(`New order ${orderNo(msg.order.number)}`, 'success'); }
      if (route === 'orders' || route === 'overview') refreshSoon();
      break;
    }
    case 'items': case 'platforms': case 'settings':
      loadBase().then(() => { if (route !== 'settings' || msg.type !== 'settings') refreshSoon(); });
      break;
    case 'integrations': if (route === 'integrations') refreshSoon(); break;
    case 'purchase': purchaseMessage(msg); break;
    case 'users': if (route === 'staff') refreshSoon(); break;
    case 'templates': if (route === 'messages') refreshSoon(); break;
    case 'whatsapp': if (route === 'settings') loadWaLink(); break;
  }
}

(async function init() {
  me = await guard(['admin']);
  if (!me) return;
  $('#logout').onclick = () => Auth.logout();
  Sound.bind($('#soundBtn'));
  await loadBase();
  connectWS(onMessage, (ok) => {
    $('#conn').classList.toggle('on', ok);
    $('#connText').textContent = ok ? 'Live' : 'Reconnecting…';
  });
  go();
})();

SizeCtl.mount(document.getElementById('sizeSlot'));
