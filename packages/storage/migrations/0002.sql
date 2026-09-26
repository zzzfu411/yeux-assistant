-- Extraction metadata belongs to a specific immutable source text version.
ALTER TABLE app.source_versions ADD COLUMN metadata jsonb;
ALTER TABLE app.source_versions ADD CONSTRAINT source_metadata_object
  CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object');
