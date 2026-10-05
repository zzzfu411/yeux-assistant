-- Lifecycle revisions are independent of immutable document versions.
ALTER TABLE app.sources ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE app.sources ADD COLUMN archived_at timestamptz;
ALTER TABLE app.sources ADD COLUMN managed boolean NOT NULL DEFAULT false;
UPDATE app.sources SET revision=version;
-- This exact path convention is owned by the Web text importer.
UPDATE app.sources SET managed=true WHERE id ~ '^source-[a-f0-9]{24}$' AND path=id||'.md';

-- Older releases did not record per-version titles. Preserve the only known
-- title at migration time; every version created afterwards stores its own.
ALTER TABLE app.source_versions ADD COLUMN title text;
UPDATE app.source_versions v SET title=s.title FROM app.sources s WHERE s.id=v.source_id;
ALTER TABLE app.source_versions ALTER COLUMN title SET NOT NULL;
CREATE INDEX source_digest ON app.sources(digest);
CREATE INDEX source_lifecycle ON app.sources(archived_at,updated_at DESC,id);
