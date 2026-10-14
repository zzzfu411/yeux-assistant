-- Notice handling (Lab1 R5), reusable flows and phone push (R4).
-- `flow` selects the executor: 'mail-reply' or 'errand'; NULL keeps the learning / research executors.
ALTER TABLE app.sessions ADD COLUMN flow text CHECK (flow IS NULL OR flow IN ('mail-reply','errand'));
ALTER TABLE app.sessions ADD COLUMN flow_id text;
ALTER TABLE app.sessions ADD COLUMN flow_version integer;
ALTER TABLE app.sessions ADD COLUMN parent_session_id text REFERENCES app.sessions(id);
CREATE INDEX sessions_parent ON app.sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
-- Facts extracted from a notice, the user's answers and the produced actions. Versioned per change.
CREATE TABLE app.errands (
  session_id text PRIMARY KEY REFERENCES app.sessions(id),
  notice jsonb NOT NULL,
  state jsonb NOT NULL,
  archived_path text,
  archived_commit text,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.push_subscriptions (
  endpoint text PRIMARY KEY,
  keys jsonb NOT NULL,
  label text NOT NULL DEFAULT '',
  failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz
);
ALTER TABLE app.notifications ADD COLUMN pushed_at timestamptz;
-- Existing notifications are history; only new ones are pushed.
UPDATE app.notifications SET pushed_at = created_at;
