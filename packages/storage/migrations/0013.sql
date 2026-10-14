CREATE TABLE app.action_evidence (
 command_id text NOT NULL REFERENCES app.device_commands(id),
 call_id text PRIMARY KEY REFERENCES app.device_bridge_calls(id),
 kind text NOT NULL CHECK(kind='screenshot'), path text NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes BETWEEN 24 AND 2097152), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_evidence_command ON app.action_evidence(command_id,digest);
