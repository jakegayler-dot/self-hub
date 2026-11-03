-- The physique target in numbers (Jake, 2026-11-03: "Self Hub already has the right physique in mind but it isn't
-- tracking it very well"). "Daniel Craig in Casino Royale" stays as the words; these are what it means at his height
-- (5'9"), agreed with him: about 165 lb at 10% body fat, chest 42", waist 31" or less, shoulders 48" around, upper arm
-- 15.5", neck 15.5", thigh 22.5", calf 15". lib/physique.js measures against them; he can change any of them.
-- Migrations run on every start, so this sets them once (while there are none) and never overwrites his changes.
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS physique_targets JSONB;
UPDATE fitness_profile
  SET physique_targets = '{"weight_lb":165,"body_fat_pct":10,"bust":42,"waist":31,"shoulder_circ":48,"upper_arm":15.5,"neck":15.5,"thigh":22.5,"calf":15}'::jsonb,
      body_fat_target = CASE WHEN body_fat_target = 9.0 THEN 10 ELSE body_fat_target END
  WHERE id = 1 AND physique_targets IS NULL;

-- Shoulders measured all the way round, at the widest point (the V-taper measurement). The old "shoulder" is the
-- tailor's back width, which can't be compared with a waist circumference.
ALTER TABLE fitness_measurements ADD COLUMN IF NOT EXISTS shoulder_circ NUMERIC(5,1);

-- How body fat was measured, so readings are compared like with like (scale, calipers, tape method, DEXA, estimate).
ALTER TABLE fitness_bodyweight ADD COLUMN IF NOT EXISTS body_fat_method TEXT;
