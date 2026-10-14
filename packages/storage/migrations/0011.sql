ALTER TABLE app.sources ADD COLUMN IF NOT EXISTS missing_at timestamptz;
