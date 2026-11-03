'use strict';
/* Mini supermarket for the purchase link /buy/:token. No login: the link is the key. */
const TOKEN = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const app = document.getElementById('app');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);
const buzz = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let pin = ''; try { pin = sessionStorage.getItem('pin_' + TOKEN) || ''; } catch (_) {}
const SH = { info: null, cart: new Map(), q: '', group: 'All', when: '', note: '' };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-pin': pin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; throw e; }
  return data;
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n));
const itemById = (id) => SH.info.items.find((i) => i.id === id);

async function boot() {
  try {
    const d = await call('GET', '/api/shop/' + encodeURIComponent(TOKEN));
    if (d.pinRequired) return pinScreen(d);
    SH.info = d; shop();
  } catch (e) {
    app.innerHTML = `<div class="center"><div style="font-size:3rem">🔒</div><h2>${esc(e.message)}</h2><p style="color:var(--mute)">Ask the restaurant to send you a new link.</p></div>`;
  }
}
function pinScreen(d) {
  app.innerHTML = `<div class="center"><div class="pinbox"><div class="lock">🔐</div><h2 style="margin:.4rem 0 0">${esc(d.restaurant)}</h2><p style="color:var(--mute);margin:.2rem 0">${esc(d.label)}${d.name ? ' · ' + esc(d.name) : ''}<br>Enter your PIN to continue</p>
    <form id="pf"><input id="pn" type="password" inputmode="numeric" maxlength="8" autocomplete="off" autofocus>${d.wrong ? '<div class="err">Wrong PIN, try again</div>' : ''}<button class="primary">Open shop</button></form></div></div>`;
  $('#pf').onsubmit = (e) => { e.preventDefault(); pin = $('#pn').value.trim(); try { sessionStorage.setItem('pin_' + TOKEN, pin); } catch (_) {} boot(); };
}

/* ------------------------------ shop ------------------------------ */
function shop() {
  const d = SH.info, groups = ['All', ...new Set(d.items.map((i) => i.group))];
  const h = new Date().getHours(), hi = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  app.innerHTML = `<div class="top"><div class="hello"><div class="who"><div class="logo">${d.category === 'juice' ? '🍹' : '🍳'}</div><div><small>${esc(d.restaurant)} · ${esc(d.label)}</small><h1>${hi}${d.name ? ', ' + esc(d.name) : ''}</h1></div></div></div>
    <div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="q" type="search" placeholder="Search items…" autocomplete="off"></div>
    <div class="cats" id="cats">${groups.map((g) => `<button class="cat ${g === SH.group ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div></div>
    ${d.last ? `<button class="again" id="again"><span class="ico">🔁</span><span><b>Order same as last time</b><small>${d.last.lines.length} items · ${esc(d.last.number)}</small></span></button>` : ''}
    <div class="grid" id="grid"></div>
    <div class="bar"><button class="cartbtn" id="cartbtn"><span class="cnt" id="cnt">0</span><span id="ctxt">items in cart</span><span class="go">Review ›</span></button></div><div id="layer"></div>`;
  $('#q').oninput = (e) => { SH.q = e.target.value.trim().toLowerCase(); drawGrid(true); };
  $('#cats').onclick = (e) => { const b = e.target.closest('.cat'); if (!b) return; SH.group = b.dataset.g; document.querySelectorAll('.cat').forEach((x) => x.classList.toggle('on', x === b)); drawGrid(true); buzz(8); };
  const ag = $('#again'); if (ag) ag.onclick = () => { SH.cart.clear(); d.last.lines.forEach((l) => { if (itemById(l.itemId)) SH.cart.set(l.itemId, l.qty); }); buzz(20); drawGrid(true); updateBar(true); toast2('Last order loaded. Change anything you need.'); };
  $('#cartbtn').onclick = review;
  drawGrid(true); updateBar();
}
function drawGrid(anim) {
  const list = SH.info.items.filter((i) => (SH.group === 'All' || i.group === SH.group) && (!SH.q || (i.name + ' ' + i.group).toLowerCase().includes(SH.q)));
  const g = $('#grid'); let html = '', last = '', n = 0;
  list.forEach((i) => {
    if (SH.group === 'All' && !SH.q && i.group !== last) { last = i.group; html += `<h3 class="sec">${esc(i.group)}</h3>`; }
    html += itemHtml(i, anim ? n++ : 0);
  });
  g.innerHTML = html || `<div class="none"><div style="font-size:2.5rem">🔍</div>Nothing found</div>`;
}
function actHtml(i) {
  const q = SH.cart.get(i.id);
  return q ? `<div class="step"><button data-m="-" aria-label="Less">−</button><span>${fmt(q)} ${esc(i.unit)}</span><button data-m="+" aria-label="More">+</button></div>` : `<button class="add" data-m="+">Add</button>`;
}
function itemHtml(i, n) { return `<div class="it ${SH.cart.has(i.id) ? 'in' : ''}" data-id="${i.id}" style="--i:${Math.min(n, 14)}"><span class="em">${esc(i.emoji)}</span><b>${esc(i.name)}</b><small>per ${esc(i.unit)}</small><div class="act">${actHtml(i)}</div></div>`; }

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]'); if (!b || !SH.info) return;
  const card = b.closest('.it'), line = b.closest('.line'), id = (card || line).dataset.id, i = itemById(id);
  const was = SH.cart.get(id) || 0, nq = Math.max(0, +(was + (b.dataset.m === '+' ? i.step : -i.step)).toFixed(2));
  if (nq > 9999) return;
  nq ? SH.cart.set(id, nq) : SH.cart.delete(id); buzz(10);
  if (card) {
    card.classList.toggle('in', !!nq); card.querySelector('.act').innerHTML = actHtml(i);
    const sp = card.querySelector('.step span'); if (sp) { sp.classList.add('bump'); }
    if (!was && nq) fly(card.querySelector('.em'));
  }
  if (line) {
    if (!nq) { line.classList.add('out'); setTimeout(() => { if (!SH.cart.size) { closeSheet(); } else review(true); }, 260); }
    else { const sp = line.querySelector('.step span'); sp.textContent = fmt(nq) + ' ' + i.unit; sp.classList.remove('bump'); void sp.offsetWidth; sp.classList.add('bump'); }
    const gc = document.querySelector(`.it[data-id="${id}"]`); if (gc) { gc.classList.toggle('in', !!nq); gc.querySelector('.act').innerHTML = actHtml(i); }
  }
  updateBar(!was || !nq);
});
function updateBar(bump) {
  const n = SH.cart.size, btn = $('#cartbtn'); if (!btn) return;
  btn.classList.toggle('show', n > 0); $('#cnt').textContent = n; $('#ctxt').textContent = n === 1 ? 'item in cart' : 'items in cart';
  if (bump && n) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
}
function fly(from) {
  if (reduced || !from) return;
  const to = $('#cnt'); if (!to) return;
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect(), el = document.createElement('div');
  el.className = 'fly'; el.textContent = from.textContent; el.style.left = a.left + a.width / 2 - 14 + 'px'; el.style.top = a.top + 'px'; document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(.3) rotate(220deg)`; el.style.opacity = '.4'; });
  setTimeout(() => el.remove(), 750);
}
function toast2(t) {
  const el = document.createElement('div'); el.textContent = t;
  el.style.cssText = 'position:fixed;left:50%;top:1rem;transform:translate(-50%,-4rem);z-index:70;background:#12373a;color:#fff;padding:.7rem 1.1rem;border-radius:99px;font-size:.88rem;transition:transform .45s cubic-bezier(.34,1.6,.5,1);max-width:90vw;text-align:center';
  document.body.appendChild(el); requestAnimationFrame(() => (el.style.transform = 'translate(-50%,0)')); setTimeout(() => { el.style.transform = 'translate(-50%,-4rem)'; setTimeout(() => el.remove(), 500); }, 2400);
}

/* ------------------------------ review + place ------------------------------ */
function closeSheet() { const l = $('#layer'); if (l) l.innerHTML = ''; }
function review(keep) {
  const lines = [...SH.cart].map(([id, q]) => ({ i: itemById(id), q })).filter((x) => x.i);
  if (!lines.length) return closeSheet();
  const slots = ['Today', 'Tomorrow morning', 'Before 12 pm', 'Before 4 pm'];
  const html = `<div class="sheet-bg" id="bg"></div><div class="sheet"><div class="grab"></div><h2>Your order · ${lines.length} item${lines.length > 1 ? 's' : ''}</h2>
    ${lines.map(({ i, q }, n) => `<div class="line ${keep === true ? '' : ''}" data-id="${i.id}" style="--i:${keep === true ? 0 : n}"><span class="em">${esc(i.emoji)}</span><span class="nm">${esc(i.name)}</span><div class="step"><button data-m="-">−</button><span>${fmt(q)} ${esc(i.unit)}</span><button data-m="+">+</button></div></div>`).join('')}
    <div class="fld">When do you need it?<div class="when">${slots.map((s) => `<button type="button" class="${SH.when === s ? 'on' : ''}" data-w="${s}">${s}</button>`).join('')}</div></div>
    <label class="fld">Note (optional)<textarea id="note" rows="2" maxlength="200" placeholder="e.g. Fresh stock please">${esc(SH.note)}</textarea></label>
    <div id="perr"></div><button class="primary" id="place">Place order</button><button class="ghost" id="back">Keep shopping</button></div>`;
  const prevScroll = $('.sheet') ? $('.sheet').scrollTop : 0;
  $('#layer').innerHTML = html;
  if (keep === true) { $('.sheet').style.animation = 'none'; $('#bg').style.animation = 'none'; $('.sheet').scrollTop = prevScroll; }
  $('#bg').onclick = $('#back').onclick = () => { SH.note = $('#note').value; closeSheet(); };
  document.querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { SH.when = SH.when === b.dataset.w ? '' : b.dataset.w; document.querySelectorAll('[data-w]').forEach((x) => x.classList.toggle('on', x.dataset.w === SH.when)); buzz(8); }; });
  $('#place').onclick = place;
}
async function place() {
  const btn = $('#place'); btn.disabled = true; btn.classList.add('busy'); btn.textContent = 'Sending…'; SH.note = $('#note').value;
  try {
    const r = await call('POST', `/api/shop/${encodeURIComponent(TOKEN)}/order`, { lines: [...SH.cart].map(([itemId, qty]) => ({ itemId, qty })), note: SH.note, deliverBy: SH.when });
    buzz([30, 40, 60]); done(r);
  } catch (e) {
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = 'Place order';
    $('#perr').innerHTML = `<div class="err">${esc(e.message)}</div>`;
    if (e.status === 401) { pin = ''; boot(); }
  }
}
function done(r) {
  const lines = [...SH.cart].map(([id, q]) => ({ ...itemById(id), q }));
  SH.cart.clear(); SH.note = ''; SH.when = '';
  app.innerHTML = `<div class="center done"><svg class="check" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46"/><path d="M30 52l14 14 27-30"/></svg>
    <h1>Order placed!</h1><p>${esc(r.number)} · ${r.items} item${r.items > 1 ? 's' : ''}</p><p>It has been sent to the purchase team.</p>
    <button class="primary" id="again2">Order again</button></div>`;
  $('#again2').onclick = boot;
  confetti();
}
function confetti() {
  if (reduced) return;
  const cols = ['#0e8a8f', '#f2a516', '#2fb383', '#6a77d8', '#ef6f6c', '#fff'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i'); c.className = 'conf';
    c.style.cssText = `left:${Math.random() * 100}vw;background:${cols[i % cols.length]};--dx:${(Math.random() - .5) * 30}vw;--r:${Math.random() * 900 - 450}deg;animation-duration:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * .4}s;border-radius:${Math.random() > .5 ? '50%' : '2px'}`;
    document.body.appendChild(c); setTimeout(() => c.remove(), 4000);
  }
}
boot();
