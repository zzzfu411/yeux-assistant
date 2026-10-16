-- The unsent Today entry, kept on the server so it follows the owner between phone and computer.
-- One row per draft slot; the revision guards against two devices overwriting each other silently.
CREATE TABLE app.drafts (
  key text PRIMARY KEY CHECK(key IN ('compose')),
  content jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
