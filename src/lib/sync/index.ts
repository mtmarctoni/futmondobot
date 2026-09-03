/**
 * Sync jobs. Each one is idempotent and reports what it wrote, so a cron can
 * run them repeatedly and a failure part-way through costs nothing but a retry.
 *
 * They are split by cost rather than by subject. `syncDaily` is cheap enough to
 * run every few hours; `syncClausePrices` fans out one request per player and
 * belongs on a slower schedule; `backfillRoundPoints` walks history and is
 * meant to be run once and then incrementally.
 */
import { getSql } from "../db/client";
import { dbTokenStore } from "../db/token-store";
import * as repo from "../db/repo";
import { FutmondoClient, type Scope } from "../futmondo/client";
import { FutmondoError } from "../futmondo/errors";
import type { MatchOdds, Player } from "../futmondo/types";
import { fetchFitness, SOURCE_NAME } from "../providers/futbolfantasy";
import { NameMatcher } from "../providers/name-match";

export interface SyncReport {
  job: string;
  wrote: Record<string, number>;
  warnings: string[];
  durationMs: number;
}

export function createClient(): FutmondoClient {
  return new FutmondoClient({ tokenStore: dbTokenStore });
}

interface Ctx {
  client: FutmondoClient;
  scope: Scope;
}

async function context(client?: FutmondoClient): Promise<Ctx> {
  const c = client ?? createClient();
  return { client: c, scope: await c.resolveScope() };
}

function reason(err: unknown): string {
  if (err instanceof FutmondoError) return `${err.endpoint ?? "?"}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The main job: league membership, the real calendar, every squad in the
 * league and today's market, all folded into one daily snapshot row per player.
 *
 * Rosters for all teams are what make clause hunting possible at all — the
 * market endpoint only shows twelve players a day, while the interesting
 * targets are the ones rivals already own.
 */
export async function syncDaily(client?: FutmondoClient): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api, scope } = await context(client);
  const date = repo.today();

  // League members first: rosters and money-event name matching both need them.
  let teams: Awaited<ReturnType<typeof api.getChampionshipTeams>> = [];
  try {
    teams = await api.getChampionshipTeams(scope.championshipId);
    wrote.teams = await repo.upsertTeams(teams, scope.userteamId);
  } catch (err) {
    warnings.push(`teams: ${reason(err)}`);
  }

  // The real calendar. This is where the matchday deadline comes from.
  try {
    const rounds = await api.getLeagueMatches();
    wrote.rounds = await repo.upsertRounds(rounds);
  } catch (err) {
    warnings.push(`calendar: ${reason(err)}`);
  }

  const players = new Map<string, Player>();
  const snapshots: repo.SnapshotInput[] = [];

  // Every squad in the league, so ownership is known for all owned players.
  const teamIds = teams.length
    ? teams.map((t) => t.teamId)
    : [scope.userteamId];
  let rosterFailures = 0;

  for (const teamId of teamIds) {
    try {
      const roster = await api.getRoster(scope.championshipId, teamId);
      for (const p of roster) players.set(p.id, p);
      snapshots.push(...repo.snapshotsFromRoster(roster, teamId));
    } catch (err) {
      rosterFailures += 1;
      warnings.push(`roster ${teamId}: ${reason(err)}`);
    }
  }
  wrote.rostersRead = teamIds.length - rosterFailures;

  // Today's market. Machine listings are the only unowned players we ever see.
  try {
    const market = await api.getMarket(scope);
    for (const p of market) if (!players.has(p.id)) players.set(p.id, p);
    snapshots.push(...repo.snapshotsFromMarket(market));
    wrote.market = market.length;
  } catch (err) {
    warnings.push(`market: ${reason(err)}`);
  }

  // These were the only unwrapped writes in the job. A failure here threw past
  // every warning we had already collected, so the whole run reported nothing
  // at all -- which is how a decimal-points schema mismatch looked like an
  // empty 500 instead of a message naming the column.
  try {
    if (players.size > 0) wrote.players = await repo.upsertPlayers([...players.values()]);
  } catch (err) {
    warnings.push(`players: ${reason(err)}`);
  }

  try {
    if (snapshots.length > 0) wrote.snapshots = await repo.writeSnapshots(date, snapshots);
  } catch (err) {
    warnings.push(`snapshots: ${reason(err)}`);
  }

  return { job: "daily", wrote, warnings, durationMs: Date.now() - started };
}

/**
 * The append-only ledgers. Several passes because pressroom pagination returns
 * different subsets on different calls; running this often is how coverage
 * eventually becomes complete.
 */
export async function syncLedger(
  options: { passes?: number } = {},
  client?: FutmondoClient,
): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api, scope } = await context(client);

  try {
    const transfers = await api.getTransfers(scope.championshipId, {
      passes: options.passes ?? 2,
    });
    wrote.transfersSeen = transfers.length;
    wrote.transfersNew = await repo.insertTransfers(transfers);
  } catch (err) {
    warnings.push(`pressroom: ${reason(err)}`);
  }

  try {
    const events = await api.getMoneyEvents(scope.championshipId);
    wrote.moneyEventsSeen = events.length;
    wrote.moneyEventsNew = await repo.insertMoneyEvents(events);
  } catch (err) {
    warnings.push(`news: ${reason(err)}`);
  }

  return { job: "ledger", wrote, warnings, durationMs: Date.now() - started };
}

/**
 * Injuries and suspensions, one call per real club. Clubs come from the players
 * we already track, so this costs about twenty calls rather than one per player.
 */
export async function syncAvailability(client?: FutmondoClient): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api } = await context(client);
  const date = repo.today();

  const sql = getSql();
  const rows = (await sql`
    SELECT DISTINCT team_id FROM players WHERE team_id IS NOT NULL`) as Record<
    string,
    unknown
  >[];
  const clubIds = rows.map((r) => String(r.team_id));

  if (clubIds.length === 0) {
    warnings.push("No club ids known yet — run the daily sync first.");
    return { job: "availability", wrote, warnings, durationMs: Date.now() - started };
  }

  let recorded = 0;
  for (const clubId of clubIds) {
    try {
      const unavailable = await api.getUnavailablePlayers(clubId);
      recorded += await repo.recordUnavailability(date, clubId, unavailable);
    } catch (err) {
      warnings.push(`unavailable ${clubId}: ${reason(err)}`);
    }
  }
  wrote.clubsChecked = clubIds.length;
  wrote.unavailable = recorded;

  return { job: "availability", wrote, warnings, durationMs: Date.now() - started };
}

/**
 * Bookmaker odds for fixtures that have not kicked off. Odds move, so this is
 * worth re-running close to the deadline.
 */
export async function syncOdds(client?: FutmondoClient): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api } = await context(client);

  const sql = getSql();
  const rows = (await sql`
    SELECT match_id FROM matches
    WHERE kickoff IS NOT NULL
      AND kickoff > now()
      AND kickoff < now() + interval '10 days'
    ORDER BY kickoff`) as Record<string, unknown>[];

  const odds: MatchOdds[] = [];
  for (const row of rows) {
    const matchId = String(row.match_id);
    try {
      const result = await api.getMatchOdds(matchId);
      if (result) odds.push(result);
    } catch (err) {
      warnings.push(`odds ${matchId}: ${reason(err)}`);
    }
  }

  wrote.matchesChecked = rows.length;
  wrote.oddsSaved = await repo.saveOdds(odds);

  return { job: "odds", wrote, warnings, durationMs: Date.now() - started };
}

/**
 * Per-player, per-round performance for every team. One call per team per
 * round, so a full season backfill is a few hundred calls — hence `maxRounds`.
 *
 * Only closed rounds are stored: a running round's points are still changing.
 */
export async function backfillRoundPoints(
  options: { maxRounds?: number } = {},
  client?: FutmondoClient,
): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api, scope } = await context(client);

  const teams = await repo.getTeams();
  const teamIds = teams.length ? teams.map((t) => t.teamId) : [scope.userteamId];

  const sql = getSql();
  const pending = (await sql`
    SELECT r.round_id
    FROM rounds r
    WHERE r.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM round_points rp WHERE rp.round_id = r.round_id)
    ORDER BY r.number DESC
    LIMIT ${options.maxRounds ?? 5}`) as Record<string, unknown>[];

  let rowsWritten = 0;
  for (const row of pending) {
    const roundId = String(row.round_id);
    for (const teamId of teamIds) {
      try {
        const lineup = await api.getRoundLineup(
          scope.championshipId,
          teamId,
          roundId,
        );
        rowsWritten += await repo.upsertRoundPoints(lineup);
      } catch (err) {
        warnings.push(`roundlineup ${roundId}/${teamId}: ${reason(err)}`);
      }
    }
  }

  wrote.roundsProcessed = pending.length;
  wrote.playerRounds = rowsWritten;

  return { job: "roundPoints", wrote, warnings, durationMs: Date.now() - started };
}

/**
 * Clause prices, the one number that decides every steal. Only available one
 * player at a time, so this is the most expensive job in the app.
 *
 * Players are prioritised by how stale their clause is and how much they score:
 * a cheap high-scorer whose clause we last read a week ago is worth a call, the
 * fourth-choice goalkeeper is not. `limit` bounds the run so it fits inside a
 * function timeout.
 */
export async function syncClausePrices(
  options: { limit?: number } = {},
  client?: FutmondoClient,
): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const { client: api, scope } = await context(client);
  const date = repo.today();
  const limit = options.limit ?? 60;

  const sql = getSql();
  const candidates = (await sql`
    WITH latest AS (
      SELECT DISTINCT ON (player_id)
        player_id, snapshot_date, owner_team_id, points, value
      FROM player_snapshots
      ORDER BY player_id, snapshot_date DESC
    ),
    last_clause AS (
      SELECT player_id, max(snapshot_date) AS seen
      FROM player_snapshots WHERE clause_price IS NOT NULL
      GROUP BY player_id
    )
    SELECT l.player_id
    FROM latest l
    LEFT JOIN last_clause c ON c.player_id = l.player_id
    -- Owned by somebody, and not by us: only a rival's player can be taken.
    WHERE l.owner_team_id IS NOT NULL
      AND l.owner_team_id <> ${scope.userteamId}
    ORDER BY
      c.seen NULLS FIRST,
      l.points DESC NULLS LAST
    LIMIT ${limit}`) as Record<string, unknown>[];

  const snapshots: repo.SnapshotInput[] = [];
  for (const row of candidates) {
    const playerId = String(row.player_id);
    try {
      const summary = await api.getPlayerSummary(scope, playerId);
      if (!summary) continue;
      snapshots.push({
        playerId,
        clausePrice: summary.clausePrice,
        locked: summary.locked,
      });
      // The slug lives nowhere else and is required to actually pay a clause.
      if (summary.slug) await repo.setPlayerSlug(playerId, summary.slug);
    } catch (err) {
      warnings.push(`summary ${playerId}: ${reason(err)}`);
    }
  }

  wrote.playersChecked = candidates.length;
  wrote.clausesSaved = await repo.writeSnapshots(date, snapshots);

  return { job: "clauses", wrote, warnings, durationMs: Date.now() - started };
}

/** Everything on the cheap schedule, in dependency order. */
export async function syncAll(client?: FutmondoClient): Promise<SyncReport[]> {
  const api = client ?? createClient();
  const reports: SyncReport[] = [];
  reports.push(await syncDaily(api));
  reports.push(await syncLedger({}, api));
  reports.push(await syncOdds(api));
  reports.push(await syncAvailability(api));
  reports.push(await backfillRoundPoints({}, api));
  reports.push(await syncProbableLineups());
  return reports;
}

/**
 * Start probabilities scraped from FútbolFantasy, matched onto Futmondo player
 * ids by name.
 *
 * Deliberately tolerant: an unmatched name is recorded as a warning rather than
 * guessed at, and a low-confidence match is dropped entirely. A wrong match
 * would attribute one player's injury to another and bench a fit starter,
 * which is worse than having no scrape at all.
 *
 * `FUTMONDO_NAME_OVERRIDES` may hold a JSON object of {"External Name":
 * "futmondoPlayerId"} for names that never resolve.
 */
export async function syncProbableLineups(): Promise<SyncReport> {
  const started = Date.now();
  const wrote: Record<string, number> = {};
  const warnings: string[] = [];
  const date = repo.today();

  const scrape = await fetchFitness();
  warnings.push(...scrape.warnings);
  wrote.scraped = scrape.rows.length;

  if (scrape.rows.length === 0) {
    return { job: "probableLineups", wrote, warnings, durationMs: Date.now() - started };
  }

  const known = await repo.getLatestOwnership();
  if (known.length === 0) {
    warnings.push("No players stored yet — run the daily sync before matching names.");
    return { job: "probableLineups", wrote, warnings, durationMs: Date.now() - started };
  }

  const matcher = new NameMatcher(
    known.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      teamName: p.teamName,
    })),
    { overrides: parseOverrides(warnings) },
  );

  const rows: repo.ProbableLineupRow[] = [];
  let dropped = 0;

  for (const row of scrape.rows) {
    const match = matcher.match(row.name, row.teamName);
    // A bare-surname guess is not worth acting on for something that decides
    // whether a player is benched.
    if (!match || match.confidence < 0.8) {
      if (match) dropped += 1;
      continue;
    }
    rows.push({
      matchName: row.name,
      playerId: match.playerId,
      teamName: row.teamName ?? undefined,
      startProb: row.startProbability,
      source: SOURCE_NAME,
    });
  }

  wrote.matched = rows.length;
  wrote.lowConfidenceDropped = dropped;
  wrote.saved = await repo.saveProbableLineups(date, rows);

  if (matcher.unmatched.length > 0) {
    const sample = matcher.unmatched
      .slice(0, 8)
      .map((u) => `${u.name}${u.teamName ? ` (${u.teamName})` : ""}`)
      .join(", ");
    warnings.push(
      `${matcher.unmatched.length} scraped name(s) did not match a Futmondo player: ${sample}. Add them to FUTMONDO_NAME_OVERRIDES if they matter.`,
    );
  }

  return { job: "probableLineups", wrote, warnings, durationMs: Date.now() - started };
}

function parseOverrides(warnings: string[]): Record<string, string> {
  const raw = process.env.FUTMONDO_NAME_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    warnings.push("FUTMONDO_NAME_OVERRIDES must be a JSON object; ignoring it.");
  } catch {
    warnings.push("FUTMONDO_NAME_OVERRIDES is not valid JSON; ignoring it.");
  }
  return {};
}
