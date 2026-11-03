'use strict';
/* Polish layer: glass dropdowns (replace every native <select>), number steppers, kept in sync with the real fields. */
const Dropdown = (() => {
  const DOT = { preparing: '#f2a516', ready: '#2fb383', served: '#6a77d8' };
  const E = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CARET = '<svg class="dcar" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const CHECK = '<svg class="dck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let cur = null;
  const dot = (o) => { const k = String((o && (o.value || o.text)) || '').toLowerCase(); return DOT[k] ? `<i class="ddot" style="background:${DOT[k]}"></i>` : ''; };

  function close(instant) {
    if (!cur) return; const { menu, btn, off } = cur; cur = null; off();
    btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); menu.classList.remove('in');
    instant ? menu.remove() : setTimeout(() => menu.remove(), 170);
  }
  function enhance(sel) {
    if (sel.dataset.dd || sel.multiple || sel.size > 1 || sel.hasAttribute('data-native')) return;
    sel.dataset.dd = '1';
    const btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    if (sel.id) btn.dataset.for = sel.id;
    sel.after(btn); sel.style.display = 'none';
    const base = sel.className;
    const paint = () => {
      const o = sel.options[sel.selectedIndex];
      btn.className = 'dbtn ' + base; btn.disabled = sel.disabled;
      if (sel.classList.contains('status')) ['preparing', 'ready', 'served'].forEach((c) => { btn.classList.toggle(c, sel.value === c); });
      btn.innerHTML = `${dot(o)}<span class="dl ${dot(o) ? 'cap' : ''}">${E(o ? o.text : '')}</span>${CARET}`;
    };
    paint();
    let hi = -1;
    const open = () => {
      if (cur) { const same = cur.btn === btn; close(); if (same) return; }
      const menu = document.createElement('div'); menu.className = 'dmenu'; menu.setAttribute('role', 'listbox');
      menu.innerHTML = [...sel.options].map((o, i) => `<div class="di ${i === sel.selectedIndex ? 'sel' : ''}" role="option" data-i="${i}">${dot(o)}<span class="${dot(o) ? 'cap' : ''}">${E(o.text)}</span>${CHECK}</div>`).join('');
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect(), mh = menu.offsetHeight;
      menu.style.minWidth = Math.max(r.width, 170) + 'px';
      const up = r.bottom + mh + 12 > innerHeight && r.top > mh + 12;
      menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 10) + 'px'; menu.style.top = (up ? r.top - mh - 6 : r.bottom + 6) + 'px'; menu.classList.toggle('up', up);
      requestAnimationFrame(() => menu.classList.add('in'));
      btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      const items = [...menu.children];
      const mark = (i) => { hi = i; items.forEach((x, n) => x.classList.toggle('h', n === i)); if (items[i]) items[i].scrollIntoView({ block: 'nearest' }); };
      mark(sel.selectedIndex);
      const pick = (i) => { if (i < 0 || !sel.options[i]) return; const changed = sel.selectedIndex !== i; sel.selectedIndex = i; paint(); close(); btn.focus(); if (changed) sel.dispatchEvent(new Event('change', { bubbles: true })); };
      menu.addEventListener('pointermove', (e) => { const it = e.target.closest('.di'); if (it) mark(+it.dataset.i); });
      menu.addEventListener('click', (e) => { const it = e.target.closest('.di'); if (it) pick(+it.dataset.i); });
      const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); mark(Math.min(items.length - 1, hi + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, hi - 1)); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hi); }
        else if (e.key === 'Tab') close();
      };
      const away = (e) => { if (!menu.contains(e.target)) close(true); };
      document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); window.addEventListener('scroll', away, true); window.addEventListener('resize', away);
      cur = { menu, btn, off: () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); } };
    };
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
    btn.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp'].includes(e.key) && !cur) { e.preventDefault(); open(); } });
    sel.addEventListener('change', paint);
  }

  /* number fields get  −  value  +  buttons */
  function enhanceNum(inp) {
    if (inp.dataset.ns || inp.type !== 'number') return; inp.dataset.ns = '1';
    const w = document.createElement('div'); w.className = 'numstep'; inp.before(w);
    const mk = (t, d) => { const b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1; b.textContent = t; b.setAttribute('aria-label', d > 0 ? 'Increase' : 'Decrease'); b.onclick = () => {
      const st = parseFloat(inp.step) || 1, min = inp.min !== '' ? +inp.min : -Infinity, max = inp.max !== '' ? +inp.max : Infinity;
      let v = (parseFloat(inp.value) || 0) + d * st; v = Math.max(min, Math.min(max, Math.round(v * 1000) / 1000)); inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.classList.remove('bump'); void inp.offsetWidth; inp.classList.add('bump'); }; return b; };
    w.append(mk('−', -1), inp, mk('+', 1));
  }

  const scan = (root) => { if (!root.querySelectorAll) return; if (root.matches && root.matches('select')) enhance(root); if (root.matches && root.matches('input[type=number]')) enhanceNum(root); root.querySelectorAll('select').forEach(enhance); root.querySelectorAll('input[type=number]').forEach(enhanceNum); };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }))).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
  return { enhance, close };
})();
