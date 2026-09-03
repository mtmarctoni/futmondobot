-- This league scores in decimals.
--
-- The live payload reports a player's season total as 12.2 and a single match
-- as 4.1, so `points INTEGER` rejected the real data outright: the daily sync
-- died on `invalid input syntax for type integer: "12.2"` and wrote nothing.
--
-- Rounding was the wrong fix. Expected points are real points here, converted
-- to prize money at the league's own rate, so truncating every player to a
-- whole number would bias the exact quantity the lineup picker optimises.
ALTER TABLE player_snapshots ALTER COLUMN points TYPE NUMERIC(7, 2);
ALTER TABLE round_points     ALTER COLUMN points TYPE NUMERIC(7, 2);
