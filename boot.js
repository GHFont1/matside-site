/* Opens one tournament: ?e=<id> picks the event, #a=<key> (director) or #s=<key> (scorer) in the link
   is saved on this device and removed from the address bar. ?demo runs the sample on this device only. */
(function () {
  const q = new URLSearchParams(location.search);
  const id = (q.get('e') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  if (!id) { if (!q.has('demo')) location.replace('../'); return }
  window.MATSIDE_EVENT = id;

  const KEYS = 'matside-keys', MINE = 'matside-mine';
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {} } catch (e) { return {} } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} };

  const keys = read(KEYS);
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('a') || h.get('s')) {
    keys[id] = { k: h.get('a') || h.get('s'), r: h.get('a') ? 'admin' : 'scorer', at: Date.now() };
    write(KEYS, keys);
    history.replaceState(null, '', location.pathname + location.search);
  }
  let key = keys[id] ? keys[id].k : null;

  const db = MatsideDB.makeDb(id, key);
  // Offline at open: trust the key saved on this device; the server still checks every write.
  const role = MatsideDB.rpc('ms_role', { p_event: id, p_key: key }).catch(() => keys[id] ? keys[id].r : 'view').then(r => {
    if (r === 'none') notFound();
    if (r === 'view' && keys[id]) { delete keys[id]; write(KEYS, keys); key = null }
    return r;
  });
  window.MATSIDE_ROLE = 'view';
  role.then(r => { window.MATSIDE_ROLE = r });

  window.claude = { use: async n => {
    if (n === 'db') return db;
    if (n === 'user') { const r = await role; return { can: async () => r === 'admin' || r === 'scorer', role: async () => r === 'admin' ? 'director' : r } }
    return null;
  } };

  // Remember this tournament on this device for the home page.
  db.doc('event/main').onSnapshot(s => {
    const ev = s.exists ? s.data() : null; const mine = read(MINE);
    mine[id] = Object.assign(mine[id] || {}, { name: ev && ev.name || (mine[id] && mine[id].name) || 'Untitled tournament', date: ev && ev.date || '', at: Date.now() });
    write(MINE, mine);
  });

  function notFound() {
    document.addEventListener('DOMContentLoaded', show); if (document.readyState !== 'loading') show();
    function show() { const m = document.querySelector('#main'); if (m) m.innerHTML = '<div class="panel empty"><h2>Tournament not found</h2><p>Check the link, or go to <a href="../">the home page</a>.</p></div>' }
  }

  /* ---------- Share panel shown at the top of Setup ---------- */
  const base = () => location.origin + location.pathname;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let scorerKey = keys[id] && keys[id].s || null;
  role.then(r => { if (r === 'admin') MatsideDB.rpc('ms_scorer_key', { p_event: id, p_key: key }).then(s => { scorerKey = s; if (keys[id]) { keys[id].s = s; write(KEYS, keys) } repaint() }, () => {}) });
  const repaint = () => { const m = document.querySelector('.share'); if (m) m.outerHTML = window.MATSIDE_SHARE() };
  window.MATSIDE_SHARE = () => {
    const r = window.MATSIDE_ROLE, pub = base() + '?e=' + id;
    const row = (t, d, u, extra) => `<div class="sharerow"><div class="sharetxt"><b>${t}</b><div class="sub">${d}</div>
      ${u ? `<div class="linkrow"><input readonly value="${esc(u)}" aria-label="${t}"><button class="btn" data-ms="copy" data-u="${esc(u)}">Copy</button></div>` : '<div class="sub">Loading…</div>'}${extra || ''}</div></div>`;
    return `<section class="panel share"><div class="panel-h"><h2>Share this tournament</h2><span class="sub">${r === 'admin' ? 'Send each group its own link.' : 'Send this link to anyone who wants to follow along.'}</span></div>
      <div class="sharewrap"><div class="sharelist">
      ${row('Public link', 'For coaches, parents and fans: brackets, live scores and following wrestlers. Nobody can change anything with it.', pub)}
      ${r === 'admin' ? row('Scorer link', 'For mat tables and the head table: score bouts, enter results and call bouts. Cannot change setup or entries.', scorerKey ? pub + '#s=' + scorerKey : '', scorerKey ? '<button class="btn ghost sm" data-ms="newScorer">Replace the scorer link</button>' : '') : ''}
      ${r === 'admin' ? row('Director link', 'Full control. Keep it private and save it somewhere safe. It is the only way back in on another device.', pub + '#a=' + key) : ''}
      </div><figure class="qrbox"><img class="qr" alt="QR code for the public link" src="${qr(pub)}"><figcaption>Scan to follow live</figcaption></figure></div>
      <div class="sub"><a href="../">All your tournaments</a></div></section>`;
  };
  function qr(u) { try { const c = qrcode(0, 'M'); c.addData(u); c.make(); return c.createDataURL(6, 2) } catch (e) { return '' } }

  document.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-ms]'); if (!b) return;
    if (b.dataset.ms === 'copy') {
      try { await navigator.clipboard.writeText(b.dataset.u); b.textContent = 'Copied' } catch (e) { const i = b.parentNode.querySelector('input'); i.select(); b.textContent = 'Press Ctrl+C' }
      setTimeout(() => { b.textContent = 'Copy' }, 1800);
    }
    if (b.dataset.ms === 'newScorer') {
      if (!confirm('Replace the scorer link? Tablets using the old link stop saving until they open the new one. Use this if the link got out.')) return;
      b.disabled = true;
      try { scorerKey = await MatsideDB.rpc('ms_new_scorer_key', { p_event: id, p_key: key }); keys[id].s = scorerKey; write(KEYS, keys); repaint() }
      catch (e) { b.disabled = false; alert('Could not replace the link. Check the connection and try again.') }
    }
  });
})();
