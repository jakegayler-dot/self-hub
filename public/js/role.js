// The Andrew page (2026-11-03): Jake playing Bond, cast as a Saskatchewan grain and cattle man, prepared like a
// method actor. On set (today's scene and the Trinity Bond courses he's on, each with Sentinel's director's note) ·
// The arc (every BND course by level and what it gives the character) · Inner life · The look · Notebook.
(function () {
  var API = '/api/fitness';
  var pane = document.getElementById('rolePane');
  if (!pane) return;
  var st = { view: 'set', data: null, open: {} };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2000); }
  async function api(method, path, body) {
    var res = await fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    var d = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
    return d;
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtD(s) { if (!s) return ''; var d = new Date(String(s).slice(0, 10) + 'T12:00:00Z'); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  var STATUS = { complete: 'Complete', submitted: 'With the Board', in_progress: 'On set', not_loaded: 'Ahead' };

  var VIEWS = [['set', 'On set'], ['arc', 'The arc'], ['inner', 'Inner life'], ['look', 'The look'], ['notebook', 'Notebook']];
  pane.innerHTML = '<div class="rl-head"><div class="rl-slate">Production: Andrew</div><h2 class="rl-title">Bond, cast as a Saskatchewan grain and cattle man</h2></div>' +
    '<div class="nu-views">' + VIEWS.map(function (v) { return '<button class="wk-chipbtn" data-wv="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div><div id="rlBody"></div>';
  var body = document.getElementById('rlBody');
  pane.querySelectorAll('[data-wv]').forEach(function (b) { b.onclick = function () { show(b.dataset.wv); }; });
  document.querySelectorAll('.trk-tab[data-tab="role"]').forEach(function (t) { t.addEventListener('click', function () { show(st.view); }); });

  async function load(fresh) { if (!st.data || fresh) st.data = await api('GET', '/role' + (fresh ? '?fresh=1' : '')); return st.data; }
  function show(v) {
    st.view = v;
    pane.querySelectorAll('[data-wv]').forEach(function (b) { b.classList.toggle('on', b.dataset.wv === v); });
    if (!st.data) body.innerHTML = '<p class="trk-note">Loading…</p>';
    load().then(function (d) { ({ set: onSet, arc: arc, inner: inner, look: look, notebook: notebook })[v](d); })
      .catch(function (e) { body.innerHTML = '<p class="trk-err" style="display:block">' + esc(e.message) + '</p>'; });
  }

  function trinityLine(d) {
    var t = d.trinity || {};
    if (t.error) return '<p class="rl-warn">' + esc(t.error) + '. The character pages still work.</p>';
    if (t.stale) return '<p class="trk-note">The courses below are from ' + esc(fmtD(t.fetched_at)) + '; Trinity or Sentinel didn\'t answer just now.</p>';
    return '';
  }
  function bar(done, total) { var p = total ? Math.round(100 * done / total) : 0; return '<span class="rl-bar"><i style="width:' + p + '%"></i></span>'; }

  // ---- On set: today's scene, then each course he's on with the session in front of him and the director's note ----
  function onSet(d) {
    var s = d.scene, f = s.force, h = '';
    h += '<section class="rl-scene"><div class="rl-cue">Today\'s scene</div><h3>' + esc(f.title) + '</h3><p>' + esc(f.actor) + '</p>' +
      '<details><summary>Why it matters</summary><p>' + esc(f.body) + '</p><p class="rl-shows">How it shows: ' + esc(f.shows) + '</p></details></section>';
    var so = (d.notebook || []).find(function (q) { return q.id === 'super_objective'; });
    h += '<section class="rl-obj"><div class="rl-cue">The super-objective</div><p class="rl-big">' + esc(so && so.answer ? so.answer : cap(so.hint.replace(/^A start, to make yours: /, ''))) + '</p>' +
      (so && so.answer ? '' : '<p class="trk-note">A first draft. Make it yours in the Notebook.</p>') + '</section>';
    h += trinityLine(d);
    var cur = d.current || [];
    h += '<div class="rl-cue rl-gap">On set now · ' + cur.length + ' of ' + d.totals.courses + ' Bond courses</div>';
    if (!cur.length && !(d.trinity || {}).error) h += '<p class="trk-note">No Bond course is loaded in Trinity right now. Load the next one there when there\'s room in the week.</p>';
    cur.forEach(function (c) {
      var n = c.note || {}, ses = c.session;
      h += '<article class="rl-course">' +
        '<div class="rl-ch"><span class="rl-code">' + esc(c.code) + '</span><b>' + esc(c.label) + '</b><span class="rl-state rl-' + esc(String(c.state).replace(/\s/g, '-')) + '">' + esc(c.state) + '</span></div>' +
        (c.role ? '<p class="rl-role">' + esc(c.role) + '</p>' : '') +
        (ses ? '<div class="rl-ses"><div><span class="trk-note">Next session' + (ses.due ? (ses.overdue ? ' · was due ' : ' · due ') + esc(fmtD(ses.due)) : '') + '</span><b>' + esc(ses.title) + '</b></div>' +
          (ses.url ? '<a class="wk-chipbtn" href="' + esc(ses.url) + '" target="_blank" rel="noopener">Open in Trinity</a>' : '') + '</div>' : '') +
        (n.this_session ? '<div class="rl-note"><div class="rl-cue">Director\'s note</div><p>' + esc(n.this_session) + '</p>' + (n.why ? '<p class="rl-why">' + esc(n.why) + '</p>' : '') + '</div>' : '') +
        '<p class="rl-reassure">' + esc(n.reassurance || c.reassurance_line) + '</p>' +
        (n.inspiration ? '<p class="rl-insp">' + esc(n.inspiration) + '</p>' : '') +
        '</article>';
    });
    h += '<section class="rl-foot"><div><div class="rl-cue">Study tonight</div><p><b>' + esc(s.study[0]) + '</b>: ' + esc(s.study[1]) + '</p></div>' +
      '<div><div class="rl-cue">To carry</div><p>' + esc(s.inspiration) + '</p></div></section>';
    body.innerHTML = h;
  }

  // ---- The arc: every BND course, level by level, with what it gives Andrew ----
  function arc(d) {
    var h = trinityLine(d);
    var t = d.totals;
    h += '<p class="rl-intro">' + t.complete + ' complete · ' + t.in_progress + ' on set · ' + t.not_loaded + ' ahead. The order and the pace are Trinity\'s; this is what each course adds to the man.</p>';
    (d.levels || []).forEach(function (l) {
      h += '<section class="rl-level"><div class="rl-lh"><span class="rl-cue">Level ' + l.level + '</span><h3>' + esc(l.title) + '</h3><p class="trk-note">' + esc(l.about) + '</p></div>';
      l.courses.forEach(function (c) {
        var open = st.open[c.code];
        h += '<div class="rl-row' + (c.status === 'complete' ? ' done' : c.status === 'in_progress' || c.status === 'submitted' ? ' live' : '') + '" data-code="' + esc(c.code) + '" tabindex="0" role="button" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="rl-code">' + esc(c.code) + '</span><span class="rl-name">' + esc(c.label) + '</span>' +
          '<span class="rl-st">' + esc(STATUS[c.status] || c.status) + (c.status === 'in_progress' ? ' · ' + c.steps_done + '/' + c.steps_total : '') + '</span>' +
          (c.status === 'in_progress' ? bar(c.steps_done, c.steps_total) : '') +
          (open ? '<div class="rl-more">' + (c.role ? '<p>' + esc(c.role) + '</p>' : '') + (c.project ? '<p class="trk-note">The project: ' + esc(c.project) + '</p>' : '') +
            (c.url ? '<a class="wk-chipbtn" href="' + esc(c.url) + '" target="_blank" rel="noopener">Open in Trinity</a>' : '') + '</div>'
            : (c.role ? '<span class="rl-line">' + esc(c.role) + '</span>' : '')) +
          '</div>';
      });
      h += '</section>';
    });
    body.innerHTML = h;
    body.querySelectorAll('.rl-row').forEach(function (r) {
      var t = function (ev) { if (ev.target.closest('a')) return; st.open[r.dataset.code] = !st.open[r.dataset.code]; arc(d); };
      r.onclick = t; r.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); t(ev); } };
    });
  }

  // ---- Inner life: the ten forces, the shadow, the arc of the films, the method ----
  function inner(d) {
    var x = d.inner, h = '<p class="rl-intro">The suits and skills are what the camera sees. This is why people are a little wary of him and still want to hear what he says.</p>';
    x.forces.forEach(function (f, i) {
      h += '<details class="rl-force"' + (i === 0 ? ' open' : '') + '><summary><span class="rl-n">' + String(i + 1).padStart(2, '0') + '</span>' + esc(f.title) + '</summary>' +
        '<p>' + esc(f.body) + '</p><p class="rl-shows">How it shows: ' + esc(f.shows) + '</p><p class="rl-actor"><b>For the actor</b>' + esc(f.actor) + '</p></details>';
    });
    h += '<div class="rl-cue rl-gap">The shadow · what stays on the cutting-room floor</div><div class="rl-tbl"><table><tr><th>His strength</th><th>Its shadow in Bond</th><th>Andrew\'s version</th></tr>' +
      x.shadow.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'; }).join('') + '</table></div>' +
      '<p class="rl-rule">' + esc(x.shadow_rule) + '</p>';
    h += '<div class="rl-cue rl-gap">Five films, one man learning to trust</div>' + x.arc.map(function (a) { return '<div class="rl-arc"><b>' + esc(a[0]) + '</b><span>' + esc(a[1]) + '</span></div>'; }).join('') +
      '<p class="rl-rule rl-good">' + esc(x.arc_insight) + '</p>';
    h += '<div class="rl-cue rl-gap">The method</div><div class="rl-tbl"><table><tr><th>Technique</th><th>What it is</th><th>In your life</th></tr>' +
      x.method.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'; }).join('') + '</table></div>';
    h += links(d);
    body.innerHTML = h;
  }

  // ---- The look: costume by scene, grooming, manner ----
  function look(d) {
    var L = d.look, h = '<p class="rl-intro">' + esc(L.rule) + ' The wardrobe tab and the stylist fill it piece by piece; BND-111, 209 and 307 make it a system and then a signature.</p>';
    var block = function (title, rows) { return '<div class="rl-cue rl-gap">' + esc(title) + '</div><div class="rl-grid">' + rows.map(function (r) { return '<div class="rl-card"><b>' + esc(r[0]) + '</b><p>' + esc(r[1]) + '</p></div>'; }).join('') + '</div>'; };
    h += block('Costume, by scene', L.costume) + block('The grooming chair', L.grooming) + block('Voice and movement', L.manner);
    h += '<div class="rl-cue rl-gap">Study material</div>' + d.study.map(function (s) { return '<div class="rl-arc"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div>'; }).join('');
    h += links(d);
    body.innerHTML = h;
  }

  // ---- Notebook: his own answers to the character questions (saved as he types; Sentinel can read them) ----
  function notebook(d) {
    var h = '<p class="rl-intro">Actors write the character\'s inner life in their own words. Answer slowly, in any order, and change them whenever they stop being true. Nothing here is scored.</p>';
    d.notebook.forEach(function (q) {
      h += '<div class="rl-q"><label for="rlq-' + esc(q.id) + '">' + esc(q.q) + '</label>' + (q.hint ? '<p class="trk-note">' + esc(q.hint) + '</p>' : '') +
        '<textarea id="rlq-' + esc(q.id) + '" data-q="' + esc(q.id) + '" rows="3" maxlength="8000">' + esc(q.answer) + '</textarea><span class="rl-saved" data-for="' + esc(q.id) + '">' + (q.updated_at ? 'Saved ' + esc(fmtD(q.updated_at)) : '') + '</span></div>';
    });
    body.innerHTML = h;
    body.querySelectorAll('textarea[data-q]').forEach(function (ta) {
      var timer = null;
      var save = function () {
        clearTimeout(timer);
        var id = ta.dataset.q, val = ta.value;
        api('PUT', '/role/notebook/' + encodeURIComponent(id), { answer: val }).then(function (r) {
          var q = st.data.notebook.find(function (x) { return x.id === id; }); if (q) { q.answer = r.answer; q.updated_at = r.updated_at; }
          var s = body.querySelector('.rl-saved[data-for="' + id + '"]'); if (s) s.textContent = 'Saved';
        }).catch(function (e) { toast(e.message); });
      };
      ta.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(save, 1200); });
      ta.addEventListener('blur', function () { if (timer) save(); });
    });
  }

  function links(d) {
    var a = d.artifacts || {};
    return '<p class="trk-note rl-links">The long versions: <a href="' + esc(a.bible) + '" target="_blank" rel="noopener">the character bible</a> · <a href="' + esc(a.inner_life) + '" target="_blank" rel="noopener">the inner life of Bond</a></p>';
  }
})();
