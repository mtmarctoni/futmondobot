export interface Header {
  token: string;
  userid: string;
}

export interface Envelope<T = unknown> {
  header: Header;
  query: Record<string, unknown>;
  answer: T;
}

export type FutmondoRole = "POR" | "DEF" | "MED" | "DEL";

export interface RosterPlayer {
  id: string;
  name: string;
  role: FutmondoRole;
  team: string;
  teamId?: string;
  value: number;
  points: number;
  clause?: number;
  suggestedClause?: number;
  average?: number;
  averageLastFive?: number;
  photo?: string;
  status?: string;
  injury?: string | null;
  price?: number;
  totalValue?: number;
  [key: string]: unknown;
}

export interface MarketPlayer {
  id: string;
  name: string;
  role: FutmondoRole;
  team: string;
  teamId?: string;
  price: number;
  value: number;
  points: number;
  average?: number;
  averageLastFive?: number;
  owner?: string | null;
  ownerTeamId?: string | null;
  clause?: number;
  suggestedClause?: number;
  photo?: string;
  status?: string;
  [key: string]: unknown;
}

export interface RoundInfo {
  id: string;
  number: number;
  status: string;
  points?: number;
  negative?: boolean;
  [key: string]: unknown;
}

export interface LeagueInfo {
  _id: string;
  name: string;
  rounds?: RoundInfo[];
  [key: string]: unknown;
}

export interface PlayerSummary {
  playerId?: string;
  name?: string;
  average?: number;
  averageLastFive?: number;
  pointsByRound?: Record<string, number>;
  transactions?: unknown[];
  [key: string]: unknown;
}

export interface RankedTeam {
  teamId?: string;
  userTeamName?: string;
  username?: string;
  points?: number;
  position?: number;
  money?: number;
  [key: string]: unknown;
}

export interface ChampionshipTeam {
  id?: string;
  name?: string;
  userTeamName?: string;
  username?: string;
  points?: number;
  [key: string]: unknown;
}
