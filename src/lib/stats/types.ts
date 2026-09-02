export type StatsRole = "Goalkeeper" | "Defender" | "Midfielder" | "Attacker" | string;

export interface TeamSeason {
  id: number;
  name: string;
  code?: string;
  country?: string;
  logo?: string;
}

export interface PlayerFixtureStats {
  playerId: number;
  name: string;
  role: StatsRole;
  teamId: number;
  teamName: string;
  minutes: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  cleanSheet: boolean;
  goalsConceded: number;
  saves?: number;
  rating?: number;
}

export interface Fixture {
  id: number;
  leagueId?: number;
  round?: string;
  date: string;
  status: "notstarted" | "live" | "finished";
  homeId: number;
  homeName: string;
  awayId: number;
  awayName: string;
  homeScore?: number;
  awayScore?: number;
}

export interface TeamForm {
  teamId: number;
  teamName: string;
  ratings: { won: boolean; drawn: boolean; goals: number }[];
  wins: number;
  draws: number;
  losses: number;
  goalsScored: number;
  goalsConceded: number;
}

export interface FixtureDifficulty {
  teamId: number;
  teamName: string;
  difficulty: number;
  homeNext: number;
  awayNext: number;
}

export interface StatsProvider {
  getCurrentSeason(leagueId: number): Promise<TeamSeason[] | null>;
  getUpcomingFixtures(leagueId: number, teamId: number, count?: number): Promise<Fixture[]>;
  getLastFixtures(leagueId: number, teamId: number, count?: number): Promise<Fixture[]>;
  getTeamForm(leagueId: number, teamId: number, count?: number): Promise<TeamForm | null>;
  getFixtureDifficulty(
    leagueId: number,
    teamId: number,
    lookahead: number,
  ): Promise<FixtureDifficulty | null>;
}
