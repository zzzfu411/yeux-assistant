CREATE TABLE app.device_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO app.device_control(singleton) VALUES(true);
CREATE TABLE app.devices (
 id text PRIMARY KEY, name text NOT NULL, adapter text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 observed_state jsonb, observed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.device_commands (
 id text PRIMARY KEY, device_id text NOT NULL REFERENCES app.devices(id),
 payload jsonb NOT NULL, digest text NOT NULL, summary text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','executing','succeeded','failed','uncertain','rejected','cancelled','expired','resolved')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), expires_at timestamptz NOT NULL,
 execution_token text, execution_deadline timestamptz, error text NOT NULL DEFAULT '', receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX one_open_device_command ON app.device_commands(device_id) WHERE state IN ('pending','approved','executing','uncertain');
CREATE INDEX device_commands_recent ON app.device_commands(created_at DESC,id);
CREATE TABLE app.device_simulation_state (
 device_id text PRIMARY KEY REFERENCES app.devices(id), power boolean NOT NULL DEFAULT false
);
