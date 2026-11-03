'use strict';
/* Kitchen board: Preparing / Ready / Served, live via WebSocket */

let me, settings = { orangeAfterMin: 10, redAfterMin: 20, restaurantName: 'Kitchen', countryCode: '91' };
let platforms = new Map();
let orders = [];
const alarmed = new Set();   // "orderId:status" already alarmed as red
let armed = false;           // don't blast alarms for orders already red when the page loads

const $ = (s, r = document) => r.querySelector(s);
const col = (name) => $(`.col[data-col="${name}"] .list`);

async function loadOrders() { orders = await api.get('/api/orders'); }
async function loadMeta() {
  const [p, s] = await Promise.all([api.get('/api/platforms'), api.get('/api/settings')]);
  platforms = new Map(p.map((x) => [x.id, x]));
  settings = s; setServerTime(s.serverTime);
  $('#titleText').textContent = settings.restaurantName;
  $('#lg-green').textContent = `under ${settings.orangeAfterMin} min`;
  $('#lg-orange').textContent = `${settings.orangeAfterMin}–${settings.redAfterMin} min`;
  $('#lg-red').textContent = `over ${settings.redAfterMin} min`;
}

/* Age is measured from when the order was placed (Preparing) or when it became ready (Ready). */
const sinceOf = (o) => (o.status === 'ready' ? (o.readyAt || o.updatedAt) : o.createdAt);
function ageClass(ms) {
  const m = ms / 60000;
  return m >= settings.redAfterMin ? 'age-red' : m >= settings.orangeAfterMin ? 'age-orange' : 'age-green';
}

function cardHtml(o) {
  const p = platforms.get(o.platformId) || { name: '?', color: '#64748b' };
  const where = [o.tableNo && o.tableNo !== '-' ? 'Table ' + o.tableNo : '', o.customerName].filter(Boolean).join(' · ');
  let acts = '';
  if (o.status === 'preparing') acts = `<button class="btn go" data-id="${o.id}" data-to="ready">Mark ready</button>`;
  else if (o.status === 'ready') acts = `<button class="btn ghost" data-id="${o.id}" data-to="preparing">Back</button><button class="btn go2" data-id="${o.id}" data-to="served">Mark served</button>`;
  else acts = `<button class="btn" data-id="${o.id}" data-to="ready">Reopen</button>`;
  const timer = o.status === 'served'
    ? `<span class="timer">served ${fmtClock(o.servedAt || o.updatedAt)}</span>`
    : `<span class="timer" data-timer>--:--</span>`;
  return `<article class="ocard ${o.status === 'served' ? 'done' : ''}" data-id="${o.id}" data-status="${o.status}" data-since="${o.status === 'served' ? '' : sinceOf(o)}">
    <div class="top"><span class="num">${orderNo(o.number)}</span><span class="who"><span class="badge" style="--c:${esc(p.color)}">${esc(p.name)}</span><span class="where">${esc(where)}</span></span>${timer}</div>
    <ul>${o.items.map((l) => `<li><b>${l.qty}×</b>${esc(l.name)}</li>`).join('')}</ul>
    ${o.notes ? `<div class="note">⚠ ${esc(o.notes)}</div>` : ''}
    <div class="acts">${acts}</div>
  </article>`;
}

/* Left panel: how many of each item are still to be cooked (all orders currently in Preparing). */
function renderTotals(preparing) {
  const qty = new Map();
  preparing.forEach((o) => o.items.forEach((l) => qty.set(l.name, (qty.get(l.name) || 0) + l.qty)));
  const rows = [...qty.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = rows.length ? rows[0][1] : 1;
  $('#tcCount').textContent = rows.reduce((s, r) => s + r[1], 0);
  $('#tcKinds').textContent = `${rows.length} different item${rows.length === 1 ? '' : 's'}`;
  $('#tcOrders').textContent = `${preparing.length} order${preparing.length === 1 ? '' : 's'}`;
  $('#tcRows').innerHTML = rows.length
    ? rows.map(([name, q], i) => `<div class="tr ${i < 3 ? 'top3' : ''}"><div class="q">${q}</div><div class="nm"><span>${esc(name)}</span><div class="bar"><i style="width:${(q / max) * 100}%"></i></div></div></div>`).join('')
    : '<div class="none">Nothing to cook right now</div>';
}

function render() {
  const groups = { preparing: [], ready: [], served: [] };
  orders.forEach((o) => groups[o.status] && groups[o.status].push(o));
  groups.preparing.sort((a, b) => a.createdAt - b.createdAt);                 // oldest first
  groups.ready.sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0));
  groups.served.sort((a, b) => (b.servedAt || 0) - (a.servedAt || 0));        // newest first
  groups.served = groups.served.slice(0, 30);
  for (const s of ['preparing', 'ready', 'served']) {
    const section = $(`.col[data-col="${s}"]`);
    $('.count', section).textContent = orders.filter((o) => o.status === s).length;
    col(s).innerHTML = groups[s].length ? groups[s].map(cardHtml).join('') : '<div class="none">No orders</div>';
  }
  renderTotals(groups.preparing);
  tick();
}

function tick() {
  $('#clock').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  let newlyRed = false;
  document.querySelectorAll('.ocard[data-since]').forEach((el) => {
    if (!el.dataset.since) return;
    const ms = nowSrv() - Number(el.dataset.since);
    const cls = ageClass(ms);
    el.classList.remove('age-green', 'age-orange', 'age-red'); el.classList.add(cls);
    el.querySelector('[data-timer]').textContent = fmtElapsed(ms);
    if (cls === 'age-red') {
      const key = el.dataset.id + ':' + el.dataset.status;
      if (!alarmed.has(key)) { alarmed.add(key); if (armed) newlyRed = true; }
    }
  });
  armed = true;
  if (newlyRed) Sound.play('alarm');
}

async function setStatus(id, status) {
  try {
    const o = await api.patch(`/api/orders/${id}/status`, { status });
    const i = orders.findIndex((x) => x.id === id);
    if (i >= 0) orders[i] = o;
    render();
  } catch (e) { toast(e.message, 'error'); }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-to]');
  if (b) setStatus(b.dataset.id, b.dataset.to);
});

function onMessage(msg) {
  if (msg.type === 'orders') {
    loadOrders().then(render);
    if (msg.action === 'created') {
      Sound.play('new');
      toast(`New order ${orderNo(msg.order.number)}`, 'success');
    }
  } else if (msg.type === 'platforms' || msg.type === 'settings') {
    loadMeta().then(render);
  }
}

/* Rush mode: shows the "To cook now" totals panel. Remembered on this screen only. */
function setRush(on, remember = true) {
  document.body.classList.toggle('rush', on);
  const b = $('#rushBtn');
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  $('span', b).textContent = on ? 'Rush mode: On' : 'Rush mode: Off';
  if (remember) { try { localStorage.setItem('koms_rush', on ? '1' : '0'); } catch (_) { /* private mode: just not remembered */ } }
}
(function initRush() {
  let on = false;
  try { on = localStorage.getItem('koms_rush') === '1'; } catch (_) { /* ignore */ }
  setRush(on, false);
  $('#rushBtn').addEventListener('click', () => setRush(!document.body.classList.contains('rush')));
})();

(async function init() {
  me = await guard(['kitchen', 'admin']);
  if (!me) return;
  if (me.role === 'admin') $('#backLink').hidden = false;
  $('#logout').addEventListener('click', () => Auth.logout());
  Sound.bind($('#soundBtn'));
  await loadMeta(); await loadOrders(); render();
  connectWS(onMessage, (ok) => {
    $('#conn').classList.toggle('on', ok);
    $('#connText').textContent = ok ? 'Live' : 'Reconnecting…';
    if (ok) { loadOrders().then(render); }   // catch up after a dropped connection
  });
  setInterval(tick, 1000);
})();

SizeCtl.mount(document.getElementById('sizeSlot'));
