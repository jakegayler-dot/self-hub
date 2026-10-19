-- The look Jake is after and his own critical read of where he is now (2026-10-18). The trainer programs the
-- gap between them, not the target's defining features ("I have big broad shoulders already; it shouldn't
-- programme for big broad shoulders because that's Craig's defining physique").
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS physique_target TEXT;
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS physique_assessment TEXT;
UPDATE fitness_profile SET physique_target = 'Daniel Craig in Casino Royale: lean, athletic, solid all over.' WHERE id = 1 AND physique_target IS NULL;
UPDATE fitness_profile SET physique_assessment = 'Big, broad shoulders already and low body fat. Tiny legs and a tiny waist: those are the gaps.' WHERE id = 1 AND physique_assessment IS NULL;
