/**
 * Response shapes for the private Futmondo API. Documented in
 * docs/futmondo-api.md. Futmondo publishes no contract, so every field beyond
 * the ones we have actually observed is optional and the index signature is
 * deliberate — payloads carry more than we model.
 */

export interface Header {
  token: string | null;
  userid?: string;
  device?: string;
  deviceId?: string;
  lang?: string;
}

export interface Envelope<T = unknown> {
  header: Header;
  query: Record<string, unknown>;
  answer: T;
}

export type FutmondoRole = "POR" | "DEF" | "MED" | "DEL";

export const ROLES: readonly FutmondoRole[] = ["POR", "DEF", "MED", "DEL"];

/** `/2/user/activechampionships` */
export interface ActiveChampionship {
  id: string;
  name: string;
  userteamId: string;
  userteamName?: string;
  leagueId?: string;
  raw: Record<string, unknown>;
}

/** `/1/userteam/information` — the source of truth for money. */
export interface UserTeamInformation {
  funds: number;
  teamValue: number;
  /** Cash committed to open bids, unavailable to spend again. */
  reserved: number;
  /** Ceiling Futmondo itself will accept, when it reports one. */
  maxBid?: number;
  raw: Record<string, unknown>;
}

/** `/1/userteam/roster` and `/1/market/players` share most of their shape. */
export interface Player {
  id: string;
  name: string;
  role: FutmondoRole;
  /** Real club name, when present. */
  team?: string;
  /** Real club id — the key for injuries and fixtures. */
  teamId?: string;
  /** Futmondo market value in euros. */
  value: number;
  /** Season points total. */
  points: number;
  /** Points per appearance, as Futmondo reports it. */
  average?: number;
  slug?: string;
  photo?: string;
  raw: Record<string, unknown>;
}

export interface RosterPlayer extends Player {
  /** What the current owner paid. */
  buyPrice?: number;
  /** Clause price, only known after a /1/player/summary lookup. */
  clause?: number;
  /** True when the owner has clause-blocked the player. */
  locked?: boolean;
}

export interface MarketPlayer extends Player {
  /** Asking price. Differs from `value` when a user set it. */
  price: number;
  /** True when the seller is Futmondo itself rather than a rival. */
  fromComputer: boolean;
  /** Selling user team id, when a rival is selling. */
  sellerTeamId?: string;
  /** When the listing closes, if reported. */
  expiresAt?: string;
  bids?: number;
}

/** `/1/userteam/rounds` and `/2/league/matches` rounds. */
export interface Round {
  id: string;
  number: number;
  status: RoundStatus;
  raw: Record<string, unknown>;
}

export type RoundStatus = "closed" | "running" | "open" | "pending" | string;

export interface Match {
  id: string;
  /** Kickoff, ISO 8601. */
  date?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  raw: Record<string, unknown>;
}

export interface RoundWithMatches extends Round {
  matches: Match[];
}

/** `/2/championship/teams` */
export interface ChampionshipTeam {
  /** Stable account id. Join on this, never on the name. */
  userid: string;
  /** User team id, used as `userteamId`. */
  teamId: string;
  /** In-game team name. Users rename these, so it is not a stable key. */
  teamName: string;
  /** Real person's name. */
  userName?: string;
  teamValue?: number;
  raw: Record<string, unknown>;
}

/** `/1/ranking/general` and `/1/ranking/round` */
export interface RankedTeam {
  teamId?: string;
  userid?: string;
  teamName?: string;
  points: number;
  position?: number;
  raw: Record<string, unknown>;
}

/** `/1/player/summary` — carries the clause price nothing else exposes. */
export interface PlayerSummary {
  playerId: string;
  slug?: string;
  clausePrice?: number;
  /** True when the owner has blocked the clause. */
  locked?: boolean;
  raw: Record<string, unknown>;
}

/** `/1/userteam/roundlineup` — per-player, per-round detail for any team. */
export interface RoundLineupPlayer {
  playerId: string;
  name: string;
  role: FutmondoRole;
  points: number;
  minutesPlayed?: number;
  goals?: number;
  assists?: number;
  yellowCards?: number;
  redCards?: number;
  /** False when the player sat on the bench that round. */
  started: boolean;
  raw: Record<string, unknown>;
}

export interface RoundLineup {
  roundId: string;
  userteamId: string;
  strategy?: string;
  players: RoundLineupPlayer[];
}

/** `/1/userteam/lineup` — the lineup as it currently stands. */
export interface CurrentLineup {
  /** Formation string as Futmondo names it, e.g. "4-3-3". */
  strategy?: string;
  players: LineupSlot[];
  bench: LineupSlot[];
  raw: Record<string, unknown>;
}

export interface LineupSlot {
  playerId: string;
  name?: string;
  role?: FutmondoRole;
  /** Futmondo's slot index within the formation. */
  position?: number;
  bench: boolean;
  raw: Record<string, unknown>;
}

/** `/2/team/unavailableplayers` — injuries and suspensions, per real club. */
export interface UnavailablePlayer {
  playerId: string;
  name?: string;
  /** Futmondo's own wording, e.g. "injured", "sanctioned". */
  reason?: string;
  raw: Record<string, unknown>;
}

/** `/1/locker/pressroom` — the transfer ledger. */
export interface Transfer {
  id: string;
  playerName?: string;
  playerId?: string;
  /** User team id of the buyer. Absent when Futmondo itself bought. */
  buyerTeamId?: string;
  buyerName?: string;
  /** User team id of the seller. Absent when Futmondo itself sold. */
  sellerTeamId?: string;
  sellerName?: string;
  price: number;
  createdAt?: string;
  raw: Record<string, unknown>;
}

/** `/2/locker/news` rows with `styp === "customize"` — prize payouts. */
export interface MoneyEvent {
  id: string;
  /** In-game team name. The endpoint gives no id, so matching is by name. */
  teamName?: string;
  amount: number;
  description?: string;
  createdAt?: string;
  raw: Record<string, unknown>;
}

/** `/5/match/odds` */
export interface MatchOdds {
  matchId: string;
  home?: number;
  draw?: number;
  away?: number;
  raw: Record<string, unknown>;
}

/** `/1/championship/configuration` — the league's own settings. */
export interface ChampionshipConfiguration {
  budget?: number;
  initialPlayers?: number;
  maxUsers?: number;
  /** Prize money per point scored. */
  pointBonus?: number;
  allowCaptain?: boolean;
  allowMultiposition?: boolean;
  marketPlayers?: number;
  bidDurationDays?: number;
  automaticClauses?: boolean;
  raw: Record<string, unknown>;
}
