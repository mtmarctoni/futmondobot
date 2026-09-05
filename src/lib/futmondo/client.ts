import { FutmondoError } from "./errors";
import * as parse from "./parse";
import { postEnvelope, sleep, type PostOptions } from "./transport";
import type {
  ActiveChampionship,
  AuctionSummary,
  ChampionshipConfiguration,
  ChampionshipTeam,
  CurrentLineup,
  Header,
  MarketPlayer,
  Match,
  MatchOdds,
  MoneyEvent,
  PlayerSummary,
  RankedTeam,
  RosterPlayer,
  Round,
  RoundLineup,
  RoundWithMatches,
  Transfer,
  UnavailablePlayer,
  UserTeamInformation,
} from "./types";

/** La Liga's id in Futmondo. Constant across accounts. */
export const LA_LIGA_LEAGUE_ID = "504e4f584d8bec9a67000079";

export interface Session {
  token: string;
  userid: string;
}

/**
 * Somewhere to keep a token between invocations. Logging in on every request
 * risks an account lock, and serverless functions lose module state on cold
 * start, so production should back this with the database.
 */
export interface TokenStore {
  get(): Promise<Session | null>;
  set(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** Process-lifetime store. Survives warm invocations, lost on cold start. */
export class MemoryTokenStore implements TokenStore {
  private session: Session | null = null;
  async get() {
    return this.session;
  }
  async set(session: Session) {
    this.session = session;
  }
  async clear() {
    this.session = null;
  }
}

/** Shared so every client in a warm lambda reuses one token. */
const defaultStore = new MemoryTokenStore();

export interface Scope {
  championshipId: string;
  userteamId: string;
}

export interface FutmondoClientOptions {
  email?: string;
  password?: string;
  tokenStore?: TokenStore;
  /** Stable per install; Futmondo ties sessions to it. */
  deviceId?: string;
  post?: PostOptions;
}

export class FutmondoClient {
  private readonly email: string | undefined;
  private readonly password: string | undefined;
  private readonly store: TokenStore;
  private readonly deviceId: string;
  private readonly postOptions: PostOptions;

  private session: Session | null = null;
  private loginInFlight: Promise<Session> | null = null;
  private championships: ActiveChampionship[] | null = null;

  constructor(options: FutmondoClientOptions = {}) {
    this.email = options.email ?? process.env.FUTMONDO_EMAIL;
    this.password = options.password ?? process.env.FUTMONDO_PASSWORD;
    this.store = options.tokenStore ?? defaultStore;
    this.deviceId =
      options.deviceId ?? process.env.FUTMONDO_DEVICE_ID ?? "futmondobot-01";
    this.postOptions = options.post ?? {};
  }

  // ------------------------------------------------------------- session ----

  /**
   * Returns a usable session, reusing the cached token and collapsing
   * concurrent callers onto one login.
   */
  async authenticate(force = false): Promise<Session> {
    if (!force) {
      if (this.session) return this.session;
      const cached = await this.store.get();
      if (cached?.token && cached.userid) {
        this.session = cached;
        return cached;
      }
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<Session> {
    if (!this.email || !this.password) {
      throw new FutmondoError(
        "FUTMONDO_EMAIL and FUTMONDO_PASSWORD must be set.",
      );
    }

    const header: Header = {
      token: null,
      device: "android",
      deviceId: this.deviceId,
      lang: "es",
    };
    const answer = await postEnvelope(
      "/5/login/with_mail",
      header,
      { mail: this.email, pwd: this.password },
      this.postOptions,
    );

    const mobile =
      parse.isRec(answer) && parse.isRec(answer.mobile) ? answer.mobile : {};
    const token = parse.str(mobile.token);
    const userid = parse.str(mobile.userid ?? mobile.userId);

    if (!token || !userid) {
      throw new FutmondoError(
        "Login succeeded but returned no token or userid.",
        parse.str(mobile.code),
        "/5/login/with_mail",
      );
    }

    const session: Session = { token, userid };
    this.session = session;
    await this.store.set(session);
    return session;
  }

  /**
   * One authenticated call. On a token error it re-logs in and retries exactly
   * once, which covers the common case of a token expiring mid-run.
   */
  private async call(
    endpoint: string,
    query: Record<string, unknown>,
  ): Promise<unknown> {
    const session = await this.authenticate();
    try {
      return await postEnvelope(
        endpoint,
        { token: session.token, userid: session.userid },
        query,
        this.postOptions,
      );
    } catch (err) {
      if (!(err instanceof FutmondoError) || !err.isAuthError) throw err;
      await this.store.clear();
      this.session = null;
      const fresh = await this.authenticate(true);
      return postEnvelope(
        endpoint,
        { token: fresh.token, userid: fresh.userid },
        query,
        this.postOptions,
      );
    }
  }

  // --------------------------------------------------------------- scope ----

  /** `/2/user/activechampionships` — the only correct way to find your league. */
  async getActiveChampionships(): Promise<ActiveChampionship[]> {
    if (this.championships) return this.championships;
    const answer = await this.call("/2/user/activechampionships", {
      excludeGeneral: true,
    });
    this.championships = parse.parseActiveChampionships(answer);
    return this.championships;
  }

  /**
   * Resolves which championship and team to act on. Explicit env vars win;
   * otherwise a single active championship is selected automatically.
   */
  async resolveScope(): Promise<Scope> {
    const envChampionship = process.env.FUTMONDO_CHAMPIONSHIP_ID;
    const envTeam = process.env.FUTMONDO_USER_TEAM_ID;
    if (envChampionship && envTeam) {
      return { championshipId: envChampionship, userteamId: envTeam };
    }

    const active = await this.getActiveChampionships();
    if (active.length === 0) {
      throw new FutmondoError(
        "No active championships on this account. Set FUTMONDO_CHAMPIONSHIP_ID and FUTMONDO_USER_TEAM_ID.",
      );
    }

    const chosen = envChampionship
      ? active.find((c) => c.id === envChampionship)
      : active.length === 1
        ? active[0]
        : undefined;

    if (!chosen) {
      const names = active.map((c) => `${c.name} (${c.id})`).join(", ");
      throw new FutmondoError(
        `Several active championships — set FUTMONDO_CHAMPIONSHIP_ID to one of: ${names}`,
      );
    }
    return {
      championshipId: chosen.id,
      userteamId: envTeam ?? chosen.userteamId,
    };
  }

  // ------------------------------------------------------ squad and money ---

  async getChampionshipConfiguration(
    championshipId: string,
  ): Promise<ChampionshipConfiguration> {
    const answer = await this.call("/1/championship/configuration", {
      championshipId,
    });
    return parse.parseChampionshipConfiguration(answer);
  }

  /** Funds, team value and reserved cash. Replaces any hardcoded budget. */
  async getUserTeamInformation(scope: Scope): Promise<UserTeamInformation> {
    const answer = await this.call("/1/userteam/information", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      type: "market",
    });
    return parse.parseUserTeamInformation(answer);
  }

  /** Any team's squad. Pass a rival's `userteamId` to see theirs. */
  async getRoster(
    championshipId: string,
    userteamId: string,
  ): Promise<RosterPlayer[]> {
    const answer = await this.call("/1/userteam/roster", {
      championshipId,
      userteamId,
    });
    return parse.parseRoster(answer);
  }

  async getRounds(scope: Scope): Promise<Round[]> {
    const answer = await this.call("/1/userteam/rounds", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
    });
    return parse.parseRounds(answer);
  }

  /**
   * Per-player detail for one round and one team, including minutes played and
   * goals. The richest data the API exposes, and it works for rivals too.
   */
  async getRoundLineup(
    championshipId: string,
    userteamId: string,
    roundId: string,
  ): Promise<RoundLineup> {
    const answer = await this.call("/1/userteam/roundlineup", {
      championshipId,
      round: roundId,
      userteamId,
    });
    return parse.parseRoundLineup(roundId, userteamId, answer);
  }

  async getCurrentLineup(scope: Scope): Promise<CurrentLineup> {
    const answer = await this.call("/1/userteam/lineup", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
    });
    return parse.parseCurrentLineup(answer);
  }

  /** Formations this championship permits. */
  async getAvailableStrategies(championshipId: string): Promise<string[]> {
    const answer = await this.call("/5/strategy/availables", { championshipId });
    return parse.parseStrategies(answer);
  }

  // -------------------------------------------------------------- market ----

  async getMarket(scope: Scope): Promise<MarketPlayer[]> {
    const answer = await this.call("/1/market/players", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      type: "market",
    });
    return parse.parseMarket(answer);
  }

  /**
   * Our own listings, **with the standing bids on them**. The daily market call
   * does not show these, so without it the engine cannot tell that a player it
   * is recommending we sell is already listed, nor that a bid on one of them
   * expires inside the lineup window.
   */
  async getMyListings(scope: Scope): Promise<MarketPlayer[]> {
    const answer = await this.call("/1/market/myplayers", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      type: "market",
    });
    return parse.parseMarket(answer);
  }

  /**
   * The auction state for one listing. `increment` is the minimum bid step, so
   * this is what turns "bid the asking price" into a considered offer.
   *
   * Rejects a slug, and errors `market.playerAuctionSummary.needTeamId` without
   * the team, so both ids are mandatory.
   */
  async getAuctionSummary(
    scope: Scope,
    playerId: string,
  ): Promise<AuctionSummary | null> {
    const answer = await this.call("/1/market/playerauctionsummary", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: playerId,
    });
    return parse.parseAuctionSummary(playerId, answer);
  }


  /**
   * The only source of a player's clause price. One call per player, so callers
   * should batch deliberately — the transport throttle applies.
   */
  async getPlayerSummary(
    scope: Scope,
    playerId: string,
  ): Promise<PlayerSummary | null> {
    const answer = await this.call("/1/player/summary", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      playerId,
    });
    return parse.parsePlayerSummary(playerId, answer);
  }

  // -------------------------------------------------------------- rivals ----

  async getChampionshipTeams(championshipId: string): Promise<ChampionshipTeam[]> {
    const answer = await this.call("/2/championship/teams", { championshipId });
    return parse.parseChampionshipTeams(answer);
  }

  async getGeneralRanking(championshipId: string): Promise<RankedTeam[]> {
    const answer = await this.call("/1/ranking/general", { championshipId });
    return parse.parseRanking(answer);
  }

  /** `roundNumber` takes the round's id, not its matchday number. */
  async getRoundRanking(scope: Scope, roundId: string): Promise<RankedTeam[]> {
    const answer = await this.call("/1/ranking/round", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      roundNumber: roundId,
    });
    return parse.parseRanking(answer);
  }

  // -------------------------------------------------------------- ledger ----

  /**
   * Walks the pressroom cursor. Pagination is non-deterministic — repeated
   * calls return different subsets — so a backfill runs several passes and
   * unions them by id. Rows this returns should be treated as append-only.
   */
  async getTransfers(
    championshipId: string,
    options: { passes?: number; maxPages?: number; delayMs?: number } = {},
  ): Promise<Transfer[]> {
    const passes = options.passes ?? 1;
    const maxPages = options.maxPages ?? 40;
    const delayMs = options.delayMs ?? 2000;
    const byId = new Map<string, Transfer>();

    for (let pass = 0; pass < passes; pass += 1) {
      if (pass > 0) await sleep(delayMs);
      let cursor = "";
      const seenCursors = new Set<string>();

      for (let page = 0; page < maxPages; page += 1) {
        if (seenCursors.has(cursor)) break;
        seenCursors.add(cursor);

        const answer = await this.call("/1/locker/pressroom", {
          championshipId,
          from: cursor,
        });
        const batch = parse.parseTransfers(answer);
        if (batch.length === 0) break;

        let fresh = 0;
        for (const tx of batch) {
          if (!byId.has(tx.id)) fresh += 1;
          byId.set(tx.id, tx);
        }
        const next = batch[batch.length - 1].id;
        // No new rows and no cursor movement means the feed is exhausted.
        if (fresh === 0 && next === cursor) break;
        cursor = next;
      }
    }

    return [...byId.values()].sort((a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
  }

  /** Prize payouts, from the news feed. Needed to derive rivals' cash. */
  async getMoneyEvents(
    championshipId: string,
    options: { maxPages?: number } = {},
  ): Promise<MoneyEvent[]> {
    const maxPages = options.maxPages ?? 40;
    const byId = new Map<string, MoneyEvent>();
    let cursor = "";
    const seenCursors = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);

      const answer = await this.call("/2/locker/news", {
        championshipId,
        from: cursor,
      });
      const rows = parse.asArray(answer, "news");
      if (rows.length === 0) break;

      for (const event of parse.parseMoneyEvents(answer)) byId.set(event.id, event);

      // The cursor advances over all news, not just the customize rows we keep.
      const lastId = parse.str(rows[rows.length - 1]._id ?? rows[rows.length - 1].id);
      if (!lastId || lastId === cursor) break;
      cursor = lastId;
    }

    return [...byId.values()];
  }

  // ------------------------------------------- real football, no 3rd party --

  /** Injuries and suspensions for one real club. */
  async getUnavailablePlayers(teamId: string): Promise<UnavailablePlayer[]> {
    const answer = await this.call("/2/team/unavailableplayers", { teamId });
    return parse.parseUnavailablePlayers(answer);
  }

  /** Every round of the real competition, with kickoff times. */
  async getLeagueMatches(
    leagueId: string = LA_LIGA_LEAGUE_ID,
  ): Promise<RoundWithMatches[]> {
    const answer = await this.call("/2/league/matches", { leagueId });
    return parse.parseRoundsWithMatches(answer);
  }

  async getMatchesByDate(from: string, to: string): Promise<Match[]> {
    const answer = await this.call("/2/match/bydate", { from, to });
    return parse.parseMatches(answer);
  }

  /** Bookmaker odds — our fixture-difficulty signal. */
  async getMatchOdds(matchId: string): Promise<MatchOdds | null> {
    const answer = await this.call("/5/match/odds", { matchId });
    return parse.parseOdds(matchId, answer);
  }

  // --------------------------------------------------------------- writes ---

  /**
   * Commits whatever lineup changes are staged. Futmondo's own flow is
   * multichanges followed by clicktosave; the save is what actually persists.
   */
  async saveLineup(scope: Scope): Promise<unknown> {
    return this.call("/2/userteam/clicktosave", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
    });
  }

  /**
   * Stages a whole lineup in one call. `changes` mirrors the app's payload:
   * one entry per slot assignment.
   */
  async applyLineupChanges(
    scope: Scope,
    payload: {
      modified: unknown;
      current: unknown;
      changes: unknown[];
    },
  ): Promise<unknown> {
    return this.call("/5/userteam/multichanges", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      modified: payload.modified,
      current: payload.current,
      changes: payload.changes,
    });
  }

  /** Moves one player between slots or on and off the bench. */
  async movePlayer(
    scope: Scope,
    from: { position: number; bench: boolean },
    to: { position: number; bench: boolean },
  ): Promise<unknown> {
    return this.call("/2/userteam/moveplayer", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      from,
      to,
    });
  }

  /** Clause-blocks one of your own players. Free defence against steals. */
  async lockPlayer(championshipId: string, playerId: string): Promise<unknown> {
    return this.call("/1/userteam/lockplayer", { championshipId, playerId });
  }

  async unlockPlayer(championshipId: string, playerId: string): Promise<unknown> {
    return this.call("/5/userteam/unlockplayer", { championshipId, playerId });
  }

  /** Places a market bid. `isClause` distinguishes a clause payment. */
  async placeBid(
    scope: Scope,
    args: {
      playerId: string;
      playerSlug: string;
      price: number;
      isClause?: boolean;
    },
  ): Promise<unknown> {
    return this.call("/1/market/bid", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: args.playerId,
      player_slug: args.playerSlug,
      price: Math.round(args.price),
      isClause: args.isClause ?? false,
    });
  }

  /** Modifying a bid takes the bid id and no slug. */
  async modifyBid(
    scope: Scope,
    args: { playerId: string; price: number; bidId: string },
  ): Promise<unknown> {
    return this.call("/5/market/modifybid", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: args.playerId,
      price: Math.round(args.price),
      bid: args.bidId,
      rounds: [],
    });
  }

  /** Pays a rival's clause and takes the player. Irreversible. */
  async payClause(
    scope: Scope,
    args: { playerId: string; playerSlug: string; price: number },
  ): Promise<unknown> {
    return this.call("/1/market/rosterclause", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: args.playerId,
      player_slug: args.playerSlug,
      price: Math.round(args.price),
    });
  }

  async putOnMarket(
    scope: Scope,
    args: { playerId: string; price: number },
  ): Promise<unknown> {
    return this.call("/1/market/putonmarket", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: args.playerId,
      price: Math.round(args.price),
      isClause: false,
      toLoan: false,
    });
  }

  async cancelSale(scope: Scope, playerId: string): Promise<unknown> {
    return this.call("/1/market/cancelsell", {
      championshipId: scope.championshipId,
      userteamId: scope.userteamId,
      player_id: playerId,
    });
  }
}
