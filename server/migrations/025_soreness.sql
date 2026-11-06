-- Soreness he reports (Nov 6): one row per muscle a day, level 1 sore or 2 very sore. The plans keep off it for 2 or 3 days.
CREATE TABLE IF NOT EXISTS fitness_soreness (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  area TEXT NOT NULL,
  level INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fitness_soreness_date ON fitness_soreness (entry_date);
