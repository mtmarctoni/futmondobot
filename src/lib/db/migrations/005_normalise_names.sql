-- Stray whitespace in names, and the join that quietly lost rows to it.
--
-- Futmondo stores what its users typed. Five player names in this league end
-- in a space, which shows up as a double space wherever a name is written into
-- a sentence. The parser now trims on the way in, so those rows self-heal on
-- the next sync; this migration does not wait for one.
--
-- The expensive half is `money_events`. A pressroom item names a team and
-- gives no id, so the name is matched against `teams` and `team_name_history`
-- to find one. That match was exact apart from case, and `getRivalFunds` only
-- sums events whose `team_id` is not null, so a single stray space would drop
-- a prize from a rival's estimated funds. The ledger is append-only and
-- nothing revisits a row, so it would have stayed dropped.

-- One definition of "the same name", used by the join and by this migration,
-- so the two cannot drift apart. IMMUTABLE so it can be indexed later.
CREATE OR REPLACE FUNCTION norm_name(v TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT lower(btrim(regexp_replace(v, '\s+', ' ', 'g'))) $$;

UPDATE players SET name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
 WHERE name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

UPDATE players SET team_name = btrim(regexp_replace(team_name, '\s+', ' ', 'g'))
 WHERE team_name IS NOT NULL
   AND team_name <> btrim(regexp_replace(team_name, '\s+', ' ', 'g'));

UPDATE teams SET team_name = btrim(regexp_replace(team_name, '\s+', ' ', 'g'))
 WHERE team_name IS NOT NULL
   AND team_name <> btrim(regexp_replace(team_name, '\s+', ' ', 'g'));

-- (team_id, team_name) is the primary key here, so trimming one row onto
-- another's spelling would collide. Drop the losers first, keeping the
-- earliest first_seen, since the pair carries no information beyond the name.
DELETE FROM team_name_history h
 WHERE EXISTS (
   SELECT 1 FROM team_name_history o
    WHERE o.team_id = h.team_id
      AND norm_name(o.team_name) = norm_name(h.team_name)
      AND (o.first_seen, o.team_name) < (h.first_seen, h.team_name)
 );

UPDATE team_name_history
   SET team_name = btrim(regexp_replace(team_name, '\s+', ' ', 'g'))
 WHERE team_name <> btrim(regexp_replace(team_name, '\s+', ' ', 'g'));

-- Repair, not rewrite: ledger rows keep the name exactly as the pressroom
-- reported it, and only the id nobody could resolve is filled in.
UPDATE money_events e
   SET team_id = COALESCE(
     (SELECT team_id FROM teams t
       WHERE norm_name(t.team_name) = norm_name(e.team_name) LIMIT 1),
     (SELECT team_id FROM team_name_history h
       WHERE norm_name(h.team_name) = norm_name(e.team_name) LIMIT 1)
   )
 WHERE e.team_id IS NULL AND e.team_name IS NOT NULL;
