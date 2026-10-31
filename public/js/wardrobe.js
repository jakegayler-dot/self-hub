// The Wardrobe tab (2026-10-31): his wardrobe manager, brought into Self Hub. Today · Wardrobe · Outfits · Wishlist · Stylist.
(function () {
  var API = '/api/fitness';
  var pane = document.getElementById('wardrobePane');
  if (!pane) return;
  var st = { view: 'today', occasion: 'farm', data: null, weather: null, today: null, sortKey: 'category', sortDir: 'asc', query: '', editId: null, filter: 'Wear' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function regina() { return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2000); }
  async function api(method, path, body) {
    var res = await fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    if (res.status === 204) return null;
    var d = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
    return d;
  }
  function fail(e) { toast(e.message || String(e)); }
  function opts(list, sel) { return list.map(function (v) { return '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); }

  var VIEWS = [['today', 'Today'], ['items', 'Wardrobe'], ['outfits', 'Outfits'], ['wishlist', 'Wishlist'], ['stylist', 'Stylist']];
  pane.innerHTML = '<div class="nu-views">' + VIEWS.map(function (v) { return '<button class="wk-chipbtn" data-wv="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div><div id="wdBody"></div>';
  var body = document.getElementById('wdBody');
  pane.querySelectorAll('[data-wv]').forEach(function (b) { b.onclick = function () { show(b.dataset.wv); }; });
  document.querySelectorAll('.trk-tab[data-tab="wardrobe"]').forEach(function (t) { t.addEventListener('click', function () { show(st.view); }); });
  function show(v) {
    st.view = v;
    pane.querySelectorAll('[data-wv]').forEach(function (b) { b.classList.toggle('on', b.dataset.wv === v); });
    if (v !== 'stylist') body.innerHTML = '<p class="trk-note">Loading…</p>';
    ({ today: today, items: items, outfits: outfits, wishlist: wishlist, stylist: stylist })[v]().catch(function (e) { body.innerHTML = '<p class="trk-err" style="display:block">' + esc(e.message) + '</p>'; });
  }
  async function load(force) { if (!st.data || force) st.data = await api('GET', '/wardrobe'); return st.data; }
  function byId(id) { return (st.data.items || []).find(function (i) { return i.id === id; }); }
  function label(i) { return [i.colour && i.colour !== 'Unknown' ? i.colour : '', i.brand && i.brand !== 'Unknown' ? i.brand : '', i.type].filter(Boolean).join(' '); }

  // ---- Today: the forecast at the farm (asked from this browser), the day's plan, what to wear ----
  async function weather() {
    if (st.weather && st.weather.date === regina()) return st.weather;
    try {
      var r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=52.87&longitude=-104.35&daily=temperature_2m_max,temperature_2m_min,apparent_temperature_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max&timezone=America%2FRegina&forecast_days=1');
      var d = (await r.json()).daily, k = 0;
      st.weather = { date: d.time[k], high_c: d.temperature_2m_max[k], low_c: d.temperature_2m_min[k], feels_low_c: d.apparent_temperature_min[k], feels_high_c: d.apparent_temperature_max[k],
        precip_mm: d.precipitation_sum[k], precip_chance: d.precipitation_probability_max[k], snow_cm: d.snowfall_sum[k], wind_kmh: d.wind_speed_10m_max[k] };
    } catch (e) { st.weather = null; }
    return st.weather;
  }
  var ROLE = { top: 'Top', layer: 'Layer', bottom: 'Bottom', outer: 'Outer', shoes: 'Shoes', accessory: 'Accessory', belt: 'Belt' };
  async function today() {
    await load();
    var w = await weather();
    var qs = '?date=' + regina() + '&occasion=' + st.occasion + (w ? ['high_c', 'low_c', 'feels_low_c', 'feels_high_c', 'precip_mm', 'precip_chance', 'snow_cm', 'wind_kmh'].map(function (k) { return w[k] == null ? '' : '&' + k + '=' + w[k]; }).join('') : '');
    var t = st.today = await api('GET', '/wardrobe/today' + qs);
    var W = t.weather;
    var piece = function (p) { return '<div class="nu-line"><span><b>' + esc(ROLE[p.role] || p.role) + '</b> ' + esc([p.colour && p.colour !== 'Unknown' ? p.colour : '', p.brand && p.brand !== 'Unknown' ? p.brand : '', p.type].filter(Boolean).join(' ')) + ' <small>' + esc(p.id) + (p.last_worn ? ' · worn ' + esc(p.last_worn) : '') + '</small></span></div>'; };
    body.innerHTML =
      '<div class="nu-views">' + [['farm', 'Farm'], ['town', 'Town'], ['dress', 'Dressed up'], ['gym', 'Gym']].map(function (o) { return '<button class="wk-chipbtn' + (st.occasion === o[0] ? ' on' : '') + '" data-occ="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
      (W ? '<div class="trk-grid"><div class="trk-card"><div class="lbl">Today at the farm</div><div class="val amber">' + Math.round(W.low_c) + '° / ' + Math.round(W.high_c) + '°C</div><div class="trk-note">feels ' + Math.round(W.feels_low_c) + '° to ' + Math.round(W.feels_high_c) + '°</div></div>' +
        '<div class="trk-card"><div class="lbl">Wind · rain · snow</div><div class="val">' + Math.round(W.wind_kmh || 0) + ' km/h</div><div class="trk-note">' + (W.precip_chance || 0) + '% · ' + (W.precip_mm || 0) + ' mm · ' + (W.snow_cm || 0) + ' cm</div></div></div>' : '<p class="trk-note">No forecast right now: dressed for a mild day.</p>') +
      '<div class="trk-sec"><h2>Wear (' + esc(t.occasion_label) + (t.dress_for_c != null ? ', dressed for ' + t.dress_for_c + '°C' : '') + ')</h2>' + t.pieces.map(piece).join('') +
      (t.missing.length ? '<p class="trk-note">Nothing suitable for: ' + esc(t.missing.join(', ')) + '</p>' : '') +
      (t.notes.length ? '<ul class="wd-notes">' + t.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="trk-row" style="margin-top:8px"><button class="trk-btn primary" id="wdWore">Wore this</button><button class="trk-btn" id="wdSave">Save as outfit</button></div></div>' +
      (t.gym_kit ? '<div class="trk-sec"><h2>Gym bag (' + esc(t.gym_kit.for) + ')</h2>' + t.gym_kit.pieces.map(piece).join('') + '</div>' : '') +
      '<p class="trk-note">Picked by the rules from the forecast, your training today and what you wore lately. Ask the Stylist for anything better.</p>';
    body.querySelectorAll('[data-occ]').forEach(function (b) { b.onclick = function () { st.occasion = b.dataset.occ; today().catch(fail); }; });
    document.getElementById('wdWore').onclick = async function () {
      var ids = t.pieces.map(function (p) { return p.id; }).concat(t.gym_kit ? t.gym_kit.pieces.map(function (p) { return p.id; }) : []);
      try { await api('POST', '/wardrobe/wear', { date: regina(), item_ids: ids }); toast('Logged: tomorrow gets something different'); } catch (e) { fail(e); }
    };
    document.getElementById('wdSave').onclick = async function () {
      var name = prompt('Name this outfit', t.occasion_label + ', ' + (t.dress_for_c != null ? t.dress_for_c + '°C' : 'any day')); if (!name) return;
      try { await api('POST', '/wardrobe/outfits', { name: name, occasion: t.occasion, item_ids: t.pieces.map(function (p) { return p.id; }) }); toast('Saved'); } catch (e) { fail(e); }
    };
  }

  // ---- Wardrobe: his manager's table, stats and gaps ----
  var COLS = [['id', 'ID'], ['category', 'Category'], ['type', 'Type'], ['brand', 'Brand'], ['colour', 'Colour'], ['size', 'Size'], ['season', 'Season'], ['condition', 'Condition'], ['style', 'Style'], ['warmth', 'Warmth'], ['status', 'Status'], ['notes', 'Notes']];
  function isGap(i) { return !i.brand || i.brand === 'Unknown' || !i.season || i.season === 'Unknown' || !i.style; }
  async function items(force) {
    var d = await load(force); var o = d.options; var s = d.stats;
    var list = d.items.filter(function (i) { return st.filter === 'all' ? i.status !== 'Wishlist' : i.status === st.filter; });
    if (st.query) { var q = st.query.toLowerCase(); list = list.filter(function (i) { return COLS.some(function (c) { return String(i[c[0]] == null ? '' : i[c[0]]).toLowerCase().indexOf(q) >= 0; }); }); }
    list.sort(function (a, b) { var av = a[st.sortKey], bv = b[st.sortKey]; if (st.sortKey === 'warmth') { av = av == null ? -1 : av; bv = bv == null ? -1 : bv; } else { av = String(av == null ? '' : av).toLowerCase(); bv = String(bv == null ? '' : bv).toLowerCase(); } return av < bv ? (st.sortDir === 'asc' ? -1 : 1) : av > bv ? (st.sortDir === 'asc' ? 1 : -1) : 0; });
    var max = s.by_category.length ? s.by_category[0][1] : 1;
    body.innerHTML =
      '<div class="wd-stats"><div><div class="sub-h">By category (' + s.total + ')</div>' + s.by_category.map(function (c) { return '<div class="wd-bar"><span>' + esc(c[0]) + '</span><i><b style="width:' + Math.round(c[1] / max * 100) + '%"></b></i><span>' + c[1] + '</span></div>'; }).join('') + '</div>' +
      '<div><div class="sub-h">Needs attention</div><ul class="wd-notes"><li><b>' + s.repair.length + '</b> need repair' + (s.repair.length ? ': ' + esc(s.repair.map(function (r) { return r.type; }).join(', ')) : '') + '</li><li><b>' + s.missing_info + '</b> missing brand, season or style</li>' +
        d.gaps.map(function (g) { return '<li><b>' + esc(g.area) + '</b>: ' + esc(g.why) + '</li>'; }).join('') + '</ul></div></div>' +
      '<div class="trk-row wd-tools"><div class="nu-views" style="margin:0">' + [['Wear', 'Wearing'], ['Repair', 'Repair'], ['Retired', 'Retired'], ['all', 'All']].map(function (f) { return '<button class="wk-chipbtn' + (st.filter === f[0] ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>' +
        '<input type="search" id="wdQ" placeholder="Search type, brand, colour, notes…" value="' + esc(st.query) + '"></div>' +
      '<form id="wdAdd" class="wd-add"><select name="category">' + opts(o.categories) + '</select><input name="type" required placeholder="Type — e.g. Hoodie"><input name="brand" placeholder="Brand"><input name="colour" placeholder="Colour"><input name="size" placeholder="Size">' +
        '<select name="season">' + opts(o.seasons, 'Unknown') + '</select><select name="style">' + opts([''].concat(o.styles), '') + '</select><input name="warmth" type="number" min="1" max="5" placeholder="Warmth"><button class="trk-btn primary" type="submit">Add</button></form>' +
      '<div class="trk-log wd-table" style="max-height:none"><table><thead><tr>' + COLS.map(function (c) { return '<th data-sort="' + c[0] + '">' + c[1] + (st.sortKey === c[0] ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '') + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
        (list.map(function (i) {
          if (st.editId === i.id) return editRow(i, o);
          return '<tr class="' + (i.status === 'Repair' ? 'wd-repair' : '') + (isGap(i) ? ' wd-gap' : '') + '">' + COLS.map(function (c) { var v = i[c[0]]; return '<td' + (c[0] === 'notes' ? ' class="wd-n"' : '') + '>' + (v == null || v === '' ? '—' : esc(v)) + '</td>'; }).join('') +
            '<td><button class="trk-del" data-ed="' + esc(i.id) + '" title="Edit">✎</button><button class="trk-del" data-del="' + esc(i.id) + '" title="Delete">✕</button></td></tr>';
        }).join('') || '<tr><td colspan="13" class="empty">Nothing here.</td></tr>') + '</tbody></table></div>' +
      '<div class="trk-row" style="margin-top:10px"><a class="trk-btn" href="' + API + '/wardrobe/export?format=json">Export JSON</a><a class="trk-btn" href="' + API + '/wardrobe/export?format=csv">Export CSV</a><a class="trk-btn" href="' + API + '/wardrobe/export?format=sql">Export SQL</a></div>';
    body.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { st.filter = b.dataset.f; items().catch(fail); }; });
    var qi = document.getElementById('wdQ'); qi.oninput = function () { st.query = qi.value.trim(); var pos = qi.selectionStart; items().then(function () { var n = document.getElementById('wdQ'); n.focus(); n.setSelectionRange(pos, pos); }); };
    body.querySelectorAll('th[data-sort]').forEach(function (th) { th.onclick = function () { var k = th.dataset.sort; if (st.sortKey === k) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc'; else { st.sortKey = k; st.sortDir = 'asc'; } items().catch(fail); }; });
    body.querySelectorAll('[data-ed]').forEach(function (b) { b.onclick = function () { st.editId = b.dataset.ed; items().catch(fail); }; });
    body.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = async function () { if (!confirm('Delete ' + b.dataset.del + '?')) return; try { await api('DELETE', '/wardrobe/items/' + encodeURIComponent(b.dataset.del)); await items(true); } catch (e) { fail(e); } }; });
    document.getElementById('wdAdd').onsubmit = async function (e) {
      e.preventDefault(); var f = new FormData(e.target), b = {};
      f.forEach(function (v, k) { if (v !== '') b[k] = v; });
      try { var it = await api('POST', '/wardrobe/items', b); toast('Added ' + it.id); await items(true); } catch (er) { fail(er); }
    };
    var ef = document.getElementById('wdEdit');
    if (ef) {
      ef.onsubmit = async function (e) {
        e.preventDefault(); var f = new FormData(ef), b = {};
        f.forEach(function (v, k) { b[k] = v === '' ? null : v; });
        try { await api('PUT', '/wardrobe/items/' + encodeURIComponent(ef.dataset.id), b); st.editId = null; await items(true); } catch (er) { fail(er); }
      };
      ef.querySelector('.cancel').onclick = function () { st.editId = null; items().catch(fail); };
    }
  }
  function editRow(i, o) {
    return '<tr><td colspan="13"><form id="wdEdit" class="wd-add" data-id="' + esc(i.id) + '"><select name="category">' + opts(o.categories, i.category) + '</select>' +
      '<input name="type" value="' + esc(i.type) + '"><input name="brand" value="' + esc(i.brand) + '" placeholder="Brand"><input name="colour" value="' + esc(i.colour) + '" placeholder="Colour"><input name="size" value="' + esc(i.size) + '" placeholder="Size">' +
      '<select name="season">' + opts(o.seasons, i.season) + '</select><select name="condition">' + opts(o.conditions, i.condition) + '</select><select name="style">' + opts([''].concat(o.styles), i.style || '') + '</select>' +
      '<input name="warmth" type="number" min="1" max="5" value="' + (i.warmth == null ? '' : i.warmth) + '" placeholder="Warmth"><select name="status">' + opts(o.statuses, i.status) + '</select>' +
      '<input name="notes" value="' + esc(i.notes) + '" placeholder="Notes" style="flex:2 1 200px"><button class="trk-btn primary" type="submit">Save</button><button class="trk-btn cancel" type="button">Cancel</button></form></td></tr>';
  }

  // ---- Outfits ----
  async function outfits() {
    await load();
    var d = await api('GET', '/wardrobe/outfits');
    body.innerHTML = (d.outfits.length ? d.outfits.map(function (o) {
      return '<div class="ldg"><div class="nu-line"><span><b>' + esc(o.name) + '</b>' + (o.occasion ? ' <span class="wk-chip">' + esc(o.occasion) + '</span>' : '') + (o.source === 'stylist' ? ' <span class="wk-chip amber">stylist</span>' : '') + '</span>' +
        '<span><button class="trk-btn" data-wear="' + o.id + '">Wear today</button> <button class="trk-del" data-odel="' + o.id + '">✕</button></span></div>' +
        '<ul class="nu-ings">' + o.items.map(function (i) { return '<li>' + (i.missing ? esc(i.id) + ' <small>(gone)</small>' : esc(label(i)) + ' <small>' + esc(i.id) + (i.status !== 'Wear' ? ' · ' + esc(i.status) : '') + '</small>') + '</li>'; }).join('') + '</ul>' +
        (o.notes ? '<p class="trk-note">' + esc(o.notes) + '</p>' : '') + '</div>';
    }).join('') : '<p class="trk-note">No outfits yet. Save today\'s pick, or ask the Stylist to put some together.</p>');
    body.querySelectorAll('[data-wear]').forEach(function (b) { b.onclick = async function () { var o = d.outfits.find(function (x) { return x.id === Number(b.dataset.wear); }); try { await api('POST', '/wardrobe/wear', { date: regina(), item_ids: o.items.filter(function (i) { return !i.missing; }).map(function (i) { return i.id; }) }); toast('Logged'); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-odel]').forEach(function (b) { b.onclick = async function () { if (!confirm('Delete this outfit?')) return; try { await api('DELETE', '/wardrobe/outfits/' + b.dataset.odel); outfits(); } catch (e) { fail(e); } }; });
  }

  // ---- Wishlist: what to buy (the stylist adds to it) ----
  async function wishlist() {
    var d = await load(true);
    var list = d.items.filter(function (i) { return i.status === 'Wishlist'; });
    var total = list.reduce(function (a, i) { return a + (i.price_cad || 0); }, 0);
    body.innerHTML = '<div class="sub-h">Gaps the rules see</div><ul class="wd-notes">' + d.gaps.map(function (g) { return '<li><b>' + esc(g.area) + '</b>: ' + esc(g.why) + '</li>'; }).join('') + '</ul>' +
      '<div class="trk-row"><button class="trk-btn primary" id="wdAsk">Ask the Stylist what to buy</button></div>' +
      '<div class="trk-sec" style="margin-top:12px"><h2>Wishlist' + (total ? ' · about $' + Math.round(total) + ' CAD' : '') + '</h2>' +
      (list.length ? list.map(function (i) {
        return '<div class="nu-line"><span><b>' + esc(label(i)) + '</b>' + (i.size ? ' <small>size ' + esc(i.size) + '</small>' : '') + (i.price_cad ? ' <small>$' + esc(i.price_cad) + '</small>' : '') +
          (i.notes ? '<br><small>' + esc(i.notes) + '</small>' : '') + (i.link ? '<br><a href="' + esc(i.link) + '" target="_blank" rel="noopener" style="color:var(--amber);font-size:12px">link</a>' : '') + '</span>' +
          '<span><button class="trk-btn" data-got="' + esc(i.id) + '">Bought</button> <button class="trk-del" data-wdel="' + esc(i.id) + '">✕</button></span></div>';
      }).join('') : '<p class="trk-note">Empty. The Stylist adds what you should buy here, with why and a price.</p>') + '</div>';
    document.getElementById('wdAsk').onclick = function () { st.pending = 'Look at my wardrobe and its gaps. What should I buy next, in order? Put the top picks on my wishlist with why, a price and a link.'; show('stylist'); };
    body.querySelectorAll('[data-got]').forEach(function (b) { b.onclick = async function () { try { await api('PUT', '/wardrobe/items/' + encodeURIComponent(b.dataset.got), { status: 'Wear', condition: 'New' }); toast('In your wardrobe now'); wishlist(); } catch (e) { fail(e); } }; });
    body.querySelectorAll('[data-wdel]').forEach(function (b) { b.onclick = async function () { try { await api('DELETE', '/wardrobe/items/' + encodeURIComponent(b.dataset.wdel)); wishlist(); } catch (e) { fail(e); } }; });
  }

  // ---- Stylist: the coach chat ----
  async function stylist() {
    body.innerHTML = '<div id="wdChat"></div>';
    if (!window.SelfHubCoach) return;
    window.SelfHubCoach.mount(document.getElementById('wdChat'), 'stylist');
    if (st.pending) { var ta = document.querySelector('#wdChat textarea'); if (ta) ta.value = st.pending; st.pending = null; }
    st.data = null; // it may change things
  }
})();
