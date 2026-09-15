-- Benchmark lifts: a small, user-editable set of "indicator" lifts (as
-- opposed to every accessory movement) used to drive the biomechanical
-- strength-profile breakdown. Seeded with the classic strength/oly lifts
-- as a sensible default — add or remove any via the Manage lift names table.

CREATE TABLE IF NOT EXISTS fitness_benchmark_lifts (
  lift TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fitness_benchmark_lifts (lift) VALUES
  ('Back Squat'), ('Front Squat'), ('Deadlift'), ('Sumo Deadlift'),
  ('Bench Press'), ('Strict Press'), ('Bent Over Row'), ('Strict Pull-Ups'),
  ('Clean & Jerk'), ('Snatch'), ('Power Clean'), ('Power Snatch'), ('Split Jerk')
ON CONFLICT (lift) DO NOTHING;
