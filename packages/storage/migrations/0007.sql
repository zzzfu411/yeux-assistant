-- Agent credentials never contain a recoverable token. One credential = one actor.
CREATE TABLE app.agent_credentials (
 id text PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 last_used_at timestamptz,
 request_window timestamptz NOT NULL DEFAULT now(),
 request_count integer NOT NULL DEFAULT 0,
 write_day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 writes_today integer NOT NULL DEFAULT 0,
 daily_write_limit integer NOT NULL CHECK (daily_write_limit BETWEEN 1 AND 100)
);
CREATE TABLE app.agent_audit (
 id text PRIMARY KEY,
 agent_id text NOT NULL REFERENCES app.agent_credentials(id),
 operation text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('started','succeeded','failed','denied','limited')),
 error_code text,
 command_key text,
 entity_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX agent_audit_recent ON app.agent_audit(created_at DESC,id);
CREATE INDEX agent_audit_actor ON app.agent_audit(agent_id,created_at DESC);
