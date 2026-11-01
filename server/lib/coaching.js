// The trainer's coaching (Jake, Nov 1: "make it feel like a personal trainer… walk me through a stretching warmup,
// talk about form, tempo, and where I should focus the tension. For complex movements recommend a video… show what
// each movement is doing"). One library, loaded by the server (require) and the page (/js/coaching.js), so the session
// card, the side panel and the coach all say the same thing.
//
// Per movement: the muscles (the 3D figure's groups), what it does to them, setup, form cues, where to put the
// tension, the usual mistake, its tempo style, and, for complex lifts, a video search (YouTube search pages for named
// coaches: real results, never a made-up link). Movements not listed fall back to their pattern.
// Warm-ups are dynamic (moving through range, then ramp-up sets): long static holds before lifting cut force output,
// so the long stretches are in the cool-down.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SelfHubCoaching = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // tempo styles: 'barbell' (heavy compound), 'accessory', 'strict' (bodyweight strength), 'dynamic' (kipping, rhythm),
  // 'ballistic' (jumps, swings, throws), 'olympic', 'cardio'
  var M = {};
  function add(names, e) { e.name = names.split('|')[0]; names.split('|').forEach(function (n) { M[n] = e; }); }

  // ---- squat ----
  add('Back Squat', { primary: ['quads', 'glutes'], secondary: ['adductors', 'lowerback', 'abs'], tempo: 'barbell',
    does: 'Loads the quads and glutes through a deep knee and hip bend under the heaviest load you can stand under. Heavy triples to fives build maximal strength; 6–12 reps build size in the legs and glutes.',
    setup: 'Bar on the upper traps, hands just outside the shoulders, elbows under the bar. Feet shoulder-width, toes out 15–30°.',
    cues: ['Big breath into the belly, brace like you’re about to be punched, then unrack.', 'Break at hips and knees together; knees track over the toes.', 'Sit between your hips, to just below parallel, chest up.', 'Drive the floor away and lead with the chest out of the hole.'],
    tension: 'Brace hard through the trunk the whole rep and keep the whole foot rooted (big toe, little toe, heel). Feel the quads and glutes load at the bottom.',
    mistake: 'Hips shooting up first out of the bottom (turning it into a good morning): brace harder and drive the chest up with the hips.',
    video: 'Squat University back squat technique' });
  add('Front Squat', { primary: ['quads'], secondary: ['glutes', 'abs', 'midback', 'adductors'], tempo: 'barbell',
    does: 'An upright squat with the bar on the front of the shoulders: more quad and upper-back demand than the back squat, and the catch position of the clean.',
    setup: 'Bar on the front delts against the throat, fingertips under the bar, elbows high and forward.',
    cues: ['Elbows up the whole time: if they drop, the bar rolls.', 'Sit straight down between the heels.', 'Stay tall; drive up through the upper back.'],
    tension: 'Upper back and trunk. Think “elbows to the ceiling” out of the bottom.',
    mistake: 'Elbows dropping and the chest folding forward.', video: 'Catalyst Athletics front squat' });
  add('Overhead Squat', { primary: ['quads', 'shoulders'], secondary: ['traps', 'abs', 'glutes', 'midback'], tempo: 'barbell',
    does: 'A full squat with the bar locked out overhead in a wide grip: stability and mobility through the ankles, hips, thoracic spine and shoulders. The receiving position of the snatch.',
    setup: 'Snatch-width grip, bar over the back of the neck, armpits turned forward.',
    cues: ['Push up into the bar the whole time.', 'Keep the bar over mid-foot as you descend.', 'Sit straight down; chest proud.'],
    tension: 'Actively press the bar to the ceiling and squeeze the shoulder blades up and together.',
    mistake: 'Soft elbows and the bar drifting forward.', video: 'Catalyst Athletics overhead squat' });
  add('Back Rack Lunges|Walking Lunges|Lunges', { primary: ['quads', 'glutes'], secondary: ['adductors', 'hamstrings', 'abs'], tempo: 'accessory',
    does: 'Single-leg strength and balance: each leg works alone, so a weak side can’t hide, and the glutes stretch under load on the back leg.',
    setup: 'Bar on the back like a squat; step long enough that the front shin stays near vertical.',
    cues: ['Step, drop the back knee straight down to just off the floor.', 'Drive through the front heel.', 'Trunk stays tall.'],
    tension: 'Front glute and quad. Push the floor down with the whole front foot.', mistake: 'Short steps that pile the load onto the front knee.', video: null });
  add('DB Bulgarian Split Squat|Bulgarian Split Squat', { primary: ['quads', 'glutes'], secondary: ['adductors', 'hamstrings'], tempo: 'accessory',
    does: 'Rear foot elevated split squat: a deep, heavy single-leg stretch of the front glute and quad. One of the best leg builders for the load.',
    setup: 'Back foot laces-down on a bench, front foot far enough forward that you can drop straight down.',
    cues: ['Drop straight down; the back knee nearly touches.', 'Lean the trunk slightly forward for more glute.', 'Drive up through the front foot.'],
    tension: 'Front leg only: the back leg is a kickstand.', mistake: 'Pushing off the back foot.', video: 'Squat University Bulgarian split squat' });
  add('DB Box Step-Ups|Step-Ups', { primary: ['quads', 'glutes'], secondary: ['calves', 'hamstrings'], tempo: 'accessory',
    does: 'Single-leg drive up onto a box: quad and glute strength with little back load.', setup: 'Box about knee height; whole foot on the box.',
    cues: ['Drive through the top foot, not a jump off the bottom one.', 'Stand tall at the top.', 'Lower under control.'],
    tension: 'The leg on the box: push it through the heel and stand all the way up with the glute.', mistake: 'Bouncing off the bottom foot.', video: null });
  add('Goblet Squat', { primary: ['quads', 'glutes'], secondary: ['abs', 'adductors', 'midback'], tempo: 'accessory',
    does: 'A front-loaded squat with a dumbbell or kettlebell: grooves an upright squat and opens the hips.', setup: 'Bell held at the chest, elbows inside the knees at the bottom.',
    cues: ['Sit between the heels.', 'Push the knees out with the elbows at the bottom.', 'Stay tall.'], tension: 'Brace the trunk around the bell and feel the quads load at the bottom.', mistake: 'Heels lifting.', video: null });
  add('Thruster', { primary: ['quads', 'shoulders'], secondary: ['glutes', 'triceps', 'abs'], tempo: 'ballistic',
    does: 'A front squat straight into a push press: whole-body power and a big metabolic hit. The engine of Fran.',
    setup: 'Front rack, elbows a little lower than for a front squat.', cues: ['Squat fast, drive hard out of the bottom.', 'Use the leg drive to throw the bar up.', 'Head through at the top, then straight back down.'],
    tension: 'Legs and hips: the arms finish what the legs start.', mistake: 'Pressing before the hips finish.', video: 'CrossFit thruster technique' });
  add('Pistol Squats', { primary: ['quads', 'glutes'], secondary: ['abs', 'calves', 'adductors'], tempo: 'strict',
    does: 'A full single-leg squat: strength, balance and ankle and hip mobility.', setup: 'Free leg out in front, arms forward as a counterweight.',
    cues: ['Sit back and down; heel down.', 'Reach the arms forward as you descend.', 'Stand up through the whole foot.'],
    tension: 'Working quad and glute; squeeze the free leg’s quad to keep it up.', mistake: 'Heel lifting and the knee caving in.', video: 'CrossFit pistol progression' });
  add('Air Squats', { primary: ['quads', 'glutes'], secondary: ['adductors', 'calves'], tempo: 'dynamic',
    does: 'Unloaded squats: muscular endurance and a warm-up for every squat pattern.', setup: 'Feet shoulder-width.',
    cues: ['Hips back and down, below parallel.', 'Knees out.', 'Stand all the way up.'], tension: 'Light: speed and full range.', mistake: 'Cutting depth.', video: null });
  add('Wall Balls', { primary: ['quads', 'shoulders'], secondary: ['glutes', 'triceps'], tempo: 'ballistic',
    does: 'A squat into a throw at a 10 ft target: leg drive, shoulders and a heavy breathing load.', setup: 'Ball at the chin, an arm’s length from the wall.',
    cues: ['Full squat, then drive up and throw.', 'Catch high and ride it into the next squat.', 'Breathe at the top.'], tension: 'Legs drive the ball; arms guide it.', mistake: 'Throwing with the arms.', video: null });
  add('Box Jumps', { primary: ['quads', 'glutes', 'calves'], secondary: ['hamstrings'], tempo: 'ballistic',
    does: 'Explosive jumping: power and rate of force development in the hips, knees and ankles.', setup: 'Stand close to the box.',
    cues: ['Load the hips, swing the arms, jump.', 'Land soft and stand up fully on the box.', 'Step down to save the Achilles.'], tension: 'Explode through the hips.', mistake: 'Rebounding down off a high box (Achilles risk).', video: null });

  // ---- hinge ----
  add('Deadlift', { primary: ['hamstrings', 'glutes', 'lowerback'], secondary: ['traps', 'forearms', 'lats', 'quads'], tempo: 'barbell',
    does: 'Lifts the heaviest load off the floor by extending the hips: the posterior chain from the hamstrings to the upper back, and grip.',
    setup: 'Bar over mid-foot, shins a few cm away. Hip-width stance, hands just outside the legs.',
    cues: ['Push the hips back to reach the bar; shins touch it.', 'Pull the slack out of the bar: arms long, lats on.', 'Push the floor away; bar drags up the legs.', 'Finish by squeezing the glutes, not leaning back.'],
    tension: 'Lats (“bend the bar around your shins”) and a braced trunk before the bar leaves the floor.',
    mistake: 'Jerking the bar off the floor with slack in the arms, so the back rounds.', video: 'Squat University deadlift technique' });
  add('Sumo Deadlift', { primary: ['glutes', 'adductors', 'quads'], secondary: ['hamstrings', 'lowerback', 'traps', 'forearms'], tempo: 'barbell',
    does: 'A wide-stance deadlift: more hip and inner-thigh, less lower-back angle.', setup: 'Wide stance, toes out, hands inside the legs, shins vertical.',
    cues: ['Spread the floor with the feet.', 'Hips close to the bar, chest up.', 'Push the knees out as you pull.'], tension: 'Glutes and adductors.', mistake: 'Hips rising before the bar moves.', video: 'Squat University sumo deadlift' });
  add('Romanian Deadlift|RDL', { primary: ['hamstrings', 'glutes'], secondary: ['lowerback', 'forearms', 'traps'], tempo: 'accessory',
    does: 'A hip hinge from standing with soft knees: loads the hamstrings in a long stretch, one of the best hamstring builders.',
    setup: 'Start standing; knees soft and fixed.', cues: ['Push the hips back, bar slides down the thighs.', 'Stop when the hamstrings are tight (about mid-shin).', 'Drive the hips forward to stand.'],
    tension: 'Hamstrings at the stretch. Feel them load; the back stays neutral.', mistake: 'Bending the knees more to reach lower.', video: 'Squat University Romanian deadlift' });
  add('Elevated Toe Double DB Romanian Deadlift', { primary: ['hamstrings', 'glutes'], secondary: ['calves', 'lowerback', 'forearms'], tempo: 'accessory',
    does: 'An RDL with the toes raised: pre-stretches the calves and hamstrings for a deeper hamstring stretch at lighter loads.',
    setup: 'Balls of the feet on a plate, a dumbbell in each hand.', cues: ['Hips back, dumbbells close to the legs.', 'Feel the hamstrings stretch.', 'Squeeze the glutes to stand.'],
    tension: 'Hamstrings through the whole range.', mistake: 'Rushing the lowering.', video: null });
  add('Barbell Hip Thrust|Hip Thrust', { primary: ['glutes'], secondary: ['hamstrings', 'quads'], tempo: 'accessory',
    does: 'Hip extension with the glutes fully shortened under load: the most direct heavy glute work.', setup: 'Upper back on a bench, bar padded over the hips, feet flat.',
    cues: ['Chin tucked, ribs down.', 'Drive through the heels to full hip extension.', 'Pause one second at the top.'], tension: 'Glutes at the top: squeeze as if cracking a walnut.', mistake: 'Arching the lower back instead of extending the hips.', video: null });
  add('KB Swings|Kettlebell Swing|Kettlebell Swings', { primary: ['glutes', 'hamstrings'], secondary: ['lowerback', 'abs', 'shoulders', 'forearms'], tempo: 'ballistic',
    does: 'A ballistic hip hinge: explosive hip power and conditioning with the back in a safe position.', setup: 'Bell a foot in front, hike it back between the legs.',
    cues: ['Hike it high between the thighs.', 'Snap the hips forward; the arms are ropes.', 'Stand tall and brace at the top.'], tension: 'Glutes snap; abs braced at the top.', mistake: 'Squatting the swing or lifting with the arms.', video: null });
  add('Clean Pull|Snatch Pull', { primary: ['hamstrings', 'glutes', 'traps'], secondary: ['quads', 'lowerback', 'forearms'], tempo: 'olympic',
    does: 'The first and second pulls of the clean or snatch without the catch: builds pulling strength and teaches full hip extension.',
    setup: 'Set up as for the clean or snatch.', cues: ['Patient off the floor; same back angle to the knees.', 'Bar close: brush the thighs.', 'Extend hard: legs, hips, then shrug.'],
    tension: 'Legs push, then a violent hip extension.', mistake: 'Pulling with the arms early.', video: 'Catalyst Athletics clean pull' });

  // ---- push ----
  add('Strict Press|Shoulder Press', { primary: ['shoulders', 'triceps'], secondary: ['traps', 'abs', 'chest'], tempo: 'barbell',
    does: 'Presses the bar overhead with no leg drive: front and side delts and triceps, with the trunk braced to stay still.',
    setup: 'Bar on the front of the shoulders, grip just outside them, forearms vertical.', cues: ['Squeeze glutes and abs; ribs down.', 'Head back, bar straight up past the face.', 'Head through at lockout: bar over the mid-foot.'],
    tension: 'Glutes and abs locked so the press comes from the shoulders, not a back lean.', mistake: 'Leaning back to finish the rep.', video: 'Squat University overhead press' });
  add('Push Press', { primary: ['shoulders', 'triceps', 'quads'], secondary: ['traps', 'glutes', 'abs'], tempo: 'ballistic',
    does: 'A short knee dip and drive launches the bar, the arms finish: lets you move more weight overhead than a strict press and trains leg-to-arm power.',
    setup: 'Front rack as for the strict press.', cues: ['Dip straight down a few inches, heels down.', 'Drive hard through the legs.', 'Punch the arms to lockout.'], tension: 'Quads drive; the trunk stays rigid.', mistake: 'Dipping forward onto the toes.', video: 'CrossFit push press' });
  add('Seated DB Shoulder Press|DB Shoulder Press', { primary: ['shoulders', 'triceps'], secondary: ['traps', 'chest'], tempo: 'accessory',
    does: 'Seated dumbbell pressing isolates the shoulders: more range and each side works alone.', setup: 'Back against an upright bench, dumbbells at ear height.',
    cues: ['Press up and slightly in.', 'Lower to ear level under control.', 'Keep the ribs down.'], tension: 'Shoulders: press the dumbbells up and slightly together, ribs down so the chest doesn’t take over.', mistake: 'Arching off the bench.', video: null });
  add('Arnold Press', { primary: ['shoulders'], secondary: ['triceps', 'traps'], tempo: 'accessory',
    does: 'A rotating dumbbell press: hits all three heads of the delts through a long range.', setup: 'Dumbbells at the chin, palms facing you.',
    cues: ['Rotate the palms out as you press.', 'Finish palms forward, arms straight.', 'Reverse it on the way down.'], tension: 'Shoulders the whole way: keep them loaded at the bottom instead of resting.', mistake: 'Rushing the rotation.', video: null });
  add('Split Jerk', { primary: ['shoulders', 'quads', 'triceps'], secondary: ['glutes', 'traps', 'abs'], tempo: 'olympic',
    does: 'Dip, drive and split under the bar: the fastest way to get the most weight overhead. Speed and timing more than strength.',
    setup: 'Front rack, feet hip-width.', cues: ['Vertical dip and drive.', 'Punch under the bar as the feet split.', 'Recover front foot back, then back foot forward.'], tension: 'Drive with the legs; lock the arms hard as you land.', mistake: 'Pressing the bar out instead of getting under it.', video: 'Catalyst Athletics split jerk' });
  add('HSPU|Handstand Push-Ups|Strict HSPU', { primary: ['shoulders', 'triceps'], secondary: ['traps', 'abs'], tempo: 'strict',
    does: 'Pressing your bodyweight upside down: overhead strength and shoulder stability.', setup: 'Hands a little wider than shoulders, a tripod with the head at the bottom.',
    cues: ['Lower under control to the tripod.', 'Press back to lockout.', 'Squeeze the glutes; don’t arch.'], tension: 'Shoulders and triceps; trunk tight.', mistake: 'Head too far forward of the hands.', video: 'CrossFit handstand push-up progression' });
  add('Handstand Walk', { primary: ['shoulders'], secondary: ['abs', 'traps', 'triceps'], tempo: 'dynamic',
    does: 'Balance and shoulder endurance upside down.', setup: 'Kick up close to vertical, hips stacked over the shoulders.',
    cues: ['Push tall through the shoulders.', 'Small steps; fall forward under control.', 'Fingers grip the floor to steer.'], tension: 'Shoulders pushed tall; legs together.', mistake: 'Banana back.', video: 'CrossFit handstand walk progression' });
  add('Bench Press', { primary: ['chest', 'triceps'], secondary: ['shoulders', 'lats'], tempo: 'barbell',
    does: 'The heaviest horizontal press: chest, front delts and triceps. Heavy sets for strength, 6–12 reps for chest size.',
    setup: 'Eyes under the bar, shoulder blades pinched down and back, feet planted, grip just outside shoulder width.',
    cues: ['Lower to the lower chest, elbows about 45°.', 'Touch and press back toward the face.', 'Drive the feet into the floor.'], tension: 'Shoulder blades pinned back the whole set; chest up to meet the bar.', mistake: 'Elbows flared to 90° and bouncing off the chest.', video: 'Squat University bench press' });
  add('Barbell Incline Bench Press|Incline Bench Press', { primary: ['chest', 'shoulders'], secondary: ['triceps'], tempo: 'barbell',
    does: 'Pressing on a 30–45° incline shifts work to the upper chest and front delts: the upper chest is what fills out a V-taper from the front.',
    setup: 'Bench at 30–45°, shoulder blades back and down.', cues: ['Lower to the upper chest.', 'Press up and slightly back.', 'Keep the chest up.'], tension: 'Pin the shoulder blades into the bench and feel the upper chest stretch at the bottom; think of pushing yourself away from the bar.', mistake: 'Too steep an angle (it becomes a shoulder press).', video: null });
  add('Incline DB Press|Alternating DB Bench Press|DB Bench Press', { primary: ['chest'], secondary: ['shoulders', 'triceps'], tempo: 'accessory',
    does: 'Dumbbell pressing: a deeper stretch at the bottom than a barbell and each side works alone.', setup: 'Shoulder blades pinned, dumbbells at the chest.',
    cues: ['Lower until the chest stretches.', 'Press up and slightly in.', 'Control the bottom.'], tension: 'Let the dumbbells sink until the chest stretches, then squeeze the chest to bring them up, as if pinching a coin between the pecs.', mistake: 'Cutting the range short.', video: null });
  add('Weighted Dips|Ring Dips|Dips', { primary: ['chest', 'triceps'], secondary: ['shoulders'], tempo: 'strict',
    does: 'Pressing your bodyweight down between bars or rings: lower chest and triceps, a big compound for the upper body.',
    setup: 'Arms locked, shoulders down away from the ears.', cues: ['Lower until the shoulders are just below the elbows.', 'Lean slightly forward for more chest.', 'Press to full lockout.'], tension: 'Chest and triceps; shoulders stay down.', mistake: 'Shrugging into the bottom.', video: null });
  add('Push-Ups', { primary: ['chest', 'triceps'], secondary: ['shoulders', 'abs'], tempo: 'strict',
    does: 'A moving plank: chest, triceps and front delts with the trunk held rigid.', setup: 'Hands under the shoulders, body straight.',
    cues: ['Chest to the floor.', 'Elbows about 45°.', 'Glutes and abs tight.'], tension: 'Push the floor away.', mistake: 'Hips sagging.', video: null });

  // ---- pull ----
  add('Strict Pull-Ups|Pull-Ups|Pull-up|Weighted Pull-Up|Chin-Ups', { primary: ['lats', 'biceps'], secondary: ['midback', 'forearms', 'abs'], tempo: 'strict',
    does: 'Vertical pulling with your bodyweight: lats and biceps. Lats are the width in a V-taper.',
    setup: 'Hands just outside the shoulders, dead hang.', cues: ['Start by pulling the shoulders down away from the ears.', 'Drive the elbows down to the ribs.', 'Chin over the bar; lower all the way.'], tension: 'Lats: think “elbows to the back pockets”.', mistake: 'Half reps and kicking.', video: 'Squat University pull-up' });
  add('Lat Pulldowns', { primary: ['lats'], secondary: ['biceps', 'midback'], tempo: 'accessory',
    does: 'The pull-up pattern at any load: lat width.', setup: 'Thighs locked under the pad, grip just wider than shoulders.',
    cues: ['Shoulders down first.', 'Pull to the upper chest, elbows down.', 'Full stretch at the top.'], tension: 'Lats: pull the elbows down into the back pockets and feel the sides of the back work, not the biceps.', mistake: 'Leaning back and rowing it.', video: null });
  add('Chest-to-Bar', { primary: ['lats'], secondary: ['biceps', 'abs', 'midback'], tempo: 'dynamic',
    does: 'A kipping pull-up that finishes with the chest at the bar: more range and more lat.', setup: 'As a kipping pull-up.',
    cues: ['Big hollow-to-arch swing.', 'Snap the hips to the bar.', 'Pull the chest to the bar.'], tension: 'Lats at the finish.', mistake: 'Chin over but chest short.', video: 'CrossFit chest-to-bar pull-up' });
  add('Butterfly Pull-Ups|Kipping Pull-Ups|Pull-ups (Kipping)', { primary: ['lats'], secondary: ['biceps', 'abs', 'shoulders'], tempo: 'dynamic',
    does: 'A cycling kipping pull-up for speed: lats and trunk timing; high reps for conditioning.', setup: 'Strong strict pulling and a solid kip first.',
    cues: ['Circle: chin up and over, hips back under.', 'Small, fast cycles.', 'Stay tight through the shoulders.'], tension: 'Lats and abs in rhythm.', mistake: 'Learning it before 8–10 strict pull-ups (shoulder strain).', video: 'CrossFit butterfly pull-up progression' });
  add('Bar Muscle-Ups|Ring Muscle-Ups|Muscle-Ups', { primary: ['lats', 'chest', 'triceps'], secondary: ['biceps', 'shoulders', 'abs'], tempo: 'dynamic',
    does: 'A pull into a dip over the bar or rings: pulling power, transition speed and pressing.', setup: 'Strong chest-to-bar and dips first.',
    cues: ['Big hollow-arch kip.', 'Hips to the bar, then sit up fast over it.', 'Press out to lockout.'], tension: 'Lats then chest and triceps.', mistake: 'Chicken-winging one arm over.', video: 'CrossFit muscle-up progression' });
  add('Bent Over Row|Double DB Standing Bent Over Row|Single-Arm DB Row|Barbell Row', { primary: ['midback', 'lats'], secondary: ['biceps', 'lowerback', 'traps'], tempo: 'accessory',
    does: 'Horizontal pulling: mid-back thickness (rhomboids, mid traps) and lats; balances all the pressing.',
    setup: 'Hinge to about 45°, back flat, weight hanging.', cues: ['Pull the elbows back toward the hips.', 'Squeeze the shoulder blades together at the top.', 'Lower to a full stretch.'], tension: 'Between the shoulder blades: pull with the elbows, not the hands, and hold the squeeze a beat.', mistake: 'Jerking it up with the back.', video: null });
  add('Ring Rows', { primary: ['midback', 'lats'], secondary: ['biceps'], tempo: 'strict',
    does: 'Bodyweight horizontal pulling; walk the feet forward to make it harder.', setup: 'Body straight, heels down.', cues: ['Chest to the rings.', 'Squeeze the shoulder blades.', 'Lower slowly.'], tension: 'Between the shoulder blades: lead with the chest and squeeze them together at the top.', mistake: 'Hips sagging.', video: null });

  // ---- olympic ----
  add('Snatch|Power Snatch|DB Snatch', { primary: ['glutes', 'hamstrings', 'quads', 'traps'], secondary: ['shoulders', 'lowerback', 'abs'], tempo: 'olympic',
    does: 'Floor to overhead in one move: the most demanding power lift. Trains hip power, speed and mobility.',
    setup: 'Wide grip, bar over mid-foot, hips higher than the clean, chest up.', cues: ['Patient off the floor.', 'Bar close; finish the extension.', 'Pull yourself under fast and punch up into the catch.'],
    tension: 'Legs and hips drive; arms only guide the bar close.', mistake: 'Swinging the bar away from the body.', video: 'Catalyst Athletics snatch technique' });
  add('Clean & Jerk|Clean and Jerk', { primary: ['quads', 'glutes', 'hamstrings', 'shoulders'], secondary: ['traps', 'triceps', 'lowerback', 'abs'], tempo: 'olympic',
    does: 'The clean to the shoulders then the jerk overhead: whole-body power and the heaviest weight taken overhead.',
    setup: 'As for the clean.', cues: ['Clean: patient off the floor, extend, pull under, elbows fast.', 'Stand, re-grip, breathe.', 'Jerk: vertical dip and drive, punch under.'], tension: 'Hips on the clean, legs on the jerk.', mistake: 'Rushing the jerk without resetting.', video: 'Catalyst Athletics clean and jerk' });
  add('Clean|Power Clean|Hang Squat Clean|Hang Power Clean|Squat Clean', { primary: ['quads', 'glutes', 'hamstrings', 'traps'], secondary: ['lowerback', 'forearms', 'abs'], tempo: 'olympic',
    does: 'Floor (or hang) to the shoulders in one explosive pull: hip power and speed.',
    setup: 'Grip just outside the legs, bar over mid-foot, shoulders over the bar.', cues: ['Push with the legs off the floor.', 'Bar brushes the thighs; explode the hips.', 'Elbows fast around to the front rack.'], tension: 'Hips extend violently; then fast elbows.', mistake: 'Reverse-curling the bar.', video: 'Catalyst Athletics clean technique' });

  // ---- accessories ----
  add('DB Lateral Raises|Cable Lateral Raises|Lateral Raises', { primary: ['shoulders'], secondary: ['traps'], tempo: 'accessory',
    does: 'Isolates the side delts: the muscle that makes the shoulders wider. The most direct V-taper exercise.',
    setup: 'Slight lean forward, soft elbows.', cues: ['Lead with the elbows out to the sides.', 'Stop at shoulder height.', 'Lower slowly (3 seconds).'], tension: 'Side delt: think “push the dumbbells out to the walls”, not up.', mistake: 'Shrugging and swinging.', video: null });
  add('Rear Delt Flyes|Face Pulls|Reverse Flyes', { primary: ['shoulders', 'midback'], secondary: ['traps'], tempo: 'accessory',
    does: 'The rear delts and upper back: rounds out the shoulders from behind and balances pressing for healthier shoulders.',
    setup: 'Light weight, slight bend at the elbows.', cues: ['Pull the hands apart and back.', 'Pause with the shoulder blades squeezed.', 'Lower slowly.'], tension: 'Back of the shoulders.', mistake: 'Too heavy, so the traps take over.', video: null });
  add('Incline Bench DB Chest Fly|DB Chest Fly|Cable Fly', { primary: ['chest'], secondary: ['shoulders'], tempo: 'accessory',
    does: 'Chest isolation through a long stretch: size for the upper chest.', setup: 'Bench at 30°, slight bend in the elbows.',
    cues: ['Open wide until the chest stretches.', 'Hug a big tree to bring them back.', 'Don’t press it.'], tension: 'Chest at the stretch.', mistake: 'Bending the elbows into a press.', video: null });
  add('Barbell Shrugs|DB Shrugs|Shrugs', { primary: ['traps'], secondary: ['forearms'], tempo: 'accessory',
    does: 'Upper traps: the slope from neck to shoulder.', setup: 'Stand tall, arms long.', cues: ['Straight up toward the ears.', 'Hold one second.', 'Lower fully.'], tension: 'Upper traps: shrug straight up toward the ears and hold the squeeze.', mistake: 'Rolling the shoulders.', video: null });
  add('DB Preacher Curl|Standing KB Crush Grip Bicep Curl|Barbell Curl|Curls', { primary: ['biceps'], secondary: ['forearms'], tempo: 'accessory',
    does: 'Biceps isolation: arm size.', setup: 'Elbows fixed.', cues: ['Curl without moving the elbows.', 'Squeeze at the top.', 'Lower slowly to full extension.'], tension: 'Biceps: pin the elbows, squeeze hard at the top and fight the weight on the way down.', mistake: 'Swinging the weight.', video: null });
  add('Barbell Skull Crushers|Skull Crushers|Tricep Pushdowns', { primary: ['triceps'], secondary: [], tempo: 'accessory',
    does: 'Triceps isolation: the back of the arm is two-thirds of its size.', setup: 'Upper arms fixed.', cues: ['Bend only at the elbows.', 'Stretch the triceps at the bottom.', 'Lock out fully.'], tension: 'Triceps: elbows still, feel the stretch behind the arm at the bottom and lock out hard.', mistake: 'Elbows flaring.', video: null });

  // ---- core ----
  add('Toes-to-Bar|Hanging Knee Raises|Hanging Leg Raises', { primary: ['abs'], secondary: ['obliques', 'lats', 'forearms'], tempo: 'dynamic',
    does: 'Hanging trunk flexion: the lower abs and hip flexors, plus grip.', setup: 'Dead hang, active shoulders.',
    cues: ['Pull the bar toward the hips (lats).', 'Curl the pelvis up.', 'Control the swing.'], tension: 'Abs: curl the spine, don’t just lift the legs.', mistake: 'All hip flexor, no spinal curl.', video: 'CrossFit toes-to-bar' });
  add('Sit-Ups|V-Ups|Hollow Rocks|Hollow Hold', { primary: ['abs'], secondary: ['obliques'], tempo: 'dynamic',
    does: 'Trunk flexion and the hollow position that underpins every gymnastics movement.', setup: 'Lower back pressed down.',
    cues: ['Ribs down to the hips.', 'Lower back stays glued to the floor in the hollow.', 'Breathe.'], tension: 'Abs.', mistake: 'Arching the lower back off the floor.', video: null });

  // ---- conditioning ----
  add('Burpees', { primary: ['chest', 'quads'], secondary: ['shoulders', 'triceps', 'abs'], tempo: 'dynamic', cardio: 'mixed',
    does: 'Full body down and up: a heavy breathing load with little skill.', setup: '', cues: ['Chest to the floor.', 'Feet to the hands.', 'Small jump and clap overhead.'], tension: 'Steady rhythm.', mistake: 'Starting too fast.', video: null });
  add('Double-Unders|Jump Rope', { primary: ['calves'], secondary: ['shoulders', 'abs'], tempo: 'dynamic', cardio: 'mixed',
    does: 'Rope passes twice per jump: calf stiffness, timing and conditioning.', setup: 'Rope length: handles to the armpits.', cues: ['Wrists turn the rope, not the arms.', 'Small, quick jumps on the balls of the feet.', 'Stay tall.'], tension: 'Calves springy.', mistake: 'Piking the legs.', video: 'CrossFit double-under technique' });
  add('Row', { primary: ['quads', 'lats'], secondary: ['glutes', 'hamstrings', 'biceps', 'midback'], tempo: 'cardio', cardio: 'machine',
    does: 'Whole-body, low-impact cardio: legs drive, then the back opens, then the arms.', setup: 'Damper 4–6; feet strapped at the widest part of the foot.',
    cues: ['Legs, back, arms; arms, back, legs.', 'Drive with the legs: about 60% of the stroke.', 'Recover slower than you drive (1:2).'], tension: 'Legs push; arms only finish.', mistake: 'Pulling with the arms first.', video: 'Concept2 rowing technique' });
  add('Bike|Echo Bike|Assault Bike', { primary: ['quads'], secondary: ['glutes', 'hamstrings', 'shoulders', 'calves'], tempo: 'cardio', cardio: 'machine',
    does: 'Air bike: arms and legs together, no impact; brutally hard at high intensity.', setup: 'Seat so the knee is slightly bent at the bottom.', cues: ['Push and pull the handles.', 'Steady cadence.', 'Breathe in rhythm.'], tension: 'Legs drive.', mistake: 'Going out too hard.', video: null });
  add('Ski Erg', { primary: ['lats', 'triceps', 'abs'], secondary: ['glutes', 'hamstrings', 'shoulders'], tempo: 'cardio', cardio: 'machine',
    does: 'A double-pole pull: lats, trunk flexion and hips.', setup: 'Stand close, handles overhead.', cues: ['Hips hinge as the arms pull.', 'Crunch the trunk down.', 'Stand tall to recover.'], tension: 'Lats and abs.', mistake: 'Arms only.', video: 'Concept2 SkiErg technique' });
  add('Run', { primary: ['quads', 'calves', 'hamstrings'], secondary: ['glutes'], tempo: 'cardio', cardio: 'machine',
    does: 'Running: heart, lungs, and the tendons and bones of the legs.', setup: '', cues: ['Tall posture, slight forward lean.', 'Quick, short steps landing under the hips.', 'Relax the shoulders.'], tension: 'Relaxed.', mistake: 'Overstriding.', video: null });
  add('Swim (freestyle)|Swim with fins|Sidestroke with fins|Breaststroke|Kick with fins|Pull (pull buoy)', { primary: ['lats', 'shoulders'], secondary: ['triceps', 'abs', 'glutes'], tempo: 'cardio', cardio: 'machine',
    does: 'Swimming: aerobic work with no impact, lats and shoulders; the diving units build on it.', setup: '', cues: ['Long body, head down.', 'Breathe every 3 strokes.', 'Reach long, pull to the hip.'], tension: 'Long through the trunk.', mistake: 'Lifting the head to breathe.', video: null });

  // Pattern fallbacks for movements not listed.
  var PATTERN = {
    'Squat': M['Back Squat'], 'Hinge': M['Romanian Deadlift'], 'Push Vertical': M['Strict Press'], 'Push Horizontal': M['Bench Press'],
    'Pull Vertical': M['Strict Pull-Ups'], 'Pull Horizontal': M['Bent Over Row'], 'Olympic': M['Clean'], 'Core': M['Sit-Ups'],
  };

  // Tempo: eccentric-pause-concentric-pause in seconds; X = as fast as you can move it.
  function tempo(e, reps) {
    if (!e) return null;
    var r = Number(reps) || 0;
    switch (e.tempo) {
      case 'barbell': return r && r <= 5 ? { code: '2-1-X-1', say: '2 s down, 1 s pause at the bottom, up as fast as you can, a breath at the top. Heavy: speed with intent, even if the bar moves slowly.' }
        : { code: '3-1-1-0', say: '3 s down, 1 s at the bottom, 1 s up: time under tension for size.' };
      case 'accessory': return { code: '3-0-1-1', say: '3 s on the way down, up in 1 s, squeeze 1 s at the top.' };
      case 'strict': return { code: '2-1-1-1', say: 'Smooth and strict: 2 s lowering, pause, 1 s up, hold the top.' };
      case 'olympic': return { code: 'Fast', say: 'No tempo: patient off the floor, then as fast and violent as you can through the hips. Speed is the point.' };
      case 'ballistic': return { code: 'X', say: 'Explosive: every rep as fast as possible. Stop the set when speed drops.' };
      case 'dynamic': return { code: 'Rhythm', say: 'Smooth rhythm: link the reps, break before you fail.' };
      default: return null;
    }
  }

  // What cardio does, by the kind of session (engine.SESSION_TYPES) or a metcon.
  var ENERGY = {
    aerobic: { label: 'Aerobic base (zone 2)', for: 'Heart health and circulation',
      does: 'Easy, conversational effort. The heart pumps more blood per beat (stroke volume rises), muscles grow more capillaries and mitochondria, resting heart rate falls and you burn more fat at any pace. It is the base everything else stands on and recovers you between hard days.',
      feel: 'You could hold a conversation; nose breathing is nearly possible.' },
    threshold: { label: 'Threshold', for: 'The pace you can hold',
      does: 'Comfortably hard intervals near the point where lactate starts to pile up. Raises that point, so you can hold a faster pace for longer in long workouts, runs and rucks.',
      feel: 'Short sentences only; sustainable for 20–40 minutes in total.' },
    vo2: { label: 'VO2max intervals', for: 'Top-end aerobic capacity',
      does: 'Hard 2–4 minute efforts near your maximum oxygen uptake. Raises VO2max, the ceiling of your aerobic engine; higher VO2max is one of the strongest predictors of long life in large studies.',
      feel: 'Breathing hard, a few words at most; the last interval should be your hardest.' },
    speed: { label: 'Sprint and speed', for: 'Power and repeatability',
      does: 'All-out efforts of seconds with long rests: trains the phosphagen system (the fastest energy for power) and your ability to repeat hard efforts in a metcon.',
      feel: 'Every rep maximal; rest long enough to repeat it.' },
    repeat: { label: 'Repeat efforts', for: 'Recovering between hard efforts',
      does: 'Hard efforts with short rests: trains how fast you recover between bursts, the CrossFit engine.',
      feel: 'Hard, but each round should match the first.' },
    test: { label: 'Engine test', for: 'Setting your targets',
      does: 'A benchmark effort that sets the pace targets for your machine intervals.', feel: 'Even pacing; empty the tank at the end.' },
    mixed: { label: 'Mixed-modal conditioning', for: 'Work capacity',
      does: 'Several movements done fast: heart, lungs and muscular endurance together, the glycolytic system that burns in a 3–12 minute metcon.',
      feel: 'Hard but steady; pace so you don’t stop.' },
  };

  function lookup(name, pattern) {
    if (!name) return null;
    if (M[name]) return M[name];
    var low = String(name).toLowerCase();
    for (var k in M) if (k.toLowerCase() === low) return M[k];
    // "Back Squat (pause)", "Tempo Back Squat": the longest listed name inside it.
    var best = null;
    for (var k2 in M) if (low.indexOf(k2.toLowerCase()) >= 0 && (!best || k2.length > best.length)) best = k2;
    if (best) return M[best];
    return pattern && PATTERN[pattern] ? Object.assign({ approx: true }, PATTERN[pattern]) : null;
  }
  function videoUrl(e) { return e && e.video ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(e.video) : null; }

  // The guided warm-up for a session: a few minutes of easy cardio, mobility for the joints the session uses, then
  // ramp-up sets for the first heavy lift. patterns: the session's movement patterns; main: { movement, load_lb? }.
  var DRILLS = {
    general: { name: 'Easy cardio', dose: '3 min', seconds: 180, cue: 'Row, bike or jog at a conversational pace to raise your temperature and heart rate.', muscles: [] },
    hips: [
      { name: 'World’s greatest stretch', dose: '4 each side', seconds: 75, cue: 'Long lunge, elbow to the instep, then rotate that arm to the ceiling. Hips low.', muscles: ['glutes', 'adductors', 'hamstrings'] },
      { name: '90/90 hip switches', dose: '6 each side', seconds: 60, cue: 'Sit with both knees bent at 90°, rotate the knees side to side, chest tall.', muscles: ['glutes', 'adductors'] },
      { name: 'Ankle rocks', dose: '10 each side', seconds: 50, cue: 'Half kneeling, drive the front knee over the toes with the heel down.', muscles: ['calves'] },
      { name: 'Glute bridges', dose: '12', seconds: 40, cue: 'Squeeze the glutes for a second at the top.', muscles: ['glutes'] },
      { name: 'Goblet squat pry', dose: '45 s', seconds: 45, cue: 'Hold the bottom of a squat, elbows pushing the knees out, shift side to side.', muscles: ['quads', 'adductors'] },
    ],
    hinge: [
      { name: 'Leg swings', dose: '10 each way, each leg', seconds: 60, cue: 'Front-to-back then side-to-side, letting the range grow.', muscles: ['hamstrings', 'adductors'] },
      { name: 'Good mornings (empty bar or PVC)', dose: '10', seconds: 40, cue: 'Hips back, back flat, feel the hamstrings.', muscles: ['hamstrings', 'lowerback'] },
    ],
    shoulders: [
      { name: 'Band pull-aparts', dose: '15', seconds: 40, cue: 'Arms straight, squeeze the shoulder blades together.', muscles: ['midback', 'shoulders'] },
      { name: 'PVC pass-throughs', dose: '10', seconds: 40, cue: 'Wide grip, arms straight, over the head and behind; narrow the grip as it frees up.', muscles: ['shoulders', 'chest'] },
      { name: 'Scap push-ups', dose: '10', seconds: 35, cue: 'In a plank, let the chest sink between the shoulder blades, then push it away.', muscles: ['midback', 'chest'] },
      { name: 'Thoracic openers', dose: '6 each side', seconds: 45, cue: 'On all fours, hand behind the head, rotate the elbow to the ceiling.', muscles: ['midback'] },
    ],
    pull: [
      { name: 'Dead hang', dose: '30 s', seconds: 30, cue: 'Relax and let the shoulders open.', muscles: ['lats', 'forearms'] },
      { name: 'Scap pull-ups', dose: '8', seconds: 30, cue: 'From a dead hang, pull the shoulders down without bending the arms.', muscles: ['lats', 'midback'] },
    ],
    olympic: [
      { name: 'Burgener warm-up (empty bar)', dose: '5 of each: down-and-up, elbows high, muscle snatch, snatch land, drops', seconds: 120, cue: 'Light and crisp: teaching positions, not training.', muscles: ['shoulders', 'traps', 'quads'] },
    ],
  };
  // budget: seconds the warm-up block has (the drills fill it after 3 min of easy cardio and ~3 min of ramp-up sets),
  // the main lift's region first, then the rest of the session's.
  function warmup(patterns, main, budget) {
    var P = {}; (patterns || []).forEach(function (p) { P[p] = true; });
    var lower = P.Squat || P.Hinge || P.Olympic, upper = P['Push Vertical'] || P['Push Horizontal'] || P['Pull Vertical'] || P['Pull Horizontal'] || P.Olympic;
    var lowerList = lower ? DRILLS.hips.slice(0, P.Squat || P.Olympic ? 5 : 3).concat(P.Hinge ? DRILLS.hinge : []) : [];
    var upperList = upper ? DRILLS.shoulders.slice(0, P['Push Vertical'] || P.Olympic ? 4 : 3).concat(P['Pull Vertical'] ? DRILLS.pull : []) : [];
    if (!lower && !upper) { lowerList = DRILLS.hips.slice(0, 2); upperList = DRILLS.shoulders.slice(0, 2); }
    var mp = main && main.pattern, mainUpper = /Push|Pull/.test(mp || '');
    var first = mainUpper ? upperList : lowerList, second = mainUpper ? lowerList : upperList;
    // Alternate after the main region's first two, so both regions get their most useful drills.
    var order = first.slice(0, 2), a = first.slice(2), b2 = second.slice();
    while (a.length || b2.length) { if (b2.length) order.push(b2.shift()); if (a.length) order.push(a.shift()); }
    if (P.Olympic) order = DRILLS.olympic.concat(order);
    var left = Math.max(240, (Number(budget) || 600) - DRILLS.general.seconds - (main ? 180 : 0)), steps = [DRILLS.general];
    for (var i = 0; i < order.length; i++) { if (order[i].seconds > left && steps.length > 3) break; steps.push(order[i]); left -= order[i].seconds; }
    var ramp = null;
    if (main && main.movement) {
      var e = lookup(main.movement, main.pattern);
      if (e && (e.tempo === 'barbell' || e.tempo === 'olympic')) {
        var w = Number(main.load_lb) || null, pct = [[0, 8], [0.4, 5], [0.6, 3], [0.75, 2], [0.85, 1]];
        ramp = { movement: main.movement, sets: pct.map(function (x) {
          return { load_lb: x[0] === 0 ? 45 : w ? Math.max(45, Math.round((w * x[0]) / 5) * 5) : null, pct: Math.round(x[0] * 100), reps: x[1] };
        }), cue: 'Ramp to your first working set: same technique at every weight, rest only as long as it takes to load the bar.' };
      }
    }
    return { steps: steps, ramp: ramp, note: 'Dynamic, not long static holds: holding stretches for a minute or more before lifting measurably cuts force output. The long stretches are in the cool-down.' };
  }
  // Cool-down stretches for the muscles the session worked: 30–45 s holds, breathing slowly.
  var STRETCHES = {
    quads: { name: 'Couch stretch', dose: '45 s each side', cue: 'Back knee against a wall, squeeze the glute of that leg.' },
    glutes: { name: 'Pigeon stretch', dose: '45 s each side', cue: 'Square the hips, fold forward over the front shin.' },
    hamstrings: { name: 'Seated hamstring fold', dose: '45 s', cue: 'Hinge from the hips with a flat back.' },
    adductors: { name: 'Frog stretch', dose: '45 s', cue: 'Knees wide, rock the hips back slowly.' },
    calves: { name: 'Wall calf stretch', dose: '30 s each side', cue: 'Straight back leg, heel down.' },
    chest: { name: 'Doorway pec stretch', dose: '30 s each side', cue: 'Forearm on the door frame, turn the body away.' },
    lats: { name: 'Child’s pose reach', dose: '45 s', cue: 'Walk the hands to one side, then the other.' },
    shoulders: { name: 'Cross-body shoulder stretch', dose: '30 s each side', cue: 'Pull the arm across at shoulder height.' },
    triceps: { name: 'Overhead triceps stretch', dose: '30 s each side', cue: 'Elbow up, hand down the back.' },
    lowerback: { name: 'Knees-to-chest', dose: '45 s', cue: 'Lying down, hug both knees and rock gently.' },
    midback: { name: 'Thread the needle', dose: '30 s each side', cue: 'On all fours, slide one arm under and rest the shoulder down.' },
    abs: { name: 'Cobra', dose: '30 s', cue: 'Hips down, press the chest up gently.' },
  };
  function cooldown(muscles) {
    var seen = {}, out = [];
    (muscles || []).forEach(function (g) { var s = STRETCHES[g]; if (s && !seen[s.name]) { seen[s.name] = 1; out.push(Object.assign({ muscle: g }, s)); } });
    return out.slice(0, 6);
  }

  return { MOVES: M, ENERGY: ENERGY, lookup: lookup, tempo: tempo, videoUrl: videoUrl, warmup: warmup, cooldown: cooldown, STRETCHES: STRETCHES };
});
