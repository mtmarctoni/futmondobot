/**
 * Data access for the history store. Bulk writes go through UNNEST so a whole
 * sync batch is one parameterised round trip rather than a loop of statements.
 */
import type {
  ChampionshipTeam,
  MarketPlayer,
  MatchOdds,
  MoneyEvent,
  Player,
  RosterPlayer,
  RoundLineup,
  RoundWithMatches,
  Transfer,
  UnavailablePlayer,
} from "../futmondo/types";
import { getSql } from "./client";

type Row = Record<string, unknown>;

/**
 * Formats a `date` column back to `YYYY-MM-DD`.
 *
 * Two traps here, both of which silently corrupt a value trend:
 *
 * 1. The driver returns a JS Date, not a string, so `String(value)` yields
 *    "Sat Jan 01 2000 …" and slicing ten characters gives "Sat Jan 01".
 * 2. That Date is built in *local* time, so 2000-01-01 becomes
 *    1999-12-31T23:00:00Z under a positive UTC offset. Calling `toISOString`
 *    would therefore report the previous day.
 *
 * So the local calendar components are read, never the UTC ones.
 */
function isoDay(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

function isoInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** ISO date in Europe/Madrid, which is the day boundary the league runs on. */
export function today(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// --------------------------------------------------------------- players ----

export async function upsertPlayers(players: Player[]): Promise<number> {
  if (players.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `INSERT INTO players (player_id, name, role, team_id, team_name, slug, updated_at)
     SELECT * FROM UNNEST(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
     ), now()
     ON CONFLICT (player_id) DO UPDATE SET
       name       = EXCLUDED.name,
       role       = EXCLUDED.role,
       team_id    = COALESCE(EXCLUDED.team_id, players.team_id),
       team_name  = COALESCE(EXCLUDED.team_name, players.team_name),
       -- A slug is only learned from /1/player/summary, so never overwrite a
       -- known one with a null from a cheaper endpoint.
       slug       = COALESCE(EXCLUDED.slug, players.slug),
       updated_at = now()`,
    [
      players.map((p) => p.id),
      players.map((p) => p.name),
      players.map((p) => p.role),
      players.map((p) => p.teamId ?? null),
      players.map((p) => p.team ?? null),
      players.map((p) => p.slug ?? null),
    ],
  );
  return players.length;
}

export async function setPlayerSlug(
  playerId: string,
  slug: string,
): Promise<void> {
  const sql = getSql();
  await sql`UPDATE players SET slug = ${slug}, updated_at = now() WHERE player_id = ${playerId}`;
}

// ----------------------------------------------------------------- teams ----

export async function upsertTeams(
  teams: ChampionshipTeam[],
  myTeamId?: string,
): Promise<number> {
  if (teams.length === 0) return 0;
  const sql = getSql();

  await sql.query(
    `INSERT INTO teams (team_id, userid, team_name, user_name, team_value, is_me, updated_at)
     SELECT * FROM UNNEST(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::boolean[]
     ), now()
     ON CONFLICT (team_id) DO UPDATE SET
       userid     = EXCLUDED.userid,
       team_name  = EXCLUDED.team_name,
       user_name  = COALESCE(EXCLUDED.user_name, teams.user_name),
       team_value = COALESCE(EXCLUDED.team_value, teams.team_value),
       is_me      = teams.is_me OR EXCLUDED.is_me,
       updated_at = now()`,
    [
      teams.map((t) => t.teamId),
      teams.map((t) => t.userid),
      teams.map((t) => t.teamName),
      teams.map((t) => t.userName ?? null),
      teams.map((t) => t.teamValue ?? null),
      teams.map((t) => t.teamId === myTeamId),
    ],
  );

  // Names change, and money events identify a team only by name, so every
  // name a team has ever used must stay resolvable.
  await sql.query(
    `INSERT INTO team_name_history (team_id, team_name)
     SELECT * FROM UNNEST($1::text[], $2::text[])
     ON CONFLICT (team_id, team_name) DO UPDATE SET last_seen = now()`,
    [teams.map((t) => t.teamId), teams.map((t) => t.teamName)],
  );

  return teams.length;
}

export interface TeamRow {
  teamId: string;
  userid: string;
  teamName: string | null;
  userName: string | null;
  teamValue: number | null;
  isMe: boolean;
}

export async function getTeams(): Promise<TeamRow[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT team_id, userid, team_name, user_name, team_value, is_me
    FROM teams ORDER BY team_name`) as Row[];
  return rows.map((r) => ({
    teamId: String(r.team_id),
    userid: String(r.userid),
    teamName: r.team_name as string | null,
    userName: r.user_name as string | null,
    teamValue: r.team_value === null ? null : Number(r.team_value),
    isMe: Boolean(r.is_me),
  }));
}

// ------------------------------------------------------------- snapshots ----

export interface SnapshotInput {
  playerId: string;
  value?: number;
  points?: number;
  average?: number;
  clausePrice?: number;
  ownerTeamId?: string;
  locked?: boolean;
  marketPrice?: number;
}

/**
 * Writes one day's row per player. Re-running the same day updates it, and
 * COALESCE keeps facts learned by an earlier, richer pass — a cheap roster
 * sync must not wipe a clause price a summary sweep already found.
 */
/**
 * Folds repeated rows for one player into a single row, mirroring the SQL's
 * COALESCE: a later defined value wins, and an undefined one never clobbers a
 * known fact.
 *
 * A batch legitimately contains the same player twice. A rival-owned player who
 * is also listed on the market arrives once from their owner's roster (owner,
 * locked, clause) and once from the market (price). Postgres refuses to let one
 * ON CONFLICT statement touch the same row twice, so without this the whole
 * day's snapshot write failed. Merging rather than dropping keeps both halves.
 */
export function mergeSnapshots(rows: SnapshotInput[]): SnapshotInput[] {
  const merged = new Map<string, SnapshotInput>();
  for (const row of rows) {
    const prev = merged.get(row.playerId);
    if (!prev) {
      merged.set(row.playerId, { ...row });
      continue;
    }
    merged.set(row.playerId, {
      playerId: row.playerId,
      value: row.value ?? prev.value,
      points: row.points ?? prev.points,
      average: row.average ?? prev.average,
      clausePrice: row.clausePrice ?? prev.clausePrice,
      ownerTeamId: row.ownerTeamId ?? prev.ownerTeamId,
      locked: row.locked ?? prev.locked,
      marketPrice: row.marketPrice ?? prev.marketPrice,
    });
  }
  return [...merged.values()];
}

export async function writeSnapshots(
  date: string,
  input: SnapshotInput[],
): Promise<number> {
  const rows = mergeSnapshots(input);
  if (rows.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `INSERT INTO player_snapshots (
       snapshot_date, player_id, value, points, average,
       clause_price, owner_team_id, locked, market_price, captured_at
     )
     SELECT $1::date, * FROM UNNEST(
       $2::text[], $3::bigint[], $4::numeric[], $5::numeric[],
       $6::bigint[], $7::text[], $8::boolean[], $9::bigint[]
     ), now()
     ON CONFLICT (snapshot_date, player_id) DO UPDATE SET
       value         = COALESCE(EXCLUDED.value, player_snapshots.value),
       points        = COALESCE(EXCLUDED.points, player_snapshots.points),
       average       = COALESCE(EXCLUDED.average, player_snapshots.average),
       clause_price  = COALESCE(EXCLUDED.clause_price, player_snapshots.clause_price),
       owner_team_id = COALESCE(EXCLUDED.owner_team_id, player_snapshots.owner_team_id),
       locked        = COALESCE(EXCLUDED.locked, player_snapshots.locked),
       market_price  = COALESCE(EXCLUDED.market_price, player_snapshots.market_price),
       captured_at   = now()`,
    [
      date,
      rows.map((r) => r.playerId),
      rows.map((r) => r.value ?? null),
      rows.map((r) => r.points ?? null),
      rows.map((r) => r.average ?? null),
      rows.map((r) => r.clausePrice ?? null),
      rows.map((r) => r.ownerTeamId ?? null),
      rows.map((r) => r.locked ?? null),
      rows.map((r) => r.marketPrice ?? null),
    ],
  );
  return rows.length;
}

export function snapshotsFromRoster(
  roster: RosterPlayer[],
  ownerTeamId: string,
): SnapshotInput[] {
  return roster.map((p) => ({
    playerId: p.id,
    value: p.value,
    points: p.points,
    average: p.average,
    clausePrice: p.clause,
    ownerTeamId,
    locked: p.locked,
  }));
}

export function snapshotsFromMarket(market: MarketPlayer[]): SnapshotInput[] {
  return market.map((p) => ({
    playerId: p.id,
    value: p.value,
    points: p.points,
    average: p.average,
    marketPrice: p.price,
    // A machine listing means nobody owns them; leave owner unset otherwise so
    // COALESCE does not clobber ownership learned from a roster sync.
    ownerTeamId: p.fromComputer ? undefined : p.sellerTeamId,
  }));
}

export interface ValuePoint {
  date: string;
  value: number | null;
  points: number | null;
}

/** A player's value and points history, newest first. */
export async function getValueHistory(
  playerId: string,
  days = 30,
): Promise<ValuePoint[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT snapshot_date, value, points
    FROM player_snapshots
    WHERE player_id = ${playerId}
      AND snapshot_date >= CURRENT_DATE - ${days}::int
    ORDER BY snapshot_date DESC`) as Row[];
  return rows.map((r) => ({
    date: isoDay(r.snapshot_date),
    value: r.value === null ? null : Number(r.value),
    points: r.points === null ? null : Number(r.points),
  }));
}

export interface ValueTrend {
  playerId: string;
  currentValue: number;
  /** Change over the window in euros. Positive means rising. */
  delta: number;
  /** Days of data actually available, so callers can discount thin history. */
  days: number;
}

/**
 * Value movement per player over a window. This is the signal the live API
 * cannot provide, and the reason the snapshot table exists.
 */
export async function getValueTrends(days = 7): Promise<ValueTrend[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH window_rows AS (
      SELECT player_id, snapshot_date, value
      FROM player_snapshots
      WHERE snapshot_date >= CURRENT_DATE - ${days}::int
        AND value IS NOT NULL
    ),
    bounds AS (
      SELECT
        player_id,
        min(snapshot_date) AS first_date,
        max(snapshot_date) AS last_date,
        count(*)           AS days
      FROM window_rows GROUP BY player_id
    )
    SELECT
      b.player_id,
      last_row.value  AS current_value,
      first_row.value AS first_value,
      b.days
    FROM bounds b
    JOIN window_rows first_row
      ON first_row.player_id = b.player_id AND first_row.snapshot_date = b.first_date
    JOIN window_rows last_row
      ON last_row.player_id = b.player_id AND last_row.snapshot_date = b.last_date`) as Row[];

  return rows.map((r) => ({
    playerId: String(r.player_id),
    currentValue: Number(r.current_value),
    delta: Number(r.current_value) - Number(r.first_value),
    days: Number(r.days),
  }));
}

/** Latest known ownership and clause price for every player we have seen. */
export async function getLatestOwnership(): Promise<
  {
    playerId: string;
    name: string;
    role: string;
    teamId: string | null;
    teamName: string | null;
    slug: string | null;
    value: number | null;
    points: number | null;
    clausePrice: number | null;
    ownerTeamId: string | null;
    locked: boolean | null;
  }[]
> {
  const sql = getSql();
  const rows = (await sql`
    SELECT DISTINCT ON (s.player_id)
      s.player_id, p.name, p.role, p.team_id, p.team_name, p.slug,
      s.value, s.points, s.clause_price, s.owner_team_id, s.locked
    FROM player_snapshots s
    JOIN players p ON p.player_id = s.player_id
    ORDER BY s.player_id, s.snapshot_date DESC`) as Row[];

  return rows.map((r) => ({
    playerId: String(r.player_id),
    name: String(r.name),
    role: String(r.role),
    teamId: r.team_id as string | null,
    teamName: r.team_name as string | null,
    slug: r.slug as string | null,
    value: r.value === null ? null : Number(r.value),
    points: r.points === null ? null : Number(r.points),
    clausePrice: r.clause_price === null ? null : Number(r.clause_price),
    ownerTeamId: r.owner_team_id as string | null,
    locked: r.locked as boolean | null,
  }));
}

// ------------------------------------------------------ rounds & matches ----

export async function upsertRounds(rounds: RoundWithMatches[]): Promise<number> {
  if (rounds.length === 0) return 0;
  const sql = getSql();

  // The deadline is the earliest kickoff in the round: once the first match
  // starts, that round's lineup is locked.
  const deadlines = rounds.map((r) => {
    const dates = r.matches
      .map((m) => m.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    return dates[0] ?? null;
  });

  await sql.query(
    `INSERT INTO rounds (round_id, number, status, deadline, updated_at)
     SELECT * FROM UNNEST($1::text[], $2::numeric[], $3::text[], $4::timestamptz[]), now()
     ON CONFLICT (round_id) DO UPDATE SET
       number     = EXCLUDED.number,
       status     = EXCLUDED.status,
       deadline   = COALESCE(EXCLUDED.deadline, rounds.deadline),
       updated_at = now()`,
    [
      rounds.map((r) => r.id),
      rounds.map((r) => r.number),
      rounds.map((r) => r.status),
      deadlines,
    ],
  );

  const matches = rounds.flatMap((r) =>
    r.matches.map((m) => ({ ...m, roundId: r.id })),
  );
  if (matches.length > 0) {
    await sql.query(
      `INSERT INTO matches (
         match_id, round_id, kickoff, home_team_id, away_team_id,
         home_team, away_team, updated_at
       )
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::text[],
         $6::text[], $7::text[]
       ), now()
       ON CONFLICT (match_id) DO UPDATE SET
         round_id     = EXCLUDED.round_id,
         kickoff      = COALESCE(EXCLUDED.kickoff, matches.kickoff),
         home_team_id = COALESCE(EXCLUDED.home_team_id, matches.home_team_id),
         away_team_id = COALESCE(EXCLUDED.away_team_id, matches.away_team_id),
         home_team    = COALESCE(EXCLUDED.home_team, matches.home_team),
         away_team    = COALESCE(EXCLUDED.away_team, matches.away_team),
         updated_at   = now()`,
      [
        matches.map((m) => m.id),
        matches.map((m) => m.roundId),
        matches.map((m) => m.date ?? null),
        matches.map((m) => m.homeTeamId ?? null),
        matches.map((m) => m.awayTeamId ?? null),
        matches.map((m) => m.homeTeamName ?? null),
        matches.map((m) => m.awayTeamName ?? null),
      ],
    );
  }

  return rounds.length;
}

export async function saveOdds(odds: MatchOdds[]): Promise<number> {
  if (odds.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `UPDATE matches SET
       odds_home = v.home, odds_draw = v.draw, odds_away = v.away, updated_at = now()
     FROM (
       SELECT * FROM UNNEST($1::text[], $2::numeric[], $3::numeric[], $4::numeric[])
         AS t(match_id, home, draw, away)
     ) v
     WHERE matches.match_id = v.match_id`,
    [
      odds.map((o) => o.matchId),
      odds.map((o) => o.home ?? null),
      odds.map((o) => o.draw ?? null),
      odds.map((o) => o.away ?? null),
    ],
  );
  return odds.length;
}

export interface RoundRow {
  roundId: string;
  number: number;
  status: string;
  deadline: string | null;
}

export async function getRounds(): Promise<RoundRow[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT round_id, number, status, deadline FROM rounds ORDER BY number`) as Row[];
  return rows.map(toRoundRow);
}

/**
 * The round we should be setting a lineup for: the earliest round whose
 * deadline is still in the future.
 */
export async function getNextRound(): Promise<RoundRow | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT round_id, number, status, deadline
    FROM rounds
    WHERE deadline IS NOT NULL AND deadline > now()
    ORDER BY deadline
    LIMIT 1`) as Row[];
  return rows.length ? toRoundRow(rows[0]) : null;
}

function toRoundRow(r: Row): RoundRow {
  return {
    roundId: String(r.round_id),
    number: Number(r.number),
    status: String(r.status),
    deadline: isoInstant(r.deadline),
  };
}

/**
 * Difficulty per real club for its next fixture, on a 0..1 scale where higher
 * is harder, derived from bookmaker odds. Implied win probability is
 * 1/odds; normalising against the two other outcomes removes the bookmaker
 * margin, and difficulty is then the complement of the win chance.
 */
export async function getFixtureDifficulty(): Promise<
  Map<string, { difficulty: number; kickoff: string | null; opponent: string | null }>
> {
  const sql = getSql();
  const rows = (await sql`
    WITH next_match AS (
      SELECT DISTINCT ON (team_id) team_id, match_id, kickoff, win_odds, draw_odds, lose_odds, opponent
      FROM (
        SELECT home_team_id AS team_id, match_id, kickoff,
               odds_home AS win_odds, odds_draw AS draw_odds, odds_away AS lose_odds,
               away_team AS opponent
        FROM matches WHERE home_team_id IS NOT NULL
        UNION ALL
        SELECT away_team_id AS team_id, match_id, kickoff,
               odds_away AS win_odds, odds_draw AS draw_odds, odds_home AS lose_odds,
               home_team AS opponent
        FROM matches WHERE away_team_id IS NOT NULL
      ) sides
      WHERE kickoff IS NOT NULL AND kickoff > now()
      ORDER BY team_id, kickoff
    )
    SELECT team_id, kickoff, opponent, win_odds, draw_odds, lose_odds FROM next_match`) as Row[];

  const out = new Map<
    string,
    { difficulty: number; kickoff: string | null; opponent: string | null }
  >();

  for (const r of rows) {
    const win = num(r.win_odds);
    const draw = num(r.draw_odds);
    const lose = num(r.lose_odds);
    let difficulty = 0.5; // Neutral until odds are known.

    if (win && draw && lose && win > 1 && draw > 1 && lose > 1) {
      const total = 1 / win + 1 / draw + 1 / lose;
      const winProb = 1 / win / total;
      difficulty = clamp01(1 - winProb);
    }

    out.set(String(r.team_id), {
      difficulty,
      kickoff: isoInstant(r.kickoff),
      opponent: r.opponent as string | null,
    });
  }
  return out;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ---------------------------------------------------------- round points ----

export async function upsertRoundPoints(lineup: RoundLineup): Promise<number> {
  if (lineup.players.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `INSERT INTO round_points (
       round_id, player_id, team_id, points, minutes, goals,
       assists, yellow_cards, red_cards, started
     )
     SELECT $1::text, * FROM UNNEST(
       $2::text[], $3::text[], $4::numeric[], $5::int[], $6::int[],
       $7::int[], $8::int[], $9::int[], $10::boolean[]
     )
     ON CONFLICT (round_id, player_id, team_id) DO UPDATE SET
       points       = EXCLUDED.points,
       minutes      = COALESCE(EXCLUDED.minutes, round_points.minutes),
       goals        = COALESCE(EXCLUDED.goals, round_points.goals),
       assists      = COALESCE(EXCLUDED.assists, round_points.assists),
       yellow_cards = COALESCE(EXCLUDED.yellow_cards, round_points.yellow_cards),
       red_cards    = COALESCE(EXCLUDED.red_cards, round_points.red_cards),
       started      = EXCLUDED.started`,
    [
      lineup.roundId,
      lineup.players.map((p) => p.playerId),
      lineup.players.map(() => lineup.userteamId),
      lineup.players.map((p) => p.points),
      lineup.players.map((p) => p.minutesPlayed ?? null),
      lineup.players.map((p) => p.goals ?? null),
      lineup.players.map((p) => p.assists ?? null),
      lineup.players.map((p) => p.yellowCards ?? null),
      lineup.players.map((p) => p.redCards ?? null),
      lineup.players.map((p) => p.started),
    ],
  );
  return lineup.players.length;
}

export interface PlayerForm {
  playerId: string;
  /** Mean points across the window's scored rounds. */
  avgPoints: number;
  /** Mean minutes, the best available proxy for whether they actually start. */
  avgMinutes: number | null;
  /** Rounds of evidence, so callers can discount a thin sample. */
  rounds: number;
  /** Share of recent rounds in which they played at least 60 minutes. */
  startRate: number;
}

/**
 * Real form from the last N completed rounds. Uses per-round rows rather than
 * a season average, so a player who has caught fire is visible immediately.
 */
export async function getPlayerForm(lastRounds = 5): Promise<PlayerForm[]> {
  const sql = getSql();
  const rows = (await sql`
    WITH recent AS (
      SELECT round_id FROM rounds
      WHERE status = 'closed'
      ORDER BY number DESC
      LIMIT ${lastRounds}
    )
    SELECT
      rp.player_id,
      avg(rp.points)::numeric  AS avg_points,
      avg(rp.minutes)::numeric AS avg_minutes,
      count(*)                 AS rounds,
      avg(CASE WHEN COALESCE(rp.minutes, 0) >= 60 THEN 1.0 ELSE 0.0 END) AS start_rate
    FROM round_points rp
    JOIN recent r ON r.round_id = rp.round_id
    GROUP BY rp.player_id`) as Row[];

  return rows.map((r) => ({
    playerId: String(r.player_id),
    avgPoints: Number(r.avg_points ?? 0),
    avgMinutes: r.avg_minutes === null ? null : Number(r.avg_minutes),
    rounds: Number(r.rounds),
    startRate: Number(r.start_rate ?? 0),
  }));
}

// ---------------------------------------------------------------- ledger ----

/** Append-only: an id we already hold is never rewritten. */
export async function insertTransfers(transfers: Transfer[]): Promise<number> {
  if (transfers.length === 0) return 0;
  const sql = getSql();
  const rows = (await sql.query(
    `INSERT INTO transfers (
       tx_id, player_id, player_name, buyer_team_id, buyer_name,
       seller_team_id, seller_name, price, created_at
     )
     SELECT * FROM UNNEST(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::text[], $7::text[], $8::bigint[], $9::timestamptz[]
     )
     ON CONFLICT (tx_id) DO NOTHING
     RETURNING tx_id`,
    [
      transfers.map((t) => t.id),
      transfers.map((t) => t.playerId ?? null),
      transfers.map((t) => t.playerName ?? null),
      transfers.map((t) => t.buyerTeamId ?? null),
      transfers.map((t) => t.buyerName ?? null),
      transfers.map((t) => t.sellerTeamId ?? null),
      transfers.map((t) => t.sellerName ?? null),
      transfers.map((t) => t.price),
      transfers.map((t) => t.createdAt ?? null),
    ],
  )) as Row[];
  return rows.length;
}

/**
 * Money events carry only an in-game team name, so ownership is resolved
 * against current and historical names.
 */
export async function insertMoneyEvents(events: MoneyEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const sql = getSql();
  const rows = (await sql.query(
    `WITH incoming AS (
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::bigint[], $4::text[], $5::timestamptz[]
       ) AS t(event_id, team_name, amount, description, created_at)
     )
     INSERT INTO money_events (event_id, team_id, team_name, amount, description, created_at)
     SELECT
       i.event_id,
       COALESCE(
         (SELECT team_id FROM teams WHERE lower(team_name) = lower(i.team_name) LIMIT 1),
         (SELECT team_id FROM team_name_history WHERE lower(team_name) = lower(i.team_name) LIMIT 1)
       ),
       i.team_name, i.amount, i.description, i.created_at
     FROM incoming i
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      events.map((e) => e.id),
      events.map((e) => e.teamName ?? null),
      events.map((e) => e.amount),
      events.map((e) => e.description ?? null),
      events.map((e) => e.createdAt ?? null),
    ],
  )) as Row[];
  return rows.length;
}

export interface RivalFunds {
  teamId: string;
  teamName: string | null;
  /** Best-effort cash estimate. See the caveat below. */
  estimatedFunds: number;
  spent: number;
  received: number;
  prizes: number;
  /** Transfers we hold for this team. Low counts mean a weak estimate. */
  ledgerRows: number;
}

/**
 * Reconstructs each rival's spending power from the ledger, for leagues that
 * hide funds.
 *
 * Caveat worth stating plainly: this is an estimate, not a reading. It assumes
 * every team began with `initialBudget` and that the ledger is complete, and
 * neither holds perfectly — pressroom pagination drops old rows, and the
 * initial squad allocation may not appear as transfers at all. Treat the
 * ordering as meaningful and the absolute figures as approximate.
 */
export async function getRivalFunds(initialBudget: number): Promise<RivalFunds[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      t.team_id,
      t.team_name,
      COALESCE(spent.total, 0)    AS spent,
      COALESCE(received.total, 0) AS received,
      COALESCE(prizes.total, 0)   AS prizes,
      COALESCE(spent.rows, 0) + COALESCE(received.rows, 0) AS ledger_rows
    FROM teams t
    LEFT JOIN (
      SELECT buyer_team_id AS team_id, sum(price) AS total, count(*) AS rows
      FROM transfers WHERE buyer_team_id IS NOT NULL GROUP BY buyer_team_id
    ) spent ON spent.team_id = t.team_id
    LEFT JOIN (
      SELECT seller_team_id AS team_id, sum(price) AS total, count(*) AS rows
      FROM transfers WHERE seller_team_id IS NOT NULL GROUP BY seller_team_id
    ) received ON received.team_id = t.team_id
    LEFT JOIN (
      SELECT team_id, sum(amount) AS total
      FROM money_events WHERE team_id IS NOT NULL GROUP BY team_id
    ) prizes ON prizes.team_id = t.team_id
    ORDER BY t.team_name`) as Row[];

  return rows.map((r) => {
    const spent = Number(r.spent);
    const received = Number(r.received);
    const prizes = Number(r.prizes);
    return {
      teamId: String(r.team_id),
      teamName: r.team_name as string | null,
      estimatedFunds: initialBudget - spent + received + prizes,
      spent,
      received,
      prizes,
      ledgerRows: Number(r.ledger_rows),
    };
  });
}

// ---------------------------------------------------------- availability ----

export async function recordUnavailability(
  date: string,
  teamId: string,
  players: UnavailablePlayer[],
): Promise<number> {
  if (players.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `INSERT INTO unavailability (observed_on, player_id, team_id, reason, player_name)
     SELECT $1::date, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (observed_on, player_id) DO UPDATE SET
       reason      = COALESCE(EXCLUDED.reason, unavailability.reason),
       team_id     = COALESCE(EXCLUDED.team_id, unavailability.team_id),
       player_name = COALESCE(EXCLUDED.player_name, unavailability.player_name)`,
    [
      date,
      players.map((p) => p.playerId),
      players.map(() => teamId),
      players.map((p) => p.reason ?? null),
      players.map((p) => p.name ?? null),
    ],
  );
  return players.length;
}

/** Player ids currently flagged unavailable, with the reason. */
export async function getCurrentUnavailability(): Promise<Map<string, string>> {
  const sql = getSql();
  const rows = (await sql`
    SELECT DISTINCT ON (player_id) player_id, reason
    FROM unavailability
    WHERE observed_on >= CURRENT_DATE - 3
    ORDER BY player_id, observed_on DESC`) as Row[];
  return new Map(
    rows.map((r) => [String(r.player_id), String(r.reason ?? "unavailable")]),
  );
}

// -------------------------------------------------------- probable XI -------

export interface ProbableLineupRow {
  matchName: string;
  playerId?: string;
  teamName?: string;
  startProb: number;
  source: string;
  roundNumber?: number;
}

export async function saveProbableLineups(
  date: string,
  rows: ProbableLineupRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getSql();
  await sql.query(
    `INSERT INTO probable_lineups (
       observed_on, round_number, match_name, player_id, team_name, start_prob, source
     )
     SELECT $1::date, * FROM UNNEST(
       $2::numeric[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[]
     )
     ON CONFLICT (observed_on, match_name, source) DO UPDATE SET
       player_id  = COALESCE(EXCLUDED.player_id, probable_lineups.player_id),
       team_name  = COALESCE(EXCLUDED.team_name, probable_lineups.team_name),
       start_prob = EXCLUDED.start_prob`,
    [
      date,
      rows.map((r) => r.roundNumber ?? null),
      rows.map((r) => r.matchName),
      rows.map((r) => r.playerId ?? null),
      rows.map((r) => r.teamName ?? null),
      rows.map((r) => r.startProb),
      rows.map((r) => r.source),
    ],
  );
  return rows.length;
}

/** Newest start probability per player, from any source. */
export async function getStartProbabilities(): Promise<Map<string, number>> {
  const sql = getSql();
  const rows = (await sql`
    SELECT DISTINCT ON (player_id) player_id, start_prob
    FROM probable_lineups
    WHERE player_id IS NOT NULL AND observed_on >= CURRENT_DATE - 4
    ORDER BY player_id, observed_on DESC`) as Row[];
  return new Map(rows.map((r) => [String(r.player_id), Number(r.start_prob)]));
}

// --------------------------------------------------------------- session ----

export async function loadSession(): Promise<{ token: string; userid: string } | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT token, userid FROM futmondo_session WHERE id = TRUE`) as Row[];
  if (rows.length === 0) return null;
  return { token: String(rows[0].token), userid: String(rows[0].userid) };
}

export async function saveSession(token: string, userid: string): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO futmondo_session (id, token, userid, updated_at)
    VALUES (TRUE, ${token}, ${userid}, now())
    ON CONFLICT (id) DO UPDATE SET
      token = EXCLUDED.token, userid = EXCLUDED.userid, updated_at = now()`;
}

export async function clearSession(): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM futmondo_session WHERE id = TRUE`;
}

// ------------------------------------------------------------ action log ----

export async function logAction(entry: {
  action: string;
  target?: string;
  detail?: unknown;
  ok: boolean;
  error?: string;
}): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO action_log (action, target, detail, ok, error)
    VALUES (
      ${entry.action}, ${entry.target ?? null},
      ${entry.detail === undefined ? null : JSON.stringify(entry.detail)}::jsonb,
      ${entry.ok}, ${entry.error ?? null}
    )`;
}

export interface ActionLogRow {
  id: number;
  action: string;
  target: string | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

export async function getRecentActions(limit = 25): Promise<ActionLogRow[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT id, action, target, ok, error, created_at
    FROM action_log ORDER BY created_at DESC LIMIT ${limit}`) as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    action: String(r.action),
    target: r.target as string | null,
    ok: Boolean(r.ok),
    error: r.error as string | null,
    createdAt: isoInstant(r.created_at) ?? "",
  }));
}
