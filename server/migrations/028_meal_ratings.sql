-- Meals rated (Jake, Nov 14: "when i tick off a meal can you open a 5 star rating for them so we can rank meals"): one rating
-- per meal eaten (a nutrition_plan row), 1 to 5 stars; a recipe's rank is the average of its meals' stars. Cheffy sees them.
CREATE TABLE IF NOT EXISTS nutrition_meal_ratings (
  plan_id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL,
  stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nutrition_meal_ratings_recipe ON nutrition_meal_ratings (recipe_id);
