-- Self Hub — initial schema
-- Each Bond unit's data lives in its own set of tables under this one app,
-- the same way Cattle Manager grew feature by feature under one deployment.

CREATE TABLE IF NOT EXISTS fitness_profile (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  phase SMALLINT NOT NULL DEFAULT 0,
  body_fat_target NUMERIC(4,1) NOT NULL DEFAULT 9.0,
  bodyweight_goal_lb NUMERIC(6,1),
  leaderboard_goal TEXT DEFAULT 'top of local box',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO fitness_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS fitness_bodyweight (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  weight_lb NUMERIC(5,1) NOT NULL,
  body_fat_pct NUMERIC(4,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bw_date ON fitness_bodyweight (entry_date);

CREATE TABLE IF NOT EXISTS fitness_lifts (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  lift TEXT NOT NULL,
  load_lb NUMERIC(6,1) NOT NULL,
  reps SMALLINT NOT NULL,
  rpe NUMERIC(3,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lifts_date ON fitness_lifts (entry_date);
CREATE INDEX IF NOT EXISTS idx_lifts_name ON fitness_lifts (lift);

CREATE TABLE IF NOT EXISTS fitness_benchmarks (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  name TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bm_date ON fitness_benchmarks (entry_date);
