-- The Andrew page (Jake, 2026-11-03): the actor's notebook, his own answers to the character questions
-- (lib/role.js QUESTIONS), and the last Bond-module read from Trinity through Sentinel, kept so the page still
-- shows the courses when Sentinel or Trinity is down.
CREATE TABLE IF NOT EXISTS role_notebook (
  question_id TEXT PRIMARY KEY,
  answer TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS role_cache (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
