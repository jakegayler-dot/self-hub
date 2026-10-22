-- Foods from outside the built-in list (2026-10-21): USDA FoodData Central (branded and as-eaten foods), Open Food
-- Facts, or a restaurant's own numbers found by Sentinel. Saved as his foods the first time he picks one, with where
-- they came from; their serving sizes go in nutrition_portions.
ALTER TABLE nutrition_foods ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE nutrition_foods ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE nutrition_foods ADD COLUMN IF NOT EXISTS source_url TEXT;

-- Built-in foods whose portion weights have been looked up in FoodData Central (found or not), so it's asked once.
CREATE TABLE IF NOT EXISTS nutrition_portion_checks (
  food_key TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
