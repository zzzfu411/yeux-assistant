CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE app.goals (
 id text PRIMARY KEY, title text NOT NULL, outcome text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
 revision integer NOT NULL DEFAULT 1, source_ids jsonb NOT NULL DEFAULT '[]',
 intervals jsonb NOT NULL DEFAULT '[86400,259200,604800]', review_stage integer NOT NULL DEFAULT 0,
 next_review timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.plans (
 id text PRIMARY KEY, goal_id text NOT NULL REFERENCES app.goals(id), version integer NOT NULL,
 steps jsonb NOT NULL, rationale text NOT NULL, goal_revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(goal_id,version)
);
CREATE TABLE app.sessions (
 id text PRIMARY KEY, goal_id text REFERENCES app.goals(id), title text NOT NULL, kind text NOT NULL,
 prompt text NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting_feedback','ready','completed','failed','cancelled','archived')),
 revision integer NOT NULL DEFAULT 1, current_run_id text, content text NOT NULL DEFAULT '',
 citations jsonb NOT NULL DEFAULT '[]', error text NOT NULL DEFAULT '', recipient text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_session_per_goal ON app.sessions(goal_id) WHERE goal_id IS NOT NULL AND state IN ('queued','running','waiting_feedback');
CREATE TABLE app.attempts (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES app.sessions(id), answer text NOT NULL,
 verdict text NOT NULL DEFAULT 'pending', feedback text NOT NULL DEFAULT '', evidence text NOT NULL DEFAULT '',
 source text NOT NULL DEFAULT 'model_estimate', self_report text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.runs (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES app.sessions(id), state text NOT NULL DEFAULT 'queued',
 input jsonb NOT NULL DEFAULT '{}', generation integer NOT NULL DEFAULT 0, graph_thread text NOT NULL,
 model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls <= 5), usage jsonb NOT NULL DEFAULT '[]',
 error text NOT NULL DEFAULT '', deadline timestamptz, started_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX run_state ON app.runs(state);
CREATE TABLE app.artifacts (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES app.sessions(id), run_id text,
 kind text NOT NULL, content text NOT NULL, provenance text NOT NULL, citations jsonb NOT NULL DEFAULT '[]',
 dedupe_key text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.sources (
 id text PRIMARY KEY, title text NOT NULL, path text UNIQUE, version integer NOT NULL DEFAULT 1,
 digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.source_versions (
 source_id text NOT NULL REFERENCES app.sources(id), version integer NOT NULL, content text NOT NULL,
 digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_id,version)
);
CREATE TABLE app.chunks (
 id text PRIMARY KEY, source_id text NOT NULL, version integer NOT NULL, start_offset integer NOT NULL,
 end_offset integer NOT NULL, content text NOT NULL, FOREIGN KEY(source_id,version) REFERENCES app.source_versions(source_id,version)
);
CREATE INDEX chunk_text ON app.chunks USING gin(content gin_trgm_ops);
CREATE INDEX chunk_source ON app.chunks(source_id,version);
CREATE TABLE app.memories (
 key text PRIMARY KEY, scope text NOT NULL, content text NOT NULL, version integer NOT NULL,
 confirmed boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true, source_session text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.memory_versions (
 key text NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(key,version)
);
CREATE TABLE app.schedules (
 id text PRIMARY KEY, title text NOT NULL, kind text NOT NULL, prompt text NOT NULL,
 interval_seconds integer NOT NULL CHECK(interval_seconds=0 OR interval_seconds>=60), next_run timestamptz NOT NULL,
 enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, active_session text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.notifications (
 id text PRIMARY KEY, dedupe_key text UNIQUE NOT NULL, session_id text, title text NOT NULL, body text NOT NULL DEFAULT '',
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL, entity_id text, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.commands (
 key text PRIMARY KEY, operation text NOT NULL, digest text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.approvals (
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES app.sessions(id), action text NOT NULL,
 digest text NOT NULL, payload jsonb NOT NULL, state text NOT NULL, message_id text NOT NULL,
 error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, finished_at timestamptz
);
CREATE TABLE app.health (
 name text PRIMARY KEY, heartbeat timestamptz NOT NULL DEFAULT now(), error text NOT NULL DEFAULT ''
);
CREATE TABLE app.settings(key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE app.legacy_rows (
 table_name text NOT NULL, row_key text NOT NULL, payload jsonb NOT NULL, digest text NOT NULL,
 PRIMARY KEY(table_name,row_key)
);
CREATE TABLE app.imports (
 id text PRIMARY KEY, source_digest text UNIQUE NOT NULL, report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
