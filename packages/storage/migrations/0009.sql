ALTER TABLE app.memories ADD COLUMN IF NOT EXISTS path text UNIQUE;
ALTER TABLE app.memories ADD COLUMN IF NOT EXISTS file_digest text;
ALTER TABLE app.memories ADD COLUMN IF NOT EXISTS commit_sha text;
ALTER TABLE app.memories ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'web' CHECK (origin IN ('web','file_edit','import'));
ALTER TABLE app.memory_versions ADD COLUMN IF NOT EXISTS commit_sha text;
CREATE TABLE IF NOT EXISTS app.rule_usage(
  run_id text NOT NULL REFERENCES app.runs(id), key text NOT NULL, version integer NOT NULL,
  commit_sha text, content text NOT NULL, PRIMARY KEY(run_id,key)
);
CREATE TABLE IF NOT EXISTS app.flows(
  id text PRIMARY KEY,path text NOT NULL UNIQUE,version integer NOT NULL,digest text,commit_sha text,
  enabled boolean NOT NULL DEFAULT true,definition jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
