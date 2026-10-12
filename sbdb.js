/* Matside data adapter: gives the app the same small db API it was written against
   (doc(path).get/set/delete/onSnapshot, collection(name).limit(n).get/onSnapshot) on top of Supabase.
   One event = one set of rows in ms_docs. Everything is kept in a local cache; realtime pushes changes,
   and a catch-up query (rows changed since the last one seen) runs on reconnect, on focus and every 30 s. */
(function () {
  const CFG = window.MATSIDE_CFG;
  const sb = supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: false, autoRefreshToken: false } });
  // Postgres and realtime format timestamps differently ("2026-10-12 16:00:00.12+00" vs ISO); compare as ms.
  const ts = v => { if (!v) return 0; const t = Date.parse(String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')); return isNaN(t) ? 0 : t };
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  function makeDb(eventId, key) {
    const docs = new Map();            // path -> data (null = deleted)
    const stamp = new Map();           // path -> ms of the newest version applied
    const docSubs = new Map();         // path -> Set(fn)
    const collSubs = new Map();        // name -> Set(fn)
    let since = 0, loaded = false, loading = null, chan = null, pollT = null, pollEvery = 30000;

    const snapDoc = p => { const d = docs.get(p); return { exists: d != null, data: () => clone(d) } };
    const snapColl = (name, lim) => {
      const out = [];
      for (const [p, d] of docs) if (d != null && p.startsWith(name + '/')) { out.push({ id: p.slice(name.length + 1), data: () => clone(d) }); if (out.length >= lim) break }
      return { docs: out };
    };
    const clone = d => d == null ? d : JSON.parse(JSON.stringify(d));
    const emit = changed => {
      const names = new Set();
      for (const p of changed) { (docSubs.get(p) || []).forEach(fn => fn(snapDoc(p))); names.add(p.split('/')[0]) }
      for (const n of names) (collSubs.get(n) || []).forEach(s => s.fn(snapColl(n, s.lim)));
    };
    const apply = rows => {
      const changed = [];
      for (const r of rows) {
        const t = ts(r.updated_at);
        if (t > since) since = t;
        if (stamp.has(r.path) && t < stamp.get(r.path)) continue;   // an older version arriving late
        stamp.set(r.path, t);
        const cur = docs.get(r.path);
        if (!docs.has(r.path) || JSON.stringify(cur) !== JSON.stringify(r.data)) { docs.set(r.path, r.data); changed.push(r.path) }
      }
      if (changed.length) emit(changed);
    };
    async function fetchRows() {
      // overlap the cursor by 5 s so a write that committed out of order is not missed
      let q = sb.from('ms_docs').select('path,data,updated_at').eq('event_id', eventId).order('updated_at').limit(5000);
      if (since) q = q.gt('updated_at', new Date(since - 5000).toISOString());
      const { data, error } = await q;
      if (error) throw err('unavailable', error.message);
      apply(data || []);
      loaded = true;
    }
    function load() { if (!loading) loading = fetchRows().catch(e => { loading = null; throw e }).finally(() => { setTimeout(() => { loading = null }, 0) }); return loading }
    function startRealtime() {
      if (chan) return;
      chan = sb.channel('ms-' + eventId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ms_docs', filter: 'event_id=eq.' + eventId }, m => { if (m.new && m.new.path) apply([m.new]) })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') { pollEvery = 30000; load().catch(() => {}) }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { pollEvery = 5000 } // realtime full or down: poll faster
          schedule();
        });
    }
    function schedule() { clearTimeout(pollT); pollT = setTimeout(() => { load().catch(() => {}).finally(schedule) }, pollEvery) }
    let started = false;
    function start() {
      if (started) return; started = true;
      load().catch(() => {}).finally(schedule);
      startRealtime();
      window.addEventListener('online', () => load().catch(() => {}));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) load().catch(() => {}) });
    }

    async function put(path, data) {
      if (navigator.onLine === false) throw err('unavailable', 'offline');
      if (!key) throw err('invalid_argument', 'view only');
      let res;
      try { res = await sb.rpc('ms_put', { p_event: eventId, p_key: key, p_path: path, p_data: data }) }
      catch (e) { throw err('unavailable', e && e.message) }
      const { data: at, error } = res;
      if (error) {
        if (error.code === '42501') throw err('invalid_argument', 'not allowed');
        if (error.code === '22023') throw err('invalid_argument', error.message);
        throw err('unavailable', error.message);
      }
      apply([{ path, data, updated_at: at }]);
    }

    const doc = path => ({
      async get() { if (!loaded) await load(); return snapDoc(path) },
      set: data => put(path, data == null ? null : clone(data)),
      delete: () => put(path, null),
      onSnapshot(next) { start(); if (!docSubs.has(path)) docSubs.set(path, new Set()); docSubs.get(path).add(next); if (loaded) next(snapDoc(path)); else load().then(() => next(snapDoc(path)), () => {}); return () => docSubs.get(path).delete(next) }
    });
    const collection = name => {
      let lim = 1000;
      const q = {
        limit(n) { lim = n; return q },
        async get() { if (!loaded) await load(); return snapColl(name, lim) },
        onSnapshot(next) { start(); const s = { fn: next, lim }; if (!collSubs.has(name)) collSubs.set(name, new Set()); collSubs.get(name).add(s); if (loaded) next(snapColl(name, lim)); else load().then(() => next(snapColl(name, lim)), () => {}); return () => collSubs.get(name).delete(s) }
      };
      return q;
    };
    return { doc, collection };
  }

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw err(error.code || 'error', error.message);
    return data;
  }

  window.MatsideDB = { makeDb, rpc };
})();
