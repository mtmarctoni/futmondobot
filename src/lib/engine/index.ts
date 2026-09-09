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
import type { FutmondoRole, PlayerPricePoint, PlayerStats } from "../futmondo/types";
import {
  classify,
  classifyAll,
  mergeAvailability,
  type Unavailability,
} from "./availability";
import { runClauses, type ClauseReport } from "./clauses";
import { scanDepartures, type DepartedPlayer } from "./departed";
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

  /**
   * Our players who are no longer in the competition. Separate from the squad
   * list because holding one is a standing loss rather than a bad selection,
   * and it has to be impossible to miss.
   */
  departed: DepartedPlayer[];

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
  // Every money sentence in the app depends on getting these right, and the
  // failure mode is silent: a missed key reads as "not configured" and falls
  // through to a default that is simply invented. `pointBonus` of 0 is a real
  // answer and must survive `??`, which is why each field is tested for
  // undefined rather than falsiness.
  let rules = DEFAULT_RULES;
  try {
    const config = await client.getChampionshipConfiguration(scope.championshipId);
    rules = {
      budget: config.budget ?? DEFAULT_RULES.budget,
      initialPlayers: config.initialPlayers ?? DEFAULT_RULES.initialPlayers,
      pricePerPoint: config.pointBonus ?? DEFAULT_RULES.pricePerPoint,
      pricePerRanking: config.rankingBonus ?? DEFAULT_RULES.pricePerRanking,
      rankingMode: config.rankingMode ?? null,
      maxOfferTeamValueShare: DEFAULT_RULES.maxOfferTeamValueShare,
      directSellShare: config.directSellShare ?? null,
      minListingShare: config.minListingShare ?? null,
      clauseWindowDays: config.clauseWindowDays ?? null,
      bidDurationDays: config.bidDurationDays ?? null,
      marketPlayers: config.marketPlayers ?? null,
    };
  } catch (err) {
    warnings.push(`League settings unavailable, using defaults: ${describe(err)}`);
  }

  // ----------------------------------------------------------------- live --
  const [
    infoResult,
    rosterResult,
    marketResult,
    lineupResult,
    strategyResult,
    myListingsResult,
  ] = await Promise.allSettled([
    client.getUserTeamInformation(scope),
    client.getRoster(scope.championshipId, scope.userteamId),
    client.getMarket(scope),
    client.getCurrentLineup(scope),
    client.getAvailableStrategies(scope.championshipId),
    // Our own listings, with the bids standing on them. Without this the
    // engine recommends selling players who are already listed and cannot see
    // an offer expiring inside the lineup window.
    client.getMyListings(scope),
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

  const myListings =
    myListingsResult.status === "fulfilled" ? myListingsResult.value : [];
  if (myListingsResult.status === "rejected") {
    warnings.push(`Your own listings unavailable: ${describe(myListingsResult.reason)}`);
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

  // ------------------------------------------------------------ departed ---
  // Run before evaluating, so a departure reaches the projection the same way
  // an injury does: start probability zero, out of the XI, and out of the
  // clause-steal candidates. Scanning the whole league rather than just our
  // squad is what stops the engine offering a rival's departed player as a
  // bargain steal on the strength of a low clause and a stale average.
  const departures = scanDepartures(
    [
      ...roster.map((p) => ({
        playerId: p.id,
        name: p.name,
        role: p.role,
        clubId: p.teamId ?? null,
        clubName: p.team ?? null,
        value: p.value,
        mine: true,
        onMarket: p.onMarket,
        askPrice: p.askPrice ?? null,
      })),
      ...history.ownership
        .filter((row) => !roster.some((p) => p.id === row.playerId))
        .map((row) => ({
          playerId: row.playerId,
          name: row.name,
          role: row.role as FutmondoRole,
          clubId: row.teamId ?? null,
          clubName: row.teamName,
          value: row.value ?? 0,
        })),
    ],
    history.competitionClubs,
  );
  warnings.push(...departures.warnings);

  // Three sources, deliberately merged rather than ranked by recency:
  //
  //   - the per-club injury endpoint, which names the reason most precisely;
  //   - the `status` field on every roster and market row, which costs no extra
  //     call and reaches market listings the club endpoint never sees;
  //   - the departure scan, which is the strongest fact of all and always wins.
  //
  // The merge keeps the more severe reading, so an "ok" on a roster row cannot
  // clear an injury the club has reported.
  const statuses = new Map<string, Unavailability>();
  for (const p of [...roster, ...listings, ...myListings]) {
    const graded = classify(p.status);
    if (graded) statuses.set(p.id, graded);
  }
  for (const row of history.ownership) {
    const graded = classify(row.status);
    if (graded && !statuses.has(row.playerId)) statuses.set(row.playerId, graded);
  }

  const unavailable = mergeAvailability(
    classifyAll(history.unavailable),
    statuses,
  );
  for (const [playerId, reason] of departures.reasons) {
    unavailable.set(playerId, { reason, severity: "out", multiplier: 0 });
  }

  // ------------------------------------------------------------ evaluate ---
  const ctx: EvaluateContext = {
    form: history.form,
    trends: history.trends,
    difficulty: history.difficulty,
    unavailable,
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
        // Only the per-player summary carries these, so they always come from
        // history rather than from the roster read.
        clauseDate: history.clauseDateById.get(p.id) ?? null,
        suggestedClause: history.suggestedClauseById.get(p.id) ?? null,
        onMarket: p.onMarket ?? false,
        askPrice: p.askPrice ?? null,
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
            clauseDate: row.clauseDate,
            suggestedClause: row.suggestedClause,
            onMarket: row.onMarket ?? false,
            askPrice: row.askPrice,
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

  // The minimum bid step, per listing. It decides what a considered bid looks
  // like -- an off-step offer may be rejected outright -- and it may scale with
  // value, so it is read rather than assumed. One extra call per listing, only
  // for players we might actually bid on, and a failure just falls back to the
  // observed default.
  const { increments, prices } = await readListingDetail(
    client,
    scope,
    listings.map((l) => l.id),
    warnings,
  );

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
      return {
        player,
        price: listing.price,
        increment: increments.get(listing.id),
        prices: prices.get(listing.id),
      };
    }),
    squad,
    starterIds,
    funds: info.funds,
    teamValue: info.teamValue,
    rules,
    reportedMaxBid: info.maxBid,
    committed: info.reserved,
    ownListings: myListings.map((l) => ({
      playerId: l.id,
      name: l.name,
      price: l.price,
      value: l.value,
      expiresAt: l.expiresAt,
      bids: l.bids?.map((b) => ({ price: b.price })),
    })),
    now: options.now,
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
    lockedPlayerIds: history.lockedPlayerIds,
    now: options.now,
  });

  // --------------------------------------------------------------- today ---
  const today = buildToday({
    lineup,
    lineupChanges,
    lineupApplied: options.lineupApplied ?? false,
    market: marketReport,
    clauses: clauseReport,
    departed: departures.mine,
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
    departed: departures.mine,
    rivalFunds: history.rivalFunds,
    nextRound: history.nextRound,
    warnings: [...warnings, ...history.warnings],
    coverage: history.coverage,
  };
}

/**
 * Minimum bid steps and daily value history for today's listings.
 *
 * Bounded, because this is two calls per listing on top of everything else the
 * report already does, and a market of a dozen machine listings is the normal
 * case. A listing we could not read falls back to the observed default step,
 * and drops out of the radar with a warning, rather than failing the section.
 */
const INCREMENT_LOOKUP_LIMIT = 12;

interface ListingDetail {
  increments: Map<string, number>;
  /**
   * Daily value series per listing, from `/1/player/summary`'s `prices[]`.
   *
   * This is the only workable source for a listing's daily change. The series
   * is republished in full on every call -- the one exception to "history
   * cannot be backfilled" -- while `player_snapshots` is not an alternative
   * here: `syncClausePrices` only fans out to players with an owner, and a
   * machine listing has none, so the cheap listings this feeds have no stored
   * history at all.
   */
  prices: Map<string, PlayerPricePoint[]>;
}

async function readListingDetail(
  client: FutmondoClient,
  scope: Scope,
  playerIds: string[],
  warnings: string[],
): Promise<ListingDetail> {
  const increments = new Map<string, number>();
  const prices = new Map<string, PlayerPricePoint[]>();
  let stepFailures = 0;
  let priceFailures = 0;

  for (const playerId of playerIds.slice(0, INCREMENT_LOOKUP_LIMIT)) {
    try {
      const auction = await client.getAuctionSummary(scope, playerId);
      if (auction?.increment) increments.set(playerId, auction.increment);
    } catch {
      stepFailures += 1;
    }
    try {
      const summary = await client.getPlayerSummary(scope, playerId);
      if (summary && summary.prices.length > 0) prices.set(playerId, summary.prices);
    } catch {
      priceFailures += 1;
    }
  }
  if (stepFailures > 0) {
    warnings.push(
      `Could not read the minimum bid step for ${stepFailures} listing(s); using the default step for those.`,
    );
  }
  // Said out loud rather than folded into "nothing is rising". Without the
  // series the daily change is unknown, and a silent unknown makes a failed
  // read indistinguishable from a market with no opportunities in it.
  if (priceFailures > 0) {
    warnings.push(
      `Could not read the value history for ${priceFailures} listing(s); the low-value radar cannot judge those.`,
    );
  }
  return { increments, prices };
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
  /** Raw reason strings; graded once, in runAnalysis, alongside the other sources. */
  unavailable: Map<string, string>;
  startProbabilities: Map<string, number>;
  /** Real clubs with a fixture, id to name. The competition's own membership. */
  competitionClubs: Map<string, string>;
  ownership: Awaited<ReturnType<typeof repo.getLatestOwnership>>;
  rivalFunds: repo.RivalFunds[];
  teamNames: Map<string, string | null>;
  nextRound: repo.RoundRow | null;
  clauseById: Map<string, number>;
  clauseDateById: Map<string, string>;
  suggestedClauseById: Map<string, number>;
  lockedById: Map<string, boolean>;
  /** Players our own audit log says we have blocked. See ClauseContext. */
  lockedPlayerIds: Set<string>;
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
    competitionClubs: new Map(),
    ownership: [],
    rivalFunds: [],
    teamNames: new Map(),
    nextRound: null,
    clauseById: new Map(),
    clauseDateById: new Map(),
    suggestedClauseById: new Map(),
    lockedById: new Map(),
    lockedPlayerIds: new Set(),
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
    competitionClubs,
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
      () => repo.getCompetitionClubs(),
      new Map<string, string>(),
      warnings,
      "competition clubs",
    ),
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

  // No payload carries clause-lock state, so our own audit log is the only
  // record that a block exists. See ClauseContext.lockedPlayerIds and OPEN-7.
  const lockedPlayerIds = await safe(
    () => repo.getLockedPlayerIds(),
    new Set<string>(),
    warnings,
    "clause blocks",
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
    // The measured start record comes from /1/player/summary's points[], which
    // the summary sweep collects. Until it has run, start probability falls
    // back to the share of rounds a player appeared in -- which cannot tell a
    // starter from a substitute, and that is the largest term in every
    // projection.
    warnings.push(
      "No per-round start records stored yet, so how often a player starts is estimated from rounds appeared in rather than measured. Run the clause sync.",
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
    competitionClubs,
    ownership,
    rivalFunds,
    teamNames: new Map(teams.map((t) => [t.teamId, t.teamName])),
    nextRound,
    clauseById: new Map(
      ownership
        .filter((o) => o.clausePrice !== null)
        .map((o) => [o.playerId, o.clausePrice as number]),
    ),
    clauseDateById: new Map(
      ownership
        .filter((o) => o.clauseDate !== null)
        .map((o) => [o.playerId, o.clauseDate as string]),
    ),
    suggestedClauseById: new Map(
      ownership
        .filter((o) => o.suggestedClause !== null)
        .map((o) => [o.playerId, o.suggestedClause as number]),
    ),
    lockedById: new Map(
      ownership
        .filter((o) => o.locked !== null)
        .map((o) => [o.playerId, o.locked as boolean]),
    ),
    lockedPlayerIds,
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
      departed: [],
      deadline: null,
      rules,
    }),
    departed: [],
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
export type { DepartedPlayer } from "./departed";
