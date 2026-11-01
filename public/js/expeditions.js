// Expeditions (2026-10-31): Jake's trips and expeditions, built around the map. The atlas shows every trip's route;
// a trip is its route, its places in order, and its days: journal pages with that day's weather, photos (placed by
// their own GPS when the camera kept it) and whatever he logged in training on the way.
// Leaflet 1.9.4 (cdnjs) loads the first time the tab opens; the map is OpenTopoMap's topographic style, toned to match.
(function () {
  var API = '/api/fitness';
  var pane = document.getElementById('expeditionsPane');
  if (!pane) return;
  var st = { view: 'atlas', id: null, list: null, trip: null, pickMode: false, atlasMap: null, tripMap: null, busy: false };

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function today() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function toast(m) { var t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2400); }
  async function api(method, path, body) {
    var res = await fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    if (res.status === 204) return null;
    var d = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
    return d;
  }
  function fail(e) { toast(e.message || String(e)); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function d8(s) { return new Date(s + 'T12:00:00Z'); }
  function fmtD(s, year) { if (!s) return ''; var d = d8(s); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (year ? ' ' + d.getUTCFullYear() : ''); }
  function fmtSpan(a, b) {
    if (!a && !b) return 'No dates yet';
    if (!b || a === b) return fmtD(a || b, true);
    var y1 = a.slice(0, 4), y2 = b.slice(0, 4);
    return fmtD(a, y1 !== y2) + ' – ' + fmtD(b, true);
  }
  function addDays(s, n) { return new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function para(t) { return esc(t).split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br>') + '</p>'; }).join(''); }
  function wx(w) {
    if (!w) return '';
    var t = (w.high_c != null ? Math.round(w.high_c) + '°' : '') + (w.low_c != null ? ' / ' + Math.round(w.low_c) + '°C' : '');
    var bits = [w.sky, t, w.precip_mm ? w.precip_mm + ' mm' : '', w.snow_cm ? w.snow_cm + ' cm snow' : '', w.wind_kmh != null ? 'wind ' + Math.round(w.wind_kmh) + ' km/h' : ''].filter(Boolean);
    return '<div class="ex-wx">' + esc(bits.join(' · ')) + (w.at ? ' <span>at ' + esc(w.at) + '</span>' : '') + '</div>';
  }

  // ---- Leaflet, loaded once ----
  var leaflet = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leaflet) return leaflet;
    leaflet = new Promise(function (ok, no) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
      var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      s.onload = function () { ok(window.L); }; s.onerror = function () { leaflet = null; no(new Error("The map couldn't load (no connection to cdnjs)")); };
      document.head.appendChild(s);
    });
    return leaflet;
  }
  function makeMap(el) {
    var map = L.map(el, { zoomControl: true, attributionControl: true, worldCopyJump: true, scrollWheelZoom: false }).setView([52.9, -104.4], 4);
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc',
      attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }).addTo(map);
    // Wheel zoom only after a click, so the page still scrolls past the map.
    map.on('click', function () { map.scrollWheelZoom.enable(); });
    el.addEventListener('mouseleave', function () { map.scrollWheelZoom.disable(); });
    return map;
  }
  function pin(n, cls) { return L.divIcon({ className: 'ex-pin' + (cls ? ' ' + cls : ''), html: '<span>' + (n == null ? '' : esc(n)) + '</span>', iconSize: [26, 26], iconAnchor: [13, 13] }); }
  function route(map, places, opts) {
    var pts = places.map(function (p) { return [p.lat, p.lon]; });
    if (pts.length > 1) L.polyline(pts, Object.assign({ color: '#a8231c', weight: 2.5, dashArray: '6 7', opacity: 0.85 }, opts || {})).addTo(map);
    return pts;
  }
  function fit(map, pts) {
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 10); else map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 12 });
  }

  // ---- views ----
  function show() { st.view === 'trip' && st.id ? openTrip(st.id) : atlas(); }
  document.querySelectorAll('.trk-tab[data-tab="expeditions"]').forEach(function (t) { t.addEventListener('click', function () { show(); }); });

  async function atlas() {
    st.view = 'atlas'; st.id = null; st.tripMap = null;
    pane.innerHTML = '<p class="trk-note">Loading…</p>';
    try { st.list = await api('GET', '/expeditions'); } catch (e) { pane.innerHTML = '<p class="trk-err" style="display:block">' + esc(e.message) + '</p>'; return; }
    var L0 = st.list;
    var km = L0.reduce(function (s, e) { return s + (e.distance_km || 0); }, 0), places = L0.reduce(function (s, e) { return s + e.places.length; }, 0);
    pane.innerHTML =
      '<div class="ex-atlas"><div class="ex-mapwrap"><div class="ex-map" id="exAtlasMap"></div></div>' +
      '<div class="ex-side">' +
      '<div class="ex-tally">' + (L0.length ? '<b>' + L0.length + '</b> ' + (L0.length === 1 ? 'expedition' : 'expeditions') + ' · <b>' + places + '</b> places · <b>' + km.toLocaleString() + '</b> km between them' : 'No expeditions yet.') + '</div>' +
      '<button class="trk-btn primary" id="exNew">New expedition</button>' +
      '<form class="ex-form" id="exNewForm" hidden>' +
      '<input name="title" maxlength="120" placeholder="Name it (e.g. Rockies, July 2024)" required>' +
      '<div class="ex-row"><select name="kind"><option value="trip">Trip</option><option value="expedition">Expedition</option><option value="outing">Outing</option></select>' +
      '<label>From <input type="date" name="start_date"></label><label>To <input type="date" name="end_date"></label></div>' +
      '<textarea name="summary" rows="2" maxlength="4000" placeholder="What it was for (optional)"></textarea>' +
      '<div class="ex-row"><button class="trk-btn primary" type="submit">Create</button><button class="trk-btn" type="button" id="exNewCancel">Cancel</button></div></form>' +
      '<div class="ex-list">' + L0.map(card).join('') + '</div>' +
      (L0.length ? '' : '<p class="trk-note">Start one, then find its places by name or drop pins on the map. Pages pick up the weather of their day; photos with GPS land where they were taken.</p>') +
      '</div></div>';
    var f = document.getElementById('exNewForm');
    document.getElementById('exNew').onclick = function () { f.hidden = false; this.hidden = true; f.title.focus(); };
    document.getElementById('exNewCancel').onclick = function () { f.hidden = true; document.getElementById('exNew').hidden = false; };
    f.onsubmit = async function (ev) {
      ev.preventDefault();
      try {
        var e = await api('POST', '/expeditions', { title: f.title.value, kind: f.kind.value, start_date: f.start_date.value || null, end_date: f.end_date.value || null, summary: f.summary.value });
        openTrip(e.id);
      } catch (err) { fail(err); }
    };
    pane.querySelectorAll('[data-exp]').forEach(function (el) { el.onclick = function () { openTrip(Number(el.dataset.exp)); }; });
    try {
      await loadLeaflet();
      var map = st.atlasMap = makeMap(document.getElementById('exAtlasMap'));
      var all = [];
      L0.forEach(function (e) {
        var pts = route(map, e.places);
        e.places.forEach(function (p, i) {
          L.marker([p.lat, p.lon], { icon: pin(null, 'ex-dot') }).addTo(map)
            .bindPopup('<b>' + esc(p.name) + '</b><br>' + esc(e.title) + '<br><a href="#" data-open="' + e.id + '">Open the journal</a>');
        });
        all = all.concat(pts);
      });
      map.on('popupopen', function (ev) { var a = ev.popup.getElement().querySelector('[data-open]'); if (a) a.onclick = function (x) { x.preventDefault(); openTrip(Number(a.dataset.open)); }; });
      if (all.length) fit(map, all);
    } catch (err) { document.getElementById('exAtlasMap').innerHTML = '<p class="trk-note b3d-msg">' + esc(err.message) + '</p>'; }
  }
  function card(e) {
    var route = e.places.map(function (p) { return esc(p.name); }).join(' <i>→</i> ');
    var stats = [e.days ? e.days + ' day' + (e.days === 1 ? '' : 's') : '', e.distance_km ? e.distance_km.toLocaleString() + ' km' : '', e.entries ? e.entries + ' page' + (e.entries === 1 ? '' : 's') : '', e.photos ? e.photos + ' photo' + (e.photos === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
    return '<button class="ex-card" data-exp="' + e.id + '">' +
      (e.cover_url ? '<img src="' + esc(e.cover_url) + '" alt="" loading="lazy">' : '<span class="ex-nocover"></span>') +
      '<span class="ex-card-t"><b>' + esc(e.title) + '</b><span class="ex-when">' + esc(fmtSpan(e.start_date, e.end_date)) + ' · ' + esc(e.kind) + '</span>' +
      (route ? '<span class="ex-route">' + route + '</span>' : '') + (stats ? '<span class="ex-stats">' + esc(stats) + '</span>' : '') + '</span></button>';
  }

  async function openTrip(id) {
    st.view = 'trip'; st.id = id; st.pickMode = false;
    if (!st.trip || st.trip.id !== id) pane.innerHTML = '<p class="trk-note">Loading…</p>';
    try { st.trip = await api('GET', '/expeditions/' + id); } catch (e) { pane.innerHTML = '<p class="trk-err" style="display:block">' + esc(e.message) + '</p>'; return; }
    renderTrip();
    window.scrollTo(0, 0);
  }

  // The days of a trip, each with what happened: arrivals, pages, photos, training. Undated things go last.
  function daysOf(t) {
    var map = {}, add = function (d, k, v) { var x = map[d] = map[d] || { date: d, arrive: [], pages: [], photos: [], training: [] }; x[k].push(v); };
    t.places.forEach(function (p) { if (p.arrived_on) add(p.arrived_on, 'arrive', p); });
    t.entries.forEach(function (e) { add(e.entry_date, 'pages', e); });
    t.photos.forEach(function (p) { if (p.taken_on) add(p.taken_on, 'photos', p); });
    Object.keys(t.training || {}).forEach(function (d) { t.training[d].forEach(function (x) { add(d, 'training', x); }); });
    return Object.keys(map).sort().map(function (d) { return map[d]; });
  }
  function placeOn(t, d) {
    var p = t.places.filter(function (x) { return x.arrived_on && x.arrived_on <= d && (!x.left_on || x.left_on >= d); });
    return p.length ? p[p.length - 1] : null;
  }

  function renderTrip() {
    var t = st.trip, start = t.span && t.span.from;
    var days = daysOf(t), loose = t.photos.filter(function (p) { return !p.taken_on; });
    var placeName = function (id) { var p = t.places.find(function (x) { return x.id === id; }); return p ? p.name : ''; };
    var photoHtml = function (list) {
      return list.length ? '<div class="ex-photos">' + list.map(function (p) {
        return '<button class="ex-ph" data-photo="' + p.id + '"><img src="' + esc(p.thumb_url) + '" alt="' + esc(p.caption || '') + '" loading="lazy">' + (p.caption ? '<span>' + esc(p.caption) + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '';
    };
    var dayHtml = days.map(function (d) {
      var n = start ? Math.round((Date.parse(d.date) - Date.parse(start)) / 864e5) + 1 : null, here = placeOn(t, d.date);
      var dt = d8(d.date);
      return '<section class="ex-day">' +
        '<header><span class="ex-dayn">' + (n != null && n >= 1 ? 'Day ' + n : '') + '</span><h3>' + DOW[dt.getUTCDay()] + ' ' + fmtD(d.date, true) + '</h3>' + (here ? '<span class="ex-at">' + esc(here.name) + '</span>' : '') + '</header>' +
        d.arrive.map(function (p) { return '<div class="ex-arrive">Arrived at <b>' + esc(p.name) + '</b>' + (p.region ? ', ' + esc(p.region) : '') + (p.notes ? '<div class="ex-pnote">' + esc(p.notes) + '</div>' : '') + '</div>'; }).join('') +
        d.pages.map(function (e) {
          return '<article class="ex-page" data-entry="' + e.id + '">' + (e.title ? '<h4>' + esc(e.title) + '</h4>' : '') +
            (e.place_id ? '<div class="ex-at">' + esc(placeName(e.place_id)) + '</div>' : '') + wx(e.weather) + '<div class="ex-body">' + para(e.body) + '</div>' +
            '<div class="ex-acts"><button class="wk-undo" data-edit="' + e.id + '">Edit</button><button class="wk-undo" data-delentry="' + e.id + '">Delete</button></div></article>';
        }).join('') +
        photoHtml(d.photos) +
        (d.training.length ? '<ul class="ex-train">' + d.training.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul>' : '') +
        '</section>';
    }).join('');

    pane.innerHTML =
      '<div class="ex-trip">' +
      '<button class="wk-undo ex-back" id="exBack">‹ All expeditions</button>' +
      '<div class="ex-head"><div><div class="ex-kind">' + esc(t.kind) + '</div><h2 class="ex-title">' + esc(t.title) + '</h2>' +
      '<div class="ex-when">' + esc(fmtSpan(t.start_date || (t.span && t.span.from), t.end_date || (t.span && t.span.to))) +
      (t.distance_km ? ' · ' + t.distance_km.toLocaleString() + ' km between places' : '') + '</div>' +
      (t.summary ? '<div class="ex-summary">' + para(t.summary) + '</div>' : '') + '</div>' +
      '<button class="wk-undo" id="exEditTrip">Edit</button></div>' +
      '<form class="ex-form" id="exTripForm" hidden>' +
      '<input name="title" maxlength="120" value="' + esc(t.title) + '" required>' +
      '<div class="ex-row"><select name="kind">' + ['trip', 'expedition', 'outing'].map(function (k) { return '<option value="' + k + '"' + (k === t.kind ? ' selected' : '') + '>' + k[0].toUpperCase() + k.slice(1) + '</option>'; }).join('') + '</select>' +
      '<label>From <input type="date" name="start_date" value="' + esc(t.start_date || '') + '"></label><label>To <input type="date" name="end_date" value="' + esc(t.end_date || '') + '"></label></div>' +
      '<textarea name="summary" rows="3" maxlength="4000" placeholder="What it was for">' + esc(t.summary || '') + '</textarea>' +
      '<div class="ex-row"><button class="trk-btn primary" type="submit">Save</button><button class="trk-btn" type="button" id="exTripCancel">Cancel</button><button class="trk-btn ex-danger" type="button" id="exTripDelete">Delete expedition</button></div></form>' +

      '<div class="ex-tripgrid"><div class="ex-mapcol"><div class="ex-mapwrap"><div class="ex-map" id="exTripMap"></div><div class="ex-pickhint" id="exPickHint" hidden>Tap the map where it is</div></div>' +
      '<div class="ex-places"><div class="ex-sub">Route</div>' +
      (t.places.length ? '<ol>' + t.places.map(function (p, i) {
        return '<li><span class="ex-pn">' + (i + 1) + '</span><span class="ex-pt"><b>' + esc(p.name) + '</b>' + (p.region ? ' <small>' + esc(p.region) + '</small>' : '') +
          (p.arrived_on ? '<small class="ex-pd">' + esc(fmtSpan(p.arrived_on, p.left_on)) + '</small>' : '') + '</span>' +
          '<span class="ex-pa">' + (i ? '<button class="wk-undo" data-up="' + p.id + '" title="Earlier">↑</button>' : '') + '<button class="wk-undo" data-delplace="' + p.id + '" title="Remove">×</button></span></li>';
      }).join('') + '</ol>' : '<p class="trk-note">No places yet.</p>') +
      '<div class="ex-addplace"><input id="exPlaceQ" placeholder="Add a place: search by name" autocomplete="off"><button class="trk-btn" id="exPick" type="button">Pin on map</button></div>' +
      '<div class="ex-results" id="exPlaceResults"></div>' +
      '<form class="ex-form" id="exPlaceForm" hidden><div class="ex-row"><input name="name" placeholder="Name" maxlength="120" required><input name="region" placeholder="Region (optional)" maxlength="120"></div>' +
      '<div class="ex-row"><label>Arrived <input type="date" name="arrived_on"></label><label>Left <input type="date" name="left_on"></label></div>' +
      '<input type="hidden" name="lat"><input type="hidden" name="lon"><div class="ex-row"><button class="trk-btn primary" type="submit">Add to the route</button><button class="trk-btn" type="button" id="exPlaceCancel">Cancel</button></div></form>' +
      '</div></div>' +

      '<div class="ex-journal">' +
      '<div class="ex-jhead"><div class="ex-sub">Journal</div><div class="ex-row"><button class="trk-btn primary" id="exWrite">Write a page</button><label class="trk-btn ex-file">Add photos<input type="file" id="exPhotos" accept="image/jpeg,image/png,image/webp,image/*" multiple hidden></label></div></div>' +
      '<div class="ex-up" id="exUp" hidden></div>' +
      '<form class="ex-form ex-pageform" id="exPageForm" hidden><input type="hidden" name="id">' +
      '<div class="ex-row"><input type="date" name="entry_date" required><select name="place_id"><option value="">Where (optional)</option>' + t.places.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</select></div>' +
      '<input name="title" maxlength="160" placeholder="Title (optional)">' +
      '<textarea name="body" rows="7" maxlength="20000" placeholder="What happened"></textarea>' +
      '<div class="ex-row"><button class="trk-btn primary" type="submit">Save page</button><button class="trk-btn" type="button" id="exPageCancel">Cancel</button></div></form>' +
      (dayHtml || '<p class="trk-note">Nothing written yet. Pages pick up the weather of their day at their place; photos taken with location on land at the place they were taken.</p>') +
      (loose.length ? '<section class="ex-day"><header><h3>Undated photos</h3></header>' + photoHtml(loose) + '</section>' : '') +
      '</div></div></div>' +
      '<div class="ex-light" id="exLight" hidden></div>';
    wireTrip();
    drawTripMap();
  }

  async function drawTripMap() {
    var t = st.trip, el = document.getElementById('exTripMap');
    try { await loadLeaflet(); } catch (e) { el.innerHTML = '<p class="trk-note b3d-msg">' + esc(e.message) + '</p>'; return; }
    var map = st.tripMap = makeMap(el);
    var pts = route(map, t.places);
    t.places.forEach(function (p, i) { L.marker([p.lat, p.lon], { icon: pin(i + 1) }).addTo(map).bindPopup('<b>' + esc(p.name) + '</b>' + (p.arrived_on ? '<br>' + esc(fmtSpan(p.arrived_on, p.left_on)) : '')); });
    t.photos.forEach(function (p) {
      if (p.lat == null) return;
      L.marker([p.lat, p.lon], { icon: pin(null, 'ex-cam') }).addTo(map).on('click', function () { lightbox(p.id); });
      pts.push([p.lat, p.lon]);
    });
    if (pts.length) fit(map, pts); else map.setView([52.9, -104.4], 5);
    map.on('click', function (ev) {
      if (!st.pickMode) return;
      st.pickMode = false; document.getElementById('exPickHint').hidden = true;
      placeForm({ name: '', region: '', lat: ev.latlng.lat, lon: ev.latlng.lng });
    });
  }

  function placeForm(p) {
    var f = document.getElementById('exPlaceForm');
    f.hidden = false; f.name.value = p.name || ''; f.region.value = p.region || ''; f.lat.value = p.lat; f.lon.value = p.lon;
    var t = st.trip, last = t.places[t.places.length - 1];
    f.arrived_on.value = (last && (last.left_on || last.arrived_on)) || t.start_date || '';
    f.left_on.value = '';
    document.getElementById('exPlaceResults').innerHTML = '';
    if (!f.name.value) f.name.focus();
  }

  function wireTrip() {
    var t = st.trip;
    document.getElementById('exBack').onclick = function () { st.trip = null; atlas(); };
    var tf = document.getElementById('exTripForm');
    document.getElementById('exEditTrip').onclick = function () { tf.hidden = !tf.hidden; };
    document.getElementById('exTripCancel').onclick = function () { tf.hidden = true; };
    document.getElementById('exTripDelete').onclick = async function () {
      if (!confirm('Delete "' + t.title + '" with its places, pages and photos? This can\'t be undone.')) return;
      try { await api('DELETE', '/expeditions/' + t.id); st.trip = null; toast('Deleted'); atlas(); } catch (e) { fail(e); }
    };
    tf.onsubmit = async function (ev) {
      ev.preventDefault();
      try { await api('PUT', '/expeditions/' + t.id, { title: tf.title.value, kind: tf.kind.value, start_date: tf.start_date.value || null, end_date: tf.end_date.value || null, summary: tf.summary.value }); openTrip(t.id); } catch (e) { fail(e); }
    };
    // Places: search by name, or pin on the map.
    var q = document.getElementById('exPlaceQ'), res = document.getElementById('exPlaceResults'), timer = null;
    q.oninput = function () {
      clearTimeout(timer);
      var v = q.value.trim(); if (v.length < 2) { res.innerHTML = ''; return; }
      timer = setTimeout(async function () {
        try {
          var found = await api('GET', '/expeditions/geocode?q=' + encodeURIComponent(v));
          res.innerHTML = found.length ? found.map(function (p, i) { return '<button class="ex-res" data-i="' + i + '"><b>' + esc(p.name) + '</b> <small>' + esc(p.region) + '</small></button>'; }).join('')
            : '<p class="trk-note">Nothing by that name. Pin it on the map instead.</p>';
          res.querySelectorAll('[data-i]').forEach(function (b) { b.onclick = function () { placeForm(found[Number(b.dataset.i)]); q.value = ''; }; });
        } catch (e) { res.innerHTML = '<p class="trk-note">' + esc(e.message) + '</p>'; }
      }, 350);
    };
    document.getElementById('exPick').onclick = function () {
      st.pickMode = !st.pickMode;
      document.getElementById('exPickHint').hidden = !st.pickMode;
      if (st.pickMode && window.innerWidth < 900) document.getElementById('exTripMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    var pf = document.getElementById('exPlaceForm');
    document.getElementById('exPlaceCancel').onclick = function () { pf.hidden = true; };
    pf.onsubmit = async function (ev) {
      ev.preventDefault();
      try {
        await api('POST', '/expeditions/' + t.id + '/places', { name: pf.name.value, region: pf.region.value || null, lat: Number(pf.lat.value), lon: Number(pf.lon.value), arrived_on: pf.arrived_on.value || null, left_on: pf.left_on.value || null });
        openTrip(t.id);
      } catch (e) { fail(e); }
    };
    pane.querySelectorAll('[data-delplace]').forEach(function (b) {
      b.onclick = async function () { if (!confirm('Remove this place from the route?')) return; try { await api('DELETE', '/expeditions/places/' + b.dataset.delplace); openTrip(t.id); } catch (e) { fail(e); } };
    });
    pane.querySelectorAll('[data-up]').forEach(function (b) {
      b.onclick = async function () {
        var ids = t.places.map(function (p) { return p.id; }), i = ids.indexOf(Number(b.dataset.up));
        ids.splice(i - 1, 0, ids.splice(i, 1)[0]);
        try { await api('POST', '/expeditions/' + t.id + '/places/order', { ids: ids }); openTrip(t.id); } catch (e) { fail(e); }
      };
    });
    // Pages.
    var gf = document.getElementById('exPageForm');
    var openPage = function (e) {
      gf.hidden = false; gf.id.value = e ? e.id : '';
      var d = today(), s = t.span || {};
      gf.entry_date.value = e ? e.entry_date : (s.from && (d < s.from || (s.to && d > s.to)) ? s.from : d);
      gf.place_id.value = e && e.place_id ? e.place_id : '';
      gf.title.value = e ? (e.title || '') : ''; gf.body.value = e ? e.body : '';
      gf.scrollIntoView({ behavior: 'smooth', block: 'start' }); gf.body.focus({ preventScroll: true });
    };
    document.getElementById('exWrite').onclick = function () { openPage(null); };
    document.getElementById('exPageCancel').onclick = function () { gf.hidden = true; };
    gf.onsubmit = async function (ev) {
      ev.preventDefault();
      var body = { entry_date: gf.entry_date.value, place_id: gf.place_id.value || null, title: gf.title.value, body: gf.body.value };
      try {
        if (gf.id.value) await api('PUT', '/expeditions/entries/' + gf.id.value, body); else await api('POST', '/expeditions/' + t.id + '/entries', body);
        openTrip(t.id);
      } catch (e) { fail(e); }
    };
    pane.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openPage(t.entries.find(function (e) { return e.id === Number(b.dataset.edit); })); }; });
    pane.querySelectorAll('[data-delentry]').forEach(function (b) {
      b.onclick = async function () { if (!confirm('Delete this page?')) return; try { await api('DELETE', '/expeditions/entries/' + b.dataset.delentry); openTrip(t.id); } catch (e) { fail(e); } };
    });
    // Photos.
    document.getElementById('exPhotos').onchange = function () { upload(Array.from(this.files || [])); this.value = ''; };
    pane.querySelectorAll('[data-photo]').forEach(function (b) { b.onclick = function () { lightbox(Number(b.dataset.photo)); }; });
  }

  function lightbox(id) {
    var t = st.trip, p = t.photos.find(function (x) { return x.id === id; }); if (!p) return;
    var lb = document.getElementById('exLight');
    lb.hidden = false;
    lb.innerHTML = '<div class="ex-lbin"><img src="' + esc(p.url) + '" alt="' + esc(p.caption || '') + '">' +
      '<div class="ex-lbbar"><input id="exCap" maxlength="500" placeholder="Caption" value="' + esc(p.caption || '') + '">' +
      '<span class="trk-note">' + esc([p.taken_on ? fmtD(p.taken_on, true) : '', p.lat != null ? p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) : ''].filter(Boolean).join(' · ')) + '</span>' +
      '<button class="trk-btn" id="exCapSave">Save</button><button class="trk-btn ex-danger" id="exPhDel">Delete</button><button class="trk-btn" id="exLbClose">Close</button></div></div>';
    var close = function () { lb.hidden = true; lb.innerHTML = ''; document.removeEventListener('keydown', key); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    lb.onclick = function (e) { if (e.target === lb) close(); };
    document.getElementById('exLbClose').onclick = close;
    document.getElementById('exCapSave').onclick = async function () { try { await api('PUT', '/expeditions/photos/' + p.id, { caption: document.getElementById('exCap').value }); close(); openTrip(t.id); } catch (e) { fail(e); } };
    document.getElementById('exPhDel').onclick = async function () { if (!confirm('Delete this photo?')) return; try { await api('DELETE', '/expeditions/photos/' + p.id); close(); openTrip(t.id); } catch (e) { fail(e); } };
  }

  // ---- photos: read the camera's date and GPS, shrink in the browser, send ----
  async function upload(files) {
    if (!files.length || st.busy) return;
    var t = st.trip, box = document.getElementById('exUp'), done = 0, placed = 0, failed = [];
    st.busy = true; box.hidden = false;
    for (var i = 0; i < files.length; i++) {
      box.textContent = 'Adding photo ' + (i + 1) + ' of ' + files.length + '…';
      try {
        var f = files[i], buf = await f.arrayBuffer(), meta = readExif(buf);
        var bmp = await decode(f);
        var big = await shrink(bmp, 1600, 0.82), small = await shrink(bmp, 480, 0.74);
        if (bmp.close) bmp.close();
        var body = { image: big.data, thumb: small.data, width: big.w, height: big.h, taken_on: meta.date || null, lat: meta.lat, lon: meta.lon };
        var res = await fetch(API + '/expeditions/' + t.id + '/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var d = await res.json().catch(function () { return null; });
        if (!res.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
        done++; if (d.place_id) placed++;
      } catch (e) { failed.push(files[i].name + ': ' + (e.message || e)); }
    }
    st.busy = false;
    toast(done + ' photo' + (done === 1 ? '' : 's') + ' added' + (placed ? ', ' + placed + ' placed by their GPS' : ''));
    await openTrip(t.id);
    if (failed.length) { var b = document.getElementById('exUp'); b.hidden = false; b.textContent = "Couldn't add: " + failed.join('; '); }
  }
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back to an <img> */ }
    }
    return await new Promise(function (ok, no) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error(/heic|heif/i.test(file.type + file.name) ? 'HEIC photos can\'t be read here; share it as JPEG (Most Compatible)' : "this file isn't a photo the browser can read")); };
      img.src = url;
    });
  }
  function shrink(src, max, quality) {
    var w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, s = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise(function (ok, no) {
      c.toBlob(function (b) {
        if (!b) return no(new Error("couldn't shrink it"));
        var r = new FileReader(); r.onload = function () { ok({ data: String(r.result).split(',')[1], w: c.width, h: c.height }); }; r.onerror = no; r.readAsDataURL(b);
      }, 'image/jpeg', quality);
    });
  }
  // The date taken and GPS position from a JPEG's EXIF (APP1), if the camera kept them. { date, lat, lon }
  function readExif(buf) {
    var out = { date: null, lat: null, lon: null };
    try {
      var v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return out;
      var o = 2;
      while (o + 4 < v.byteLength) {
        var m = v.getUint16(o), len = v.getUint16(o + 2);
        if (m === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10, out);
        if ((m & 0xff00) !== 0xff00 || m === 0xffda) break;
        o += 2 + len;
      }
    } catch (e) { /* no EXIF */ }
    return out;
  }
  function parseTiff(v, t, out) {
    var le = v.getUint16(t) === 0x4949;
    var u16 = function (p) { return v.getUint16(p, le); }, u32 = function (p) { return v.getUint32(p, le); };
    var ifd = function (p) {
      var n = u16(t + p), tags = {};
      for (var i = 0; i < n; i++) {
        var e = t + p + 2 + i * 12;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return tags;
    };
    var ascii = function (tag) { var p = tag.count > 4 ? t + u32(tag.at) : tag.at, s = ''; for (var i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
    var rationals = function (tag) { var p = t + u32(tag.at), a = []; for (var i = 0; i < tag.count; i++) { var d = u32(p + i * 8 + 4); a.push(d ? u32(p + i * 8) / d : 0); } return a; };
    var ref = function (tag) { return String.fromCharCode(v.getUint8(tag.at)); };
    var i0 = ifd(u32(t + 4));
    if (i0[0x8769]) {
      var ex = ifd(u32(i0[0x8769].at)), dt = ex[0x9003] || ex[0x9004];
      if (dt) { var m = /^(\d{4}):(\d{2}):(\d{2})/.exec(ascii(dt)); if (m && m[1] !== '0000') out.date = m[1] + '-' + m[2] + '-' + m[3]; }
    }
    if (!out.date && i0[0x0132]) { var m2 = /^(\d{4}):(\d{2}):(\d{2})/.exec(ascii(i0[0x0132])); if (m2 && m2[1] !== '0000') out.date = m2[1] + '-' + m2[2] + '-' + m2[3]; }
    if (i0[0x8825]) {
      var g = ifd(u32(i0[0x8825].at));
      if (g[2] && g[4]) {
        var la = rationals(g[2]), lo = rationals(g[4]);
        var lat = la[0] + la[1] / 60 + la[2] / 3600, lon = lo[0] + lo[1] / 60 + lo[2] / 3600;
        if (g[1] && ref(g[1]) === 'S') lat = -lat;
        if (g[3] && ref(g[3]) === 'W') lon = -lon;
        if (isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0)) { out.lat = Math.round(lat * 1e6) / 1e6; out.lon = Math.round(lon * 1e6) / 1e6; }
      }
    }
    return out;
  }
  window.SelfHubExpeditions = { readExif: readExif, open: openTrip };
})();
