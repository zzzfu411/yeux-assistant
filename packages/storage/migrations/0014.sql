ALTER TABLE app.sessions ADD COLUMN research jsonb;
ALTER TABLE app.runs ADD COLUMN max_model_calls integer NOT NULL DEFAULT 5 CHECK(max_model_calls BETWEEN 1 AND 8);
ALTER TABLE app.runs ADD COLUMN max_seconds integer NOT NULL DEFAULT 180 CHECK(max_seconds BETWEEN 1 AND 480);
ALTER TABLE app.runs DROP CONSTRAINT runs_model_calls_check;
ALTER TABLE app.runs ADD CONSTRAINT runs_model_calls_check CHECK(model_calls >= 0 AND model_calls <= max_model_calls);
CREATE TABLE app.research_workspaces (
  run_id text PRIMARY KEY REFERENCES app.runs(id),
  snapshot jsonb NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
