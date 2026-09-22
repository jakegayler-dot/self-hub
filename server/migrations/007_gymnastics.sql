-- Gymnastics / calisthenics: bodyweight-only movements (no external load),
-- logged as sets and reps — distinct from fitness_lifts, which requires a
-- load_lb value and drives the strength profile's bodyweight-ratio scoring.
-- Handstand walk, HSPU, push-ups, sit-ups, toes-to-bar, pistol squats,
-- strict pull-ups, chest-to-bar, butterfly pull-ups, bar muscle-ups, etc.

CREATE TABLE IF NOT EXISTS fitness_gymnastics (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  movement TEXT NOT NULL,
  reps SMALLINT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gym_date ON fitness_gymnastics (entry_date);
CREATE INDEX IF NOT EXISTS idx_gym_name ON fitness_gymnastics (movement);
