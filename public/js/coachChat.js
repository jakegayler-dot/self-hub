// The coach chat (2026-10-26): talk to the trainer or the nutritionist. They can change anything in Self Hub you
// ask for, and they remember. window.SelfHubCoach.mount(el, 'trainer' | 'nutritionist', { switcher: true })
(function () {
  var API = '/api/fitness/coach/';
  var NAMES = { trainer: 'Trainer', nutritionist: 'Nutritionist', stylist: 'Stylist' };
  var HINTS = {
    trainer: 'e.g. "Shoulder\'s sore — change tomorrow" · "I\'m harvesting Mon–Wed" · "Why squats today?" · "Log 5×5 back squat at 245"',
    nutritionist: 'e.g. "Had a Double Big Mac for lunch" · "Plan next week, I\'m in the field Tue–Thu" · "I\'m out of oysters" · "Bump my protein to 190"',
    stylist: 'e.g. "What should I buy for winter?" · "Outfit for a wedding Saturday" · "I bought Blundstones" · "Retire the stained chinos"',
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // A little formatting for the coach's words: **bold**, "- " bullets, line breaks.
  function fmt(t) {
    return esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').split('\n').map(function (l) {
      return /^\s*[-•]\s+/.test(l) ? '<span class="cc-li">' + l.replace(/^\s*[-•]\s+/, '') + '</span>' : l;
    }).join('<br>').replace(/<\/span><br>/g, '</span>').replace(/<br><span class="cc-li">/g, '<span class="cc-li">');
  }
  async function api(method, path, body) {
    var res = await fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    if (res.status === 204) return null;
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  function mount(el, coach, opts) {
    opts = opts || {};
    var state = { coach: coach, poll: null, memOpen: false, lastCount: -1 };
    el.innerHTML =
      '<div class="cc">' +
      '<div class="cc-top">' + (opts.switcher ? '<div class="nu-views cc-switch">' + Object.keys(NAMES).map(function (k) { return '<button class="wk-chipbtn" data-cc="' + k + '">' + NAMES[k] + '</button>'; }).join('') + '</div>' : '') +
      '<div class="cc-tools"><button class="wk-chipbtn cc-mem-btn">Memory</button><button class="wk-chipbtn cc-new">New chat</button></div></div>' +
      '<div class="cc-mem" style="display:none"></div>' +
      '<div class="cc-log"></div>' +
      '<div class="cc-err trk-err"></div>' +
      '<div class="cc-input"><textarea rows="1" placeholder="Message your coach…"></textarea><button class="trk-btn primary cc-send">Send</button></div>' +
      '<div class="trk-note cc-hint"></div></div>';
    var log = el.querySelector('.cc-log'), ta = el.querySelector('textarea'), send = el.querySelector('.cc-send'), err = el.querySelector('.cc-err'), mem = el.querySelector('.cc-mem'), hint = el.querySelector('.cc-hint');

    function setCoach(c) {
      state.coach = c; state.lastCount = -1; state.memOpen = false; mem.style.display = 'none';
      el.querySelectorAll('[data-cc]').forEach(function (b) { b.classList.toggle('on', b.dataset.cc === c); });
      hint.textContent = HINTS[c];
      ta.placeholder = 'Message your ' + NAMES[c].toLowerCase() + '…';
      log.innerHTML = '<p class="trk-note">Loading…</p>';
      load();
    }
    function render(d) {
      var items = d.items || [];
      var busy = d.turn && d.turn.status === 'running';
      var html = items.length ? '' : '<p class="trk-note cc-empty">Talk to your ' + NAMES[state.coach].toLowerCase() + '. Ask for anything — it can change your ' + (state.coach === 'trainer' ? 'sessions, week and logs' : state.coach === 'stylist' ? 'wardrobe, outfits and wishlist' : 'log, meal plan, recipes, pantry, groceries and targets') + ' itself, and it remembers what matters.</p>';
      items.forEach(function (m) {
        if (m.role === 'user') html += '<div class="cc-msg cc-me">' + fmt(m.text) + '</div>';
        else if (m.role === 'coach') html += '<div class="cc-msg cc-them">' + fmt(m.text) + '</div>';
        else html += '<div class="cc-act ' + (m.ok === false ? 'bad' : 'good') + '" title="' + esc(m.detail || '') + '">' + (m.ok === false ? '✗ ' : '✓ ') + esc(m.text) + '</div>';
      });
      if (busy) html += '<div class="cc-msg cc-them cc-typing"><i></i><i></i><i></i></div>';
      if (d.turn && d.turn.status === 'failed') html += '<div class="cc-act bad">✗ ' + esc(d.turn.error || 'That reply failed') + '</div>';
      var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80 || state.lastCount < 0;
      log.innerHTML = html;
      if (stick || items.length !== state.lastCount) log.scrollTop = log.scrollHeight;
      state.lastCount = items.length;
      send.disabled = busy; ta.disabled = false;
      el.querySelector('.cc-mem-btn').textContent = 'Memory (' + (d.memory || []).length + ')';
      if (state.memOpen) renderMem(d.memory || []);
      if (!d.ready) err.textContent = "Sentinel isn't connected, so the coaches are off."; else err.textContent = '';
      err.style.display = err.textContent ? 'block' : 'none';
      clearTimeout(state.poll);
      if (busy) state.poll = setTimeout(load, 1500);
    }
    async function load() {
      var c = state.coach;
      try { var d = await api('GET', c + '/messages'); if (c === state.coach) render(d); }
      catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    }
    function renderMem(list) {
      mem.innerHTML = '<div class="cc-mem-h">What your ' + NAMES[state.coach].toLowerCase() + ' remembers</div>' +
        (list.length ? list.map(function (m) { return '<div class="cc-mem-row"><span>' + esc(m.text) + '</span><button class="trk-del" data-forget="' + m.id + '" title="Forget">✕</button></div>'; }).join('') : '<p class="trk-note">Nothing yet. It saves things as you talk; you can add one here too.</p>') +
        '<div class="cc-mem-add"><input placeholder="Add something it should know"><button class="wk-chipbtn">Add</button></div>';
      mem.querySelectorAll('[data-forget]').forEach(function (b) { b.onclick = async function () { try { await api('DELETE', state.coach + '/memory/' + b.dataset.forget); load(); } catch (e) { err.textContent = e.message; } }; });
      var inp = mem.querySelector('.cc-mem-add input');
      mem.querySelector('.cc-mem-add button').onclick = async function () {
        if (!inp.value.trim()) return;
        try { await api('POST', state.coach + '/memory', { text: inp.value.trim() }); load(); } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
      };
    }
    async function go() {
      var text = ta.value.trim(); if (!text) return;
      send.disabled = true;
      try {
        await api('POST', state.coach + '/messages', { text: text });
        ta.value = ''; ta.style.height = '';
        load();
      } catch (e) { send.disabled = false; err.textContent = e.message; err.style.display = 'block'; }
    }
    send.onclick = go;
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); go(); } });
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
    el.querySelectorAll('[data-cc]').forEach(function (b) { b.onclick = function () { setCoach(b.dataset.cc); }; });
    el.querySelector('.cc-mem-btn').onclick = function () { state.memOpen = !state.memOpen; mem.style.display = state.memOpen ? 'block' : 'none'; load(); };
    el.querySelector('.cc-new').onclick = async function () {
      if (!confirm('Start a new conversation? What it remembers stays.')) return;
      try { await api('DELETE', state.coach + '/messages'); load(); } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
    };
    setCoach(coach);
    return { refresh: load, setCoach: setCoach };
  }
  window.SelfHubCoach = { mount: mount };
})();
