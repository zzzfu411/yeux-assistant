-- Indexed search terms for every chunk. app.search_terms is the single tokenizer definition; the
-- TypeScript mirror in packages/core/src/search.ts is checked against it by tests.
-- NFKC folds full-width letters and digits; ASCII words of two or more characters stay whole;
-- each run of Han characters contributes its bigrams and its single characters.
CREATE FUNCTION app.search_terms(input text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT term ORDER BY term), '{}')
  FROM regexp_matches(
    lower(normalize(coalesce(input, ''), NFKC)),
    '[a-z0-9_]{2,}|[⺀-⿟々〇〡-〩〸-〻㐀-䶿一-鿿豈-﫿\U00020000-\U0003134f]+',
    'g'
  ) AS found(token),
  LATERAL (
    SELECT found.token[1] AS term WHERE found.token[1] ~ '^[a-z0-9_]+$'
    UNION ALL
    SELECT substr(found.token[1], i, 2) FROM generate_series(1, char_length(found.token[1]) - 1) AS i
      WHERE found.token[1] !~ '^[a-z0-9_]+$'
    UNION ALL
    SELECT substr(found.token[1], i, 1) FROM generate_series(1, char_length(found.token[1])) AS i
      WHERE found.token[1] !~ '^[a-z0-9_]+$'
  ) AS terms
$$;
ALTER TABLE app.chunks ADD COLUMN lexemes text[] GENERATED ALWAYS AS (app.search_terms(content)) STORED;
-- Without the pending list every search reads only the index proper; material changes far less often than it is searched.
CREATE INDEX chunk_lexemes ON app.chunks USING gin(lexemes) WITH (fastupdate = off);
