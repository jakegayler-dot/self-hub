// Movement library for the workout generator.
//
// Names match the names the app already logs (the Lift list, the gymnastics
// list, the conditioning list) wherever one exists, so a generated workout
// logs into the same history the strength profile and weekly load read.
//
// Fields:
//   name     — display + log name
//   kind     — 'lift' (fitness_lifts: load × reps), 'gym' (fitness_gymnastics:
//              reps only), 'cond' (fitness_conditioning: distance/time)
//   pattern  — same taxonomy as server/lib/strength.js; 'Conditioning' for
//              monostructural / mixed-modal pieces that don't count toward a
//              strength pattern
//   roles    — which slots it can fill: main (heavy compound), second
//              (secondary strength), oly, acc (accessory), core, skill
//              (gymnastics practice), gstr (gymnastics strength), metcon,
//              mono (metcon cardio piece)
//   equip    — alternatives: [['dumbbells'], ['kettlebells']] = either kit
//              works; [] = needs nothing
//   tags     — physique regions it grows (see the Physique diagram):
//              shoulder, bust, neck, seat_hips, arms
//   loadFrom — when this lift has no logged max, estimate from another
//              lift's e1RM × factor (rough rule-of-thumb ratios)
//   unit     — 'per hand' for dumbbells/kettlebells, 'per side' for
//              unilateral reps
//   metcon   — default per-round reps / load for metcons
//   gymDefault — default reps per set when there's no history

const EQUIPMENT = [
  { id: 'barbell', label: 'Barbell + plates' },
  { id: 'rack', label: 'Squat rack' },
  { id: 'bench', label: 'Bench' },
  { id: 'dumbbells', label: 'Dumbbells' },
  { id: 'kettlebells', label: 'Kettlebells' },
  { id: 'pullup_bar', label: 'Pull-up bar' },
  { id: 'rings', label: 'Rings' },
  { id: 'dip_bars', label: 'Dip bars' },
  { id: 'cable', label: 'Cable / pulldown' },
  { id: 'box', label: 'Plyo box' },
  { id: 'medball', label: 'Wall ball' },
  { id: 'jumprope', label: 'Jump rope' },
  { id: 'rower', label: 'Rower' },
  { id: 'bike', label: 'Assault/Echo bike' },
  { id: 'ski', label: 'Ski erg' },
  // Swimming, the Navy SEAL guide's way (Jake, 2026-10-18: the pool at the Northern Lights Palace, Melfort).
  { id: 'pool', label: 'Pool' },
  { id: 'fins', label: 'Swim fins' },
  { id: 'swim_gear', label: 'Kickboard / pull buoy / paddles' },
];
const SWIM_EQUIPMENT = ['pool', 'fins', 'swim_gear'];
// A gym's kit: everything but the pool (the box has no pool; a swim is its own trip).
const ALL_EQUIPMENT = EQUIPMENT.map((e) => e.id).filter((id) => !SWIM_EQUIPMENT.includes(id));

const EQUIPMENT_PRESETS = {
  box: { label: 'CrossFit box', equipment: ALL_EQUIPMENT },
  home: { label: 'Home gym', equipment: ['barbell', 'rack', 'bench', 'dumbbells', 'kettlebells', 'pullup_bar', 'box', 'jumprope'] },
  dumbbells: { label: 'Dumbbells only', equipment: ['dumbbells', 'bench'] },
  bodyweight: { label: 'Bodyweight only', equipment: [] },
  pool: { label: 'Pool', equipment: SWIM_EQUIPMENT },
};

const BB = [['barbell']];
const BB_RACK = [['barbell', 'rack']];
const DB = [['dumbbells']];
const DB_OR_KB = [['dumbbells'], ['kettlebells']];
const BAR = [['pullup_bar']];
const NONE = [];

const MOVEMENTS = [
  // ---- Squat ----
  { name: 'Back Squat', kind: 'lift', pattern: 'Squat', roles: ['main', 'second'], equip: BB_RACK, tags: ['seat_hips'] },
  { name: 'Front Squat', kind: 'lift', pattern: 'Squat', roles: ['main', 'second', 'oly_support'], equip: BB_RACK, tags: ['seat_hips'], loadFrom: ['Back Squat', 0.85] },
  { name: 'Overhead Squat', kind: 'lift', pattern: 'Squat', roles: ['oly_support'], equip: BB, tags: ['shoulder'], loadFrom: ['Snatch', 1.1] },
  { name: 'Back Rack Lunges', kind: 'lift', pattern: 'Squat', roles: ['acc', 'second'], equip: BB_RACK, tags: ['seat_hips'], unit: 'per side', loadFrom: ['Back Squat', 0.45] },
  { name: 'DB Bulgarian Split Squat', kind: 'lift', pattern: 'Squat', roles: ['acc'], equip: [['dumbbells', 'bench']], tags: ['seat_hips'], unit: 'per hand, per side' },
  { name: 'DB Box Step-Ups', kind: 'lift', pattern: 'Squat', roles: ['acc'], equip: [['dumbbells', 'box'], ['dumbbells', 'bench']], tags: ['seat_hips'], unit: 'per hand, per side' },
  { name: 'Goblet Squat', kind: 'lift', pattern: 'Squat', roles: ['acc', 'second'], equip: DB_OR_KB, tags: ['seat_hips'] },
  { name: 'Thruster', kind: 'lift', pattern: 'Squat', roles: ['metcon'], equip: BB, tags: ['shoulder'], metcon: { reps: 9, load: 95, pct: 0.45, from: 'Front Squat' } },
  { name: 'Pistol Squats', kind: 'gym', pattern: 'Squat', roles: ['gstr', 'metcon'], equip: NONE, tags: ['seat_hips'], unit: 'per side', gymDefault: 5, metcon: { reps: 10, note: 'alternating' } },
  { name: 'Air Squats', kind: 'gym', pattern: 'Squat', roles: ['metcon'], equip: NONE, tags: [], metcon: { reps: 20 } },
  { name: 'Wall Balls', kind: 'gym', pattern: 'Squat', roles: ['metcon'], equip: [['medball']], tags: ['shoulder'], metcon: { reps: 15, note: '20 lb ball, 10 ft target' } },
  { name: 'Box Jumps', kind: 'gym', pattern: 'Squat', roles: ['metcon'], equip: [['box']], tags: [], metcon: { reps: 12, note: '24 in' } },

  // ---- Hinge ----
  { name: 'Deadlift', kind: 'lift', pattern: 'Hinge', roles: ['main', 'second', 'metcon'], equip: BB, tags: ['seat_hips'], metcon: { reps: 10, load: 185, pct: 0.5, from: 'Deadlift' } },
  { name: 'Sumo Deadlift', kind: 'lift', pattern: 'Hinge', roles: ['main'], equip: BB, tags: ['seat_hips'], loadFrom: ['Deadlift', 0.95] },
  { name: 'Romanian Deadlift', kind: 'lift', pattern: 'Hinge', roles: ['second', 'acc'], equip: BB, tags: ['seat_hips'], loadFrom: ['Deadlift', 0.7] },
  { name: 'Barbell Hip Thrust', kind: 'lift', pattern: 'Hinge', roles: ['acc'], equip: [['barbell', 'bench']], tags: ['seat_hips'] },
  { name: 'Elevated Toe Double DB Romanian Deadlift', kind: 'lift', pattern: 'Hinge', roles: ['acc', 'second'], equip: DB, tags: ['seat_hips'], unit: 'per hand' },
  { name: 'KB Swings', kind: 'lift', pattern: 'Hinge', roles: ['metcon', 'acc'], equip: [['kettlebells']], tags: ['seat_hips'], metcon: { reps: 15, load: 53 } },
  { name: 'Clean Pull', kind: 'lift', pattern: 'Hinge', roles: ['oly_support'], equip: BB, tags: ['neck'], loadFrom: ['Clean', 1.1] },
  { name: 'Snatch Pull', kind: 'lift', pattern: 'Hinge', roles: ['oly_support'], equip: BB, tags: ['neck'], loadFrom: ['Snatch', 1.1] },

  // ---- Push vertical ----
  { name: 'Strict Press', kind: 'lift', pattern: 'Push Vertical', roles: ['main', 'second'], equip: BB_RACK, tags: ['shoulder'], loadFrom: ['Push Press', 0.77] },
  { name: 'Push Press', kind: 'lift', pattern: 'Push Vertical', roles: ['main', 'second', 'oly_support'], equip: BB_RACK, tags: ['shoulder'], loadFrom: ['Strict Press', 1.3] },
  { name: 'Seated DB Shoulder Press', kind: 'lift', pattern: 'Push Vertical', roles: ['second', 'acc'], equip: [['dumbbells', 'bench']], tags: ['shoulder'], unit: 'per hand' },
  { name: 'Arnold Press', kind: 'lift', pattern: 'Push Vertical', roles: ['acc'], equip: DB, tags: ['shoulder'], unit: 'per hand' },
  { name: 'HSPU', kind: 'gym', pattern: 'Push Vertical', roles: ['gstr', 'skill', 'metcon'], equip: NONE, tags: ['shoulder'], gymDefault: 4, metcon: { reps: 6 } },
  { name: 'Handstand Walk', kind: 'gym', pattern: 'Balance', roles: ['skill'], equip: NONE, tags: ['shoulder'], gymDefault: 1, setNote: '25 ft' },

  // ---- Push horizontal ----
  { name: 'Bench Press', kind: 'lift', pattern: 'Push Horizontal', roles: ['main', 'second'], equip: [['barbell', 'rack', 'bench']], tags: ['bust'] },
  { name: 'Barbell Incline Bench Press', kind: 'lift', pattern: 'Push Horizontal', roles: ['main', 'second'], equip: [['barbell', 'rack', 'bench']], tags: ['bust', 'shoulder'], loadFrom: ['Bench Press', 0.82] },
  { name: 'Incline DB Press', kind: 'lift', pattern: 'Push Horizontal', roles: ['second', 'acc'], equip: [['dumbbells', 'bench']], tags: ['bust'], unit: 'per hand' },
  { name: 'Alternating DB Bench Press', kind: 'lift', pattern: 'Push Horizontal', roles: ['acc'], equip: [['dumbbells', 'bench']], tags: ['bust'], unit: 'per hand' },
  { name: 'Weighted Dips', kind: 'lift', pattern: 'Push Horizontal', roles: ['second', 'acc'], equip: [['dip_bars', 'dumbbells'], ['rings', 'dumbbells']], tags: ['bust'] },
  { name: 'Ring Dips', kind: 'gym', pattern: 'Push Horizontal', roles: ['gstr'], equip: [['rings']], tags: ['bust'], gymDefault: 6 },
  { name: 'Push-Ups', kind: 'gym', pattern: 'Push Horizontal', roles: ['gstr', 'acc', 'metcon'], equip: NONE, tags: ['bust'], gymDefault: 15, metcon: { reps: 15 } },

  // ---- Pull vertical ----
  { name: 'Weighted Pull-Up', kind: 'lift', pattern: 'Pull Vertical', roles: ['main', 'second'], equip: [['pullup_bar', 'dumbbells'], ['pullup_bar', 'kettlebells']], tags: ['bust'], note: 'load = added weight' },
  { name: 'Strict Pull-Ups', kind: 'gym', pattern: 'Pull Vertical', roles: ['gstr'], equip: BAR, tags: ['bust'], gymDefault: 6 },
  { name: 'Lat Pulldowns', kind: 'lift', pattern: 'Pull Vertical', roles: ['acc', 'second'], equip: [['cable']], tags: ['bust'] },
  { name: 'Chest-to-Bar', kind: 'gym', pattern: 'Pull Vertical', roles: ['skill', 'metcon'], equip: BAR, tags: ['bust'], gymDefault: 8, metcon: { reps: 9 } },
  { name: 'Butterfly Pull-Ups', kind: 'gym', pattern: 'Pull Vertical', roles: ['skill', 'metcon'], equip: BAR, tags: [], gymDefault: 10, metcon: { reps: 12 } },
  { name: 'Bar Muscle-Ups', kind: 'gym', pattern: 'Pull Vertical', roles: ['skill', 'metcon'], equip: BAR, tags: ['bust'], gymDefault: 2, metcon: { reps: 3 } },
  { name: 'Ring Muscle-Ups', kind: 'gym', pattern: 'Pull Vertical', roles: ['skill'], equip: [['rings']], tags: ['bust'], gymDefault: 2 },

  // ---- Pull horizontal ----
  { name: 'Bent Over Row', kind: 'lift', pattern: 'Pull Horizontal', roles: ['second', 'acc'], equip: BB, tags: ['bust'] },
  { name: 'Double DB Standing Bent Over Row', kind: 'lift', pattern: 'Pull Horizontal', roles: ['second', 'acc'], equip: DB, tags: ['bust'], unit: 'per hand' },
  { name: 'Single-Arm DB Row', kind: 'lift', pattern: 'Pull Horizontal', roles: ['acc'], equip: [['dumbbells', 'bench']], tags: ['bust'], unit: 'per side' },
  { name: 'Ring Rows', kind: 'gym', pattern: 'Pull Horizontal', roles: ['gstr', 'acc'], equip: [['rings']], tags: ['bust'], gymDefault: 12 },

  // ---- Olympic ----
  { name: 'Snatch', kind: 'lift', pattern: 'Olympic', roles: ['oly'], equip: BB, tags: ['shoulder', 'neck'] },
  { name: 'Clean & Jerk', kind: 'lift', pattern: 'Olympic', roles: ['oly'], equip: BB, tags: ['shoulder', 'neck'] },
  { name: 'Clean', kind: 'lift', pattern: 'Olympic', roles: ['oly'], equip: BB, tags: ['neck'], loadFrom: ['Clean & Jerk', 1.05] },
  { name: 'Power Clean', kind: 'lift', pattern: 'Olympic', roles: ['oly', 'metcon'], equip: BB, tags: ['neck'], loadFrom: ['Clean', 0.85], metcon: { reps: 6, load: 135, pct: 0.55, from: 'Power Clean' } },
  { name: 'Power Snatch', kind: 'lift', pattern: 'Olympic', roles: ['oly'], equip: BB, tags: ['shoulder'], loadFrom: ['Snatch', 0.85] },
  { name: 'Hang Squat Clean', kind: 'lift', pattern: 'Olympic', roles: ['oly'], equip: BB, tags: ['neck'], loadFrom: ['Clean', 0.9] },
  { name: 'Split Jerk', kind: 'lift', pattern: 'Push Vertical', roles: ['oly'], equip: BB_RACK, tags: ['shoulder'], loadFrom: ['Clean & Jerk', 1.0] },
  { name: 'DB Snatch', kind: 'lift', pattern: 'Olympic', roles: ['oly', 'metcon'], equip: DB, tags: ['shoulder'], unit: 'alternating', metcon: { reps: 10, load: 50 } },

  // ---- Physique accessories (isolation) ----
  { name: 'DB Lateral Raises', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: DB, tags: ['shoulder'], unit: 'per hand', physique: 'Lateral delts — the main driver of shoulder width' },
  { name: 'Cable Lateral Raises', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['cable']], tags: ['shoulder'], unit: 'per side', physique: 'Lateral delts — the main driver of shoulder width' },
  { name: 'Rear Delt Flyes', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: DB, tags: ['shoulder'], unit: 'per hand', physique: 'Rear delts — shoulder width from behind' },
  { name: 'Face Pulls', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['cable']], tags: ['shoulder'], physique: 'Rear delts + upper back' },
  { name: 'Incline Bench DB Chest Fly', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['dumbbells', 'bench']], tags: ['bust'], unit: 'per hand' },
  { name: 'Barbell Shrugs', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: BB_RACK, tags: ['neck'], physique: 'Upper traps — neck size' },
  { name: 'DB Shrugs', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: DB, tags: ['neck'], unit: 'per hand', physique: 'Upper traps — neck size' },
  { name: 'DB Preacher Curl', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['dumbbells', 'bench']], tags: ['arms'], unit: 'per hand' },
  { name: 'Standing KB Crush Grip Bicep Curl', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['kettlebells']], tags: ['arms'] },
  { name: 'Barbell Skull Crushers', kind: 'lift', pattern: 'Accessory', roles: ['acc'], equip: [['barbell', 'bench']], tags: ['arms'] },

  // ---- Core: bodyweight only (heavy loaded oblique work thickens the waist) ----
  { name: 'Toes-to-Bar', kind: 'gym', pattern: 'Core', roles: ['core', 'metcon', 'skill'], equip: BAR, tags: [], gymDefault: 10, metcon: { reps: 12 } },
  { name: 'Sit-Ups', kind: 'gym', pattern: 'Core', roles: ['core', 'metcon'], equip: NONE, tags: [], gymDefault: 20, metcon: { reps: 20 } },
  { name: 'Hollow Rocks', kind: 'gym', pattern: 'Core', roles: ['core'], equip: NONE, tags: [], gymDefault: 20 },
  { name: 'V-Ups', kind: 'gym', pattern: 'Core', roles: ['core', 'metcon'], equip: NONE, tags: [], gymDefault: 15, metcon: { reps: 15 } },
  { name: 'Hanging Knee Raises', kind: 'gym', pattern: 'Core', roles: ['core'], equip: BAR, tags: [], gymDefault: 12 },

  // ---- Metcon full-body / monostructural ----
  { name: 'Burpees', kind: 'gym', pattern: 'Conditioning', roles: ['metcon'], equip: NONE, tags: [], metcon: { reps: 10 } },
  { name: 'Double-Unders', kind: 'gym', pattern: 'Conditioning', roles: ['mono'], equip: [['jumprope']], tags: [], metcon: { reps: 40 } },
  { name: 'Row', kind: 'cond', pattern: 'Conditioning', roles: ['mono'], equip: [['rower']], tags: [], metcon: { cal: 15 } },
  { name: 'Bike', kind: 'cond', pattern: 'Conditioning', roles: ['mono'], equip: [['bike']], tags: [], metcon: { cal: 12 } },
  { name: 'Ski Erg', kind: 'cond', pattern: 'Conditioning', roles: ['mono'], equip: [['ski']], tags: [], metcon: { cal: 12 } },
  { name: 'Run', kind: 'cond', pattern: 'Conditioning', roles: ['mono'], equip: NONE, tags: [], metcon: { meters: 400 } },
  // Swims (log distance and time). No generator roles: the trainer programs swims.
  { name: 'Swim (freestyle)', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool']], tags: [] },
  { name: 'Swim with fins', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool', 'fins']], tags: [] },
  { name: 'Sidestroke with fins', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool', 'fins']], tags: [] },
  { name: 'Breaststroke', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool']], tags: [] },
  { name: 'Kick with fins', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool', 'fins']], tags: [] },
  { name: 'Pull (pull buoy)', kind: 'cond', pattern: 'Conditioning', roles: [], equip: [['pool', 'swim_gear']], tags: [] },
];

const BY_NAME = new Map(MOVEMENTS.map((m) => [m.name, m]));

function hasEquipment(m, available) {
  if (!m.equip.length) return true;
  const have = new Set(available);
  return m.equip.some((group) => group.every((t) => have.has(t)));
}

module.exports = { EQUIPMENT, ALL_EQUIPMENT, EQUIPMENT_PRESETS, MOVEMENTS, BY_NAME, hasEquipment };
