-- Four facts the API has been handing us all along and we discarded.
--
-- 1. `clause.date` — the instant a clause first becomes payable. Without it the
--    engine offered 55 clause steals and 15 clause blocks on a day when not one
--    clause in the league could be paid by anybody. It is stored, never
--    derived: drafted players carry acquisition + 5 days to the millisecond and
--    bought players carry end-of-local-day + 2, and reconciling those two into
--    a formula would be guessing about a decision that spends millions.
--
-- 2. `suggestedClause` — Futmondo's own valuation of a fair clause, roughly
--    half what owners actually set. A free prior for both attack and defence.
--
-- 3. The measured start record from `/1/player/summary`'s `points[]`. This is
--    what `round_points` was always meant to hold: `/1/userteam/roundlineup`
--    returns an empty player list even for closed rounds, so the table has been
--    empty since the app was written and start probability was a guess for 116
--    of 135 owned players.
--
-- 4. Daily value history from the same call, reaching back before our first
--    snapshot. "History cannot be backfilled" holds for points and ownership;
--    for value it is simply false, because the whole series is republished on
--    every call. A backfilled row is marked so a real capture always wins.

ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS clause_date      TIMESTAMPTZ;
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS suggested_clause BIGINT;
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS on_market        BOOLEAN;
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS ask_price        BIGINT;
-- Futmondo's own availability marker, from the roster and market rows.
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS status           TEXT;
-- TRUE for a value reconstructed from `/1/player/summary`'s `prices[]` rather
-- than captured live on the day.
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS value_backfilled BOOLEAN NOT NULL DEFAULT FALSE;

-- Whether the player was in the starting XI, as opposed to merely appearing.
-- `started` already exists but was only ever written from the dead roundlineup
-- endpoint, where it meant "not on the fantasy bench".
ALTER TABLE round_points ADD COLUMN IF NOT EXISTS initial_lineup BOOLEAN;

-- Where a round_points row came from. Rows sourced from a player summary use
-- the sentinel team id '@summary': they describe the player's own real-life
-- appearance rather than a fantasy team fielding him, so they have no owning
-- userteam and must not be confused with one.
ALTER TABLE round_points ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'roundlineup';

CREATE INDEX IF NOT EXISTS round_points_source_idx ON round_points (source);
