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

/**
 * The scoring record the roster and market payloads already carry under
 * `average`. Until `/1/userteam/roundlineup` gives up its per-round rows this
 * is the only per-player evidence there is, so the expected-points model reads
 * it directly rather than waiting for history that may never arrive.
 *
 * `average` is per match *played*; `averageLastFive` is per *round*, counting a
 * round missed as zero. The two differ once a player starts missing games, and
 * that difference is the signal that they have lost their place.
 */
export interface PlayerStats {
  /** Points per match actually played. */
  average: number;
  /** Same, split by venue. Half the sample, so weight it accordingly. */
  homeAverage?: number;
  awayAverage?: number;
  /** Mean over the last five rounds, with a round missed counting as zero. */
  averageLastFive?: number;
  /** Matches played: the sample size behind `average`. */
  matches: number;
  /**
   * Points per round in chronological order, zero for a round not played.
   * `fitness.length` is therefore rounds elapsed, and
   * `fitness.length - matches` is rounds missed.
   */
  fitness: number[];
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
  /** The full scoring record, when the payload carries one. */
  stats?: PlayerStats;
  /**
   * Futmondo's own availability marker, present on every roster and market row.
   *
   * Observed values across all nine rosters: `""` (110), `"ok"` (16),
   * `"doubt"` (10), `"injured"` (2), `"injured2"` (3), `"redcard"` (1). `"ok"`
   * is a *positive* marker — a player returning to fitness — not an absence,
   * and reading it as one would bench exactly the players who just recovered.
   *
   * It arrives in calls we already make, and it covers market listings that
   * `/2/team/unavailableplayers` never reaches.
   */
  status?: string;
  slug?: string;
  photo?: string;
  raw: Record<string, unknown>;
}

export interface RosterPlayer extends Player {
  /** What the current owner paid. */
  buyPrice?: number;
  /** Clause price. The roster row carries it nested under `clause.price`. */
  clause?: number;
  /** True when the owner has clause-blocked the player. */
  locked?: boolean;
  /** True when the player is already listed on the market. */
  onMarket?: boolean;
  /** The asking price of that listing, when there is one. */
  askPrice?: number;
}

/**
 * A standing offer on a listing. Only `/1/market/myplayers` exposes these.
 *
 * Identity is sealed inconsistently: a bid placed through the market comes back
 * with `userTeam: {name: "", slug: ""}`, while a direct roster bid from a rival
 * carries their team name in full. So the absence of a name is a fact about the
 * kind of bid, not about the endpoint.
 */
export interface MarketBid {
  id?: string;
  price: number;
  /** Present for a rival's direct roster bid; blanked for a market bid. */
  bidderTeamName?: string;
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
  /**
   * How many offers stand on the listing.
   *
   * The field is `numberOfBids` and its value is the **string** `"-"` when
   * hidden, which is why it is `number | null` rather than a plain number: the
   * parser used to look for `bids`/`numBids`/`offers` and run a strict numeric
   * conversion over the result, so it was permanently undefined.
   *
   * Do not make decisions on it until OPEN-3 establishes what it counts: it
   * came back as 20 for a 1M injured defender in a nine-member league.
   */
  numberOfBids: number | null;
  /** The bids themselves. Populated only by `/1/market/myplayers`. */
  bids?: MarketBid[];
}

/**
 * `/1/market/playerauctionsummary` with `{championshipId, userteamId, player_id}`.
 * It rejects a slug, and errors `market.playerAuctionSummary.needTeamId`
 * without the team.
 */
export interface AuctionSummary {
  playerId: string;
  /** The minimum bid step. The direct answer to "how much should I bid". */
  increment: number | null;
  /** See MarketPlayer.numberOfBids: not trustworthy yet. */
  numberOfBids: number | null;
  raw: Record<string, unknown>;
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
  /** Final score, once played. The fallback strength signal when odds are absent. */
  homeScore?: number;
  awayScore?: number;
  /** True once the fixture has been played out. */
  finished?: boolean;
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

/** One round from `/1/player/summary`'s `points[]`. A measured start record. */
export interface PlayerRoundRecord {
  /** Matchday number, not a round id. */
  round: number;
  points: number;
  /** True when the player was in the starting XI that round. */
  initialLineUp: boolean;
  /** `"st"` starter, `"bc"` bench. The second source for the same fact. */
  state?: string;
  isHomeTeam?: boolean;
  /**
   * Reported as 1 for every round of every player sampled, so it is a flag
   * rather than minutes until a substitute appearance proves otherwise.
   */
  minutesPlayed?: number;
}

/** One daily valuation from `/1/player/summary`'s `prices[]`. */
export interface PlayerPricePoint {
  /** ISO instant Futmondo stamped the valuation with. */
  date: string;
  price: number;
}

/**
 * `/1/player/summary` — far more than the clause price we used to take from it.
 *
 * One call already made sixty times per sync run, carrying a measured start
 * record, daily value history reaching back before our first snapshot, the
 * clause availability date, and Futmondo's own suggested clause.
 */
export interface PlayerSummary {
  playerId: string;
  slug?: string;
  clausePrice?: number;
  /**
   * When the clause first becomes payable, ISO 8601. Read, never derived — see
   * the header of src/lib/engine/clauses.ts.
   */
  clauseDate?: string;
  /** Futmondo's own valuation of a fair clause. */
  suggestedClause?: number;
  /** True once the clause has been paid. */
  clauseTransferred?: boolean;
  /**
   * True when the owner has blocked the clause.
   *
   * Never populated: no payload anywhere carries this field. Kept so the shape
   * does not have to change if one ever appears, and so the absence is
   * documented at the point of use. See OPEN-7.
   */
  locked?: boolean;
  /** Per-round record, oldest first. */
  rounds: PlayerRoundRecord[];
  /** Daily value history, oldest first. */
  prices: PlayerPricePoint[];
  /** Current owner's user team id, when the payload names one. */
  ownerTeamId?: string;
  /** When the current owner acquired them, exact to the millisecond. */
  acquiredAt?: string;
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

/**
 * `/1/championship/configuration` — the league's own settings.
 *
 * The real keys are flat and terse: `moneyPerPoint`, `moneyPerRanking`,
 * `dspct`, `mnmp`, `enablingClause`. The parser used to look for `perPoint`
 * inside a `bonus` object that does not exist, found nothing, and let the
 * engine fall through to a hardcoded 60.000€ per point — in a league that pays
 * zero. Everything below is read from a captured payload, not inferred.
 */
export interface ChampionshipConfiguration {
  budget?: number;
  initialPlayers?: number;
  maxUsers?: number;
  /** `moneyPerPoint`. Legitimately zero in leagues that pay by ranking only. */
  pointBonus?: number;
  /** `moneyPerRanking`: the pool distributed by round ranking. */
  rankingBonus?: number;
  /** `rankingMode`, e.g. "flop". The payout shape behind it is not decoded. */
  rankingMode?: string;
  /** `usersToRank`. -1 observed; meaning not established. */
  usersToRank?: number;
  allowCaptain?: boolean;
  allowMultiposition?: boolean;
  /** `marketPlayers`: new machine listings per market refresh. */
  marketPlayers?: number;
  /** `bidDuration`: how many days a listing lives. */
  bidDurationDays?: number;
  /** `enablingClause`: days from acquisition before a clause can be paid. */
  clauseWindowDays?: number;
  /** `dspct`: share of value the machine pays for a direct sale. */
  directSellShare?: number;
  /** `mnmp`: floor on a listing price, as a share of value. */
  minListingShare?: number;
  automaticClauses?: boolean;
  /** True when clause blocking is enabled at all (`blc`). */
  clauseBlockingEnabled?: boolean;
  raw: Record<string, unknown>;
}
