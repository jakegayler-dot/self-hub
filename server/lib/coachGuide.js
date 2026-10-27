// The part of Self Hub's API each coach uses, for the coach chat's self_hub_api tool (2026-10-26). Paths are
// exact; every route the app serves is callable (list_routes finds the rest). Dates are YYYY-MM-DD (Regina).

const COMMON = `All paths start /api/fitness. GET returns JSON; errors come back as { error } with a 4xx status: read it and fix the call.
Profile and body:
  GET /profile · PUT /profile { phase 0-4, body_fat_target, bodyweight_goal_lb, leaderboard_goal, weekly_strength_sessions_goal, weekly_conditioning_sessions_goal, height_in, physique_target, physique_assessment }
  GET /bodyweight · POST /bodyweight { entry_date, weight_lb, body_fat_pct? } · DELETE /bodyweight/:id
  GET /measurements · POST /measurements { entry_date, waist, bust, shoulder, neck, seat_hips, … inches }
  POST /body-data { date, thigh?, calf?, upper_arm?, waist?, body_fat_pct?, weight_lb?, resting_hr?, age?, fins?, swim_gear? }
  GET /summary (7-day bodyweight average, weekly rate of gain, latest lifts)`;

const TRAINER = `${COMMON}
Training:
  GET /workouts?from=&to= (each: id, date, title, focus, minutes, status planned|done|skipped, body.blocks[].items[].sets[], meta.why…)
  GET /workouts/:id · GET /workouts/week?start= (the coached week: plan, review)
  POST /workouts/custom { date, body: {title, focus, minutes, rationale[], blocks[…]}, objective?, why? }  a new session you write (body as in athlete().schema.body)
  PUT /workouts/:id/refined { body, notes }  replace a session he hasn't started (same body format)
  PUT /workouts/:id/date { date }  move it · PUT /workouts/:id/status { status: planned|done|skipped } · DELETE /workouts/:id
  POST /workouts/:id/revert  back to the rules version · POST /workouts/:id/regenerate  a fresh rules session
  POST /workouts/generate { date, minutes 20-120, focus, equipment: [..] | preset name }  quick rules session
  POST /workouts/plan-week { start_date (Monday), days 4-6, minutes, note?, volume_level beginner|intermediate|advanced|elite, availability: { "YYYY-MM-DD": gym|truck|off }, background: true }  the full trainer plan (takes minutes; GET /workouts/plan-week/status)
  POST /workouts/review-week { start_date }  review the week so far and adjust the rest
Logging what he did:
  POST /workouts/log-entry { date, movement, reps?, load_lb?, rpe?, notes?, distance_m?, duration_s?, output?, minutes?, session_rpe?, session_notes?, done? }  into that day's session (or the history if nothing planned matches)
  POST /workouts/:id/log { block_id, item_id, set_index, reps?, load_lb?, rpe?, duration_s?, distance_m?, output?, notes? } · POST /workouts/:id/unlog { block_id, item_id, set_index }
  PUT /workouts/:id/session { minutes?, rpe? 1-10, notes?, done? }
  POST /lifts { entry_date, lift, load_lb, reps, rpe? } · POST /gymnastics { entry_date, movement, reps, notes? } · POST /conditioning { entry_date, movement, distance_m?, duration_seconds?, notes? }
  POST /benchmarks { entry_date, name, result, rx? } · POST /tests { date, test, value, notes? } · DELETE /lifts/:id etc.
Reading: GET /lifts · /gymnastics · /conditioning · /benchmarks · /tests · /ledger (tests due, numbers missing) · /percentiles · /engine · /weekly-load · /workout-options (equipment, presets, foci)
Food (read only for you): GET /nutrition/day?date= · GET /nutrition/targets`;

const NUTRITIONIST = `${COMMON}
Foods:
  GET /nutrition/foods/search?q=&online=1  his foods + the built-in USDA list (foods); online: USDA branded and Open Food Facts (online[], keys fdc:… / off:…)
  POST /nutrition/foods/import { key }  save an online result as his food (do this before logging it) → { key: "custom:…", serving }
  POST /nutrition/foods/lookup { query }  a restaurant item no database has: Sentinel finds the official numbers (saved)
  GET /nutrition/foods/:key (servings) · POST /nutrition/foods { name, brand?, per_grams, serving_name?, kcal, protein_g, carbs_g, fat_g, fiber_g?, sodium_mg? } (from a label) · POST /nutrition/portions { food_key, name, grams }
The log:
  GET /nutrition/day?date=  targets, totals, remaining, entries, today's planned meals
  POST /nutrition/diary { date, slot breakfast|lunch|dinner|snack, food_key, qty, unit (g|oz|lb|a portion name, e.g. "large egg") } | { date, slot, recipe_id, servings } | { plan_id } (a planned meal, eaten) | { date, slot, name, kcal, protein_g, carbs_g, fat_g } (quick add)
  DELETE /nutrition/diary/:id · GET /nutrition/diary?from=&to=
Recipes and saved meals:
  GET /nutrition/recipes · POST /nutrition/recipes { name, kind recipe|meal, slot breakfast|main|snack, servings, ingredients: [{ food_key, grams, label? }], instructions?, prep_minutes?, portable?, max_per_week? } · PUT /nutrition/recipes/:id (any of those) · DELETE /nutrition/recipes/:id
  POST /nutrition/meals/from-day { date, slot, name }
Targets: GET /nutrition/targets · PUT /nutrition/settings { base_kcal?, protein_g?, training_extra_kcal?, fat_pct?, rate_min_lb?, rate_max_lb?, adaptive?, slots? } · POST /nutrition/targets/recheck
The plan: GET /nutrition/plan?week= · POST /nutrition/plan/generate { week_start } (rules) · POST /nutrition/coach { task: week, week_start, note? } (the full meal planner, in the background) · POST /nutrition/plan { date, slot, recipe_id, servings } · PUT /nutrition/plan/:id { date?, slot?, recipe_id?, servings? } · DELETE /nutrition/plan/:id
Pantry: GET /nutrition/pantry · POST /nutrition/pantry { food_key, qty, unit, mode: add|set } · DELETE /nutrition/pantry/:id
Groceries (also on Sentinel's shopping list): GET /nutrition/groceries · POST /nutrition/groceries { name, quantity?, food_key?, grams? } · PATCH /nutrition/groceries/:id { status: open|bought, name?, quantity? } · DELETE /nutrition/groceries/:id · POST /nutrition/groceries/from-plan
Training (read only for you): GET /workouts?from=&to=`;

module.exports = { trainer: TRAINER, nutritionist: NUTRITIONIST };
