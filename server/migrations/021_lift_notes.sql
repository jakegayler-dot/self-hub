-- Lift notes (2026-11-01): what Jake is working on in each lift ("a little note pad… things to work on with that
-- lift"), from his own video reviews. Keyed by the lift's name as the coaching library names it.
CREATE TABLE IF NOT EXISTS lift_notes (
  movement TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
