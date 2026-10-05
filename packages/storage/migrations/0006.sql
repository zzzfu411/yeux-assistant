-- Business event IDs are allocated before transaction commit. A separate cursor
-- is assigned only to committed events, so a late commit can never be skipped.
ALTER TABLE app.events ADD COLUMN stream_id bigint;
UPDATE app.events SET stream_id=id;
CREATE UNIQUE INDEX events_stream_id ON app.events(stream_id) WHERE stream_id IS NOT NULL;
CREATE INDEX events_unpublished ON app.events(id) WHERE stream_id IS NULL;
CREATE TABLE app.event_stream (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 cursor bigint NOT NULL CHECK (cursor >= 0)
);
INSERT INTO app.event_stream(singleton,cursor) SELECT true,coalesce(max(stream_id),0) FROM app.events;
