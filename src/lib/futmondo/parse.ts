/**
 * Normalisers for Futmondo's inconsistent payloads. `answer` is sometimes a
 * bare array and sometimes an object wrapping one under an endpoint-specific
 * key, and numbers arrive as either numbers or strings. Everything here is
 * total: a shape we do not recognise yields an empty result rather than
 * throwing, so one changed endpoint degrades a feature instead of the app.
 */
import type {
  ActiveChampionship,
  ChampionshipConfiguration,
  ChampionshipTeam,
  CurrentLineup,
  FutmondoRole,
  LineupSlot,
  MarketPlayer,
  Match,
  MatchOdds,
  MoneyEvent,
  Player,
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
  DEL: "DEL",
  FW: "DEL",
  DELANTERO: "DEL",
  ATT: "DEL",
};

export function role(v: unknown): FutmondoRole | undefined {
  const raw = str(v);
  if (!raw) return undefined;
  return ROLE_ALIASES[raw.trim().toUpperCase()];
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
    slug: str(pick(raw, "slug", "player_slug")),
    photo: str(pick(raw, "photo", "image", "avatar")),
    raw,
  };
}

export function parseRoster(answer: unknown): RosterPlayer[] {
  const out: RosterPlayer[] = [];
  for (const raw of asArray(answer, "players", "roster")) {
    const base = basePlayer(raw);
    if (!base) continue;
    out.push({
      ...base,
      buyPrice: num(pick(raw, "buyPrice", "buy_price", "purchasePrice")),
      clause: num(pick(raw, "clause", "clausePrice", "clause_price")),
      locked: bool(pick(raw, "locked", "isLocked", "blocked")),
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
      bids: num(pick(raw, "bids", "numBids", "offers")),
    });
  }
  return out;
}

export function parsePlayerSummary(
  playerId: string,
  answer: unknown,
): PlayerSummary | null {
  if (!isRec(answer)) return null;
  const data = isRec(answer.data) ? answer.data : {};
  const championship = isRec(answer.championship) ? answer.championship : {};
  const clause = isRec(championship.clause) ? championship.clause : {};

  return {
    playerId,
    slug: str(pick(data, "slug", "player_slug")) ?? str(pick(answer, "slug")),
    clausePrice: num(pick(clause, "price", "value")),
    locked: bool(pick(clause, "locked", "isLocked", "blocked")),
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
  const reserved =
    num(pick(rec, "reserved", "retained", "blockedMoney", "bidsMoney")) ?? 0;

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

function parseMatch(raw: Rec): Match | null {
  const matchId = id(raw, "matchId");
  if (!matchId) return null;
  const info = isRec(raw.info) ? raw.info : {};
  const home = isRec(raw.home) ? raw.home : isRec(raw.local) ? raw.local : {};
  const away = isRec(raw.away) ? raw.away : isRec(raw.visitor) ? raw.visitor : {};

  return {
    id: matchId,
    date: str(pick(info, "date", "kickoff")) ?? str(pick(raw, "date", "kickoff")),
    homeTeamId: id(home) ?? str(pick(raw, "homeTeamId", "localTeamId")),
    awayTeamId: id(away) ?? str(pick(raw, "awayTeamId", "visitorTeamId")),
    homeTeamName: str(pick(home, "name", "shortName")),
    awayTeamName: str(pick(away, "name", "shortName")),
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

export function parseOdds(matchId: string, answer: unknown): MatchOdds | null {
  if (!isRec(answer)) return null;
  const rec = isRec(answer.odds) ? answer.odds : answer;
  const home = num(pick(rec, "home", "local", "1", "homeWin"));
  const draw = num(pick(rec, "draw", "tie", "x", "X"));
  const away = num(pick(rec, "away", "visitor", "2", "awayWin"));
  if (home === undefined && draw === undefined && away === undefined) return null;
  return { matchId, home, draw, away, raw: answer };
}

// --------------------------------------------------------------- config ------

export function parseChampionshipConfiguration(
  answer: unknown,
): ChampionshipConfiguration {
  const rec = isRec(answer) ? answer : {};
  const market = isRec(rec.market) ? rec.market : rec;
  const bonus = isRec(rec.bonus) ? rec.bonus : isRec(rec.awards) ? rec.awards : rec;

  return {
    budget: num(pick(rec, "budget", "initialBudget", "money")),
    initialPlayers: num(pick(rec, "initialPlayers", "numInitialPlayers")),
    maxUsers: num(pick(rec, "maxUsers", "maxUsersNumber")),
    pointBonus: num(pick(bonus, "perPoint", "point", "pointPrize")),
    allowCaptain: bool(pick(rec, "allowCaptain", "captain")),
    allowMultiposition: bool(pick(rec, "allowMultiposition", "multiposition")),
    marketPlayers: num(pick(market, "players", "marketPlayers", "numPlayers")),
    bidDurationDays: num(pick(market, "bidDuration", "offerDuration", "duration")),
    automaticClauses: bool(pick(market, "automaticClauses", "autoClauses")),
    raw: rec,
  };
}
