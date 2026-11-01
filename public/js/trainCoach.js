// The trainer on the Train page (Nov 1): coaching on every movement (tempo, the cue to think about, a video for the
// complex lifts), a guided warm-up built from the session, cool-down stretches for what it worked, and a side panel
// (a sheet on the phone) saying what each movement does: the muscles and what it does to them, or for cardio which
// system it trains and why. Content: SelfHubCoaching (server/lib/coaching.js, served as /js/coaching.js).
(function () {
  var C = window.SelfHubCoaching;
  if (!C) return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var GL = { chest: 'Chest', shoulders: 'Shoulders', traps: 'Traps', lats: 'Lats', midback: 'Mid back', lowerback: 'Lower back', biceps: 'Biceps', triceps: 'Triceps',
    forearms: 'Forearms', abs: 'Abs', obliques: 'Obliques', glutes: 'Glutes', quads: 'Quads', adductors: 'Adductors', hamstrings: 'Hamstrings', calves: 'Calves', neck: 'Neck' };
  var mmss = function (s) { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var MOVE_ITEMS = function (it) { return it.log_as === 'lift' || it.log_as === 'gymnastics' || it.log_as === 'conditioning' || it.log_as === 'engine' || it.log_as === 'test' || it.log_as === 'none'; };

  function entryFor(it) { return C.lookup(it.movement, it.pattern); }
  function repsOf(it) { var s = (it.sets || [])[0]; return s && s.reps; }
  function energyOf(b, it) {
    if (b.engine && C.ENERGY[b.engine.type]) return C.ENERGY[b.engine.type];
    if (b.kind === 'metcon') return C.ENERGY.mixed;
    var e = it ? entryFor(it) : null;
    if (e && e.cardio === 'machine') return C.ENERGY.aerobic;
    if (e && e.cardio === 'mixed') return C.ENERGY.mixed;
    if (b.kind === 'conditioning') return C.ENERGY.aerobic;
    return null;
  }

  // ---- inline, under each movement on the card ----
  // ---- lift notes: what he's working on in each lift (Nov 1: "a little note pad… things to work on with that lift") ----
  var notes = {};
  function noteKey(it) { var e = entryFor(it); return e && !e.approx && e.name ? e.name : it.movement; }
  fetch('/api/fitness/lift-notes').then(function (r) { return r.ok ? r.json() : []; }).then(function (list) {
    (list || []).forEach(function (n) { notes[n.movement] = n.body; });
    if (list && list.length && window.SelfHubTrainRender) window.SelfHubTrainRender();
  }).catch(function () {});
  function noteHtml(it) {
    var n = notes[noteKey(it)];
    return n ? '<div class="tc-wo"><span class="tc-wol">Working on</span>' + esc(n).replace(/\n/g, '<br>') + '</div>' : '';
  }
  function saveNote(key, body) {
    return fetch('/api/fitness/lift-notes/' + encodeURIComponent(key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: body }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error((d && d.error) || 'Could not save'); return d; }); })
      .then(function (d) { if (d.body) notes[key] = d.body; else delete notes[key]; return d; });
  }
  // An editor in place of el: Save puts it in Self Hub (and re-draws the cards); Cancel puts el back.
  function editNote(it, el, done) {
    var key = noteKey(it), box = document.createElement('div'); box.className = 'tc-noteedit';
    box.innerHTML = '<div class="tc-sub">Working on: ' + esc(key) + '</div><textarea rows="4" maxlength="2000" placeholder="e.g. Stay over the bar longer before the second pull. Elbows faster in the catch.">' + esc(notes[key] || '') + '</textarea>' +
      '<div class="tc-noterow"><button class="trk-btn primary" type="button">Save</button><button class="trk-btn" type="button">Cancel</button></div>';
    el.replaceWith(box);
    var ta = box.querySelector('textarea'), bt = box.querySelectorAll('button');
    ta.focus();
    bt[1].onclick = function () { box.replaceWith(el); };
    bt[0].onclick = function () {
      bt[0].disabled = true;
      saveNote(key, ta.value).then(function () { if (done) done(); if (window.SelfHubTrainRender) window.SelfHubTrainRender(); })
        .catch(function (e) { bt[0].disabled = false; alert(e.message); });
    };
  }
  // The lifts worth filming: Olympic lifts, the barbell compounds, the kipping and inverted gymnastics.
  function filmable(e) { return !!e && !e.approx && (e.tempo === 'olympic' || e.tempo === 'barbell' || ((e.tempo === 'dynamic' || e.tempo === 'strict') && !!e.video)); }
  var FILM_TIPS = ['From the side, square on, camera at hip height, 3–4 m away.', 'Whole body, feet and the bar (or rings) in frame for the whole rep; landscape.', 'Slow motion or 60 fps if your phone has it; light behind the camera.', 'Film a working set, not a warm-up: the faults show under load.'];

  function itemExtras(w, b, it) {
    if (b.kind === 'warmup' || b.kind === 'cooldown') return '';
    var e = entryFor(it); if (!e) return '';
    var t = C.tempo(e, repsOf(it)), cue = e.cues && e.cues[0];
    var h = '<div class="tc-line">';
    if (t && it.log_as !== 'conditioning' && it.log_as !== 'engine' && b.kind !== 'metcon') h += '<span class="tc-tempo" title="' + esc(t.say) + '">Tempo ' + esc(t.code) + '</span>';
    if (cue && b.kind !== 'metcon') h += '<span class="tc-cue">' + esc(cue) + '</span>';
    h += '</div>';
    if (b.kind !== 'metcon') h += noteHtml(it);
    var lifting = it.log_as === 'lift' || it.log_as === 'gymnastics';
    h += '<div class="tc-links"><button class="tc-more" data-act="coach">Form, tension and what it trains</button>' +
      (lifting && b.kind !== 'metcon' ? '<button class="tc-more tc-notebtn" data-act="liftnote">' + (notes[noteKey(it)] ? 'Edit notes' : '+ Notes for this lift') + '</button>' : '') + '</div>';
    if (lifting && filmable(e) && b.kind !== 'metcon') h += '<div class="tc-filmrec">Worth filming a working set: side-on at hip height, whole bar path in frame.</div>';
    return h;
  }
  function noteFromCard(w, bid, iid, row) {
    var b = w.body.blocks.find(function (x) { return x.id === bid; }), it = b && b.items.find(function (x) { return x.id === iid; });
    if (!it) return;
    var anchor = row.querySelector('.tc-wo') || row.querySelector('.tc-links');
    editNote(it, anchor);
  }
  function blockNote(b) {
    var en = b.kind === 'warmup' || b.kind === 'cooldown' ? null : energyOf(b, b.items[0]);
    if (!en || !(b.engine || b.kind === 'metcon' || b.kind === 'conditioning')) return '';
    return '<div class="tc-energy"><b>' + esc(en.label) + '</b> · ' + esc(en.for) + '<span>' + esc(en.feel) + '</span></div>';
  }

  // ---- the guided warm-up and the cool-down ----
  function sessionPatterns(w) {
    var out = [];
    (w.body.blocks || []).forEach(function (b) { if (b.kind === 'warmup' || b.kind === 'cooldown') return; b.items.forEach(function (it) { if (it.pattern && out.indexOf(it.pattern) < 0) out.push(it.pattern); }); });
    return out;
  }
  function mainLift(w) {
    for (var i = 0; i < (w.body.blocks || []).length; i++) {
      var b = w.body.blocks[i];
      if (b.kind !== 'strength' && b.kind !== 'olympic') continue;
      var it = b.items.find(function (x) { return x.log_as === 'lift'; });
      if (it) return { movement: it.movement, pattern: it.pattern, load_lb: (it.sets.find(function (s) { return s.load_lb; }) || {}).load_lb };
    }
    return null;
  }
  function warmupOf(w) {
    var wb = (w.body.blocks || []).find(function (b) { return b.kind === 'warmup'; });
    return C.warmup(sessionPatterns(w), mainLift(w), wb && wb.minutes ? wb.minutes * 60 : 600);
  }
  function warmupHtml(w, b) {
    var g = warmupOf(w), total = g.steps.reduce(function (s, x) { return s + (x.seconds || 0); }, 0);
    var h = '<div class="tc-warm"><div class="tc-wh"><span>' + g.steps.length + ' drills · about ' + Math.round(total / 60) + ' min' + (g.ramp ? ', then ramp-up sets' : '') + '</span>' +
      '<button class="trk-btn primary" data-act="gwarm">&#9654; Start guided warm-up</button></div><ol class="tc-steps">' +
      g.steps.map(function (s) { return '<li><b>' + esc(s.name) + '</b> <span class="tc-dose">' + esc(s.dose) + '</span><div>' + esc(s.cue) + '</div></li>'; }).join('') + '</ol>';
    if (g.ramp) {
      h += '<div class="tc-ramp"><div class="tc-sub">Ramp-up: ' + esc(g.ramp.movement) + '</div><div class="tc-rampsets">' +
        g.ramp.sets.map(function (s) { return '<span><b>' + (s.load_lb ? s.load_lb + ' lb' : (s.pct ? s.pct + '%' : 'Bar')) + '</b> × ' + s.reps + '</span>'; }).join('') +
        '</div><div class="tc-note">' + esc(g.ramp.cue) + '</div></div>';
    }
    var orig = b.items.filter(function (it) { return it.movement; });
    if (orig.length) h += '<details class="tc-orig"><summary>The plan’s own warm-up</summary>' + orig.map(function (it) { return '<div>' + esc(it.movement) + (it.prescription ? ' · ' + esc(it.prescription) : '') + '</div>'; }).join('') + '</details>';
    return h + '<div class="tc-note">' + esc(g.note) + '</div></div>';
  }
  function trained(w) {
    var score = {};
    (w.body.blocks || []).forEach(function (b) {
      if (b.kind === 'warmup' || b.kind === 'cooldown') return;
      b.items.forEach(function (it) {
        var e = entryFor(it); if (!e) return;
        var n = Math.max(1, (it.sets || []).length);
        (e.primary || []).forEach(function (g) { score[g] = (score[g] || 0) + n; });
        (e.secondary || []).forEach(function (g) { score[g] = (score[g] || 0) + n / 2; });
      });
    });
    return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).map(function (g) { return { g: g, s: score[g] }; });
  }
  function cooldownHtml(w, b) {
    var st = C.cooldown(trained(w).map(function (x) { return x.g; }));
    if (!st.length) return '';
    return '<div class="tc-cool"><div class="tc-note">Slow breathing, long holds: this is where the stretching goes.</div><ul class="tc-steps">' +
      st.map(function (s) { return '<li><b>' + esc(s.name) + '</b> <span class="tc-dose">' + esc(s.dose) + '</span><div>' + esc(s.cue) + ' <i>(' + esc(GL[s.muscle] || s.muscle) + ')</i></div></li>'; }).join('') + '</ul></div>';
  }

  // ---- the side panel (desktop) / sheet (phone) ----
  function panelEl() {
    var wide = window.matchMedia('(min-width: 1100px)').matches, p = document.getElementById('trPanel');
    if (wide && p) return p;
    var s = document.getElementById('trSheet');
    if (!s) {
      s = document.createElement('div'); s.id = 'trSheet'; s.className = 'tc-sheet';
      s.innerHTML = '<div class="tc-sheetin"><button class="tc-close" aria-label="Close">&times;</button><div class="tc-sheetbody"></div></div>';
      document.body.appendChild(s);
      s.addEventListener('click', function (e) { if (e.target === s || e.target.classList.contains('tc-close')) s.classList.remove('on'); });
    }
    s.classList.add('on');
    return s.querySelector('.tc-sheetbody');
  }
  function chips(list, cls) { return list.map(function (g) { return '<span class="tc-mus ' + cls + '">' + esc(GL[g] || g) + '</span>'; }).join(''); }
  function rpeSay(r) { return r >= 9.5 ? 'nothing left in the tank' : r >= 9 ? 'one more rep possible' : r >= 8 ? 'two more reps possible' : r >= 7 ? 'three more reps possible' : 'comfortably short of failure'; }
  function movementHtml(w, b, it) {
    var e = entryFor(it), en = energyOf(b, it), t = e && C.tempo(e, repsOf(it)), v = C.videoUrl(e);
    var s0 = (it.sets || [])[0] || {};
    var h = '<div class="tc-kicker">' + esc(b.title) + '</div><h3 class="tc-name">' + esc(it.movement) + '</h3>';
    if (it.prescription) h += '<div class="tc-rx">' + esc(it.prescription) + (s0.rpe ? ' · RPE ' + esc(s0.rpe) + ': ' + rpeSay(Number(s0.rpe)) : '') + '</div>';
    if (it.load_source) h += '<div class="tc-src">' + esc(it.load_source) + '</div>';
    if (!e && !en) return h + '<p class="trk-note">No notes for this movement yet. Ask your trainer about it in Train → Trainer.</p>';
    if (e) {
      if (e.approx) h += '<p class="tc-note">Not in the library: these are the notes for its movement pattern.</p>';
      h += '<div class="tc-sec"><div class="tc-sub">What it works</div><div class="tc-muss">' + chips(e.primary || [], 'p') + chips(e.secondary || [], 's') + '</div><p>' + esc(e.does) + '</p></div>';
    }
    if (en) h += '<div class="tc-sec tc-en"><div class="tc-sub">' + esc(en.label) + ' · ' + esc(en.for) + '</div><p>' + esc(en.does) + '</p><p class="tc-feel">How it should feel: ' + esc(en.feel) + '</p></div>';
    if (e) {
      if (e.setup) h += '<div class="tc-sec"><div class="tc-sub">Set up</div><p>' + esc(e.setup) + '</p></div>';
      if (e.cues && e.cues.length) h += '<div class="tc-sec"><div class="tc-sub">Form</div><ul class="tc-cues">' + e.cues.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>';
      if (e.tension) h += '<div class="tc-sec tc-ten"><div class="tc-sub">Where to put the tension</div><p>' + esc(e.tension) + '</p></div>';
      if (t && it.log_as !== 'conditioning' && it.log_as !== 'engine') h += '<div class="tc-sec"><div class="tc-sub">Tempo <b class="tc-code">' + esc(t.code) + '</b></div><p>' + esc(t.say) + '</p></div>';
      if (e.mistake) h += '<div class="tc-sec"><div class="tc-sub">The usual mistake</div><p>' + esc(e.mistake) + '</p></div>';
      if (it.log_as === 'lift' || it.log_as === 'gymnastics') {
        var n = notes[noteKey(it)];
        h += '<div class="tc-sec"><div class="tc-sub">Working on</div><div class="tc-panelnote">' + (n ? '<p>' + esc(n).replace(/\n/g, '<br>') + '</p>' : '<p class="tc-note">Nothing yet. After you review a video, write down the one or two things to fix; they show on the card every time this lift comes up.</p>') +
          '<button class="trk-btn tc-pnedit" type="button">' + (n ? 'Edit notes' : 'Add notes') + '</button></div></div>';
      }
      if (filmable(e)) h += '<div class="tc-sec"><div class="tc-sub">Film it</div><p>Film a working set every few weeks and review it: what you feel and what the bar does are rarely the same. Run it past your AI or a coach, then put the fixes in your notes above.</p><ul class="tc-cues">' +
        FILM_TIPS.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
      if (v) h += '<a class="tc-video" href="' + esc(v) + '" target="_blank" rel="noopener">See it done well (' + esc(e.video.split(' ').slice(0, 2).join(' ')) + ' on YouTube)</a>';
    }
    var rest = it.rest_s || s0.rest_s;
    if (rest) h += '<p class="tc-note">Rest ' + mmss(rest) + ' between sets: the rest timer starts when you tick a set.</p>';
    return h;
  }
  function overviewHtml(w) {
    var tr = trained(w), sets = 0, en = [];
    (w.body.blocks || []).forEach(function (b) {
      b.items.forEach(function (it) { if (it.log_as === 'lift' || it.log_as === 'gymnastics') sets += (it.sets || []).length; });
      var x = blockNote(b) && energyOf(b, b.items[0]); if (x && en.indexOf(x) < 0) en.push(x);
    });
    var top = tr.slice(0, 4).map(function (x) { return x.g; }), rest = tr.slice(4, 9).map(function (x) { return x.g; });
    return '<div class="tc-kicker">Today’s session</div><h3 class="tc-name">' + esc(w.title) + '</h3>' +
      '<div class="tc-sec"><div class="tc-sub">What it trains</div><div class="tc-muss">' + chips(top, 'p') + chips(rest, 's') + '</div>' +
      '<p>' + (sets ? sets + ' working sets. ' : '') + 'Red: the main movers. Amber: helpers.</p></div>' +
      en.map(function (x) { return '<div class="tc-sec tc-en"><div class="tc-sub">' + esc(x.label) + ' · ' + esc(x.for) + '</div><p>' + esc(x.does) + '</p></div>'; }).join('') +
      '<p class="tc-note">Tap “Form, tension and what it trains” under any movement for its coaching.</p>';
  }
  var current = null;
  function select(w, bid, iid) {
    var b = w.body.blocks.find(function (x) { return x.id === bid; }), it = b && b.items.find(function (x) { return x.id === iid; });
    if (!it) return;
    current = { w: w.id, bid: bid, iid: iid };
    var el = panelEl(); el.innerHTML = movementHtml(w, b, it); el.scrollTop = 0;
    var pe = el.querySelector('.tc-pnedit');
    if (pe) pe.onclick = function () { editNote(it, el.querySelector('.tc-panelnote'), function () { current = null; select(w, bid, iid); }); };
    document.querySelectorAll('.wk-item.tc-sel').forEach(function (x) { x.classList.remove('tc-sel'); });
    var row = document.querySelector('.wk-card[data-wid="' + w.id + '"] .wk-block[data-bid="' + bid + '"] .wk-item[data-iid="' + iid + '"]'); if (row) row.classList.add('tc-sel');
  }
  function overview(w) {
    var p = document.getElementById('trPanel'); if (!p) return;
    if (current && w && current.w === w.id) return;
    current = null; p.innerHTML = w ? overviewHtml(w) : '<p class="trk-note">Plan your week and today’s session shows here: what it trains, and the coaching for each movement.</p>';
  }

  // ---- the guided warm-up, step by step ----
  var gw = null;
  function beep() { try { var A = window.AudioContext || window.webkitAudioContext, a = new A(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; o.connect(g); g.connect(a.destination); g.gain.setValueAtTime(0.18, a.currentTime); o.start(); o.stop(a.currentTime + 0.25); } catch (e) {} try { navigator.vibrate && navigator.vibrate(150); } catch (e) {} }
  function startWarmup(w) {
    var g = warmupOf(w), steps = g.steps.slice();
    if (g.ramp) steps.push({ name: 'Ramp-up: ' + g.ramp.movement, dose: g.ramp.sets.map(function (s) { return (s.load_lb ? s.load_lb + ' lb' : (s.pct ? s.pct + '%' : 'bar')) + ' × ' + s.reps; }).join(', '), cue: g.ramp.cue, seconds: 0 });
    var ov = document.getElementById('tcGuide');
    if (!ov) { ov = document.createElement('div'); ov.id = 'tcGuide'; ov.className = 'tc-guide'; document.body.appendChild(ov); }
    gw = { steps: steps, i: 0, left: steps[0].seconds || 0, paused: false, iv: null, ov: ov };
    ov.classList.add('on'); drawGuide(); tick();
  }
  function drawGuide() {
    var s = gw.steps[gw.i], n = gw.steps.length;
    gw.ov.innerHTML = '<div class="tc-gin"><div class="tc-gstep">Step ' + (gw.i + 1) + ' of ' + n + '</div><div class="tc-gname">' + esc(s.name) + '</div><div class="tc-gdose">' + esc(s.dose) + '</div>' +
      '<div class="tc-gclock">' + (s.seconds ? mmss(gw.left) : 'At your pace') + '</div><div class="tc-gcue">' + esc(s.cue) + '</div>' +
      (gw.i + 1 < n ? '<div class="tc-gnext">Next: ' + esc(gw.steps[gw.i + 1].name) + '</div>' : '') +
      '<div class="tc-gctl"><button class="trk-btn" data-g="prev"' + (gw.i ? '' : ' disabled') + '>Back</button>' + (s.seconds ? '<button class="trk-btn" data-g="pause">' + (gw.paused ? 'Resume' : 'Pause') + '</button>' : '') +
      '<button class="trk-btn primary" data-g="next">' + (gw.i + 1 < n ? 'Next' : 'Done') + '</button><button class="trk-btn" data-g="close">Close</button></div></div>';
    gw.ov.querySelectorAll('[data-g]').forEach(function (b) { b.onclick = function () { control(b.dataset.g); }; });
  }
  function go(i) { if (i >= gw.steps.length) return control('close'); gw.i = Math.max(0, i); gw.left = gw.steps[gw.i].seconds || 0; gw.paused = false; drawGuide(); }
  function control(a) {
    if (a === 'close') { clearInterval(gw.iv); gw.ov.classList.remove('on'); gw.ov.innerHTML = ''; gw = null; return; }
    if (a === 'next') go(gw.i + 1); else if (a === 'prev') go(gw.i - 1); else if (a === 'pause') { gw.paused = !gw.paused; drawGuide(); }
  }
  function tick() {
    clearInterval(gw.iv);
    gw.iv = setInterval(function () {
      if (!gw) return;
      var s = gw.steps[gw.i]; if (!s.seconds || gw.paused) return;
      gw.left--;
      var c = gw.ov.querySelector('.tc-gclock'); if (c) c.textContent = mmss(Math.max(0, gw.left));
      if (gw.left <= 0) { beep(); go(gw.i + 1); }
    }, 1000);
  }

  window.SelfHubTrain = { noteFromCard: noteFromCard, itemExtras: itemExtras, blockNote: blockNote, warmupHtml: warmupHtml, cooldownHtml: cooldownHtml, select: select, overview: overview, startWarmup: startWarmup };
})();
