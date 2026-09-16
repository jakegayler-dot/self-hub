-- Conditioning: non-strength movements (row, run, bike, etc.) tracked by
-- distance/duration instead of load/reps. Kept separate from fitness_lifts
-- since the metrics and the point of tracking them are genuinely different.

CREATE TABLE IF NOT EXISTS fitness_conditioning (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  movement TEXT NOT NULL,
  distance_m NUMERIC(8,1),
  duration_seconds INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conditioning_date ON fitness_conditioning (entry_date);
CREATE INDEX IF NOT EXISTS idx_conditioning_movement ON fitness_conditioning (movement);
