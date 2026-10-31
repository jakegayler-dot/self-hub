-- The wardrobe (2026-10-31): Jake's clothes, brought over from his wardrobe manager (wardrobe.db, his items), plus a
-- wishlist (status 'Wishlist'), what he wore when, and saved outfits. The stylist (coach chat) reads and changes it.
CREATE TABLE IF NOT EXISTS wardrobe_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  brand TEXT,
  colour TEXT,
  size TEXT,
  season TEXT,
  condition TEXT,
  style TEXT,
  warmth SMALLINT,
  notes TEXT,
  status TEXT NOT NULL,
  price_cad NUMERIC(8,2),
  link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wardrobe_wear (
  id SERIAL PRIMARY KEY,
  worn_on DATE NOT NULL,
  item_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wardrobe_wear_item ON wardrobe_wear (item_id, worn_on);
CREATE TABLE IF NOT EXISTS wardrobe_outfits (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  occasion TEXT,
  item_ids JSONB NOT NULL,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seeded once from his manager's data (so items he deletes stay deleted).
CREATE TABLE IF NOT EXISTS wardrobe_settings (
  id SMALLINT PRIMARY KEY,
  seeded BOOLEAN
);
INSERT INTO wardrobe_settings (id, seeded) VALUES (1, false) ON CONFLICT (id) DO NOTHING;
