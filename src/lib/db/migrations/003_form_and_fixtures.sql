-- Two signals the engine was asking for and never receiving.
--
-- 1. Real results. `/2/league/matches` names the two sides `h` and `a`, which
--    the parser did not read, so every fixture was stored with a null team id
--    and fixture difficulty could never attach to a club. With ids restored the
--    scores come free, and they are the strength signal that still works for a
--    fixture no bookmaker has priced.
--
-- 2. The per-player scoring record. `/1/userteam/roundlineup` returns an empty
--    player list for closed rounds, so `round_points` stays empty and form was
--    permanently unknown -- every player scored the bare role prior, which is
--    why the lineup page showed one identical number per position. The roster
--    payload has carried the record all along under `average`; these columns
--    historise it so the trend survives even though the API only reports today.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_score INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_score INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS finished   BOOLEAN;

ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS matches_played    INTEGER;
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS average_last_five NUMERIC(6, 2);
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS home_average      NUMERIC(6, 2);
ALTER TABLE player_snapshots ADD COLUMN IF NOT EXISTS away_average      NUMERIC(6, 2);
