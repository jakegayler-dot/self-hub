-- The workout log (Jake, 2026-10-18): what he actually did, entered on the plan (or told to Sentinel) and kept
-- in the history for analysis: the RPE and a note on each set, extra sets, and the session's time, RPE and notes.
ALTER TABLE fitness_lifts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE fitness_workouts ADD COLUMN IF NOT EXISTS actual_minutes SMALLINT;
ALTER TABLE fitness_workouts ADD COLUMN IF NOT EXISTS session_rpe NUMERIC(3,1);
ALTER TABLE fitness_workouts ADD COLUMN IF NOT EXISTS session_notes TEXT;
