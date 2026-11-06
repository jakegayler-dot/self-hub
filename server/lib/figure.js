// The physique figure (2026-10-31): everything public/js/body3d.js needs to draw Jake's figure, for the Health tab
// and Sentinel alike. One file for both (Nov 5): the page loads it as /js/figure.js (window.SelfHubFigure), so what
// counts as work on a muscle can't differ between the page and Sentinel. Lift patterns come from strength.js, which
// the page loads too.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./strength'));
  else root.SelfHubFigure = factory(root.SelfHubStrength);
})(typeof self !== 'undefined' ? self : this, function (strength) {
  // Population averages the page uses for anything not yet measured (inches).
  var BODY_DEFAULTS = { height_in: 70, shoulder: 18, bust: 40, waist: 34, seat_hips: 38, neck: 15, sleeve: 24, length: 16, inseam: 31 };

  // The 17 muscle groups of body3d.js (SelfHubBody3D.GROUPS), the keys of `sets`.
  var GROUPS = ['chest', 'shoulders', 'traps', 'lats', 'midback', 'lowerback', 'biceps', 'triceps', 'forearms', 'abs',
    'obliques', 'glutes', 'quads', 'adductors', 'hamstrings', 'calves', 'neck'];

  // Which muscles a set works: the main movers count a full set, helpers half (the usual fractional-set count).
  function musclesFor(name) {
    var s = String(name || '').toLowerCase();
    var p = strength.liftPattern(String(name || ''));
    if (/calf/.test(s)) return { calves: 1 };
    if (/shrug/.test(s)) return { traps: 1, forearms: 0.5 };
    if (/curl/.test(s) && /leg|nordic|hamstring/.test(s)) return { hamstrings: 1 };
    if (/curl/.test(s)) return { biceps: 1, forearms: 0.5 };
    if (/tricep|skull|pushdown|push-down|french press|overhead extension/.test(s)) return { triceps: 1 };
    if (/lateral raise|side raise|rear.?delt|face pull|reverse fly|y.?raise|upright row/.test(s)) return { shoulders: 1, traps: 0.5 };
    if (/leg extension/.test(s)) return { quads: 1 };
    if (/hip thrust|glute|kickback|bridge/.test(s)) return { glutes: 1, hamstrings: 0.5 };
    if (/good morning|back extension|hyperextension|superman/.test(s)) return { lowerback: 1, hamstrings: 0.5, glutes: 0.5 };
    // Nov 5: movements that counted for nothing (swings, jumps, rope, HSPU, chin-ups, rack pulls).
    if (/swing/.test(s)) return { hamstrings: 1, glutes: 1, lowerback: 0.5, forearms: 0.5 };
    if (/handstand push|hspu/.test(s)) return { shoulders: 1, triceps: 1, traps: 0.5 };
    if (/box jump|broad jump|jump squat|tuck jump|box step/.test(s)) return { quads: 1, glutes: 0.5, calves: 0.5 };
    if (/double.?under|single.?under|jump rope|skipping|crossover/.test(s)) return { calves: 1 };
    if (/burpee/.test(s)) return { chest: 0.5, quads: 0.5, shoulders: 0.5, triceps: 0.5 };
    if (/chin-?up/.test(s)) return { lats: 1, biceps: 1, midback: 0.5 };
    if (/rack pull|block pull/.test(s)) return { lowerback: 1, traps: 1, glutes: 0.5, hamstrings: 0.5, forearms: 0.5 };
    if (/farmer|suitcase|carry|dead hang|wrist/.test(s)) return { forearms: 1, traps: 0.5, obliques: /suitcase/.test(s) ? 0.5 : 0 };
    if (/rope climb/.test(s)) return { lats: 1, biceps: 1, forearms: 1 };
    if (/pallof|side plank|russian twist|woodchop|oblique/.test(s)) return { obliques: 1, abs: 0.5 };
    if (/sit-?up|toes.?to.?bar|knees.?to|leg raise|crunch|plank|ab wheel|rollout|v-?up|hollow|l-?sit|ghd/.test(s)) return { abs: 1, obliques: 0.5 };
    if (/copenhagen|adduct/.test(s)) return { adductors: 1 };
    if (/neck/.test(s)) return { neck: 1 };
    if (/fly|flye|pec deck/.test(s)) return { chest: 1, shoulders: 0.5 };
    if (/muscle-?up/.test(s)) return { lats: 1, chest: 0.5, triceps: 0.5, biceps: 0.5 };
    if (/lunge|step-?up|split squat|pistol/.test(s)) return { quads: 1, glutes: 1, adductors: 0.5 };
    if (/sumo/.test(s) && /deadlift/.test(s)) return { glutes: 1, hamstrings: 0.5, adductors: 1, quads: 0.5, lowerback: 0.5, forearms: 0.5 };
    if (/romanian|rdl|stiff/.test(s)) return { hamstrings: 1, glutes: 1, lowerback: 0.5 };
    if (/thruster|wall ball/.test(s)) return { quads: 1, glutes: 0.5, shoulders: 1, triceps: 0.5 };
    if (/jerk/.test(s) && !/clean/.test(s)) return { shoulders: 1, triceps: 0.5, quads: 0.5 };
    switch (p) {
      // A loaded squat holds the spine against the bar: the erectors work hard the whole set (Nov 5: sore low back
      // after squats to RPE 9 that the figure didn't show). Bodyweight and machine squats don't.
      // Full squats grow glutes (~6.7%) and adductors (~6.2%) as much as quads (~5%) and hamstrings hardly at all
      // (~0.5%; Kubo et al. 2019): all three count in full, hamstrings not at all (they need a hinge or a curl).
      case 'Squat': return /air squat|goblet|leg press|hack|sissy/.test(s) ? { quads: 1, glutes: 0.5, adductors: 0.5 }
        : { quads: 1, glutes: 1, adductors: 1, lowerback: 0.5 };
      case 'Hinge': return { hamstrings: 1, glutes: 1, lowerback: 0.5, traps: 0.5, forearms: 0.5 };
      case 'Push Vertical': return { shoulders: 1, triceps: 0.5, traps: 0.5 };
      case 'Push Horizontal': return /dip/.test(s) ? { chest: 1, triceps: 1, shoulders: 0.5 } : { chest: 1, triceps: 0.5, shoulders: 0.5 };
      case 'Pull Vertical': return { lats: 1, biceps: 0.5, midback: 0.5 };
      case 'Pull Horizontal': return { midback: 1, lats: 0.5, biceps: 0.5, shoulders: 0.5 };
      case 'Olympic': return /clean.*jerk/.test(s) ? { quads: 1, glutes: 0.5, traps: 1, shoulders: 0.5, triceps: 0.5, lowerback: 0.5 }
        : { quads: 0.5, glutes: 1, hamstrings: 0.5, traps: 1, lowerback: 0.5, shoulders: /snatch/.test(s) ? 0.5 : 0 };
      case 'Core': return { abs: 1, obliques: 0.5 };
      default: return {};
    }
  }

  // Machines, runs, rucks and swims (the conditioning log, and the same words inside a metcon): what a piece of
  // about five minutes works. Null when the name isn't one of these.
  function conditioningMuscles(name) {
    var s = String(name || '').toLowerCase();
    if (/ski.?erg|\bski\b/.test(s)) return { lats: 1, triceps: 0.5, abs: 0.5 };
    if (/row|erg\b|c2/.test(s) && !/barbell|db|dumbbell|kb|kettlebell|ring|seal|pendlay|cable|bent|upright|renegade/.test(s)) {
      return { quads: 0.5, glutes: 0.25, hamstrings: 0.25, lowerback: 0.25, lats: 0.5, midback: 0.5, biceps: 0.25 };
    }
    if (/bike|cycl|echo|assault/.test(s)) return { quads: 1, glutes: 0.5, hamstrings: 0.25 };
    if (/ruck/.test(s)) return { quads: 0.5, glutes: 0.5, calves: 0.5, traps: 0.5, lowerback: 0.25 };
    if (/run|jog|sprint|shuttle/.test(s) && !/running man/.test(s)) return { quads: 0.5, hamstrings: 0.5, glutes: 0.5, calves: 0.5 };
    if (/swim|stroke|flutter kick|kick with fins|freestyle/.test(s)) return { lats: 0.5, shoulders: 0.5, triceps: 0.25 };
    return null;
  }

  var ymd = function (d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); };
  var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
  var parse = function (v) { return typeof v === 'string' ? JSON.parse(v) : v; };

  // Everything that put work on a muscle, as { name, date, n (sets), muscles }:
  //   lifts and gymnastics: each logged row is a set;
  //   conditioning (Nov 5: a hard 500 m row counted for nothing): a set per 5 minutes, at least one;
  //   a metcon he finished (its score logged, or the session marked done): each movement in it a set per 2 minutes
  //   of the piece shared between the movements, 1 to 4 (an 8-minute AMRAP of swings and box jumps: 2 sets each).
  function credits(src) {
    var out = [];
    var add = function (name, date, n, muscles) { if (muscles && Object.keys(muscles).length) out.push({ name: name, date: ymd(date), n: n, muscles: muscles }); };
    (src.lifts || []).forEach(function (l) { add(l.lift, l.entry_date, 1, musclesFor(l.lift)); });
    (src.gymnastics || []).forEach(function (g) { add(g.movement, g.entry_date, 1, musclesFor(g.movement)); });
    (src.conditioning || []).forEach(function (c) {
      var mins = Number(c.duration_seconds) / 60;
      add(c.movement, c.entry_date, mins > 0 ? Math.max(1, Math.round(mins / 5)) : 1, conditioningMuscles(c.movement));
    });
    (src.workouts || []).forEach(function (w) {
      if (w.status === 'skipped') return;
      var body = parse(w.body) || {};
      var date = w.date || w.workout_date;
      (body.blocks || []).forEach(function (b) {
        if (b.kind !== 'metcon' || !(b.result != null || w.status === 'done')) return;
        var items = (b.items || []).filter(function (it) { return it.movement && (it.log_as === 'none' || !it.log_as); });
        if (!items.length) return;
        var n = clamp(Math.round((Number(b.minutes) || 10) / (2 * items.length)), 1, 4);
        items.forEach(function (it) { add(it.movement, date, n, conditioningMuscles(it.movement) || musclesFor(it.movement)); });
      });
    });
    return out;
  }

  // This week's working sets per muscle group, Monday to Sunday (week = { start, end } as YYYY-MM-DD).
  function muscleWeekSets(lifts, gymnastics, week, more) {
    var sets = {};
    credits(Object.assign({ lifts: lifts, gymnastics: gymnastics }, more || {})).forEach(function (c) {
      if (c.date < week.start || c.date > week.end) return;
      Object.keys(c.muscles).forEach(function (g) { if (c.muscles[g]) sets[g] = (sets[g] || 0) + c.muscles[g] * c.n; });
    });
    Object.keys(sets).forEach(function (g) { sets[g] = Math.round(sets[g] * 100) / 100; });
    return sets;
  }

  // Recovery (Jake, Oct 31): what colours the figure. Each set counts in full the day it's done and fades evenly to
  // nothing over 7 days. 0 = fresh (pale yellow); 6 or more (body3d.js FULL_LOAD) = worked hard just now (deep red).
  // today = YYYY-MM-DD in Regina. Rounded to 0.01.
  var RECOVERY_DAYS = 7;
  function muscleLoad(lifts, gymnastics, today, more) {
    var load = {};
    var t = Date.parse(today + 'T00:00:00Z');
    credits(Object.assign({ lifts: lifts, gymnastics: gymnastics }, more || {})).forEach(function (c) {
      var age = Math.round((t - Date.parse(c.date + 'T00:00:00Z')) / 86400000);
      if (!(age >= 0 && age < RECOVERY_DAYS)) return;
      Object.keys(c.muscles).forEach(function (g) { if (c.muscles[g]) load[g] = (load[g] || 0) + c.muscles[g] * c.n * (1 - age / RECOVERY_DAYS); });
    });
    Object.keys(load).forEach(function (g) { load[g] = Math.round(load[g] * 100) / 100; });
    return load;
  }

  // Too much (Nov 5: "highlight areas that are being worked too hard"), from the evidence, in the last 7 days:
  //   session: more than 11 counted sets on the muscle in one day. Growth from a session levels off at about 11
  //     fractional sets (Remmert/Pelland et al. 2024 meta-regression); past it, sets mostly cost recovery.
  //   unrecovered: its recovery-weighted load at 1.5 × a hard session's (FULL_LOAD 6 → 9) or more: trained again and
  //     again before the last sessions had faded.
  // → { group: { why: 'session' | 'unrecovered' | 'both', day, day_sets, load } }.
  var SESSION_CEILING = 11;
  var UNRECOVERED_LOAD = 9;
  function overworked(lifts, gymnastics, today, more) {
    var t = Date.parse(today + 'T00:00:00Z');
    var byDay = {};
    credits(Object.assign({ lifts: lifts, gymnastics: gymnastics }, more || {})).forEach(function (c) {
      var age = Math.round((t - Date.parse(c.date + 'T00:00:00Z')) / 86400000);
      if (!(age >= 0 && age < RECOVERY_DAYS)) return;
      Object.keys(c.muscles).forEach(function (g) {
        if (!c.muscles[g]) return;
        byDay[g] = byDay[g] || {};
        byDay[g][c.date] = (byDay[g][c.date] || 0) + c.muscles[g] * c.n;
      });
    });
    var load = muscleLoad(lifts, gymnastics, today, more);
    var out = {};
    Object.keys(byDay).forEach(function (g) {
      var day = null, most = 0;
      Object.keys(byDay[g]).forEach(function (d) { if (byDay[g][d] > most) { most = byDay[g][d]; day = d; } });
      var session = most > SESSION_CEILING, unrecovered = (load[g] || 0) >= UNRECOVERED_LOAD;
      if (session || unrecovered) out[g] = { why: session && unrecovered ? 'both' : session ? 'session' : 'unrecovered', day: day, day_sets: Math.round(most * 10) / 10, load: load[g] || 0 };
    });
    return out;
  }

  // The body passed to setBody(), from his height and latest tape measurements (defaults where not measured).
  function bodyFor(profile, measurements) {
    var p = profile || {};
    var m = (measurements && measurements.length ? measurements[measurements.length - 1] : null) || {};
    var d = BODY_DEFAULTS;
    var defaults = [];
    var pick = function (val, key) { if (val != null) return Number(val); defaults.push(key); return d[key]; };
    var height = pick(p.height_in, 'height_in');
    var shoulder = pick(m.shoulder, 'shoulder');
    var bust = pick(m.bust, 'bust');
    var waist = pick(m.waist, 'waist');
    var hips = pick(m.seat_hips, 'seat_hips');
    var neck = pick(m.neck, 'neck');
    var sleeve = pick(m.sleeve, 'sleeve');
    var inseam;
    if (m.inseam_low != null && m.inseam_high != null) inseam = (Number(m.inseam_low) + Number(m.inseam_high)) / 2;
    else if (m.inseam_low != null) inseam = Number(m.inseam_low);
    else if (m.inseam_high != null) inseam = Number(m.inseam_high);
    else { inseam = d.inseam; defaults.push('inseam'); }
    return { body: { height: height, shoulder: shoulder, bust: bust, waist: waist, hips: hips, neck: neck, sleeve: sleeve, inseam: inseam }, defaults: defaults };
  }

  // more = { conditioning, workouts }: the rest of what counts (see credits).
  function buildFigure(o) {
    var bf = bodyFor(o.profile, o.measurements);
    var out = {
      height_in: o.profile && o.profile.height_in != null ? Number(o.profile.height_in) : null,
      body: bf.body,
      sets: muscleWeekSets(o.lifts, o.gymnastics, o.week, o.more),
      week_of: o.week.start,
      defaults_used: bf.defaults,
    };
    // body3d.js setLoad(load): the colours. sets stays for the 10-a-week count.
    if (o.today) {
      out.load = muscleLoad(o.lifts, o.gymnastics, o.today, o.more);
      out.over = overworked(o.lifts, o.gymnastics, o.today, o.more); // body3d.js setOver(over): violet
    }
    return out;
  }

  return {
    GROUPS: GROUPS, BODY_DEFAULTS: BODY_DEFAULTS, RECOVERY_DAYS: RECOVERY_DAYS,
    musclesFor: musclesFor, conditioningMuscles: conditioningMuscles, credits: credits,
    muscleWeekSets: muscleWeekSets, muscleLoad: muscleLoad, overworked: overworked, SESSION_CEILING: SESSION_CEILING, UNRECOVERED_LOAD: UNRECOVERED_LOAD, bodyFor: bodyFor, buildFigure: buildFigure,
  };
});
