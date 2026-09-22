-- Height, used to scale the Physique body diagram to actual proportions.
-- Nullable — no backfill needed since the single existing profile row is
-- fine with a null height until the person logs one.
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS height_in NUMERIC(4,1);
