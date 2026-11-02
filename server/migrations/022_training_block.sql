-- Periodization (2026-11-02): 6-week blocks, 5 build weeks then a deload. block_start is the Monday of build week 1;
-- null until the first week is planned (that week becomes week 1). "Deload this week" moves it so this week is week 6.
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS block_start DATE;
