-- Testing and missing data (Jake, 2026-10-18): test results, the circumferences the physique analysis needs,
-- morning resting heart rate (in fitness_tests as resting_hr: the SEAL guide's overtraining check), his age (heart-rate zones) and his gear.
CREATE TABLE IF NOT EXISTS fitness_tests (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  test TEXT NOT NULL,
  value NUMERIC(8,1) NOT NULL,
  unit TEXT NOT NULL,
  notes TEXT,
  workout_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tests_test_date ON fitness_tests (test, entry_date);
ALTER TABLE fitness_measurements ADD COLUMN IF NOT EXISTS thigh NUMERIC(5,1);
ALTER TABLE fitness_measurements ADD COLUMN IF NOT EXISTS calf NUMERIC(5,1);
ALTER TABLE fitness_measurements ADD COLUMN IF NOT EXISTS upper_arm NUMERIC(5,1);
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS age_years SMALLINT;
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS age_recorded_on DATE;
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS gear JSONB;
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS ledger_snoozed JSONB;
-- He's 34 (told Sentinel 2026-10-18).
UPDATE fitness_profile SET age_years = 34, age_recorded_on = DATE '2026-10-18' WHERE id = 1 AND age_years IS NULL;
