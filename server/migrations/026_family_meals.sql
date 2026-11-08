-- The family's meals (Jake, Nov 8: "nutritionist needs a chef/meal planner that comes up with a daily menu, grocery list,
-- recipes. And these get saved in self hub and parsed through to sentinel that tells me the days meal plan. Making sure the
-- meals have visuals, correct portions for all family members, and work toward the dietary caloric and health goals").
--
-- Who eats: Jake (his calories and protein are his adaptive targets, as before) and his family, each with their own daily
-- calories and protein. Starting values for Ashley and the boys are Health Canada's estimated energy requirements for a
-- low-active woman and for boys of 5 and 3; he changes them on Nutrition → Targets → Family.
CREATE TABLE IF NOT EXISTS nutrition_household (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'adult',      -- jake, adult, child
  birth_year INTEGER,
  kcal INTEGER,                            -- daily target; Jake's comes from his adaptive targets
  protein_g INTEGER,
  avoid TEXT,                              -- foods to leave out for this person (allergies, dislikes)
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0
);
INSERT INTO nutrition_household (name, role, birth_year, kcal, protein_g, notes, position) VALUES
  ('Jake', 'jake', 1992, NULL, NULL, 'Targets from his own plan (Targets tab).', 0),
  ('Ashley', 'adult', NULL, 2000, 70, 'Starting value: Health Canada estimated energy requirement for a low-active woman. Change it to hers.', 1),
  ('Alex', 'child', 2021, 1500, 25, 'Starting value: Health Canada estimated energy requirement for a low-active boy of 5.', 2),
  ('Ollie', 'child', 2023, 1200, 20, 'Starting value: Health Canada estimated energy requirement for a low-active boy of 3. Cut grapes, cherry tomatoes and sausages lengthwise; no whole nuts.', 3)
ON CONFLICT (name) DO NOTHING;

-- Each planned meal's portions, in servings of its recipe, by person ({"Jake": 1.5, "Ashley": 1, "Alex": 0.5, "Ollie": 0.4}).
-- servings stays Jake's own (his log and targets read it); a meal with no portions is his alone, as before.
ALTER TABLE nutrition_plan ADD COLUMN IF NOT EXISTS portions JSONB;

-- A picture of each recipe, made by Sentinel and kept here so the Nutrition tab can show it.
CREATE TABLE IF NOT EXISTS nutrition_recipe_images (
  recipe_id INTEGER PRIMARY KEY REFERENCES nutrition_recipes(id) ON DELETE CASCADE,
  jpeg BYTEA NOT NULL,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
