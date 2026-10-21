-- Nutrition (Jake, 2026-10-20): food log, recipes and saved meals, adaptive targets, a weekly meal plan,
-- the pantry and the grocery list (pushed to Sentinel's shopping list, two-way).
-- Food keys: 'usda:<id>' (server/data/foods_usda.json, per 100 g) or 'custom:<id>' (nutrition_foods).

CREATE TABLE IF NOT EXISTS nutrition_foods (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  kcal NUMERIC(7,1) NOT NULL,
  protein_g NUMERIC(6,1) NOT NULL,
  carbs_g NUMERIC(6,1) NOT NULL,
  fat_g NUMERIC(6,1) NOT NULL,
  fiber_g NUMERIC(6,1),
  sugar_g NUMERIC(6,1),
  sat_fat_g NUMERIC(6,1),
  sodium_mg NUMERIC(7,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- His own portion sizes for any food ("1 large egg" = 50 g), on top of the built-in ones.
CREATE TABLE IF NOT EXISTS nutrition_portions (
  id SERIAL PRIMARY KEY,
  food_key TEXT NOT NULL,
  name TEXT NOT NULL,
  grams NUMERIC(7,1) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nutrition_portions_food ON nutrition_portions (food_key);

-- Recipes (cooked dishes with servings) and saved meals (a combination he eats often; servings 1).
-- ingredients: [{ food_key, grams, label? }] for the whole recipe.
CREATE TABLE IF NOT EXISTS nutrition_recipes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  servings NUMERIC(5,2) NOT NULL,
  ingredients JSONB NOT NULL,
  instructions TEXT,
  prep_minutes SMALLINT,
  portable BOOLEAN,
  max_per_week SMALLINT,
  notes TEXT,
  source TEXT,
  archived BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What he ate. Nutrients are copied in when logged, so a later recipe edit doesn't rewrite history.
CREATE TABLE IF NOT EXISTS nutrition_diary (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  slot TEXT NOT NULL,
  name TEXT NOT NULL,
  food_key TEXT,
  recipe_id INTEGER,
  grams NUMERIC(8,1),
  servings NUMERIC(5,2),
  amount TEXT,
  kcal NUMERIC(7,1) NOT NULL,
  protein_g NUMERIC(6,1) NOT NULL,
  carbs_g NUMERIC(6,1) NOT NULL,
  fat_g NUMERIC(6,1) NOT NULL,
  fiber_g NUMERIC(6,1),
  sodium_mg NUMERIC(8,1),
  plan_id INTEGER,
  pantry_used JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nutrition_diary_date ON nutrition_diary (entry_date);

-- One row: how the targets are set. base_kcal is the current weekly average; the adaptive check moves it.
CREATE TABLE IF NOT EXISTS nutrition_settings (
  id SMALLINT PRIMARY KEY,
  base_kcal INTEGER,
  protein_g INTEGER,
  fat_pct NUMERIC(4,1),
  rate_min_lb NUMERIC(4,2),
  rate_max_lb NUMERIC(4,2),
  training_extra_kcal INTEGER,
  adaptive BOOLEAN,
  slots TEXT,
  seeded BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO nutrition_settings (id, base_kcal, protein_g, fat_pct, rate_min_lb, rate_max_lb, training_extra_kcal, adaptive, slots, seeded)
  VALUES (1, 3300, 175, 30, 0.25, 0.5, 400, true, 'breakfast,lunch,dinner,snack', false) ON CONFLICT (id) DO NOTHING;

-- Each week's target decision (Monday in Regina), with the numbers behind it.
CREATE TABLE IF NOT EXISTS nutrition_targets (
  week_start DATE PRIMARY KEY,
  base_kcal INTEGER NOT NULL,
  protein_g INTEGER NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  tdee_kcal INTEGER,
  rate_lb_wk NUMERIC(5,2),
  avg_intake_kcal INTEGER,
  logged_days SMALLINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The week's meal plan: a recipe (or saved meal) in a slot on a day.
CREATE TABLE IF NOT EXISTS nutrition_plan (
  id SERIAL PRIMARY KEY,
  plan_date DATE NOT NULL,
  slot TEXT NOT NULL,
  recipe_id INTEGER NOT NULL,
  servings NUMERIC(5,2) NOT NULL,
  source TEXT,
  eaten BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nutrition_plan_date ON nutrition_plan (plan_date);
CREATE TABLE IF NOT EXISTS nutrition_plan_weeks (
  week_start DATE PRIMARY KEY,
  source TEXT NOT NULL,
  summary TEXT,
  prep JSONB,
  days JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What's in the house, by food, in grams.
CREATE TABLE IF NOT EXISTS nutrition_pantry (
  id SERIAL PRIMARY KEY,
  food_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grams NUMERIC(9,1) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The grocery list. Sentinel shows it on its shopping list (source_id grocery:<id>) and can tick items off.
CREATE TABLE IF NOT EXISTS nutrition_groceries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  food_key TEXT,
  grams NUMERIC(9,1),
  quantity TEXT,
  aisle TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  week_start DATE,
  bought_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The nutritionist runs in the background (a week takes a minute or two); the page checks back.
CREATE TABLE IF NOT EXISTS nutrition_jobs (
  id SERIAL PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
