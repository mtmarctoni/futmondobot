/**
 * Orchestration: assemble everything the app knows into one report.
 *
 * Live API calls supply the present — funds, today's market, the lineup as it
 * currently stands. The database supplies the past — form, value trends,
 * fixture difficulty from stored odds, availability. Neither alone is enough:
 * the API cannot tell you a player is rising, and the database cannot tell you
 * what is for sale today.
 *
 * Every stage degrades independently. A failed market read costs the market
 * section, not the report.
 */
import { hasDatabase } from "../db/client";
import * as repo from "../db/repo";
import { dbTokenStore } from "../db/token-store";
import { FutmondoClient, type Scope } from "../futmondo/client";
import { FutmondoError } from "../futmondo/errors";
import type { FutmondoRole, PlayerStats } from "../futmondo/types";
import { runClauses, type ClauseReport } from "./clauses";
import { evaluate, type EvaluateContext } from "./expected";
import {
  diffLineup,
  parseFormations,
  pickLineup,
  type Formation,
  type LineupChange,
  type LineupPick,
} from "./lineup";
import { runMarket, type MarketReport } from "./market";
import { buildToday, type TodayReport } from "./today";
import { DEFAULT_RULES, type Evaluated, type LeagueRules } from "./types";

export interface AnalysisReport {
  scope: Scope | null;
  rules: LeagueRules;
  funds: number;
  teamValue: number;
  reserved: number;

  squad: Evaluated[];
  lineup: LineupPick;
  lineupChanges: LineupChange[];
  currentFormation: string | null;
  availableFormations: Formation[];

  market: MarketReport;
  clauses: ClauseReport;
  today: TodayReport;

  rivalFunds: repo.RivalFunds[];
  nextRound: repo.RoundRow | null;

  /** Non-fatal problems, surfaced rather than swallowed. */
  warnings: string[];
  /** Set when the report could not be produced at all. */
  error?: string;
  /** How much history exists, so the UI can say when advice is thin. */
  coverage: Coverage;
}

export interface Coverage {
  hasDatabase: boolean;
  snapshotDays: number;
  roundsWithPoints: number;
  playersWithClause: number;
  transfersKnown: number;
  hasOdds: boolean;
  hasProbableLineups: boolean;
}

export interface RunOptions {
  client?: FutmondoClient;
  /** True after the caller has already written the lineup to Futmondo. */
  lineupApplied?: boolean;
  now?: Date;
}

export async function runAnalysis(options: RunOptions = {}): Promise<AnalysisReport> {
  const warnings: string[] = [];
  const client = options.client ?? new FutmondoClient({ tokenStore: dbTokenStore });

  let scope: Scope;
  try {
    scope = await client.resolveScope();
  } catch (err) {
    return emptyReport(describe(err), warnings);
  }

  // ---------------------------------------------------------------- rules --
  let rules = DEFAULT_RULES;
  try {
    const config = await client.getChampionshipConfiguration(scope.championshipId);
    rules = {
      budget: config.budget ?? DEFAULT_RULES.budget,
      initialPlayers: config.initialPlayers ?? DEFAULT_RULES.initialPlayers,
      pricePerPoint: config.pointBonus ?? DEFAULT_RULES.pricePerPoint,
      maxOfferTeamValueShare: DEFAULT_RULES.maxOfferTeamValueShare,
    };
  } catch (err) {
    warnings.push(`League settings unavailable, using defaults: ${describe(err)}`);
  }

  // ----------------------------------------------------------------- live --
  const [infoResult, rosterResult, marketResult, lineupResult, strategyResult] =
    await Promise.allSettled([
      client.getUserTeamInformation(scope),
      client.getRoster(scope.championshipId, scope.userteamId),
      client.getMarket(scope),
      client.getCurrentLineup(scope),
      client.getAvailableStrategies(scope.championshipId),
    ]);

  const info =
    infoResult.status === "fulfilled"
      ? infoResult.value
      : { funds: 0, teamValue: 0, reserved: 0, raw: {} };
  if (infoResult.status === "rejected") {
    warnings.push(`Funds unavailable: ${describe(infoResult.reason)}`);
  }

  const roster = rosterResult.status === "fulfilled" ? rosterResult.value : [];
  if (rosterResult.status === "rejected") {
    warnings.push(`Squad unavailable: ${describe(rosterResult.reason)}`);
  }

  const listings = marketResult.status === "fulfilled" ? marketResult.value : [];
  if (marketResult.status === "rejected") {
    warnings.push(`Market unavailable: ${describe(marketResult.reason)}`);
  }

  const currentLineup =
    lineupResult.status === "fulfilled" ? lineupResult.value : null;
  if (lineupResult.status === "rejected") {
    warnings.push(`Current lineup unavailable: ${describe(lineupResult.reason)}`);
  }

  const availableFormations =
    strategyResult.status === "fulfilled"
      ? parseFormations(strategyResult.value)
      : [];
  if (strategyResult.status === "rejected") {
    warnings.push(
      `Legal formations unavailable, considering the standard set: ${describe(strategyResult.reason)}`,
    );
  }

  // ------------------------------------------------------------- history ---
  const history = await loadHistory();

  // ------------------------------------------------------------ evaluate ---
  const ctx: EvaluateContext = {
    form: history.form,
    trends: history.trends,
    difficulty: history.difficulty,
    unavailable: history.unavailable,
    startProbabilities: history.startProbabilities,
  };

  const squad: Evaluated[] = roster.map((p) =>
    evaluate(
      {
        playerId: p.id,
        name: p.name,
        role: p.role,
        clubName: p.team ?? null,
        clubId: p.teamId ?? null,
        slug: p.slug ?? null,
        value: p.value,
        seasonPoints: p.points,
        ownerTeamId: scope.userteamId,
        // Prefer the stored clause: the roster payload rarely carries one.
        clausePrice: p.clause ?? history.clauseById.get(p.id) ?? null,
        clauseLocked: p.locked ?? history.lockedById.get(p.id) ?? null,
        stats: p.stats,
      },
      ctx,
    ),
  );

  // Club ids drive fixture difficulty. They come from the stored player row,
  // with the live payloads as a fallback for anyone not yet synced.
  const clubIdByName = new Map<string, string>();
  for (const p of [...roster, ...listings]) {
    if (p.team && p.teamId) clubIdByName.set(p.team, p.teamId);
  }

  // Every player in the league, for clause hunting. Falls back to the squad
  // alone when no history has been collected yet.
  const allPlayers: Evaluated[] = history.ownership.length
    ? history.ownership.map((row) =>
        evaluate(
          {
            playerId: row.playerId,
            name: row.name,
            role: row.role as FutmondoRole,
            clubName: row.teamName,
            clubId: row.teamId ?? (row.teamName ? clubIdByName.get(row.teamName) ?? null : null),
            slug: row.slug,
            value: row.value ?? 0,
            seasonPoints: row.points ?? 0,
            ownerTeamId: row.ownerTeamId,
            clausePrice: row.clausePrice,
            clauseLocked: row.locked,
            stats: statsFromOwnership(row),
          },
          ctx,
        ),
      )
    : squad;

  // -------------------------------------------------------------- lineup ---
  const lineup = pickLineup(squad, availableFormations);
  const currentStarterIds = currentLineup
    ? currentLineup.players.map((s) => s.playerId)
    : [];
  const lineupChanges = currentLineup ? diffLineup(currentStarterIds, lineup) : [];

  const starterIds = new Set(lineup.starters.map((p) => p.playerId));

  // -------------------------------------------------------------- market ---
  const evaluatedById = new Map(allPlayers.map((p) => [p.playerId, p]));
  const marketReport = runMarket({
    listings: listings.map((listing) => {
      const known = evaluatedById.get(listing.id);
      const player =
        known ??
        evaluate(
          {
            playerId: listing.id,
            name: listing.name,
            role: listing.role,
            clubName: listing.team ?? null,
            clubId: listing.teamId ?? null,
            slug: listing.slug ?? null,
            value: listing.value,
            seasonPoints: listing.points,
            ownerTeamId: listing.fromComputer ? null : listing.sellerTeamId ?? null,
            clausePrice: null,
            clauseLocked: null,
            stats: listing.stats,
          },
          ctx,
        );
      return { player, price: listing.price };
    }),
    squad,
    starterIds,
    funds: info.funds,
    teamValue: info.teamValue,
    rules,
    reportedMaxBid: info.maxBid,
  });

  // ------------------------------------------------------------- clauses ---
  const clauseReport = runClauses({
    allPlayers,
    squad,
    starterIds,
    myTeamId: scope.userteamId,
    funds: info.funds,
    teamValue: info.teamValue,
    rules,
    rivalFunds: history.rivalFunds,
    teamNames: history.teamNames,
  });

  // --------------------------------------------------------------- today ---
  const today = buildToday({
    lineup,
    lineupChanges,
    lineupApplied: options.lineupApplied ?? false,
    market: marketReport,
    clauses: clauseReport,
    deadline: history.nextRound?.deadline ?? null,
    rules,
    now: options.now,
  });

  return {
    scope,
    rules,
    funds: info.funds,
    teamValue: info.teamValue,
    reserved: info.reserved,
    squad,
    lineup,
    lineupChanges,
    currentFormation: currentLineup?.strategy ?? null,
    availableFormations,
    market: marketReport,
    clauses: clauseReport,
    today,
    rivalFunds: history.rivalFunds,
    nextRound: history.nextRound,
    warnings: [...warnings, ...history.warnings],
    coverage: history.coverage,
  };
}

type OwnershipRow = Awaited<ReturnType<typeof repo.getLatestOwnership>>[number];

/**
 * Rebuilds a scoring record from a stored snapshot. Only our own squad and
 * today's market come back from the live API with `stats` attached; every other
 * player in the league -- the clause targets -- is known only through the
 * snapshot, and evaluating them on the role prior while our own squad had real
 * numbers would have made every steal look like an upgrade.
 *
 * `fitness` cannot be reconstructed, so form is flat here and the projection
 * rests on the season average alone. That is a weaker estimate, not a wrong
 * one, and the sample size still shrinks it honestly.
 */
function statsFromOwnership(row: OwnershipRow): PlayerStats | undefined {
  if (row.average === null || row.matchesPlayed === null) return undefined;
  return {
    average: row.average,
    homeAverage: row.homeAverage ?? undefined,
    awayAverage: row.awayAverage ?? undefined,
    averageLastFive: row.averageLastFive ?? undefined,
    matches: row.matchesPlayed,
    fitness: [],
  };
}

interface History {
  form: Map<string, repo.PlayerForm>;
  trends: Map<string, repo.ValueTrend>;
  difficulty: repo.FixtureMap;
  unavailable: Map<string, string>;
  startProbabilities: Map<string, number>;
  ownership: Awaited<ReturnType<typeof repo.getLatestOwnership>>;
  rivalFunds: repo.RivalFunds[];
  teamNames: Map<string, string | null>;
  nextRound: repo.RoundRow | null;
  clauseById: Map<string, number>;
  lockedById: Map<string, boolean>;
  coverage: Coverage;
  warnings: string[];
}

function emptyHistory(warnings: string[]): History {
  return {
    form: new Map(),
    trends: new Map(),
    difficulty: new Map(),
    unavailable: new Map(),
    startProbabilities: new Map(),
    ownership: [],
    rivalFunds: [],
    teamNames: new Map(),
    nextRound: null,
    clauseById: new Map(),
    lockedById: new Map(),
    coverage: {
      hasDatabase: false,
      snapshotDays: 0,
      roundsWithPoints: 0,
      playersWithClause: 0,
      transfersKnown: 0,
      hasOdds: false,
      hasProbableLineups: false,
    },
    warnings,
  };
}

async function loadHistory(): Promise<History> {
  if (!hasDatabase()) {
    return emptyHistory([
      "No database configured, so form, value trends and clause history are unavailable. Advice falls back to role averages.",
    ]);
  }

  const warnings: string[] = [];
  const rules = DEFAULT_RULES;

  const [
    form,
    trends,
    difficulty,
    unavailable,
    startProbabilities,
    ownership,
    teams,
    nextRound,
  ] = await Promise.all([
    safe(() => repo.getPlayerForm(), [] as repo.PlayerForm[], warnings, "form"),
    safe(() => repo.getValueTrends(), [] as repo.ValueTrend[], warnings, "value trends"),
    safe(
      () => repo.getFixtureDifficulty(),
      new Map() as repo.FixtureMap,
      warnings,
      "fixture difficulty",
    ),
    safe(() => repo.getCurrentUnavailability(), new Map<string, string>(), warnings, "injuries"),
    safe(() => repo.getStartProbabilities(), new Map<string, number>(), warnings, "probable lineups"),
    safe(
      () => repo.getLatestOwnership(),
      [] as Awaited<ReturnType<typeof repo.getLatestOwnership>>,
      warnings,
      "ownership",
    ),
    safe(() => repo.getTeams(), [] as repo.TeamRow[], warnings, "teams"),
    safe(() => repo.getNextRound(), null as repo.RoundRow | null, warnings, "calendar"),
  ]);

  const rivalFunds = await safe(
    () => repo.getRivalFunds(rules.budget),
    [] as repo.RivalFunds[],
    warnings,
    "rival funds",
  );

  const coverage = await safe(
    () => loadCoverage(),
    emptyHistory([]).coverage,
    warnings,
    "coverage",
  );
  coverage.hasDatabase = true;
  coverage.hasProbableLineups = startProbabilities.size > 0;

  if (coverage.snapshotDays < 2) {
    warnings.push(
      "Only one day of snapshots so far, so value trends are not yet meaningful. They improve each day the sync runs.",
    );
  }
  if (coverage.roundsWithPoints === 0) {
    // Not a fallback to role averages any more: the scoring record on every
    // roster payload carries the per-player evidence. What is missing is real
    // minutes, which is the difference between "did not start" and "started
    // and was substituted early" -- so the start estimate is the coarse part.
    warnings.push(
      "No per-round minutes stored, so how often a player starts is estimated from rounds appeared in rather than measured.",
    );
  }
  if (!coverage.hasOdds) {
    warnings.push(
      "No bookmaker odds stored yet, so opponent strength falls back to goal difference from results so far.",
    );
  }
  if (coverage.playersWithClause === 0) {
    warnings.push(
      "No clause prices collected yet, so no steal targets can be found. Run the clause sync.",
    );
  }

  return {
    form: new Map(form.map((f) => [f.playerId, f])),
    trends: new Map(trends.map((t) => [t.playerId, t])),
    difficulty,
    unavailable,
    startProbabilities,
    ownership,
    rivalFunds,
    teamNames: new Map(teams.map((t) => [t.teamId, t.teamName])),
    nextRound,
    clauseById: new Map(
      ownership
        .filter((o) => o.clausePrice !== null)
        .map((o) => [o.playerId, o.clausePrice as number]),
    ),
    lockedById: new Map(
      ownership
        .filter((o) => o.locked !== null)
        .map((o) => [o.playerId, o.locked as boolean]),
    ),
    coverage,
    warnings,
  };
}

async function loadCoverage(): Promise<Coverage> {
  const { getSql } = await import("../db/client");
  const sql = getSql();
  const rows = (await sql`
    SELECT
      (SELECT count(DISTINCT snapshot_date) FROM player_snapshots)                AS snapshot_days,
      (SELECT count(DISTINCT round_id) FROM round_points)                         AS rounds_with_points,
      (SELECT count(DISTINCT player_id) FROM player_snapshots
        WHERE clause_price IS NOT NULL)                                           AS players_with_clause,
      (SELECT count(*) FROM transfers)                                            AS transfers_known,
      (SELECT count(*) FROM matches WHERE odds_home IS NOT NULL)                  AS matches_with_odds
  `) as Record<string, unknown>[];

  const row = rows[0] ?? {};
  return {
    hasDatabase: true,
    snapshotDays: Number(row.snapshot_days ?? 0),
    roundsWithPoints: Number(row.rounds_with_points ?? 0),
    playersWithClause: Number(row.players_with_clause ?? 0),
    transfersKnown: Number(row.transfers_known ?? 0),
    hasOdds: Number(row.matches_with_odds ?? 0) > 0,
    hasProbableLineups: false,
  };
}

async function safe<T>(
  fn: () => Promise<T>,
  fallback: T,
  warnings: string[],
  label: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label}: ${describe(err)}`);
    return fallback;
  }
}

function describe(err: unknown): string {
  if (err instanceof FutmondoError) {
    return err.isCredentialError
      ? "Futmondo rejected the credentials. Check FUTMONDO_EMAIL and FUTMONDO_PASSWORD."
      : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function emptyReport(error: string, warnings: string[]): AnalysisReport {
  const lineup = pickLineup([]);
  const rules = DEFAULT_RULES;
  const market = runMarket({
    listings: [],
    squad: [],
    starterIds: new Set(),
    funds: 0,
    teamValue: 0,
    rules,
  });
  const clauses = runClauses({
    allPlayers: [],
    squad: [],
    starterIds: new Set(),
    myTeamId: "",
    funds: 0,
    teamValue: 0,
    rules,
    rivalFunds: [],
    teamNames: new Map(),
  });

  return {
    scope: null,
    rules,
    funds: 0,
    teamValue: 0,
    reserved: 0,
    squad: [],
    lineup,
    lineupChanges: [],
    currentFormation: null,
    availableFormations: [],
    market,
    clauses,
    today: buildToday({
      lineup,
      lineupChanges: [],
      lineupApplied: false,
      market,
      clauses,
      deadline: null,
      rules,
    }),
    rivalFunds: [],
    nextRound: null,
    warnings,
    error,
    coverage: emptyHistory([]).coverage,
  };
}

export type { Evaluated, LeagueRules } from "./types";
export type { Action, TodayReport } from "./today";
export type { LineupPick, LineupChange, Formation } from "./lineup";
export type { MarketReport } from "./market";
export type { ClauseReport } from "./clauses";
