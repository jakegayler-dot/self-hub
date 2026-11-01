-- Expeditions (2026-10-31): Jake's trips and expeditions, built around the map. An expedition has places (pins on the
-- map, in the order he went), journal pages (dated, optionally at a place, with the weather that day kept), and
-- photos (shrunk in his browser before upload; their own GPS and date when the camera recorded them).
CREATE TABLE IF NOT EXISTS expeditions (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'trip',
  start_date DATE,
  end_date DATE,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expedition_places (
  id SERIAL PRIMARY KEY,
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  region TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  arrived_on DATE,
  left_on DATE,
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expedition_places_exp ON expedition_places (expedition_id, position);

CREATE TABLE IF NOT EXISTS expedition_entries (
  id SERIAL PRIMARY KEY,
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES expedition_places(id) ON DELETE SET NULL,
  entry_date DATE NOT NULL,
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  weather JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expedition_entries_exp ON expedition_entries (expedition_id, entry_date);

CREATE TABLE IF NOT EXISTS expedition_photos (
  id SERIAL PRIMARY KEY,
  expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES expedition_entries(id) ON DELETE SET NULL,
  place_id INTEGER REFERENCES expedition_places(id) ON DELETE SET NULL,
  taken_on DATE,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  caption TEXT,
  width INTEGER,
  height INTEGER,
  -- base64 JPEG (a shrunk photo is about 300 KB; base64 adds a third, and it reads back the same in every driver)
  image TEXT NOT NULL,
  thumb TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expedition_photos_exp ON expedition_photos (expedition_id);
