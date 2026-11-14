-- Receipts into the pantry (Jake, Nov 14: "when I scan a receipt for moneyhub, if it's clothes or groceries, it automatically
-- updates self hubs wardrobe library and grocery inventory"). One row a receipt, so one sent twice adds once.
CREATE TABLE IF NOT EXISTS nutrition_receipts (
  receipt_key TEXT PRIMARY KEY,
  store TEXT,
  bought_on DATE,
  added JSONB,
  skipped JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
