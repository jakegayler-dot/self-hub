// Weekly training load: ACWR-based rating against your own rolling baseline.
// Standard acute:chronic workload ratio approach (Gabbett et al.) — acute is
// this calendar week (Mon–now), chronic is the average of the 4 completed
// weeks before it. A ratio near 1.0 means you're training at your own
// recent normal; well below or above that flags a real shift either way.
// This is a heuristic used widely in S&C, not a precise clinical measure —
// and early in the week "this week" is necessarily partial, so the ratio
// will read low until the week fills in.
//
// Shared by GET /api/fitness/weekly-load (the Health tab panel), the coach
// prompt and the Sentinel read API so they always agree.
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function acwrStatus(r) {
  if (r == null) return 'not enough history yet';
  if (r < 0.8) return 'below your recent baseline';
  if (r <= 1.3) return 'sustainable range';
  if (r <= 1.5) return 'trending high — monitor';
  return 'sharp spike — elevated risk';
}

async function computeWeeklyLoad(pool, now = new Date()) {
  const thisWeekStart = mondayOf(now);
  const chronicStart = addDays(thisWeekStart, -28);
  const liftRows = (await pool.query(
    'SELECT entry_date, lift, load_lb, reps FROM fitness_lifts WHERE entry_date >= $1',
    [chronicStart]
  )).rows;
  const condRows = (await pool.query(
    'SELECT entry_date, duration_seconds FROM fitness_conditioning WHERE entry_date >= $1',
    [chronicStart]
  )).rows;

  function weekIndex(entryDate) {
    // Days from the entry to this Monday: 0..-6 is this week (index 0),
    // 1..7 last week (1), … 22..28 four weeks ago (4). (Was floor(diff / 7),
    // which dropped Tue–Sun of the current week and shifted every week by a day.)
    const diffDays = Math.floor((thisWeekStart - new Date(Date.UTC(entryDate.getUTCFullYear(), entryDate.getUTCMonth(), entryDate.getUTCDate()))) / 86400000);
    if (diffDays < -6) return -1; // after this week
    return diffDays <= 0 ? 0 : Math.ceil(diffDays / 7);
  }

  const tonnageByWeek = [0, 0, 0, 0, 0];
  const strengthDaysByWeek = [new Set(), new Set(), new Set(), new Set(), new Set()];
  const liftNamesThisWeek = new Set();
  liftRows.forEach((l) => {
    const wi = weekIndex(l.entry_date);
    if (wi < 0 || wi > 4) return;
    tonnageByWeek[wi] += Number(l.load_lb) * Number(l.reps);
    const key = l.entry_date.toISOString().slice(0, 10);
    strengthDaysByWeek[wi].add(key);
    if (wi === 0) liftNamesThisWeek.add(l.lift);
  });

  const condMinByWeek = [0, 0, 0, 0, 0];
  const condDaysByWeek = [new Set(), new Set(), new Set(), new Set(), new Set()];
  condRows.forEach((c) => {
    const wi = weekIndex(c.entry_date);
    if (wi < 0 || wi > 4) return;
    if (c.duration_seconds != null) condMinByWeek[wi] += Number(c.duration_seconds) / 60;
    condDaysByWeek[wi].add(c.entry_date.toISOString().slice(0, 10));
  });

  const acuteTonnage = Math.round(tonnageByWeek[0]);
  const chronicTonnage = Math.round((tonnageByWeek[1] + tonnageByWeek[2] + tonnageByWeek[3] + tonnageByWeek[4]) / 4);
  const strengthACWR = chronicTonnage > 0 ? Math.round((acuteTonnage / chronicTonnage) * 100) / 100 : null;

  const acuteCondMin = Math.round(condMinByWeek[0]);
  const chronicCondMin = Math.round((condMinByWeek[1] + condMinByWeek[2] + condMinByWeek[3] + condMinByWeek[4]) / 4);
  const conditioningACWR = chronicCondMin > 0 ? Math.round((acuteCondMin / chronicCondMin) * 100) / 100 : null;

  const profile = (await pool.query('SELECT weekly_strength_sessions_goal, weekly_conditioning_sessions_goal FROM fitness_profile WHERE id = 1')).rows[0];

  return {
    week_start: thisWeekStart.toISOString().slice(0, 10),
    strength: {
      tonnage_this_week_lb: acuteTonnage,
      tonnage_4wk_avg_lb: chronicTonnage,
      acwr: strengthACWR,
      status: acwrStatus(strengthACWR),
      sessions_this_week: strengthDaysByWeek[0].size,
      sessions_goal: profile.weekly_strength_sessions_goal,
    },
    conditioning: {
      minutes_this_week: acuteCondMin,
      minutes_4wk_avg: chronicCondMin,
      acwr: conditioningACWR,
      status: acwrStatus(conditioningACWR),
      sessions_this_week: condDaysByWeek[0].size,
      sessions_goal: profile.weekly_conditioning_sessions_goal,
    },
    lift_names_this_week: [...liftNamesThisWeek],
  };
}

module.exports = { computeWeeklyLoad, mondayOf, addDays, acwrStatus };
