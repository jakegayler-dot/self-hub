-- The coached week (2026-10-18): Sentinel's trainer plans 4 to 6 sessions a week from Jake's numbers and
-- goals, reviews what he did, adjusts the rest of the week and ranks where to work. Each workout keeps what
-- it's for (meta: objective, energy systems, qualities, muscles, intensity, why); the week keeps the plan's
-- own targets and the latest review.
ALTER TABLE fitness_workouts ADD COLUMN IF NOT EXISTS meta JSONB;

CREATE TABLE IF NOT EXISTS fitness_weeks (
  week_start  DATE PRIMARY KEY,
  days        SMALLINT NOT NULL,
  plan        JSONB NOT NULL,
  review      JSONB,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
