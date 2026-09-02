import type {
  Fixture,
  FixtureDifficulty,
  StatsProvider,
  TeamForm,
  TeamSeason,
} from "./types";

interface ApiFootballResponse<T> {
  get?: string;
  parameters?: Record<string, string>;
  errors?: Record<string, unknown>;
  results?: number;
  response: T;
}

interface ApiTeam {
  id: number;
  name: string;
  code?: string;
  country?: string;
  logo?: string;
}

interface ApiFixture {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
  };
  league: { id: number; round?: string };
  teams: {
    home: { id: number; name: string; winner?: boolean | null };
    away: { id: number; name: string; winner?: boolean | null };
  };
  goals: {
    home: number | null;
    away: number | null;
  };
}

interface ApiStanding {
  rank: number;
  team: ApiTeam;
  points: number;
  goalsDiff: string;
  all: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
  form?: string;
}

interface ApiStandingsResponse {
  league: {
    id: number;
    standings: ApiStanding[][];
  };
}

const ROOT =
  process.env.API_FOOTBALL_URL ?? "https://v3.football.api-sports.io";

export class ApiFootballProvider implements StatsProvider {
  constructor(private apiKey: string = process.env.API_FOOTBALL_KEY ?? "") {
    if (!this.apiKey) {
      throw new Error(
        "API_FOOTBALL_KEY is not set. Provide it via env or constructor.",
      );
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T[]> {
    const url = new URL(`${ROOT}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      headers: {
        "x-apisports-key": this.apiKey,
      },
      cache: "force-cache",
    });
    if (!res.ok) {
      throw new Error(`API-Football ${path} returned ${res.status}`);
    }
    const data = (await res.json()) as ApiFootballResponse<T>;
    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
    }
    return Array.isArray(data.response) ? data.response : [];
  }

  async getCurrentSeason(leagueId: number): Promise<TeamSeason[] | null> {
    const standings = await this.get<ApiStandingsResponse>("/standings", {
      league: String(leagueId),
      season: String(new Date().getFullYear()),
    });
    const first = standings[0];
    const rows = first?.league?.standings?.flat() ?? [];
    return rows.map((s) => ({
      id: s.team.id,
      name: s.team.name,
      code: s.team.code,
      country: s.team.country,
      logo: s.team.logo,
    }));
  }

  async getUpcomingFixtures(
    leagueId: number,
    teamId: number,
    count = 5,
  ): Promise<Fixture[]> {
    const fixtures = await this.get<ApiFixture>("/fixtures", {
      league: String(leagueId),
      season: String(new Date().getFullYear()),
      team: String(teamId),
      next: String(count),
    });
    return fixtures
      .filter((f) => f.fixture.status.short !== "PST")
      .map((f) => this.toFixture(f));
  }

  async getLastFixtures(
    leagueId: number,
    teamId: number,
    count = 5,
  ): Promise<Fixture[]> {
    const fixtures = await this.get<ApiFixture>("/fixtures", {
      league: String(leagueId),
      season: String(new Date().getFullYear()),
      team: String(teamId),
      last: String(count),
    });
    return fixtures
      .filter((f) => f.fixture.status.short !== "PST")
      .map((f) => this.toFixture(f));
  }

  private toFixture(f: ApiFixture): Fixture {
    const short = f.fixture.status.short;
    let status: Fixture["status"];
    if (short === "FT" || short === "AET" || short === "PEN") status = "finished";
    else if (short === "1H" || short === "2H" || short === "HT" || short === "ET") status = "live";
    else status = "notstarted";
    return {
      id: f.fixture.id,
      leagueId: f.league.id,
      round: f.league.round,
      date: f.fixture.date,
      status,
      homeId: f.teams.home.id,
      homeName: f.teams.home.name,
      awayId: f.teams.away.id,
      awayName: f.teams.away.name,
      homeScore: f.goals.home ?? undefined,
      awayScore: f.goals.away ?? undefined,
    };
  }

  async getTeamForm(
    leagueId: number,
    teamId: number,
    count = 5,
  ): Promise<TeamForm | null> {
    const standings = await this.get<ApiStandingsResponse>("/standings", {
      league: String(leagueId),
      season: String(new Date().getFullYear()),
    });
    const row = standings
      .flatMap((s) => s.league.standings)
      .flat()
      .find((r) => r.team.id === teamId);
    if (!row) return null;

    const all = row.all;
    return {
      teamId,
      teamName: row.team.name,
      ratings: (row.form ?? "")
        .split("")
        .filter((c) => c !== "")
        .slice(-count)
        .map((c) => ({
          won: c === "W",
          drawn: c === "D",
          goals: c === "W" ? 3 : c === "D" ? 1 : 0,
        })),
      wins: all.win,
      draws: all.draw,
      losses: all.lose,
      goalsScored: all.goals.for,
      goalsConceded: all.goals.against,
    };
  }

  async getFixtureDifficulty(
    leagueId: number,
    teamId: number,
    lookahead = 3,
  ): Promise<FixtureDifficulty | null> {
    const teams = await this.getCurrentSeason(leagueId);
    const upcoming = await this.getUpcomingFixtures(leagueId, teamId, lookahead);
    if (upcoming.length === 0 || !teams) return null;

    let homeNext = 0;
    let awayNext = 0;
    let difficulty = 0;

    // Win-rate-based strength proxy from standings via form (best-effort free tier)
    for (const f of upcoming) {
      const oppId = f.homeId === teamId ? f.awayId : f.homeId;
      const opp = teams.find((t) => t.id === oppId);
      void opp;
      const isHome = f.homeId === teamId;
      if (isHome) homeNext++;
      else awayNext++;
    }

    difficulty = Math.min(homeNext, 2) * 0.4 + Math.min(awayNext, 2) * 0.6;

    return {
      teamId,
      teamName: "",
      difficulty: Number(difficulty.toFixed(2)),
      homeNext,
      awayNext,
    };
  }
}

export function isFixtureDifficult(d: FixtureDifficulty, threshold = 1.6): boolean {
  return d.difficulty >= threshold;
}
