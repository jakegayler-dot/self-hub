-- Benchmark results can be Rx or scaled; percentiles only use Rx.
-- Nullable so existing rows (and pg-mem, which doesn't backfill defaults)
-- read as Rx — NULL is treated as Rx everywhere.
ALTER TABLE fitness_benchmarks ADD COLUMN IF NOT EXISTS rx BOOLEAN;

-- CrossFit Open results straight off the official leaderboard: your rank and
-- the number of athletes in your division give an exact percentile.
-- workout is '26.1', '26.2', … or 'overall'.
CREATE TABLE IF NOT EXISTS fitness_open_results (
  id SERIAL PRIMARY KEY,
  year SMALLINT NOT NULL,
  workout TEXT NOT NULL,
  division TEXT NOT NULL,
  rank INTEGER NOT NULL,
  total INTEGER NOT NULL,
  score TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
