-- One execution kernel for every flow: a step's receipt commits with its effects, and every model
-- request is traced with its step, profile, timing and token use.
CREATE TABLE app.run_steps (
  run_id text NOT NULL REFERENCES app.runs(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  -- Digest of what the step depended on; a retried run may reuse a receipt only when it matches.
  input_digest text NOT NULL DEFAULT '',
  output jsonb NOT NULL,
  reused_from text REFERENCES app.runs(id),
  started_at timestamptz,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, name)
);
CREATE TABLE app.model_calls (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES app.runs(id),
  generation integer NOT NULL,
  step text NOT NULL DEFAULT '',
  profile text NOT NULL,
  model text NOT NULL,
  structured text NOT NULL DEFAULT 'none' CHECK(structured IN ('none', 'json_schema')),
  started_at timestamptz NOT NULL DEFAULT now(),
  first_byte_ms integer CHECK(first_byte_ms >= 0),
  latency_ms integer CHECK(latency_ms >= 0),
  prompt_tokens integer CHECK(prompt_tokens >= 0),
  completion_tokens integer CHECK(completion_tokens >= 0),
  reasoning_tokens integer CHECK(reasoning_tokens >= 0),
  outcome text NOT NULL DEFAULT 'pending'
    CHECK(outcome IN ('pending', 'ok', 'invalid', 'http_error', 'unavailable', 'budget')),
  error_code text NOT NULL DEFAULT ''
);
CREATE INDEX model_calls_run ON app.model_calls(run_id, id);

-- Node receipts used to live in the key/value settings table as runtime:<run>:<node>.
-- Run IDs are UUIDs, so the second field is the run and the remainder is the node name.
INSERT INTO app.run_steps(run_id, name, output)
SELECT r.id, substring(s.key FROM '^runtime:[^:]+:(.+)$'), s.value
FROM app.settings s JOIN app.runs r ON r.id = split_part(s.key, ':', 2)
WHERE s.key LIKE 'runtime:%' AND substring(s.key FROM '^runtime:[^:]+:(.+)$') IS NOT NULL;
DELETE FROM app.settings s
USING app.run_steps st
WHERE s.key = 'runtime:' || st.run_id || ':' || st.name;
