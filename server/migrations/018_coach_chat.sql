-- Talking to the coaches (2026-10-26): the trainer and the nutritionist, each with its conversation and its memory.
-- The conversation is kept as the model sees it (Anthropic message content: text, tool calls and results).
CREATE TABLE IF NOT EXISTS coach_messages (
  id SERIAL PRIMARY KEY,
  coach TEXT NOT NULL,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  turn_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coach_messages_coach ON coach_messages (coach, id);

-- What each coach remembers about Jake: one plain sentence each, written by the coach (or him).
CREATE TABLE IF NOT EXISTS coach_memory (
  id SERIAL PRIMARY KEY,
  coach TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One reply being worked out (it can take a minute when the coach changes things); the page checks back.
CREATE TABLE IF NOT EXISTS coach_turns (
  id SERIAL PRIMARY KEY,
  coach TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
