CREATE TABLE app.device_bridges (
 device_id text PRIMARY KEY REFERENCES app.devices(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, last_seen_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 request_window timestamptz NOT NULL DEFAULT now(), request_count integer NOT NULL DEFAULT 0
);
CREATE TABLE app.device_bridge_calls (
 id text PRIMARY KEY, device_id text NOT NULL REFERENCES app.device_bridges(device_id),
 command_id text NOT NULL REFERENCES app.device_commands(id), execution_token text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('read','execute')), phase text NOT NULL CHECK(phase IN ('before','write','after')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','started','completed','cancelled')),
 lease text, deadline timestamptz NOT NULL, active_until timestamptz,
 result jsonb, result_digest text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(command_id,execution_token,phase)
);
CREATE INDEX device_bridge_pending ON app.device_bridge_calls(device_id,created_at) WHERE state='pending';
