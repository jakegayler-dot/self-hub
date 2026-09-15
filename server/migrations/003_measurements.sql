-- Clothing measurements: tracked over time the same way bodyweight is,
-- so you can see the trend as the Casino Royale build progresses.
-- Inseam is stored as a low/high pair since it was given as a range
-- (29 to 30 inch); every other field is a single number in inches.

CREATE TABLE IF NOT EXISTS fitness_measurements (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  arm_length NUMERIC(4,1),
  bust NUMERIC(4,1),
  shoulder NUMERIC(4,1),
  length NUMERIC(4,1),
  waist NUMERIC(4,1),
  seat_hips NUMERIC(4,1),
  neck NUMERIC(4,1),
  sleeve NUMERIC(4,1),
  inseam_low NUMERIC(4,1),
  inseam_high NUMERIC(4,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_measurements_date ON fitness_measurements (entry_date);
