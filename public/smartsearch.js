'use strict';
/* SmartSearch: order-independent, typo-tolerant, sound-alike, ranked, learns what you pick most.
   "shawai peri peri", "peri peri shwarma", "2 peri shawai" and "periperi shawai x3" all find the right item. */
const SmartSearch = (() => {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // sound-alike key: shawarma / shawai / shavarma / shwarma, kubboos / kubus, rumali / romali ...
  const phon = (w) => {
    let s = w.replace(/ph/g, 'f').replace(/sh/g, 's').replace(/ch/g, 'c').replace(/kh/g, 'k').replace(/th/g, 't').replace(/w/g, 'v').replace(/[qc]/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks').replace(/(.)\1+/g, '$1');
    return s[0] + s.slice(1).replace(/[aeiouy]/g, '');
  };
  function lev(a, b, max) {            // Damerau-Levenshtein with early exit
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let p2 = null, p1 = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let min = i;
      for (let j = 1; j <= b.length; j++) {
        let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v; if (v < min) min = v;
      }
      if (min > max) return max + 1; p2 = p1; p1 = cur;
    }
    return p1[b.length];
  }
  const maxTypos = (n) => (n <= 3 ? 0 : n <= 7 ? 1 : 2);

  /* ---- what this device picks most (tiny local "learning") ---- */
  const KEY = 'koms_pick_counts';
  const counts = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; } })();
  const learn = (id, n = 1) => { counts[id] = (counts[id] || 0) + n; try { localStorage.setItem(KEY, JSON.stringify(counts)); } catch (_) {} };
  const favourites = (ids, n = 6) => ids.filter((id) => counts[id] > 1).sort((a, b) => counts[b] - counts[a]).slice(0, n);

  function index(list) {
    return list.map((it, ix) => {
      const nameWords = norm(it.name).split(' ').filter(Boolean), catWords = norm(it.category).split(' ').filter(Boolean);
      return { it, ix, name: norm(it.name), nameWords, catWords, words: [...nameWords.map((w) => ({ w, c: 0, p: phon(w) })), ...catWords.map((w) => ({ w, c: 1, p: phon(w) }))], joined: nameWords.join('') };
    });
  }
  function scoreToken(t, e) {
    const tp = t.length >= 3 ? phon(t) : '', k = maxTypos(t.length); let best = 0, hit = null;
    for (const x of e.words) {
      let s = 0;
      if (x.w === t) s = 100;
      else if (x.w.startsWith(t)) s = 82;
      else if (t.length >= 3 && x.w.includes(t)) s = 56;
      else if (k) { const d = Math.min(lev(t, x.w, k), lev(t, x.w.slice(0, t.length), k)); if (d <= k) s = 66 - 14 * d; }
      if (!s && tp && x.p === tp) s = 52;
      if (!s && tp.length >= 2 && x.p.startsWith(tp)) s = 42;
      if (x.c) s *= 0.6;
      if (s > best) { best = s; hit = x.w; }
    }
    if (!best && t.length >= 5 && e.joined.includes(t)) { best = 50; hit = null; }    // "periperi" typed as one word
    return { s: best, w: hit };
  }
  /** Parse "2 peri shawai" / "peri shawai x3" -> quantity + text */
  function parse(q) {
    let qty = 1, text = String(q || '').trim(), m;
    if ((m = text.match(/^(\d{1,2})\s*[x×*]?\s+(.+)$/i))) { qty = +m[1]; text = m[2]; }
    else if ((m = text.match(/^(.+?)\s*[x×*]\s*(\d{1,2})$/i))) { qty = +m[2]; text = m[1]; }
    return { qty: Math.max(1, Math.min(99, qty)), text };
  }
  function search(entries, raw) {
    const { qty, text } = parse(raw), q = norm(text);
    if (!q) return { qty, results: [], mode: 'all', q };
    const toks = [...new Set(q.split(' '))], whole = toks.join('');
    const run = (needAll) => {
      const out = [];
      for (const e of entries) {
        let sum = 0, ok = 0, words = [];
        for (const t of toks) { const r = scoreToken(t, e); if (r.s) { sum += r.s; ok++; if (r.w) words.push(r.w); } }
        if (needAll ? ok < toks.length : !ok) continue;
        let s = sum / toks.length;
        if (e.name.startsWith(q)) s += 30; else if (e.name.includes(q)) s += 16;
        if (e.joined.startsWith(whole)) s += 12;
        s += Math.min(14, (counts[e.it.id] || 0) * 2);
        s -= Math.min(6, e.name.length / 12);          // shorter names first among equals
        if (!needAll) s *= ok / toks.length;
        out.push({ e, s, words });
      }
      return out.sort((a, b) => b.s - a.s || a.e.ix - b.e.ix);
    };
    let results = run(true), mode = 'match';
    if (!results.length) { results = run(false); mode = results.length ? 'close' : 'none'; }
    let suggestion = null;
    if (mode === 'none') {                                   // "did you mean": closest whole name
      let bd = 1e9; for (const e of entries) { const d = lev(q, e.name.slice(0, q.length + 2), 4); if (d < bd) { bd = d; suggestion = e.it; } }
      if (bd > 3) suggestion = null;
    }
    return { qty, results, mode, q, suggestion, words: toks };
  }
  /** Bold the parts of a name that matched */
  function highlight(name, words, esc) {
    const toks = words || []; if (!toks.length) return esc(name);
    let out = '', last = 0; const re = /[A-Za-z0-9À-ɏ]+/g; let m;
    while ((m = re.exec(name))) {
      const w = norm(m[0]); let n = 0;
      for (const t of toks) {
        if (w === t || w.startsWith(t)) n = Math.max(n, t.length);
        else if (t.length >= 3 && w.includes(t)) n = Math.max(n, t.length);
        else { const k = maxTypos(t.length); if (k && lev(t, w.slice(0, t.length), k) <= k) n = Math.max(n, Math.min(w.length, t.length)); else if (t.length >= 3 && phon(t) === phon(w)) n = Math.max(n, w.length); }
      }
      if (n) { out += esc(name.slice(last, m.index)) + '<mark>' + esc(m[0].slice(0, Math.max(1, n))) + '</mark>' + esc(m[0].slice(Math.max(1, n))); last = m.index + m[0].length; }
    }
    return out + esc(name.slice(last));
  }
  return { norm, index, search, highlight, learn, favourites, parse };
})();
