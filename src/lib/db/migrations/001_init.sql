-- Futmondo history store.
--
-- The API only ever reports the present: today's value, today's clause, today's
-- funds. Every edge in this app comes from comparing today against yesterday,
-- so the job of these tables is to accumulate what the API forgets.
--
-- Two tables are append-only ledgers (transfers, money_events) because
-- Futmondo's pressroom pagination is non-deterministic and returns different
-- subsets on different calls. A sync that fails to return a row is not
-- evidence the row is gone, so nothing here is ever deleted by a sync.

-- Slow-changing player identity. One row per player, overwritten in place.
CREATE TABLE IF NOT EXISTS players (
  player_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('POR', 'DEF', 'MED', 'DEL')),
  team_id     TEXT,
  team_name   TEXT,
  -- Needed alongside player_id to bid or pay a clause.
  slug        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS players_team_id_idx ON players (team_id);

-- League members. team_id is the userteamId used in API calls.
CREATE TABLE IF NOT EXISTS teams (
  team_id     TEXT PRIMARY KEY,
  -- The stable account id. Join on this, never on a name.
  userid      TEXT NOT NULL,
  team_name   TEXT,
  user_name   TEXT,
  team_value  BIGINT,
  is_me       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- In-game team names change when a user renames. Money events identify a team
-- only by name, so historical names must stay resolvable.
CREATE TABLE IF NOT EXISTS team_name_history (
  team_id     TEXT NOT NULL REFERENCES teams (team_id) ON DELETE CASCADE,
  team_name   TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, team_name)
);

-- The core time series: one row per player per day. Everything that moves.
CREATE TABLE IF NOT EXISTS player_snapshots (
  snapshot_date  DATE NOT NULL,
  player_id      TEXT NOT NULL,
  value          BIGINT,
  points         INTEGER,
  average        NUMERIC(6, 2),
  -- Only known after a /1/player/summary lookup, so often null.
  clause_price   BIGINT,
  -- Null means nobody in the league owns the player.
  owner_team_id  TEXT,
  -- True when the owner has clause-blocked them.
  locked         BOOLEAN,
  -- Present only while the player sits in the daily market.
  market_price   BIGINT,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, player_id)
);

CREATE INDEX IF NOT EXISTS player_snapshots_player_idx
  ON player_snapshots (player_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS player_snapshots_owner_idx
  ON player_snapshots (snapshot_date, owner_team_id);

-- Matchdays. deadline is the earliest kickoff in the round: once the first
-- match starts, lineups for it are locked.
CREATE TABLE IF NOT EXISTS rounds (
  round_id    TEXT PRIMARY KEY,
  number      NUMERIC(5, 1) NOT NULL,
  status      TEXT NOT NULL,
  deadline    TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rounds_number_idx ON rounds (number);

-- Real fixtures, with bookmaker odds as the fixture-difficulty signal.
CREATE TABLE IF NOT EXISTS matches (
  match_id      TEXT PRIMARY KEY,
  round_id      TEXT,
  kickoff       TIMESTAMPTZ,
  home_team_id  TEXT,
  away_team_id  TEXT,
  home_team     TEXT,
  away_team     TEXT,
  odds_home     NUMERIC(8, 3),
  odds_draw     NUMERIC(8, 3),
  odds_away     NUMERIC(8, 3),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches (kickoff);
CREATE INDEX IF NOT EXISTS matches_home_idx ON matches (home_team_id);
CREATE INDEX IF NOT EXISTS matches_away_idx ON matches (away_team_id);

-- Per-player, per-round performance, for every team in the league. The only
-- place real form can be measured rather than guessed from a season average.
CREATE TABLE IF NOT EXISTS round_points (
  round_id     TEXT NOT NULL,
  player_id    TEXT NOT NULL,
  -- The userteam that fielded them that round.
  team_id      TEXT NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  minutes      INTEGER,
  goals        INTEGER,
  assists      INTEGER,
  yellow_cards INTEGER,
  red_cards    INTEGER,
  started      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (round_id, player_id, team_id)
);

CREATE INDEX IF NOT EXISTS round_points_player_idx ON round_points (player_id);

-- Append-only transfer ledger. Never deleted: pagination is unreliable, so an
-- absent row means "not returned this time", not "did not happen".
CREATE TABLE IF NOT EXISTS transfers (
  tx_id           TEXT PRIMARY KEY,
  player_id       TEXT,
  player_name     TEXT,
  -- Null when Futmondo itself was the counterparty.
  buyer_team_id   TEXT,
  buyer_name      TEXT,
  seller_team_id  TEXT,
  seller_name     TEXT,
  price           BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfers_created_idx ON transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_buyer_idx ON transfers (buyer_team_id);
CREATE INDEX IF NOT EXISTS transfers_seller_idx ON transfers (seller_team_id);

-- Prize payouts. The news feed gives no team id, only a name, so team_id is
-- resolved by matching against teams/team_name_history and may stay null.
CREATE TABLE IF NOT EXISTS money_events (
  event_id     TEXT PRIMARY KEY,
  team_id      TEXT,
  team_name    TEXT,
  amount       BIGINT NOT NULL DEFAULT 0,
  description  TEXT,
  created_at   TIMESTAMPTZ,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS money_events_team_idx ON money_events (team_id);

-- Injuries and suspensions, kept as observations so a player's availability
-- history is legible rather than only its current state.
CREATE TABLE IF NOT EXISTS unavailability (
  observed_on  DATE NOT NULL,
  player_id    TEXT NOT NULL,
  team_id      TEXT,
  reason       TEXT,
  player_name  TEXT,
  PRIMARY KEY (observed_on, player_id)
);

CREATE INDEX IF NOT EXISTS unavailability_player_idx ON unavailability (player_id);

-- Probable lineups scraped from a third party. Kept separate from Futmondo
-- data because the source is fragile and may be absent for a round.
CREATE TABLE IF NOT EXISTS probable_lineups (
  observed_on   DATE NOT NULL,
  round_number  NUMERIC(5, 1),
  -- Matching is by normalised name, so keep what we matched on.
  match_name    TEXT NOT NULL,
  player_id     TEXT,
  team_name     TEXT,
  -- 0..1 confidence that the player starts.
  start_prob    NUMERIC(4, 3),
  source        TEXT NOT NULL,
  PRIMARY KEY (observed_on, match_name, source)
);

CREATE INDEX IF NOT EXISTS probable_lineups_player_idx ON probable_lineups (player_id);

-- Cached Futmondo session, so serverless cold starts do not re-login and risk
-- an account lock. Single row.
CREATE TABLE IF NOT EXISTS futmondo_session (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  token       TEXT NOT NULL,
  userid      TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit trail of every write this app makes to Futmondo, so an automated
-- lineup change or clause block is always traceable to a run.
CREATE TABLE IF NOT EXISTS action_log (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      JSONB,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_log_created_idx ON action_log (created_at DESC);
