import type {
  Envelope,
  LeagueInfo,
  MarketPlayer,
  PlayerSummary,
  RankedTeam,
  RosterPlayer,
} from "./types";

const BASE_URL = process.env.FUTMONDO_API_URL ?? "https://api.futmondo.com";

interface LoginResponse {
  answer: {
    code?: string;
    mobile?: {
      code?: string;
      token?: string;
      userid?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const DEFAULT_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "es-ES,es;q=0.9",
  Connection: "keep-alive",
  "Content-Type": "application/json; charset=utf-8",
  Origin: "https://app.futmondo.com",
  Referer: "https://app.futmondo.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

export class FutmondoError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "FutmondoError";
  }
}

export class FutmondoClient {
  private token: string | null = null;
  private userid: string | null = null;

  constructor(
    private email?: string,
    private password?: string,
  ) {
    this.email = email ?? process.env.FUTMONDO_EMAIL;
    this.password = password ?? process.env.FUTMONDO_PASSWORD;
  }

  get isAuthenticated(): boolean {
    return this.token !== null && this.userid !== null;
  }

  async login(): Promise<void> {
    if (!this.email || !this.password) {
      throw new FutmondoError(
        "FUTMONDO_EMAIL and FUTMONDO_PASSWORD must be set in environment variables.",
      );
    }

    const payload: Envelope = {
      header: { token: "null", userid: "" },
      query: { mail: this.email, pwd: this.password },
      answer: {},
    };

    const data = (await this.post<LoginResponse>("/5/login/with_mail", payload))
      .body;

    const answer = data?.answer ?? {};
    const mobile = answer.mobile ?? {};

    if (answer.code === "api.general.ok" && mobile.code === "login.mobile.ok") {
      this.token = mobile.token ?? null;
      this.userid = mobile.userid ?? null;
      if (!this.token || !this.userid) {
        throw new FutmondoError("Login response missing token or userid");
      }
      return;
    }

    if (answer.error) {
      throw new FutmondoError(
        `Login failed: ${String(answer.error)} ${String(answer.code ?? "")}`,
      );
    }

    throw new FutmondoError(
      `Login failed: unexpected response (${JSON.stringify(answer)})`,
    );
  }

  private async post<T>(
    endpoint: string,
    payload: Envelope,
  ): Promise<{ body: T; status: number }> {
    const url = `${BASE_URL}${endpoint}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: DEFAULT_HEADERS,
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (err) {
      throw new FutmondoError(
        `Network error calling Futmondo ${endpoint}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      throw new FutmondoError(
        `Futmondo ${endpoint} returned ${res.status}`,
        res.status,
        body,
      );
    }
    return { body: body as T, status: res.status };
  }

  private async request<T>(
    endpoint: string,
    query: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isAuthenticated) {
      await this.login();
    }
    const payload: Envelope = {
      header: { token: this.token as string, userid: this.userid as string },
      query,
      answer: {},
    };
    const { body } = await this.post<Envelope<T>>(endpoint, payload);
    return body.answer;
  }

  async getLeagueList(): Promise<LeagueInfo[]> {
    const answer = await this.request<unknown>("/2/league/list", {});
    if (Array.isArray(answer)) return answer as LeagueInfo[];
    return [];
  }

  async getChampionshipPlayers(championshipId: string): Promise<RosterPlayer[]> {
    const answer = await this.request<unknown>(
      "/5/league/championshipplayers",
      { championshipId },
    );
    if (Array.isArray(answer)) return answer as RosterPlayer[];
    if (answer && typeof answer === "object") {
      const players = (answer as { players?: RosterPlayer[] }).players;
      if (Array.isArray(players)) return players;
    }
    return [];
  }

  async getUserTeamRoster(
    championshipId: string,
    userteamId: string,
  ): Promise<RosterPlayer[]> {
    const answer = await this.request<unknown>("/1/userteam/roster", {
      championshipId,
      userteamId,
    });
    if (Array.isArray(answer)) return answer as RosterPlayer[];
    if (answer && typeof answer === "object") {
      const players =
        (answer as { players?: RosterPlayer[] }).players ??
        (answer as { roster?: RosterPlayer[] }).roster;
      if (Array.isArray(players)) return players;
    }
    return [];
  }

  async getUserTeamRounds(
    championshipId: string,
    userteamId: string,
  ) {
    const answer = await this.request<unknown>("/1/userteam/rounds", {
      championshipId,
      userteamId,
    });
    if (Array.isArray(answer)) return answer as Record<string, unknown>[];
    if (answer && typeof answer === "object") {
      for (const key of Object.keys(answer as Record<string, unknown>)) {
        const v = (answer as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v as Record<string, unknown>[];
      }
    }
    return [];
  }

  async getMarketPlayers(championshipId: string): Promise<MarketPlayer[]> {
    const answer = await this.request<unknown>("/1/market/players", {
      championshipId,
    });
    if (Array.isArray(answer)) return answer as MarketPlayer[];
    if (answer && typeof answer === "object") {
      const players =
        (answer as { players?: MarketPlayer[] }).players ??
        (answer as { market?: MarketPlayer[] }).market;
      if (Array.isArray(players)) return players;
    }
    return [];
  }

  async getPlayerSummary(
    championshipId: string,
    playerId: string,
    userteamId: string,
  ): Promise<PlayerSummary | null> {
    try {
      const answer = await this.request<unknown>("/1/player/summary", {
        championshipId,
        userteamId,
        playerId,
      });
      if (answer && typeof answer === "object") {
        return answer as PlayerSummary;
      }
    } catch {
      return null;
    }
    return null;
  }

  async getChampionshipTeams(
    championshipId: string,
  ): Promise<ChampionshipTeamLike[]> {
    const answer = await this.request<unknown>("/2/championship/teams", {
      championshipId,
    });
    if (Array.isArray(answer)) return answer as ChampionshipTeamLike[];
    if (answer && typeof answer === "object") {
      const teams = (answer as { teams?: ChampionshipTeamLike[] }).teams;
      if (Array.isArray(teams)) return teams;
    }
    return [];
  }

  async getRoundRanking(
    championshipId: string,
    matchday?: number,
    roundId?: string,
    userteamId?: string,
  ): Promise<RankedTeam[]> {
    const query: Record<string, unknown> = { championshipId };
    if (roundId) {
      query.roundId = roundId;
      query.roundNumber = roundId;
    }
    if (matchday !== undefined) query.round = matchday;
    if (userteamId) query.userteamId = userteamId;
    const answer = await this.request<unknown>("/1/ranking/round", query);
    if (Array.isArray(answer)) return answer as RankedTeam[];
    if (answer && typeof answer === "object") {
      const ranking = (answer as { ranking?: RankedTeam[] }).ranking;
      if (Array.isArray(ranking)) return ranking;
    }
    return [];
  }

  async getMatchList(
    championshipId: string,
    matchday?: number,
  ): Promise<unknown[]> {
    const query: Record<string, unknown> = { championshipId };
    if (matchday !== undefined) query.matchday = matchday;
    const answer = await this.request<unknown>("/1/match/list", query);
    if (Array.isArray(answer)) return answer as unknown[];
    return [];
  }

  async getLockerNews(championshipId: string): Promise<unknown[]> {
    const answer = await this.request<unknown>("/2/locker/news", {
      championshipId,
      from: "",
    });
    if (Array.isArray(answer)) return answer as unknown[];
    if (answer && typeof answer === "object") {
      const news =
        (answer as { news?: unknown[] }).news ??
        (answer as { data?: unknown[] }).data;
      if (Array.isArray(news)) return news;
    }
    return [];
  }
}

export type ChampionshipTeamLike = Record<string, unknown>;

export { BASE_URL };
