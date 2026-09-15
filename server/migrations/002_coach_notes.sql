-- Coach notes: the write-back channel for Sentinel (or anyone) to leave
-- persistent coaching output against a date, distinct from the raw
-- bodyweight/lift/benchmark logs. Read side already existed via
-- /summary and /coach-prompt; this is what was missing on the write side.

CREATE TABLE IF NOT EXISTS fitness_coach_notes (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'sentinel',
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coach_notes_date ON fitness_coach_notes (entry_date);
