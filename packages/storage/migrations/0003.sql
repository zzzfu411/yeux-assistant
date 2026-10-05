CREATE TABLE app.auth_sessions (
  token_hash text PRIMARY KEY,
  credential_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_expiry ON app.auth_sessions(expires_at);
CREATE TABLE app.auth_limits (
  key text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  attempts integer NOT NULL
);
