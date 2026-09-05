/**
 * Normalisers for Futmondo's inconsistent payloads. `answer` is sometimes a
 * bare array and sometimes an object wrapping one under an endpoint-specific
 * key, and numbers arrive as either numbers or strings. Everything here is
 * total: a shape we do not recognise yields an empty result rather than
 * throwing, so one changed endpoint degrades a feature instead of the app.
 */
import type {
  ActiveChampionship,
  AuctionSummary,
  ChampionshipConfiguration,
  ChampionshipTeam,
  CurrentLineup,
  FutmondoRole,
  LineupSlot,
  MarketBid,
  MarketPlayer,
  Match,
  MatchOdds,
  MoneyEvent,
  Player,
  PlayerPricePoint,
  PlayerRoundRecord,
  PlayerStats,
  PlayerSummary,
  RankedTeam,
  RosterPlayer,
  Round,
  RoundLineup,
  RoundLineupPlayer,
  RoundWithMatches,
  Transfer,
  UnavailablePlayer,
  UserTeamInformation,
} from "./types";

type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the first present key, letting us tolerate renamed fields. */
export function pick(obj: Rec, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.length ? v : undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Futmondo sends money and stats as numbers or plain numeric strings,
 * interchangeably. Deliberately strict: anything else yields undefined rather
 * than a guess. Stripping separators would make "1.500" ambiguous between
 * 1500 and 1.5, and these values are euros — a wrong guess spends real budget.
 */
export function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Scoring averages arrive either as a bare number or, in this league, as an
 * object: {average, homeAverage, awayAverage, averageLastFive, matches,
 * fitness}. Reading it with `num()` alone silently yielded undefined for every
 * player, so the average column was never populated.
 */
export function avg(v: unknown): number | undefined {
  if (isRec(v)) return num(pick(v, "average", "avg", "averageLastFive"));
  return num(v);
}

/**
 * The whole `average` object, not just its headline number. Everything the
 * expected-points model knows about a player's form comes from here, because
 * `/1/userteam/roundlineup` returns an empty player list for closed rounds and
 * so `round_points` never fills.
 *
 * A zero in `fitness` means a round the player did not feature in: Futmondo
 * awards points for the appearance itself, so a player who was on the pitch
 * essentially never finishes on exactly zero. That reading is checked against
 * `matches` by the caller rather than trusted blindly.
 */
export function parsePlayerStats(v: unknown): PlayerStats | undefined {
  if (!isRec(v)) return undefined;
  const average = num(pick(v, "average", "avg"));
  if (average === undefined) return undefined;

  const fitnessRaw = v.fitness;
  const fitness = Array.isArray(fitnessRaw)
    ? fitnessRaw.map((entry) => num(entry) ?? 0)
    : [];

  return {
    average,
    homeAverage: num(pick(v, "homeAverage", "home_average")),
    awayAverage: num(pick(v, "awayAverage", "away_average")),
    averageLastFive: num(pick(v, "averageLastFive", "average_last_five")),
    matches: num(pick(v, "matches", "played", "appearances")) ?? 0,
    fitness,
  };
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

/**
 * Pulls the array out of an `answer`, whether it is the answer itself or nested
 * under one of the given keys. Falls back to the first array-valued property so
 * a renamed wrapper key still works.
 */
export function asArray(answer: unknown, ...keys: string[]): Rec[] {
  if (Array.isArray(answer)) return answer.filter(isRec);
  if (!isRec(answer)) return [];
  for (const key of keys) {
    const v = answer[key];
    if (Array.isArray(v)) return v.filter(isRec);
  }
  for (const v of Object.values(answer)) {
    if (Array.isArray(v)) return v.filter(isRec);
  }
  return [];
}

const ROLE_ALIASES: Record<string, FutmondoRole> = {
  POR: "POR",
  GK: "POR",
  PORTERO: "POR",
  DEF: "DEF",
  DF: "DEF",
  DEFENSA: "DEF",
  MED: "MED",
  MF: "MED",
  MC: "MED",
  MEDIO: "MED",
  CEN: "MED",
  CENTROCAMPISTA: "MED",
  DEL: "DEL",
  FW: "DEL",
  DELANTERO: "DEL",
  ATT: "DEL",
};

/**
 * The live API reports roles as lowercase Spanish words: portero, defensa,
 * centrocampista, delantero. The table above had three of those four, and the
 * missing one cost five players out of a fifteen-player squad -- silently,
 * because basePlayer drops a player whose role it cannot map, so every
 * midfielder in the league vanished from rosters, the market and the database
 * at once, and the engine reported the squad as short of midfielders.
 *
 * The three-letter prefix fallback is what makes that class of omission
 * survivable: PORtero, DEFensa, CENtrocampista and DELantero all resolve
 * through the short aliases, as do MEDiocentro and any other variant built on
 * the same stems. Accents are stripped first so an accented variant matches.
 */
export function role(v: unknown): FutmondoRole | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  const norm = raw
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  return ROLE_ALIASES[norm] ?? ROLE_ALIASES[norm.slice(0, 3)];
}

function id(obj: Rec, ...extra: string[]): string | undefined {
  return str(pick(obj, ...extra, "id", "_id", "playerId", "player_id"));
}

// ---------------------------------------------------------------- players ----

function basePlayer(raw: Rec): Player | null {
  const playerId = id(raw);
  const name = str(pick(raw, "name", "playerName", "shortName"));
  const playerRole = role(pick(raw, "role", "position", "pos"));
  if (!playerId || !name || !playerRole) return null;

  // `team` is sometimes a nested club object rather than a name string.
  const teamField = pick(raw, "team", "clubTeam", "realTeam");
  const teamName = isRec(teamField)
    ? str(pick(teamField, "name", "shortName"))
    : str(teamField);
  const teamId =
    str(pick(raw, "teamId", "team_id", "clubId")) ??
    (isRec(teamField) ? id(teamField) : undefined);

  return {
    id: playerId,
    name,
    role: playerRole,
    team: teamName,
    teamId,
    value: num(pick(raw, "value", "marketValue", "totalValue")) ?? 0,
    points: num(pick(raw, "points", "totalPoints", "seasonPoints")) ?? 0,
    average: avg(pick(raw, "average", "avg", "pointsAverage")),
    stats: parsePlayerStats(pick(raw, "average", "stats", "record")),
    // Present on every roster and market row and never read until now. It is
    // the only availability signal that reaches market listings at all.
    status: str(pick(raw, "status")),
    slug: str(pick(raw, "slug", "player_slug")),
    photo: str(pick(raw, "photo", "image", "avatar")),
    raw,
  };
}

/**
 * `clause` on a roster row is an object, not a number:
 * `{price, date, transferred, suggestedClause}`. Reading it with `num()`
 * returned undefined for every player, so the roster never contributed a
 * clause price and the engine relied entirely on the far more expensive
 * per-player summary sync. Both shapes are accepted now.
 */
function clauseOf(raw: Rec): { price?: number; locked?: boolean } {
  const field = pick(raw, "clause", "clausePrice", "clause_price");
  if (isRec(field)) {
    return {
      price: num(pick(field, "price", "value")),
      locked: bool(pick(field, "locked", "isLocked", "blocked")),
    };
  }
  return {
    price: num(field),
    locked: bool(pick(raw, "locked", "isLocked", "blocked")),
  };
}

/**
 * Whether the player is already listed for sale, and at what price.
 *
 * `market` is `false` for a player who is not listed and an object when they
 * are, so a truthiness check on the field itself is the shape test.
 */
function listingOf(raw: Rec): { onMarket: boolean; askPrice?: number } {
  const field = pick(raw, "market");
  if (!isRec(field)) return { onMarket: false };
  const inMarket = bool(pick(field, "inMarket", "in_market", "onMarket"));
  const price = num(pick(field, "price", "askPrice", "p"));
  // An object with a price but no flag still means listed; the flag is the
  // stronger signal when present.
  const onMarket = inMarket ?? price !== undefined;
  return { onMarket, askPrice: price };
}

export function parseRoster(answer: unknown): RosterPlayer[] {
  const out: RosterPlayer[] = [];
  for (const raw of asArray(answer, "players", "roster")) {
    const base = basePlayer(raw);
    if (!base) continue;
    const clause = clauseOf(raw);
    const listing = listingOf(raw);
    out.push({
      ...base,
      buyPrice: num(pick(raw, "buyPrice", "buy_price", "purchasePrice")),
      clause: clause.price,
      locked: clause.locked ?? bool(pick(raw, "locked", "isLocked", "blocked")),
      onMarket: listing.onMarket,
      askPrice: listing.askPrice,
    });
  }
  return out;
}

export function parseMarket(answer: unknown): MarketPlayer[] {
  const out: MarketPlayer[] = [];
  for (const raw of asArray(answer, "players", "market")) {
    const base = basePlayer(raw);
    if (!base) continue;

    // Futmondo flags machine-owned listings as `computer`; a rival listing
    // instead carries the selling user team.
    const computer = bool(pick(raw, "computer", "isComputer", "fromComputer"));
    const sellerField = pick(raw, "userteam", "seller", "owner");
    const sellerTeamId = isRec(sellerField)
      ? id(sellerField)
      : str(pick(raw, "userteamId", "sellerTeamId", "ownerTeamId"));

    out.push({
      ...base,
      price: num(pick(raw, "price", "askPrice")) ?? base.value,
      fromComputer: computer ?? !sellerTeamId,
      sellerTeamId,
      expiresAt: str(pick(raw, "expirationDate", "expiration", "expires")),
      numberOfBids: bidCount(raw),
      bids: parseBids(raw.bids),
    });
  }
  return out;
}

/**
 * The bid count.
 *
 * The field is `numberOfBids`, not `bids`/`numBids`/`offers`, and its value is
 * the string `"-"` when Futmondo hides it. Running the strict numeric
 * conversion over the wrong key returned undefined for every listing that has
 * ever been parsed. `"-"` maps to null explicitly rather than being swallowed,
 * so "hidden" and "zero" stay distinguishable.
 */
function bidCount(raw: Rec): number | null {
  const field = pick(raw, "numberOfBids", "numberofbids");
  if (field === undefined) return null;
  if (typeof field === "string" && field.trim() === "-") return null;
  return num(field) ?? null;
}

/**
 * Standing offers on a listing. Only `/1/market/myplayers` returns these, and
 * only for our own listings: the bidder's team is blanked, so bids are sealed
 * as to identity but not as to price.
 */
function parseBids(field: unknown): MarketBid[] | undefined {
  if (!Array.isArray(field)) return undefined;
  const out: MarketBid[] = [];
  for (const entry of field) {
    if (!isRec(entry)) continue;
    const price = num(pick(entry, "price", "amount"));
    if (price === undefined) continue;
    const team = pick(entry, "userTeam", "userteam");
    out.push({
      id: str(pick(entry, "id", "_id")),
      price,
      bidderTeamName: isRec(team) ? str(pick(team, "name")) : undefined,
    });
  }
  return out;
}

/**
 * `/1/market/playerauctionsummary`. `increment` is the minimum bid step and is
 * the direct answer to "how much should I bid"; it may scale with value, so it
 * is read per candidate rather than assumed.
 */
export function parseAuctionSummary(
  playerId: string,
  answer: unknown,
): AuctionSummary | null {
  if (!isRec(answer)) return null;
  return {
    playerId,
    increment: num(pick(answer, "increment", "step", "minIncrement")) ?? null,
    numberOfBids: bidCount(answer),
    raw: answer,
  };
}

/**
 * Per-round appearances from `/1/player/summary`'s `points[]`.
 *
 * This is the measured start record that `round_points` was supposed to hold
 * and never did: `/1/userteam/roundlineup` returns an empty player list even
 * for closed rounds. `initialLineUp` and `st` say the same thing two ways, so
 * either alone is enough and disagreement resolves towards "started".
 *
 * `minutesPlayed` was 1 for every round of every player sampled, so it is kept
 * as a flag and never treated as minutes.
 */
export function parsePlayerRounds(field: unknown): PlayerRoundRecord[] {
  const out: PlayerRoundRecord[] = [];
  for (const raw of asArray(field, "points")) {
    const round = num(pick(raw, "round", "number", "matchday"));
    if (round === undefined) continue;
    const state = str(pick(raw, "st", "state"));
    const flagged = bool(pick(raw, "initialLineUp", "initial_lineup"));
    out.push({
      round,
      points: num(pick(raw, "points")) ?? 0,
      initialLineUp: flagged ?? state?.toLowerCase() === "st",
      state,
      isHomeTeam: bool(pick(raw, "isHomeTeam", "is_home_team")),
      minutesPlayed: num(pick(raw, "minutesPlayed", "mins_played")),
    });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Daily value history from `/1/player/summary`'s `prices[]`.
 *
 * Reaches back further than our own snapshots do, which makes it the one
 * exception to "history cannot be backfilled" — that rule holds for points and
 * ownership, but value is republished in full on every call.
 *
 * The rows also carry `c` and `s`, whose meaning is not established. They are
 * deliberately not parsed: storing a field we cannot name is how a wrong
 * reading gets built on later.
 */
export function parsePlayerPrices(field: unknown): PlayerPricePoint[] {
  const out: PlayerPricePoint[] = [];
  for (const raw of asArray(field, "prices")) {
    const date = str(pick(raw, "date", "d"));
    const price = num(pick(raw, "price", "value", "p"));
    if (!date || price === undefined) continue;
    out.push({ date, price });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function parsePlayerSummary(
  playerId: string,
  answer: unknown,
): PlayerSummary | null {
  if (!isRec(answer)) return null;
  const data = isRec(answer.data) ? answer.data : {};
  const championship = isRec(answer.championship) ? answer.championship : {};
  const clause = isRec(championship.clause) ? championship.clause : {};
  const owner = isRec(championship.owner) ? championship.owner : {};

  // The most recent owner entry is the current one. `d` is the acquisition
  // instant, exact to the millisecond.
  const owners = asArray(answer.owners, "owners");
  const latestOwner = owners.length ? owners[owners.length - 1] : undefined;

  return {
    playerId,
    slug: str(pick(data, "slug", "player_slug")) ?? str(pick(answer, "slug")),
    clausePrice: num(pick(clause, "price", "value")),
    clauseDate: str(pick(clause, "date")),
    suggestedClause: num(pick(clause, "suggestedClause", "suggested")),
    clauseTransferred: bool(pick(clause, "transferred")),
    // Never present in any observed payload; see PlayerSummary.locked.
    locked: bool(pick(clause, "locked", "isLocked", "blocked")),
    rounds: parsePlayerRounds(answer.points),
    prices: parsePlayerPrices(answer.prices),
    ownerTeamId: str(pick(owner, "_id", "id", "teamId")),
    acquiredAt: latestOwner ? str(pick(latestOwner, "d", "date")) : undefined,
    raw: answer,
  };
}

// ------------------------------------------------------------ team & money ---

export function parseActiveChampionships(answer: unknown): ActiveChampionship[] {
  const out: ActiveChampionship[] = [];
  for (const raw of asArray(answer, "championships", "activechampionships")) {
    const champId = id(raw, "championshipId");
    if (!champId) continue;

    // The user's own team arrives either nested or flattened.
    const teamField = pick(raw, "userteam", "userTeam", "team");
    const userteamId = isRec(teamField)
      ? id(teamField)
      : str(pick(raw, "userteamId", "userTeamId"));
    if (!userteamId) continue;

    out.push({
      id: champId,
      name: str(pick(raw, "name", "championshipName")) ?? champId,
      userteamId,
      userteamName: isRec(teamField)
        ? str(pick(teamField, "name", "teamname"))
        : str(pick(raw, "userteamName")),
      leagueId: str(pick(raw, "leagueId", "league_id")),
      raw,
    });
  }
  return out;
}

export function parseUserTeamInformation(answer: unknown): UserTeamInformation {
  const rec = isRec(answer) ? answer : {};

  // Futmondo has used several names for the cash figure across versions.
  const funds =
    num(pick(rec, "funds", "money", "budget", "availableMoney", "cash")) ?? 0;
  const teamValue = num(pick(rec, "teamValue", "value", "totalValue")) ?? 0;
  // `withheld` is what the live payload actually calls the cash held by
  // standing bids. Without it the allocator would happily propose spending the
  // same euro twice.
  const reserved =
    num(pick(rec, "withheld", "reserved", "retained", "blockedMoney", "bidsMoney")) ?? 0;

  return {
    funds,
    teamValue,
    reserved,
    maxBid: num(pick(rec, "maxBid", "maxOffer", "maxbid")),
    raw: rec,
  };
}

export function parseChampionshipTeams(answer: unknown): ChampionshipTeam[] {
  const out: ChampionshipTeam[] = [];
  for (const raw of asArray(answer, "teams")) {
    // `teamid` (lowercase d) is what /2/championship/teams actually sends.
    const teamId = str(pick(raw, "teamid", "teamId", "_id", "id"));
    const userid = str(pick(raw, "userid", "userId", "user_id"));
    if (!teamId) continue;
    out.push({
      userid: userid ?? teamId,
      teamId,
      teamName: str(pick(raw, "teamname", "teamName", "name")) ?? teamId,
      userName: str(pick(raw, "name", "username", "userName")),
      teamValue: num(pick(raw, "teamValue", "value")),
      raw,
    });
  }
  return out;
}

export function parseRanking(answer: unknown): RankedTeam[] {
  const out: RankedTeam[] = [];
  for (const raw of asArray(answer, "ranking", "teams")) {
    out.push({
      teamId: str(pick(raw, "id", "_id", "teamid", "userteamId")),
      userid: str(pick(raw, "userid", "userId")),
      teamName: str(pick(raw, "teamname", "teamName", "name")),
      points: num(pick(raw, "points", "totalPoints")) ?? 0,
      position: num(pick(raw, "position", "rank")),
      raw,
    });
  }
  return out;
}

// ---------------------------------------------------------------- rounds -----

export function parseRounds(answer: unknown): Round[] {
  const out: Round[] = [];
  for (const raw of asArray(answer, "rounds")) {
    const roundId = id(raw, "roundId");
    const number = num(pick(raw, "number", "round", "matchday"));
    if (!roundId || number === undefined) continue;
    out.push({
      id: roundId,
      number,
      status: str(pick(raw, "status", "state")) ?? "unknown",
      raw,
    });
  }
  return out;
}

/**
 * `/2/league/matches` names the two sides `h` and `a`, not `home` and `away`.
 * Reading only the long spellings left every one of the 380 stored fixtures
 * with a null team id, which broke fixture difficulty completely: odds can only
 * reach a player through their club id, so every opponent scored as neutral and
 * facing Barcelona looked exactly like facing a relegation side.
 */
function parseMatch(raw: Rec): Match | null {
  const matchId = id(raw, "matchId");
  if (!matchId) return null;
  const info = isRec(raw.info) ? raw.info : {};
  const home = isRec(raw.h)
    ? raw.h
    : isRec(raw.home)
      ? raw.home
      : isRec(raw.local)
        ? raw.local
        : {};
  const away = isRec(raw.a)
    ? raw.a
    : isRec(raw.away)
      ? raw.away
      : isRec(raw.visitor)
        ? raw.visitor
        : {};

  // `st` is a single-letter state; "F" is full time. Scores only mean something
  // once it is, since an unplayed fixture reports 0-0 rather than null.
  const state = str(pick(raw, "st", "status", "state"));
  const finished = state === undefined ? undefined : state.toUpperCase() === "F";

  return {
    id: matchId,
    date: str(pick(info, "date", "kickoff")) ?? str(pick(raw, "date", "kickoff")),
    homeTeamId: id(home) ?? str(pick(raw, "homeTeamId", "localTeamId")),
    awayTeamId: id(away) ?? str(pick(raw, "awayTeamId", "visitorTeamId")),
    homeTeamName: str(pick(home, "name", "shortName", "shortname")),
    awayTeamName: str(pick(away, "name", "shortName", "shortname")),
    homeScore: finished ? num(pick(home, "score", "goals")) : undefined,
    awayScore: finished ? num(pick(away, "score", "goals")) : undefined,
    finished,
    raw,
  };
}

export function parseRoundsWithMatches(answer: unknown): RoundWithMatches[] {
  const out: RoundWithMatches[] = [];
  for (const raw of asArray(answer, "rounds")) {
    const roundId = id(raw, "roundId");
    const number = num(pick(raw, "number", "round", "matchday"));
    if (!roundId || number === undefined) continue;
    const matches: Match[] = [];
    for (const rawMatch of asArray(raw.matches, "matches")) {
      const match = parseMatch(rawMatch);
      if (match) matches.push(match);
    }
    out.push({
      id: roundId,
      number,
      status: str(pick(raw, "status", "state")) ?? "unknown",
      matches,
      raw,
    });
  }
  return out;
}

export function parseMatches(answer: unknown): Match[] {
  const out: Match[] = [];
  for (const raw of asArray(answer, "matches")) {
    const match = parseMatch(raw);
    if (match) out.push(match);
  }
  return out;
}

// ---------------------------------------------------------------- lineups ----

export function parseRoundLineup(
  roundId: string,
  userteamId: string,
  answer: unknown,
): RoundLineup {
  const rec = isRec(answer) ? answer : {};
  const players: RoundLineupPlayer[] = [];

  for (const raw of asArray(rec.players ?? rec, "players")) {
    const playerId = id(raw);
    const name = str(pick(raw, "name"));
    const playerRole = role(pick(raw, "role", "position"));
    if (!playerId || !name || !playerRole) continue;

    // Match-level detail hides one level down, under detailedPoints.data.
    const detailed = isRec(raw.detailedPoints) ? raw.detailedPoints : {};
    const stats = isRec(detailed.data) ? detailed.data : {};
    const minutes = num(pick(stats, "mins_played", "minsPlayed", "minutes"));

    players.push({
      playerId,
      name,
      role: playerRole,
      points: num(pick(raw, "points")) ?? 0,
      minutesPlayed: minutes,
      goals: num(pick(stats, "goals", "goal")),
      assists: num(pick(stats, "goal_assist", "assists")),
      yellowCards: num(pick(stats, "yellow_card", "yellowCards")),
      redCards: num(pick(stats, "red_card", "redCards")),
      started: (bool(pick(raw, "bench", "isBench")) ?? false) === false,
      raw,
    });
  }

  return {
    roundId,
    userteamId,
    strategy: str(pick(rec, "strategy", "formation")),
    players,
  };
}

function parseSlot(raw: Rec, bench: boolean): LineupSlot | null {
  const playerId = id(raw);
  if (!playerId) return null;
  return {
    playerId,
    name: str(pick(raw, "name")),
    role: role(pick(raw, "role")),
    position: num(pick(raw, "position", "slot", "order")),
    bench: bool(pick(raw, "bench", "isBench")) ?? bench,
    raw,
  };
}

export function parseCurrentLineup(answer: unknown): CurrentLineup {
  const rec = isRec(answer) ? answer : {};
  const players: LineupSlot[] = [];
  const bench: LineupSlot[] = [];

  for (const raw of asArray(rec.players, "players")) {
    const slot = parseSlot(raw, false);
    if (!slot) continue;
    (slot.bench ? bench : players).push(slot);
  }
  // Some versions nest the bench under a `bench` object with its own players.
  // A player already placed from `players` wins: the two lists can disagree,
  // and duplicating one across the XI and the bench would corrupt any lineup
  // we then write back.
  const benchField = rec.bench;
  const benchRows = isRec(benchField)
    ? asArray(benchField.players ?? benchField, "players")
    : asArray(benchField, "players");
  const placed = new Set([...players, ...bench].map((s) => s.playerId));
  for (const raw of benchRows) {
    const slot = parseSlot(raw, true);
    if (!slot || placed.has(slot.playerId)) continue;
    placed.add(slot.playerId);
    bench.push(slot);
  }

  return {
    strategy: str(pick(rec, "strategy", "formation", "tactic")),
    players,
    bench,
    raw: rec,
  };
}

export function parseStrategies(answer: unknown): string[] {
  const out = new Set<string>();
  if (Array.isArray(answer)) {
    for (const v of answer) {
      const s = isRec(v) ? str(pick(v, "name", "strategy", "id")) : str(v);
      if (s) out.add(s);
    }
  } else if (isRec(answer)) {
    for (const raw of asArray(answer, "strategies", "availables", "available")) {
      const s = str(pick(raw, "name", "strategy", "id"));
      if (s) out.add(s);
    }
  }
  return [...out];
}

// -------------------------------------------------------- availability -------

export function parseUnavailablePlayers(answer: unknown): UnavailablePlayer[] {
  const out: UnavailablePlayer[] = [];
  for (const raw of asArray(answer, "players")) {
    const playerId = id(raw);
    if (!playerId) continue;
    out.push({
      playerId,
      name: str(pick(raw, "name")),
      reason: str(pick(raw, "reason", "type", "status", "cause")),
      raw,
    });
  }
  return out;
}

// ---------------------------------------------------------------- ledger -----

export function parseTransfers(answer: unknown): Transfer[] {
  const out: Transfer[] = [];
  for (const raw of asArray(answer, "news", "pressroom", "transfers")) {
    const txId = str(pick(raw, "_id", "id"));
    if (!txId) continue;
    const player = isRec(raw._player) ? raw._player : {};
    const buyer = isRec(raw._buyer) ? raw._buyer : {};
    const seller = isRec(raw._seller) ? raw._seller : {};

    out.push({
      id: txId,
      playerId: id(player),
      playerName: str(pick(player, "name")),
      buyerTeamId: str(pick(buyer, "_id", "id")),
      buyerName: str(pick(buyer, "name", "teamname")),
      sellerTeamId: str(pick(seller, "_id", "id")),
      sellerName: str(pick(seller, "name", "teamname")),
      price: num(pick(raw, "price", "amount")) ?? 0,
      createdAt: str(pick(raw, "created", "createdAt", "date")),
      raw,
    });
  }
  return out;
}

/**
 * Prize payouts live in the generic news feed as rows with `styp === "customize"`.
 * They carry no team id, only an in-game name, so callers must match by name.
 */
export function parseMoneyEvents(answer: unknown): MoneyEvent[] {
  const out: MoneyEvent[] = [];
  for (const raw of asArray(answer, "news")) {
    if (str(pick(raw, "styp", "subtype")) !== "customize") continue;
    const eventId = str(pick(raw, "_id", "id"));
    if (!eventId) continue;
    const data = isRec(raw.data) ? raw.data : {};

    out.push({
      id: eventId,
      teamName: str(pick(data, "name", "teamname")),
      amount: num(pick(data, "amount", "money", "value")) ?? 0,
      description: str(pick(data, "text", "description")) ?? str(pick(raw, "text")),
      createdAt: str(pick(raw, "created", "createdAt", "date")),
      raw,
    });
  }
  return out;
}

// ------------------------------------------------------------------ odds -----

/** Market names that mean the plain 1X2 result, lowercased. */
const RESULT_MARKETS = new Set([
  "match result",
  "full time result",
  "match odds",
  "1x2",
  "resultado",
  "resultado del partido",
]);

/**
 * `/5/match/odds` does not return a flat {home, draw, away}. It returns every
 * market the bookmakers price -- correct score, total goals, half time/full
 * time, dozens of them -- as `odds[]`, each with an `mn` market name and a
 * `sels[]` of selections, and each selection carrying one quote per bookmaker.
 *
 * Reading it as a flat object found nothing, so not one of the 380 fixtures
 * ever stored a price and fixture difficulty sat at the neutral 0.5 for every
 * club in the league. What we want is the "Match Result" market, whose three
 * selections are named "1", "X" and "2" -- in that order in the client, but not
 * in the payload, so they are matched by name.
 *
 * Bookmakers disagree and some quotes go stale, so each selection takes the
 * median across books rather than the first or the mean: one bookmaker left on
 * an old price cannot then swing the fixture.
 */
export function parseOdds(matchId: string, answer: unknown): MatchOdds | null {
  if (!isRec(answer)) return null;

  // Tolerate the flat shape too, in case some deployment really does send one.
  const flat = isRec(answer.odds) ? answer.odds : answer;
  const flatHome = num(pick(flat, "home", "local", "homeWin"));
  const flatDraw = num(pick(flat, "draw", "tie"));
  const flatAway = num(pick(flat, "away", "visitor", "awayWin"));
  if (flatHome !== undefined || flatDraw !== undefined || flatAway !== undefined) {
    return { matchId, home: flatHome, draw: flatDraw, away: flatAway, raw: answer };
  }

  const markets = asArray(answer, "odds", "markets");
  const result = markets.find((m) => {
    const name = str(pick(m, "mn", "marketName", "name"));
    return name !== undefined && RESULT_MARKETS.has(name.trim().toLowerCase());
  });
  if (!result) return null;

  const bySelection = new Map<string, number>();
  for (const sel of asArray(result.sels, "sels", "selections")) {
    const key = str(pick(sel, "ssn", "selectionName", "sn"))?.trim().toUpperCase();
    if (!key) continue;
    const quotes: number[] = [];
    for (const quote of asArray(sel.odds, "odds", "prices")) {
      // `c` is the current price, `f` the opening one. Prefer current.
      const price = num(pick(quote, "c", "current", "price", "odds", "f"));
      if (price !== undefined && price > 1) quotes.push(price);
    }
    if (quotes.length === 0) continue;
    quotes.sort((a, b) => a - b);
    bySelection.set(key, quotes[Math.floor(quotes.length / 2)]);
  }

  const home = bySelection.get("1");
  const draw = bySelection.get("X");
  const away = bySelection.get("2");
  if (home === undefined && draw === undefined && away === undefined) return null;
  return { matchId, home, draw, away, raw: { matchId } };
}

// --------------------------------------------------------------- config ------

/**
 * The league's own settings.
 *
 * The keys are flat and terse and there is no `bonus` object: the real names
 * are `moneyPerPoint`, `moneyPerRanking`, `numberOfPlayers`, `dspct`, `mnmp`,
 * `enablingClause`. Looking for `perPoint` inside a wrapper that does not exist
 * found nothing, so `pointBonus` was permanently undefined and the engine fell
 * through to a hardcoded 60.000€ per point — in a league whose `moneyPerPoint`
 * is 0. Every prize-money sentence the app has ever printed was fabricated by
 * that one missed key.
 *
 * The values appear twice, at the top level and again inside a `configuration`
 * object, with the same content. The nested copy is preferred and the top level
 * is the fallback, so either shape works.
 */
export function parseChampionshipConfiguration(
  answer: unknown,
): ChampionshipConfiguration {
  const outer = isRec(answer) ? answer : {};
  const nested = isRec(outer.configuration) ? outer.configuration : {};
  /** Reads from the nested configuration first, then the top level. */
  const get = (...keys: string[]): unknown => {
    const inner = pick(nested, ...keys);
    return inner !== undefined ? inner : pick(outer, ...keys);
  };

  return {
    budget: num(get("budget", "initialBudget", "money")),
    initialPlayers: num(get("numberOfPlayers", "initialPlayers", "numInitialPlayers")),
    maxUsers: num(get("maxUserteams", "maxUsers", "maxUsersNumber")),
    // Zero is a real answer here and must survive: `num` returns 0, and every
    // consumer treats 0 as "this league does not pay for points".
    pointBonus: num(get("moneyPerPoint", "perPoint", "pointPrize")),
    rankingBonus: num(get("moneyPerRanking", "perRanking")),
    rankingMode: str(get("rankingMode")),
    usersToRank: num(get("usersToRank")),
    allowCaptain: bool(get("allowCaptain", "captain")),
    allowMultiposition: bool(get("allowMultiposition", "multiposition")),
    marketPlayers: num(get("marketPlayers", "numPlayers")),
    bidDurationDays: num(get("bidDuration", "offerDuration")),
    clauseWindowDays: num(get("enablingClause")),
    directSellShare: num(get("dspct")),
    minListingShare: num(get("mnmp")),
    automaticClauses: bool(get("enableAutomaticClauses", "automaticClauses")),
    clauseBlockingEnabled: bool(get("blc")),
    raw: outer,
  };
}
