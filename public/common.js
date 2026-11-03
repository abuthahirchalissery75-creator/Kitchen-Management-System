'use strict';
/* Shared helpers: auth, API, WebSocket, sound, formatting */

const TOKEN_KEY = 'koms_token';

/* Text size control (A- / A+): remembered per screen type, applied to the whole page */
const SizeCtl = (() => {
  const area = /kitchen/.test(location.pathname) ? 'kitchen' : 'admin', KEY = 'koms_ui_' + area;
  const STEPS = [.7, .8, .9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.3, 2.6];
  let idx = STEPS.indexOf(1);
  try { const v = parseFloat(localStorage.getItem(KEY)); const n = STEPS.findIndex((x) => Math.abs(x - v) < 0.01); if (n >= 0) idx = n; } catch (_) {}
  const apply = () => { document.documentElement.style.setProperty('--ui', STEPS[idx]); try { localStorage.setItem(KEY, STEPS[idx]); } catch (_) {} };
  apply();
  function mount(where) {
    if (!where) return;
    const box = document.createElement('div'); box.className = 'sizectl'; box.title = 'Make everything smaller or bigger';
    box.innerHTML = '<button type="button" data-d="-1" aria-label="Smaller text">A−</button><button type="button" class="pct" data-d="0" title="Back to normal"></button><button type="button" data-d="1" aria-label="Bigger text">A+</button>';
    const pct = box.querySelector('.pct'), minus = box.querySelector('[data-d="-1"]'), plus = box.querySelector('[data-d="1"]');
    const paint = () => { pct.textContent = Math.round(STEPS[idx] * 100) + '%'; minus.disabled = idx === 0; plus.disabled = idx === STEPS.length - 1; };
    box.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const d = +b.dataset.d; idx = d === 0 ? STEPS.indexOf(1) : Math.min(STEPS.length - 1, Math.max(0, idx + d)); apply(); paint(); });
    paint(); where.appendChild(box);
  }
  return { mount };
})();
const Auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set(t) { localStorage.setItem(TOKEN_KEY, t); },
  logout() {
    const t = this.token;
    localStorage.removeItem(TOKEN_KEY);
    const done = () => { location.href = '/'; };
    if (t) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).finally(done); else done();
  },
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(Auth.token ? { Authorization: 'Bearer ' + Auth.token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) {
    localStorage.removeItem(TOKEN_KEY); location.href = '/';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
api.get = (u) => api('GET', u);
api.post = (u, b) => api('POST', u, b || {});
api.put = (u, b) => api('PUT', u, b || {});
api.patch = (u, b) => api('PATCH', u, b || {});
api.del = (u) => api('DELETE', u);

/** Make sure the visitor is logged in with an allowed role; returns the user or null (and redirects). */
async function guard(roles) {
  if (!Auth.token) { location.href = '/'; return null; }
  try {
    const me = await api.get('/api/me');
    if (me.mustChange) { location.href = '/?change=1'; return null; }
    if (roles && !roles.includes(me.role)) { location.href = me.role === 'admin' ? '/admin.html' : '/kitchen.html'; return null; }
    return me;
  } catch (_) { return null; }
}

/* ---- WebSocket with auto-reconnect ---- */
function connectWS(onMessage, onState) {
  let retry = 0;
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(Auth.token)}`);
    ws.onopen = () => { retry = 0; onState && onState(true); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (_) { /* ignore */ } };
    ws.onclose = (ev) => {
      onState && onState(false);
      if (ev.code === 4001) { localStorage.removeItem(TOKEN_KEY); location.href = '/'; return; }
      setTimeout(open, Math.min(1000 * 2 ** retry++, 10000));
    };
  }
  open();
}

/* ---- Sound (Web Audio, no files needed) ---- */
const Sound = {
  ctx: null,
  on: localStorage.getItem('koms_sound') !== 'off',
  unlock() {
    if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; this.ctx = new AC(); }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, at, dur, type = 'sine', vol = 0.3) {
    const c = this.ctx, t0 = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  play(kind) {
    if (!this.on) return;
    this.unlock();
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (kind === 'new') { [0, 0.6].forEach((d) => { this.tone(988, d, 0.35); this.tone(1319, d + 0.18, 0.5); }); }
    else if (kind === 'ready') { [660, 880, 1100].forEach((f, i) => this.tone(f, i * 0.14, 0.25, 'triangle')); }
    else if (kind === 'alarm') { [0, 0.35, 0.7].forEach((d) => { this.tone(520, d, 0.25, 'square', 0.18); this.tone(390, d + 0.12, 0.25, 'square', 0.18); }); }
  },
  toggle() {
    this.on = !this.on;
    localStorage.setItem('koms_sound', this.on ? 'on' : 'off');
    if (this.on) { this.unlock(); this.play('ready'); }
    return this.on;
  },
  bind(btn) {
    const paint = () => { btn.textContent = this.on ? '🔔 Sound on' : '🔕 Sound off'; btn.classList.toggle('muted', !this.on); };
    btn.addEventListener('click', () => { this.toggle(); paint(); });
    paint();
  },
};
// Browsers only allow audio after a user gesture - unlock on first interaction.
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (Sound.on) Sound.unlock(); }, { passive: true }));

/* ---- Formatting ---- */
let clockSkew = 0; // server time minus client time
function setServerTime(serverTime) { if (serverTime) clockSkew = serverTime - Date.now(); }
const nowSrv = () => Date.now() + clockSkew;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const orderNo = (n) => '#' + String(n).padStart(3, '0');
const fmtClock = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
const fmtDateTime = (ts) => new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function waLink(phone, text, countryCode) {
  let p = String(phone || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.length === 10) p = (countryCode || '91') + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

function toast(msg, type = 'info') {
  let root = document.getElementById('toasts');
  if (!root) { root = document.createElement('div'); root.id = 'toasts'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
}
