-- Generated workouts (rules engine, optionally refined by Sentinel's trainer
-- agent) and engine time-trial results.
--
-- body holds the whole session as JSON: blocks → items → sets, and each set
-- records the log entry it created when you tap it done ({table, id}), so a
-- workout knows what's been logged and can undo it. rules_body keeps the
-- rule-built version when Sentinel replaces it, so it can be reverted.

CREATE TABLE IF NOT EXISTS fitness_workouts (
  id SERIAL PRIMARY KEY,
  workout_date DATE NOT NULL,
  title TEXT NOT NULL,
  focus TEXT NOT NULL,
  minutes SMALLINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  source TEXT NOT NULL DEFAULT 'rules',
  inputs JSONB NOT NULL,
  body JSONB NOT NULL,
  rules_body JSONB,
  seed INTEGER NOT NULL DEFAULT 0,
  refine_status TEXT NOT NULL DEFAULT 'none',
  refine_request TEXT,
  refine_requested_at TIMESTAMPTZ,
  refine_notes TEXT,
  refined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON fitness_workouts (workout_date);

-- Engine time trials, Gains Lab style: tt10 (10-min max), sprint60 (1-min
-- max), repeat (6 × 0:30 max / 0:30 rest; output = average, intervals = each).
-- unit is 'cal' for machines, 'm' for running.
CREATE TABLE IF NOT EXISTS fitness_engine_tests (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  modality TEXT NOT NULL,
  test TEXT NOT NULL,
  output NUMERIC(8,1) NOT NULL,
  unit TEXT NOT NULL,
  intervals JSONB,
  notes TEXT,
  workout_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engine_tests_date ON fitness_engine_tests (entry_date);
