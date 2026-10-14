-- Research runs need longer wall-clock ceilings: real Lab2 runs hit 240 s after four calls.
-- Only the time ceiling changes; model-call budgets (1/4/8) and their constraint stay as in 0014.
ALTER TABLE app.runs DROP CONSTRAINT runs_max_seconds_check;
ALTER TABLE app.runs ADD CONSTRAINT runs_max_seconds_check CHECK(max_seconds BETWEEN 1 AND 900);
