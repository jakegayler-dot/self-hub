// The Nutrition tab (2026-10-20): Today · Plan · Recipes · Pantry · Groceries · Targets.
// Talks to /api/fitness/nutrition/*. No build step; same look as the rest of Self Hub.
(function () {
  var API = '/api/fitness/nutrition';
  var pane = document.getElementById('nutritionPane');
  if (!pane) return;
  var SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
  var state = { view: 'today', date: regina(), week: null, recipes: null, settings: null };

  function regina() { return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); }
  function addDays(d, n) { return new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function monday(d) { var w = new Date(d + 'T12:00:00Z').getUTCDay(); return addDays(d, -((w + 6) % 7)); }
  function fmt(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n0(v) { return v == null ? '–' : Math.round(v).toLocaleString(); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function toast(msg) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2000);
  }
  async function api(method, path, body) {
    var res = await fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }
  function fail(e) { toast(e.message || String(e)); }
  function bar(label, val, tgt, unit) {
    var pct = tgt ? Math.min(100, (val / tgt) * 100) : 0;
    var over = tgt && val > tgt * 1.05;
    return '<div class="trk-subbar-row"><div class="trk-progress-label"><span>' + label + '</span><span>' + n0(val) + ' / ' + n0(tgt) + ' ' + unit + '</span></div>' +
      '<div class="trk-progress-bar"><div class="trk-progress-fill" style="width:' + pct + '%;background:' + (over ? 'var(--red)' : 'var(--amber)') + '"></div></div></div>';
  }

  // ---- shell ----
  var VIEWS = [['today', 'Today'], ['plan', 'Plan'], ['recipes', 'Recipes'], ['pantry', 'Pantry'], ['groceries', 'Groceries'], ['targets', 'Targets']];
  pane.innerHTML = '<div class="nu-views">' + VIEWS.map(function (v) { return '<button class="wk-chipbtn" data-nv="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div><div id="nuBody"></div>';
  var body = document.getElementById('nuBody');
  pane.querySelectorAll('[data-nv]').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.nv); }); });
  function show(v) {
    state.view = v;
    pane.querySelectorAll('[data-nv]').forEach(function (b) { b.classList.toggle('on', b.dataset.nv === v); });
    body.innerHTML = '<p class="trk-note">Loading…</p>';
    ({ today: today, plan: plan, recipes: recipes, pantry: pantry, groceries: groceries, targets: targets })[v]().catch(function (e) { body.innerHTML = '<p class="trk-err" style="display:block">' + esc(e.message) + '</p>'; });
  }
  document.querySelectorAll('.trk-tab[data-tab="nutrition"]').forEach(function (t) { t.addEventListener('click', function () { show(state.view); }); });

  async function loadRecipes(force) {
    if (!state.recipes || force) state.recipes = (await api('GET', '/recipes')).recipes;
    return state.recipes;
  }

  // ---- a food picker ----
  // Type a food: his foods and the built-in list at once, then USDA (branded, as eaten) and Open Food Facts; anything
  // still missing, Sentinel looks up. Every food comes with its usual serving: + logs one serving in a tap; tapping
  // the name opens the amount (already set to one serving) to change it. Calls done({food, qty, unit, grams}).
  function servingText(f) {
    var s = f.serving;
    if (!s) return n0(f.per_100g.kcal) + ' kcal /100 g';
    return esc(s.name) + ' (' + Math.round(s.grams) + ' g) · ' + n0(f.per_100g.kcal * s.grams / 100) + ' kcal · ' + Math.round(f.per_100g.protein_g * s.grams / 100) + ' g P';
  }
  function foodPicker(el, opts) {
    opts = opts || {};
    el.innerHTML = '<div class="trk-row"><div class="trk-field" style="flex:2"><label>' + (opts.label || 'Food') + '</label><input type="search" class="nu-q" placeholder="eggs, double big mac, sardines…" autocomplete="off" enterkeyhint="search"></div></div>' +
      '<div class="nu-results"></div><div class="nu-online"></div><div class="nu-amount" style="display:none"></div>';
    var q = el.querySelector('.nu-q'), out = el.querySelector('.nu-results'), more = el.querySelector('.nu-online'), amt = el.querySelector('.nu-amount'), timer = null, seq = 0;
    function row(f, i, group) {
      return '<div class="nu-food" data-g="' + group + '" data-i="' + i + '"><button class="nu-pick"><span>' + esc(f.brand && f.display.indexOf(f.brand) < 0 ? f.brand + ' · ' + (f.display || f.name) : (f.display || f.name)) +
        (f.origin && f.origin !== 'usda' && f.source_label ? ' <em>' + esc(f.source_label) + '</em>' : '') + (group === 'o' ? ' <em>' + esc(f.source_label) + '</em>' : '') + '</span><small>' + servingText(f) + '</small></button>' +
        (f.serving ? '<button class="nu-plus" title="' + (opts.button || 'Add') + ' one serving">+</button>' : '') + '</div>';
    }
    function wire(list, group, box) {
      box.querySelectorAll('.nu-food[data-g="' + group + '"]').forEach(function (d) {
        var f = list[Number(d.dataset.i)];
        d.querySelector('.nu-pick').onclick = function () { open(f, group, false); };
        var plus = d.querySelector('.nu-plus'); if (plus) plus.onclick = function () { open(f, group, true); };
      });
    }
    function sentinelButton(text) {
      return '<button class="trk-btn nu-ask" style="margin-top:6px">Not here? Look up “' + esc(text) + '” with Sentinel</button>';
    }
    function wireAsk(text) {
      var b = more.querySelector('.nu-ask'); if (!b) return;
      b.onclick = async function () {
        b.disabled = true; b.textContent = 'Sentinel is finding the official numbers (10–30 s)…';
        try { var f = await api('POST', '/foods/lookup', { query: text }); toast('Found: ' + f.display + (f.note ? ' — ' + f.note : '')); show1(f); }
        catch (e) { b.disabled = false; b.textContent = 'Look it up with Sentinel'; fail(e); }
      };
    }
    function show1(f) { out.innerHTML = row(f, 0, 'l'); more.innerHTML = ''; wire([f], 'l', out); open(f, 'l', false); }
    async function search(text, my) {
      try {
        var r = await api('GET', '/foods/search?q=' + encodeURIComponent(text));
        if (my !== seq) return;
        out.innerHTML = r.foods.slice(0, 10).map(function (f, i) { return row(f, i, 'l'); }).join('');
        wire(r.foods, 'l', out);
        more.innerHTML = text.length >= 3 ? '<p class="trk-note">Checking USDA and Open Food Facts…</p>' : '';
        if (text.length < 3) return;
        var o = await api('GET', '/foods/search?online=1&limit=1&q=' + encodeURIComponent(text));
        if (my !== seq) return;
        var list = o.online || [];
        more.innerHTML = (list.length ? '<div class="nu-more">More foods</div>' + list.slice(0, 10).map(function (f, i) { return row(f, i, 'o'); }).join('') : '') +
          ((o.online_problems || []).length ? '<p class="trk-note">' + esc(o.online_problems.join('; ')) + '</p>' : '') + sentinelButton(text);
        wire(list, 'o', more); wireAsk(text);
      } catch (e) { fail(e); }
    }
    q.addEventListener('input', function () {
      clearTimeout(timer); amt.style.display = 'none';
      var text = q.value.trim();
      if (text.length < 2) { out.innerHTML = ''; more.innerHTML = ''; return; }
      var my = ++seq;
      timer = setTimeout(function () { search(text, my); }, 300);
    });
    // Online picks are saved as his foods first; built-in ones fetch their serving weights.
    async function open(f, group, quick) {
      try {
        var food = group === 'o' ? await api('POST', '/foods/import', { key: f.key }) : (!f.serving && f.source === 'usda' ? await api('GET', '/foods/' + encodeURIComponent(f.key)) : f);
        if (quick && food.serving) { out.innerHTML = ''; more.innerHTML = ''; q.value = ''; return opts.done({ food: food, qty: 1, unit: food.serving.name, grams: food.serving.grams, el: amt, quick: true }); }
        amount(food);
      } catch (e) { fail(e); }
    }
    function amount(f) {
      out.innerHTML = ''; more.innerHTML = ''; q.value = f.display;
      var units = f.portions.map(function (p) { return p.name; }).concat(['g', 'oz', 'lb']);
      var defUnit = f.serving ? f.serving.name : 'g';
      amt.style.display = 'block';
      amt.innerHTML = '<div class="trk-row"><div class="trk-field"><label>Amount</label><input type="number" class="nu-qty" step="any" min="0" value="' + (f.serving ? 1 : 100) + '"></div>' +
        '<div class="trk-field" style="flex:2"><label>Unit</label><select class="nu-unit">' + units.map(function (u) { return '<option' + (u === defUnit ? ' selected' : '') + '>' + esc(u) + '</option>'; }).join('') + '</select></div>' +
        (opts.extra || '') + '</div><div class="trk-note nu-prev"></div>' + (f.source_url ? '<p class="trk-note">Source: <a href="' + esc(f.source_url) + '" target="_blank" rel="noopener" style="color:var(--ink2)">' + esc(f.source_label || 'link') + '</a></p>' : '') +
        '<button class="trk-btn primary nu-go">' + (opts.button || 'Add') + '</button>';
      var qty = amt.querySelector('.nu-qty'), unit = amt.querySelector('.nu-unit'), prev = amt.querySelector('.nu-prev');
      function grams() {
        var n = Number(qty.value), u = unit.value;
        var g = { g: 1, oz: 28.35, lb: 453.6 }[u];
        if (!g) { var p = f.portions.find(function (x) { return x.name === u; }); g = p ? p.grams : 0; }
        return n * g;
      }
      function preview() {
        var g = grams(), p = f.per_100g, k = g / 100;
        prev.textContent = Math.round(g) + ' g → ' + n0(p.kcal * k) + ' kcal · ' + (p.protein_g * k).toFixed(1) + ' g protein · ' + (p.carbs_g * k).toFixed(1) + ' g carbs · ' + (p.fat_g * k).toFixed(1) + ' g fat';
      }
      qty.addEventListener('input', preview); unit.addEventListener('change', preview); preview();
      amt.querySelector('.nu-go').addEventListener('click', function () {
        if (!(grams() > 0)) return toast('Give an amount');
        opts.done({ food: f, qty: Number(qty.value), unit: unit.value, grams: Math.round(grams() * 10) / 10, el: amt });
      });
    }
  }

  // ---- Today ----
  async function today() {
    var d = await api('GET', '/day?date=' + state.date);
    var recs = await loadRecipes();
    var t = d.targets, tot = d.totals;
    var bySlot = {}; SLOTS.forEach(function (s) { bySlot[s] = []; }); d.entries.forEach(function (e) { (bySlot[e.slot] || (bySlot[e.slot] = [])).push(e); });
    body.innerHTML =
      '<div class="tr-head"><div><button class="wk-chipbtn" id="nuPrev">‹</button> <b>' + fmt(d.date) + '</b> <button class="wk-chipbtn" id="nuNext">›</button>' +
      (d.date !== regina() ? ' <button class="wk-chipbtn" id="nuToday">Today</button>' : '') + '</div><span class="wk-chip ' + (t.day_type === 'training' ? 'amber' : '') + '">' + t.day_type + ' day</span></div>' +
      '<div class="trk-grid"><div class="trk-card"><div class="lbl">Calories left</div><div class="val ' + (d.remaining.kcal < 0 ? 'red' : 'amber') + '">' + n0(d.remaining.kcal) + '</div></div>' +
      '<div class="trk-card"><div class="lbl">Protein left</div><div class="val ' + (d.remaining.protein_g <= 0 ? 'green' : '') + '">' + n0(d.remaining.protein_g) + ' g</div></div></div>' +
      bar('Calories', tot.kcal, t.kcal, 'kcal') + bar('Protein', tot.protein_g, t.protein_g, 'g') + bar('Carbs', tot.carbs_g, t.carbs_g, 'g') + bar('Fat', tot.fat_g, t.fat_g, 'g') +
      '<p class="trk-note" style="margin-top:8px">' + esc(d.week.rationale) + '</p>' +
      (d.plan.length ? '<div class="trk-sec" style="margin-top:14px"><h2>Planned today</h2>' + d.plan.map(function (m) {
        return '<div class="nu-line"><span><b>' + cap(m.slot) + '</b> ' + esc(m.name) + ' ×' + m.servings + ' <small>' + n0(m.kcal) + ' kcal · ' + n0(m.protein_g) + ' g P</small></span>' +
          (m.eaten ? '<span class="wk-chip green">eaten</span>' : '<button class="trk-btn" data-ate="' + m.id + '">Ate it</button>') + '</div>';
      }).join('') + '</div>' : '') +
      '<div class="trk-sec" style="margin-top:14px"><h2>Log</h2><div class="nu-views" id="nuLogMode"><button class="wk-chipbtn on" data-m="food">Food</button><button class="wk-chipbtn" data-m="recipe">Recipe / meal</button><button class="wk-chipbtn" data-m="quick">Quick add</button></div>' +
      '<div class="trk-row"><div class="trk-field"><label>Meal</label><select id="nuSlot">' + SLOTS.map(function (s) { return '<option value="' + s + '"' + (s === guessSlot() ? ' selected' : '') + '>' + cap(s) + '</option>'; }).join('') + '</select></div></div><div id="nuLog"></div></div>' +
      '<div class="trk-sec">' + SLOTS.map(function (s) {
        var list = bySlot[s];
        var sum = list.reduce(function (a, e) { return a + e.kcal; }, 0);
        return '<h2 style="display:flex;justify-content:space-between">' + cap(s) + '<span>' + (list.length ? n0(sum) + ' kcal' : '') + (list.some(function (e) { return e.food_key || e.recipe_id; }) ? ' <button class="wk-chipbtn" data-save="' + s + '">Save as meal</button>' : '') + '</span></h2>' +
          (list.length ? list.map(function (e) {
            return '<div class="nu-line"><span>' + esc(e.name) + (e.amount ? ' <small>' + esc(e.amount) + '</small>' : '') + '<br><small>' + n0(e.kcal) + ' kcal · ' + e.protein_g + ' P · ' + e.carbs_g + ' C · ' + e.fat_g + ' F</small></span><button class="trk-del" data-del="' + e.id + '">✕</button></div>';
          }).join('') : '<p class="trk-note">Nothing yet.</p>');
      }).join('') + '</div>';
    document.getElementById('nuPrev').onclick = function () { state.date = addDays(state.date, -1); show('today'); };
    document.getElementById('nuNext').onclick = function () { state.date = addDays(state.date, 1); show('today'); };
    var tb = document.getElementById('nuToday'); if (tb) tb.onclick = function () { state.date = regina(); show('today'); };
    body.querySelectorAll('[data-ate]').forEach(function (b) { b.onclick = async function () { try { await api('POST', '/diary', { plan_id: Number(b.dataset.ate) }); toast('Logged'); show('today'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = async function () { try { await api('DELETE', '/diary/' + b.dataset.del); show('today'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-save]').forEach(function (b) {
      b.onclick = async function () {
        var name = prompt('Name this meal', 'My ' + b.dataset.save); if (!name) return;
        try { await api('POST', '/meals/from-day', { date: state.date, slot: b.dataset.save, name: name }); await loadRecipes(true); toast('Saved: ' + name); } catch (e) { fail(e); }
      };
    });
    var logEl = document.getElementById('nuLog');
    function slot() { return document.getElementById('nuSlot').value; }
    function mode(m) {
      document.querySelectorAll('#nuLogMode [data-m]').forEach(function (b) { b.classList.toggle('on', b.dataset.m === m); });
      if (m === 'food') foodPicker(logEl, { button: 'Log it', done: async function (x) { try { await api('POST', '/diary', { date: state.date, slot: slot(), food_key: x.food.key, qty: x.qty, unit: x.unit }); toast('Logged'); show('today'); } catch (e) { fail(e); } } });
      if (m === 'recipe') {
        logEl.innerHTML = '<div class="trk-row"><div class="trk-field" style="flex:2"><label>Recipe or meal</label><select id="nuRec">' + recs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + ' — ' + n0(r.per_serving.kcal) + ' kcal, ' + n0(r.per_serving.protein_g) + ' g P a serving</option>'; }).join('') + '</select></div>' +
          '<div class="trk-field"><label>Servings</label><input type="number" id="nuServ" value="1" step="0.25" min="0.25"></div></div><button class="trk-btn primary" id="nuRecGo">Log it</button>';
        document.getElementById('nuRecGo').onclick = async function () { try { await api('POST', '/diary', { date: state.date, slot: slot(), recipe_id: Number(document.getElementById('nuRec').value), servings: Number(document.getElementById('nuServ').value) }); toast('Logged'); show('today'); } catch (e) { fail(e); } };
      }
      if (m === 'quick') {
        logEl.innerHTML = '<div class="trk-row"><div class="trk-field" style="flex:2"><label>What</label><input id="nuQn" placeholder="e.g. restaurant burger"></div><div class="trk-field"><label>kcal</label><input type="number" id="nuQk"></div></div>' +
          '<div class="trk-row"><div class="trk-field"><label>Protein g</label><input type="number" id="nuQp"></div><div class="trk-field"><label>Carbs g</label><input type="number" id="nuQc"></div><div class="trk-field"><label>Fat g</label><input type="number" id="nuQf"></div></div><button class="trk-btn primary" id="nuQGo">Log it</button>';
        document.getElementById('nuQGo').onclick = async function () {
          try { await api('POST', '/diary', { date: state.date, slot: slot(), name: document.getElementById('nuQn').value, kcal: Number(document.getElementById('nuQk').value), protein_g: Number(document.getElementById('nuQp').value) || 0, carbs_g: Number(document.getElementById('nuQc').value) || 0, fat_g: Number(document.getElementById('nuQf').value) || 0 }); toast('Logged'); show('today'); } catch (e) { fail(e); }
        };
      }
    }
    document.querySelectorAll('#nuLogMode [data-m]').forEach(function (b) { b.onclick = function () { mode(b.dataset.m); }; });
    mode('food');
  }
  function guessSlot() { var h = new Date(Date.now() - 6 * 3600e3).getUTCHours(); return h < 10 ? 'breakfast' : h < 14 ? 'lunch' : h < 17 ? 'snack' : 'dinner'; }

  // ---- Plan ----
  var poll = null;
  async function waitJob(id, label, then) {
    clearInterval(poll);
    var el = document.getElementById('nuBusy'); if (el) el.textContent = label;
    poll = setInterval(async function () {
      try {
        var j = await api('GET', '/coach/jobs/' + id);
        if (j.status === 'running') return;
        clearInterval(poll);
        if (j.status === 'failed') { toast(j.error || 'It failed'); if (el) el.textContent = j.error || 'It failed'; return; }
        then(j);
      } catch (e) { clearInterval(poll); fail(e); }
    }, 4000);
  }
  async function plan() {
    state.week = state.week || monday(regina());
    var p = await api('GET', '/plan?week=' + state.week);
    var recs = await loadRecipes();
    body.innerHTML =
      '<div class="tr-head"><div><button class="wk-chipbtn" id="nuWPrev">‹</button> <b>Week of ' + fmt(p.week_start) + '</b> <button class="wk-chipbtn" id="nuWNext">›</button></div></div>' +
      '<div class="trk-row"><button class="trk-btn" id="nuRules">Plan from my recipes</button><button class="trk-btn primary" id="nuAsk">Ask the nutritionist</button></div>' +
      '<div class="trk-field" style="margin-bottom:8px"><input id="nuNote" placeholder="Note for the nutritionist (e.g. harvesting Mon–Wed, in town Thursday)"></div><div class="wk-busy" id="nuBusy"></div>' +
      (p.summary ? '<div class="wk-refined"><b>' + (p.source === 'nutritionist' ? 'Nutritionist' : 'Planner') + ':</b> ' + esc(p.summary) + '</div>' : '') +
      (p.prep && p.prep.length ? '<details class="wk-why" open><summary>Prep</summary><ul>' + p.prep.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' : '') +
      (p.notes && p.notes.length ? '<details class="wk-why"><summary>Notes</summary><ul>' + p.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' : '') +
      p.days.map(function (d) {
        var off = d.planned_kcal - d.kcal;
        return '<div class="wk-card' + (d.date === regina() ? ' today' : '') + '"><div class="wk-head" style="cursor:default"><div><div class="d">' + fmt(d.date) + ' · ' + d.day_type + '</div>' +
          '<div class="t">' + n0(d.planned_kcal) + ' / ' + n0(d.kcal) + ' kcal · ' + n0(d.planned_protein_g) + ' / ' + d.protein_g + ' g protein</div></div>' +
          '<span class="wk-chip ' + (Math.abs(off) <= d.kcal * 0.05 ? 'green' : 'amber') + '">' + (off >= 0 ? '+' : '') + n0(off) + '</span></div><div style="padding:0 14px 12px">' +
          d.meals.map(function (m) {
            return '<div class="nu-line"><span><b>' + cap(m.slot) + '</b> ' + esc(m.recipe.name) + (m.recipe.portable ? ' <span class="wk-chip">packs</span>' : '') + '<br><small>' + n0(m.kcal) + ' kcal · ' + n0(m.protein_g) + ' g P</small></span>' +
              (m.eaten ? '<span class="wk-chip green">eaten</span>' : '<span><input type="number" class="nu-serv" data-id="' + m.id + '" value="' + m.servings + '" step="0.25" min="0.25" style="width:60px"> <button class="trk-del" data-pdel="' + m.id + '">✕</button></span>') + '</div>';
          }).join('') +
          '<div class="trk-row" style="margin-top:6px"><select class="nu-addslot" data-date="' + d.date + '">' + SLOTS.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select>' +
          '<select class="nu-addrec" data-date="' + d.date + '"><option value="">+ add a meal…</option>' + recs.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + '</option>'; }).join('') + '</select></div></div></div>';
      }).join('');
    document.getElementById('nuWPrev').onclick = function () { state.week = addDays(state.week, -7); show('plan'); };
    document.getElementById('nuWNext').onclick = function () { state.week = addDays(state.week, 7); show('plan'); };
    document.getElementById('nuRules').onclick = async function () { try { await api('POST', '/plan/generate', { week_start: state.week }); toast('Planned; groceries updated'); show('plan'); } catch (e) { fail(e); } };
    document.getElementById('nuAsk').onclick = async function () {
      try {
        var j = await api('POST', '/coach', { task: 'week', week_start: state.week, note: document.getElementById('nuNote').value || undefined });
        waitJob(j.job, 'The nutritionist is planning the week (a minute or two)…', function () { toast('Week planned; groceries updated'); state.recipes = null; show('plan'); });
      } catch (e) { fail(e); }
    };
    body.querySelectorAll('.nu-serv').forEach(function (i) { i.onchange = async function () { try { await api('PUT', '/plan/' + i.dataset.id, { servings: Number(i.value) }); show('plan'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-pdel]').forEach(function (b) { b.onclick = async function () { try { await api('DELETE', '/plan/' + b.dataset.pdel); show('plan'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('.nu-addrec').forEach(function (s) {
      s.onchange = async function () {
        if (!s.value) return;
        var slot = body.querySelector('.nu-addslot[data-date="' + s.dataset.date + '"]').value;
        try { await api('POST', '/plan', { date: s.dataset.date, slot: slot, recipe_id: Number(s.value), servings: 1 }); show('plan'); } catch (e) { fail(e); }
      };
    });
  }

  // ---- Recipes ----
  async function recipes() {
    var list = await loadRecipes(true);
    var groups = { breakfast: 'Breakfasts', main: 'Mains (lunch and dinner)', snack: 'Snacks' };
    body.innerHTML =
      '<div class="trk-row"><button class="trk-btn primary" id="nuNewRec">New recipe</button><button class="trk-btn" id="nuNewFood">New food (from a label)</button></div>' +
      '<div class="trk-row"><div class="trk-field" style="flex:3"><input id="nuAskRec" placeholder="Ask the nutritionist: e.g. a packable oyster lunch, no dairy"></div><button class="trk-btn" id="nuAskRecGo">Ask</button></div><div class="wk-busy" id="nuBusy"></div>' +
      '<div id="nuEditor"></div>' +
      Object.keys(groups).map(function (g) {
        var rs = list.filter(function (r) { return r.slot === g; });
        return '<div class="trk-sec"><h2>' + groups[g] + '</h2>' + (rs.length ? rs.map(function (r) {
          return '<details class="ldg"><summary>' + esc(r.name) + (r.kind === 'meal' ? ' · saved meal' : '') + ' — ' + n0(r.per_serving.kcal) + ' kcal · ' + n0(r.per_serving.protein_g) + ' g P a serving</summary>' +
            '<p class="trk-note">' + r.servings + ' serving' + (r.servings === 1 ? '' : 's') + (r.prep_minutes ? ' · ' + r.prep_minutes + ' min' : '') + (r.portable ? ' · packs for the truck' : '') + (r.max_per_week ? ' · at most ' + r.max_per_week + '× a week' : '') + (r.source === 'nutritionist' ? ' · by the nutritionist' : '') + '</p>' +
            '<ul class="nu-ings">' + r.ingredients.map(function (i) { return '<li>' + esc(i.label || i.food) + ' <small>' + Math.round(i.grams) + ' g' + (i.label ? ' · ' + esc(i.food) : '') + '</small></li>'; }).join('') + '</ul>' +
            (r.instructions ? '<p class="wk-bnote">' + esc(r.instructions) + '</p>' : '') + (r.notes ? '<p class="trk-note">' + esc(r.notes) + '</p>' : '') +
            '<p class="trk-note">Per serving: ' + n0(r.per_serving.kcal) + ' kcal · ' + r.per_serving.protein_g + ' P · ' + r.per_serving.carbs_g + ' C · ' + r.per_serving.fat_g + ' F · ' + (r.per_serving.fiber_g == null ? '–' : r.per_serving.fiber_g) + ' g fibre</p>' +
            '<div class="trk-row"><button class="trk-btn" data-edit="' + r.id + '">Edit</button><button class="trk-btn" data-rdel="' + r.id + '">Delete</button></div></details>';
        }).join('') : '<p class="trk-note">None yet.</p>') + '</div>';
      }).join('');
    document.getElementById('nuNewRec').onclick = function () { editor(null); };
    document.getElementById('nuNewFood').onclick = newFood;
    document.getElementById('nuAskRecGo').onclick = async function () {
      var q = document.getElementById('nuAskRec').value.trim(); if (!q) return;
      try { var j = await api('POST', '/coach', { task: 'recipe', request: q }); waitJob(j.job, 'The nutritionist is writing it…', function (r) { toast('Saved: ' + r.result.recipe.name); show('recipes'); }); } catch (e) { fail(e); }
    };
    body.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { editor(list.find(function (r) { return r.id === Number(b.dataset.edit); })); }; });
    body.querySelectorAll('[data-rdel]').forEach(function (b) { b.onclick = async function () { if (!confirm('Delete this recipe?')) return; try { await api('DELETE', '/recipes/' + b.dataset.rdel); show('recipes'); } catch (e) { fail(e); } }; });
  }
  function editor(r) {
    var ed = document.getElementById('nuEditor');
    var ings = r ? r.ingredients.map(function (i) { return { food_key: i.food_key, grams: i.grams, label: i.label || '', food: i.food }; }) : [];
    ed.innerHTML = '<div class="ldg"><b>' + (r ? 'Edit ' + esc(r.name) : 'New recipe') + '</b>' +
      '<div class="trk-row" style="margin-top:8px"><div class="trk-field" style="flex:2"><label>Name</label><input id="reName" value="' + esc(r ? r.name : '') + '"></div>' +
      '<div class="trk-field"><label>Slot</label><select id="reSlot">' + ['breakfast', 'main', 'snack'].map(function (s) { return '<option' + (r && r.slot === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
      '<div class="trk-field"><label>Servings</label><input type="number" id="reServ" step="0.5" min="0.5" value="' + (r ? r.servings : 1) + '"></div></div>' +
      '<div class="trk-row"><div class="trk-field"><label>Prep min</label><input type="number" id="rePrep" value="' + (r && r.prep_minutes || '') + '"></div><div class="trk-field"><label>At most × a week</label><input type="number" id="reMax" value="' + (r && r.max_per_week || '') + '"></div>' +
      '<div class="trk-field"><label><input type="checkbox" id="rePort"' + (r && r.portable ? ' checked' : '') + '> Packs for the truck</label></div></div>' +
      '<div id="reIngs"></div><div id="rePick"></div>' +
      '<div class="trk-field"><label>How to make it</label><textarea id="reInst" rows="3">' + esc(r ? r.instructions : '') + '</textarea></div>' +
      '<div class="trk-row" style="margin-top:8px"><button class="trk-btn primary" id="reSave">Save</button><button class="trk-btn" id="reCancel">Cancel</button></div></div>';
    function drawIngs() {
      document.getElementById('reIngs').innerHTML = '<ul class="nu-ings">' + ings.map(function (i, n) { return '<li>' + esc(i.label || i.food) + ' <small>' + Math.round(i.grams) + ' g</small> <button class="trk-del" data-x="' + n + '">✕</button></li>'; }).join('') + '</ul>';
      document.querySelectorAll('#reIngs [data-x]').forEach(function (b) { b.onclick = function () { ings.splice(Number(b.dataset.x), 1); drawIngs(); }; });
    }
    drawIngs();
    foodPicker(document.getElementById('rePick'), { label: 'Add an ingredient (amount for the whole recipe)', button: 'Add ingredient', done: function (x) { ings.push({ food_key: x.food.key, grams: x.grams, food: x.food.display }); drawIngs(); x.el.style.display = 'none'; document.querySelector('#rePick .nu-q').value = ''; } });
    document.getElementById('reCancel').onclick = function () { ed.innerHTML = ''; };
    document.getElementById('reSave').onclick = async function () {
      var b = { name: document.getElementById('reName').value, slot: document.getElementById('reSlot').value, servings: Number(document.getElementById('reServ').value),
        prep_minutes: document.getElementById('rePrep').value || null, max_per_week: document.getElementById('reMax').value || null, portable: document.getElementById('rePort').checked,
        instructions: document.getElementById('reInst').value, ingredients: ings.map(function (i) { return { food_key: i.food_key, grams: i.grams, label: i.label || undefined }; }) };
      try { if (r) await api('PUT', '/recipes/' + r.id, b); else await api('POST', '/recipes', b); toast('Saved'); show('recipes'); } catch (e) { fail(e); }
    };
    ed.scrollIntoView({ behavior: 'smooth' });
  }
  function newFood() {
    var ed = document.getElementById('nuEditor');
    ed.innerHTML = '<div class="ldg"><b>New food</b><p class="trk-note">From the label: the numbers for one serving of the size you give.</p>' +
      '<div class="trk-row"><div class="trk-field" style="flex:2"><label>Name</label><input id="nfName"></div><div class="trk-field"><label>Brand</label><input id="nfBrand"></div></div>' +
      '<div class="trk-row"><div class="trk-field"><label>Serving (g)</label><input type="number" id="nfPer" value="100"></div><div class="trk-field"><label>Serving name</label><input id="nfSn" placeholder="e.g. piece"></div></div>' +
      '<div class="trk-row">' + [['kcal', 'kcal'], ['protein_g', 'Protein g'], ['carbs_g', 'Carbs g'], ['fat_g', 'Fat g'], ['fiber_g', 'Fibre g'], ['sodium_mg', 'Sodium mg']].map(function (f) { return '<div class="trk-field"><label>' + f[1] + '</label><input type="number" step="any" id="nf_' + f[0] + '"></div>'; }).join('') + '</div>' +
      '<div class="trk-row"><button class="trk-btn primary" id="nfSave">Save</button><button class="trk-btn" id="nfCancel">Cancel</button></div></div>';
    document.getElementById('nfCancel').onclick = function () { ed.innerHTML = ''; };
    document.getElementById('nfSave').onclick = async function () {
      var v = function (id) { var x = document.getElementById(id).value; return x === '' ? undefined : Number(x); };
      try {
        await api('POST', '/foods', { name: document.getElementById('nfName').value, brand: document.getElementById('nfBrand').value || undefined, per_grams: v('nfPer'), serving_name: document.getElementById('nfSn').value || undefined,
          kcal: v('nf_kcal'), protein_g: v('nf_protein_g'), carbs_g: v('nf_carbs_g'), fat_g: v('nf_fat_g'), fiber_g: v('nf_fiber_g'), sodium_mg: v('nf_sodium_mg') });
        toast('Saved: it\'s in the food search now'); ed.innerHTML = '';
      } catch (e) { fail(e); }
    };
  }

  // ---- Pantry ----
  async function pantry() {
    var p = (await api('GET', '/pantry')).items;
    body.innerHTML = '<p class="trk-note">What\'s in the house. Logging a meal takes from it; ticking groceries off (here or in Sentinel) adds to it. The plan and the grocery list use it first.</p>' +
      '<div id="paPick"></div>' +
      '<div class="trk-sec" style="margin-top:12px"><h2>On hand</h2>' + (p.length ? p.map(function (x) {
        return '<div class="nu-line"><span>' + esc(x.name) + ' <small>' + esc(x.amount) + ' · ' + esc(x.aisle) + '</small></span><span><input type="number" class="nu-pset" data-key="' + esc(x.food_key) + '" value="' + Math.round(x.grams) + '" style="width:80px"> g <button class="trk-del" data-padel="' + x.id + '">✕</button></span></div>';
      }).join('') : '<p class="trk-note">Empty. Add what you have, or tick groceries off as you buy them.</p>') + '</div>';
    foodPicker(document.getElementById('paPick'), { label: 'Add to the pantry', button: 'Add', done: async function (x) { try { await api('POST', '/pantry', { food_key: x.food.key, qty: x.qty, unit: x.unit }); toast('Added'); show('pantry'); } catch (e) { fail(e); } } });
    body.querySelectorAll('.nu-pset').forEach(function (i) { i.onchange = async function () { try { await api('POST', '/pantry', { food_key: i.dataset.key, grams: Number(i.value), mode: 'set' }); show('pantry'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-padel]').forEach(function (b) { b.onclick = async function () { try { await api('DELETE', '/pantry/' + b.dataset.padel); show('pantry'); } catch (e) { fail(e); } }; });
  }

  // ---- Groceries ----
  async function groceries() {
    var g = await api('GET', '/groceries');
    var aisles = {}; g.open.forEach(function (x) { (aisles[x.aisle] = aisles[x.aisle] || []).push(x); });
    body.innerHTML = '<p class="trk-note">This list is on Sentinel\'s shopping list too (Personal): tick things off in either place. Bought items go into the pantry.</p>' +
      '<div class="trk-row"><button class="trk-btn" id="grRebuild">Rebuild from this week\'s plan</button></div>' +
      '<div class="trk-row"><div class="trk-field" style="flex:2"><input id="grName" placeholder="Add an item"></div><div class="trk-field"><input id="grQty" placeholder="How much"></div><button class="trk-btn primary" id="grAdd">Add</button></div>' +
      (g.open.length ? Object.keys(aisles).sort().map(function (a) {
        return '<div class="trk-sec"><h2>' + esc(a) + '</h2>' + aisles[a].map(function (x) {
          return '<label class="nu-line nu-check"><span><input type="checkbox" data-buy="' + x.id + '"> ' + esc(x.name) + ' <small>' + esc(x.quantity || '') + (x.source === 'plan' ? '' : ' · ' + x.source) + '</small></span><button class="trk-del" data-gdel="' + x.id + '">✕</button></label>';
        }).join('') + '</div>';
      }).join('') : '<p class="trk-note">Nothing to buy. Plan the week and the list fills itself.</p>') +
      (g.bought.length ? '<div class="trk-sec"><h2 style="display:flex;justify-content:space-between">Bought <button class="wk-chipbtn" id="grClear">Clear</button></h2>' + g.bought.map(function (x) {
        return '<label class="nu-line nu-check" style="opacity:.6"><span><input type="checkbox" checked data-unbuy="' + x.id + '"> ' + esc(x.name) + ' <small>' + esc(x.quantity || '') + '</small></span></label>';
      }).join('') + '</div>' : '');
    document.getElementById('grRebuild').onclick = async function () { try { await api('POST', '/groceries/from-plan', { week_start: monday(regina()) }); show('groceries'); } catch (e) { fail(e); } };
    document.getElementById('grAdd').onclick = async function () {
      var n = document.getElementById('grName').value.trim(); if (!n) return;
      try { await api('POST', '/groceries', { name: n, quantity: document.getElementById('grQty').value || undefined }); show('groceries'); } catch (e) { fail(e); }
    };
    body.querySelectorAll('[data-buy]').forEach(function (c) { c.onchange = async function () { try { await api('PATCH', '/groceries/' + c.dataset.buy, { status: 'bought' }); show('groceries'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-unbuy]').forEach(function (c) { c.onchange = async function () { try { await api('PATCH', '/groceries/' + c.dataset.unbuy, { status: 'open' }); show('groceries'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-gdel]').forEach(function (b) { b.onclick = async function (ev) { ev.preventDefault(); try { await api('DELETE', '/groceries/' + b.dataset.gdel); show('groceries'); } catch (e) { fail(e); } }; });
    var cl = document.getElementById('grClear'); if (cl) cl.onclick = async function () { try { await api('POST', '/groceries/clear-bought'); show('groceries'); } catch (e) { fail(e); } };
  }

  // ---- Targets ----
  async function targets() {
    var t = await api('GET', '/targets');
    var latest = await api('GET', '/coach/latest?task=review');
    var s = t.settings, w = t.week;
    var rv = latest.latest && latest.latest.result && latest.latest.result.review;
    if (rv && !(rv.target_advice && typeof rv.target_advice === 'object')) rv = null;
    body.innerHTML =
      '<div class="trk-grid"><div class="trk-card"><div class="lbl">This week</div><div class="val amber">' + n0(w.base_kcal) + '</div><div class="trk-note">kcal a day on average</div></div>' +
      '<div class="trk-card"><div class="lbl">Protein</div><div class="val">' + w.protein_g + ' g</div></div>' +
      '<div class="trk-card"><div class="lbl">Burn (est.)</div><div class="val">' + n0(w.tdee_kcal) + '</div></div>' +
      '<div class="trk-card"><div class="lbl">Trend</div><div class="val">' + (w.rate_lb_wk == null ? '–' : (w.rate_lb_wk > 0 ? '+' : '') + w.rate_lb_wk) + '</div><div class="trk-note">lb / week</div></div></div>' +
      '<div class="wk-refined"><b>' + cap(w.decision) + ':</b> ' + esc(w.rationale) + '</div>' +
      '<div class="trk-log" style="margin-top:12px"><table><thead><tr><th>Day</th><th>Type</th><th>kcal</th><th>Protein</th><th>Carbs</th><th>Fat</th></tr></thead><tbody>' +
      t.days.map(function (d) { return '<tr><td>' + fmt(d.date) + '</td><td>' + d.day_type + '</td><td>' + n0(d.kcal) + '</td><td>' + d.protein_g + '</td><td>' + d.carbs_g + '</td><td>' + d.fat_g + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<p class="trk-note">Training days are the days with a session planned on the Train page; they get more carbohydrate, rest days less, and the week averages the target. Each Monday the target is checked against what you logged and your weight trend (21 days; ≈3,500 kcal a lb) to keep the gain between ' + s.rate_min_lb + ' and ' + s.rate_max_lb + ' lb a week, moving at most 150 kcal a week.</p>' +
      '<div class="trk-row"><button class="trk-btn" id="tgRecheck">Re-check this week</button><button class="trk-btn primary" id="tgReview">Nutritionist review</button></div><div class="wk-busy" id="nuBusy"></div>' +
      (rv ? '<div class="cw" style="margin-top:12px"><div class="box"><b>Nutritionist review · ' + fmt(latest.latest.finished_at.slice(0, 10)) + '</b>' + esc(rv.summary) + '<ul><li>' + esc(rv.adherence) + '</li>' + (rv.weight_trend ? '<li>' + esc(rv.weight_trend) + '</li>' : '') + '</ul></div>' +
        '<div class="box"><b>Advice</b>' + n0(rv.target_advice.kcal) + ' kcal, ' + rv.target_advice.protein_g + ' g protein: ' + esc(rv.target_advice.why) + '<br><button class="trk-btn" id="tgApply" style="margin-top:8px">Use this</button></div>' +
        (Array.isArray(rv.gaps) && rv.gaps.length ? '<div class="box"><b>Gaps</b>' + rv.gaps.map(function (g, i) { return '<div class="wp"><span class="n">' + (i + 1) + '</span><div><div class="a">' + esc(g.area) + '</div><div class="e">' + esc(g.evidence) + '</div><div class="p">' + esc(g.fix) + '</div></div></div>'; }).join('') + '</div>' : '') +
        (rv.next_week ? '<div class="box"><b>Next week</b>' + esc(rv.next_week) + '</div>' : '') + '</div>' : '') +
      '<details class="ldg" style="margin-top:12px"><summary>Settings</summary>' +
      '<div class="trk-row" style="margin-top:8px">' + [['base_kcal', 'kcal / day (set by hand)', w.base_kcal], ['protein_g', 'Protein g', s.protein_g], ['training_extra_kcal', 'Training vs rest gap kcal', s.training_extra_kcal], ['fat_pct', 'Fat %', s.fat_pct], ['rate_min_lb', 'Gain min lb/wk', s.rate_min_lb], ['rate_max_lb', 'Gain max lb/wk', s.rate_max_lb]].map(function (f) {
        return '<div class="trk-field"><label>' + f[1] + '</label><input type="number" step="any" data-set="' + f[0] + '" value="' + f[2] + '"></div>';
      }).join('') + '</div>' +
      '<div class="trk-row"><label class="trk-note"><input type="checkbox" id="tgAdaptive"' + (s.adaptive ? ' checked' : '') + '> Adjust weekly</label>' +
      SLOTS.map(function (x) { return '<label class="trk-note"><input type="checkbox" data-slot="' + x + '"' + (s.slots.indexOf(x) >= 0 ? ' checked' : '') + '> ' + x + '</label>'; }).join(' ') + '</div>' +
      '<button class="trk-btn primary" id="tgSave">Save</button></details>' +
      (t.history.length > 1 ? '<div class="trk-sec" style="margin-top:12px"><h2>History</h2><div class="trk-log"><table><thead><tr><th>Week</th><th>kcal</th><th>Decision</th><th>Trend</th></tr></thead><tbody>' +
        t.history.map(function (h) { return '<tr><td>' + fmt(h.week_start) + '</td><td>' + n0(h.base_kcal) + '</td><td title="' + esc(h.rationale) + '">' + h.decision + '</td><td>' + (h.rate_lb_wk == null ? '–' : h.rate_lb_wk) + '</td></tr>'; }).join('') + '</tbody></table></div></div>' : '');
    document.getElementById('tgRecheck').onclick = async function () { try { await api('POST', '/targets/recheck'); show('targets'); } catch (e) { fail(e); } };
    document.getElementById('tgReview').onclick = async function () {
      try { var j = await api('POST', '/coach', { task: 'review' }); waitJob(j.job, 'The nutritionist is reviewing the last two weeks…', function () { show('targets'); }); } catch (e) { fail(e); }
    };
    var ap = document.getElementById('tgApply');
    if (ap) ap.onclick = async function () { try { await api('PUT', '/settings', { base_kcal: rv.target_advice.kcal, protein_g: rv.target_advice.protein_g }); toast('Targets updated'); show('targets'); } catch (e) { fail(e); } };
    document.getElementById('tgSave').onclick = async function () {
      var b = { adaptive: document.getElementById('tgAdaptive').checked, slots: Array.prototype.filter.call(body.querySelectorAll('[data-slot]'), function (c) { return c.checked; }).map(function (c) { return c.dataset.slot; }) };
      body.querySelectorAll('[data-set]').forEach(function (i) {
        var k = i.dataset.set, v = Number(i.value);
        var cur = k === 'base_kcal' ? w.base_kcal : s[k];
        if (i.value !== '' && v !== Number(cur)) b[k] = v;
      });
      try { await api('PUT', '/settings', b); toast('Saved'); show('targets'); } catch (e) { fail(e); }
    };
  }
})();
