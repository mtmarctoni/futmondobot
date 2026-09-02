import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FutmondoClient, MemoryTokenStore, type Scope } from "./client";
import { FutmondoError } from "./errors";
import { resetTransportQueue } from "./transport";

interface Call {
  endpoint: string;
  header: Record<string, unknown>;
  query: Record<string, unknown>;
}

/**
 * A fetch double that records envelopes and replies from a per-endpoint script.
 * Handlers receive the call so they can vary by attempt.
 */
function fakeFetch(
  handlers: Record<string, (call: Call, attempt: number) => unknown>,
) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const endpoint = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const call: Call = {
      endpoint,
      header: body.header ?? {},
      query: body.query ?? {},
    };
    calls.push(call);

    const attempt = (attempts.get(endpoint) ?? 0) + 1;
    attempts.set(endpoint, attempt);

    const handler = handlers[endpoint];
    if (!handler) {
      return new Response(
        JSON.stringify({ answer: { error: true, code: "test.unhandled" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ answer: handler(call, attempt) }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const OK_LOGIN = {
  code: "api.general.ok",
  mobile: { code: "login.mobile.ok", token: "tok-1", userid: "user-1" },
};

function makeClient(handlers: Record<string, (call: Call, attempt: number) => unknown>) {
  const { impl, calls } = fakeFetch(handlers);
  const client = new FutmondoClient({
    email: "a@b.c",
    password: "pw",
    tokenStore: new MemoryTokenStore(),
    post: { fetchImpl: impl },
  });
  return { client, calls };
}

const scope: Scope = { championshipId: "c1", userteamId: "t1" };

beforeEach(() => {
  resetTransportQueue();
  delete process.env.FUTMONDO_CHAMPIONSHIP_ID;
  delete process.env.FUTMONDO_USER_TEAM_ID;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("error handling", () => {
  it("throws on answer.error even though the status is 200", async () => {
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/userteam/roster": () => ({ error: true, code: "api.error.whatever" }),
    });

    await expect(client.getRoster("c1", "t1")).rejects.toThrowError(FutmondoError);
    await expect(client.getRoster("c1", "t1")).rejects.toMatchObject({
      code: "api.error.whatever",
    });
  });

  it("reports bad credentials distinctly so callers do not retry forever", async () => {
    const { client } = makeClient({
      "/5/login/with_mail": () => ({ error: true, code: "api.error.not_found" }),
    });

    await expect(client.authenticate()).rejects.toMatchObject({
      code: "api.error.not_found",
      isCredentialError: true,
    });
  });

  it("requires credentials to be configured", async () => {
    const { impl } = fakeFetch({});
    const client = new FutmondoClient({
      email: undefined,
      password: undefined,
      tokenStore: new MemoryTokenStore(),
      post: { fetchImpl: impl },
    });
    vi.stubEnv("FUTMONDO_EMAIL", "");
    vi.stubEnv("FUTMONDO_PASSWORD", "");

    await expect(client.authenticate()).rejects.toThrowError(/must be set/);
  });
});

describe("session handling", () => {
  it("logs in once and reuses the token across calls", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/userteam/roster": () => [],
      "/1/market/players": () => [],
    });

    await client.getRoster("c1", "t1");
    await client.getMarket(scope);
    await client.getMarket(scope);

    expect(calls.filter((c) => c.endpoint === "/5/login/with_mail")).toHaveLength(1);
    expect(calls.at(-1)?.header).toMatchObject({ token: "tok-1", userid: "user-1" });
  });

  it("collapses concurrent callers onto a single login", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/userteam/roster": () => [],
    });

    await Promise.all([
      client.getRoster("c1", "t1"),
      client.getRoster("c1", "t1"),
      client.getRoster("c1", "t1"),
    ]);

    expect(calls.filter((c) => c.endpoint === "/5/login/with_mail")).toHaveLength(1);
  });

  it("re-logs in and retries once when the token is rejected", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": (_call, attempt) => ({
        code: "api.general.ok",
        mobile: { token: `tok-${attempt}`, userid: "user-1" },
      }),
      "/1/userteam/roster": (_call, attempt) =>
        attempt === 1
          ? { error: true, code: "futmondo.access.denied" }
          : [{ id: "p1", name: "A", role: "DEF", value: 1, points: 2 }],
    });

    const roster = await client.getRoster("c1", "t1");

    expect(roster).toHaveLength(1);
    expect(calls.filter((c) => c.endpoint === "/5/login/with_mail")).toHaveLength(2);
    // The retry must carry the refreshed token, not the rejected one.
    expect(calls.at(-1)?.header).toMatchObject({ token: "tok-2" });
  });

  it("does not retry a non-auth error", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/userteam/roster": () => ({ error: true, code: "api.error.other" }),
    });

    await expect(client.getRoster("c1", "t1")).rejects.toThrow();
    expect(calls.filter((c) => c.endpoint === "/1/userteam/roster")).toHaveLength(1);
  });

  it("shares a token store between clients so a warm lambda logs in once", async () => {
    const store = new MemoryTokenStore();
    const { impl, calls } = fakeFetch({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/userteam/roster": () => [],
    });
    const opts = {
      email: "a@b.c",
      password: "pw",
      tokenStore: store,
      post: { fetchImpl: impl },
    };

    await new FutmondoClient(opts).getRoster("c1", "t1");
    await new FutmondoClient(opts).getRoster("c1", "t1");

    expect(calls.filter((c) => c.endpoint === "/5/login/with_mail")).toHaveLength(1);
  });
});

describe("resolveScope", () => {
  it("prefers explicit environment ids without calling the API", async () => {
    vi.stubEnv("FUTMONDO_CHAMPIONSHIP_ID", "env-c");
    vi.stubEnv("FUTMONDO_USER_TEAM_ID", "env-t");
    const { client, calls } = makeClient({ "/5/login/with_mail": () => OK_LOGIN });

    expect(await client.resolveScope()).toEqual({
      championshipId: "env-c",
      userteamId: "env-t",
    });
    expect(calls).toHaveLength(0);
  });

  it("auto-selects when the account has exactly one championship", async () => {
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/2/user/activechampionships": () => ({
        championships: [
          { _id: "c9", name: "Mata D Yonk", userteam: { _id: "t9" } },
        ],
      }),
    });

    expect(await client.resolveScope()).toEqual({
      championshipId: "c9",
      userteamId: "t9",
    });
  });

  it("names the options when the choice is ambiguous", async () => {
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/2/user/activechampionships": () => ({
        championships: [
          { _id: "c1", name: "One", userteam: { _id: "t1" } },
          { _id: "c2", name: "Two", userteam: { _id: "t2" } },
        ],
      }),
    });

    await expect(client.resolveScope()).rejects.toThrowError(
      /One \(c1\).*Two \(c2\)/,
    );
  });

  it("explains what to set when the account has none", async () => {
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/2/user/activechampionships": () => ({ championships: [] }),
    });

    await expect(client.resolveScope()).rejects.toThrowError(
      /No active championships/,
    );
  });
});

describe("query shapes", () => {
  it("sends type:market on the market call, which the endpoint requires", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/market/players": () => [],
    });

    await client.getMarket(scope);

    expect(calls.at(-1)?.query).toEqual({
      championshipId: "c1",
      userteamId: "t1",
      type: "market",
    });
  });

  it("passes the round id as roundNumber, which is what the endpoint wants", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/ranking/round": () => ({ ranking: [] }),
    });

    await client.getRoundRanking(scope, "round-object-id");

    expect(calls.at(-1)?.query).toMatchObject({ roundNumber: "round-object-id" });
  });

  it("uses snake_case player keys on market writes", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/market/bid": () => ({ code: "api.general.ok" }),
    });

    await client.placeBid(scope, {
      playerId: "p1",
      playerSlug: "19302146",
      price: 1234.6,
      isClause: true,
    });

    expect(calls.at(-1)?.query).toEqual({
      championshipId: "c1",
      userteamId: "t1",
      player_id: "p1",
      player_slug: "19302146",
      price: 1235,
      isClause: true,
    });
  });

  it("defaults the league id to La Liga", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/2/league/matches": () => ({ rounds: [] }),
    });

    await client.getLeagueMatches();

    expect(calls.at(-1)?.query).toEqual({
      leagueId: "504e4f584d8bec9a67000079",
    });
  });
});

describe("getTransfers pagination", () => {
  it("walks the cursor and stops when the feed repeats", async () => {
    const pages: Record<string, unknown[]> = {
      "": [{ _id: "a", price: 1, created: "2026-01-01" }],
      a: [{ _id: "b", price: 2, created: "2026-01-02" }],
      b: [],
    };
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/locker/pressroom": (call) => ({
        news: pages[String(call.query.from ?? "")] ?? [],
      }),
    });

    const transfers = await client.getTransfers("c1");

    expect(transfers.map((t) => t.id)).toEqual(["a", "b"]);
    expect(calls.filter((c) => c.endpoint === "/1/locker/pressroom")).toHaveLength(3);
  });

  it("unions several passes, since pagination returns different subsets", async () => {
    let pass = 0;
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/1/locker/pressroom": (call) => {
        if (call.query.from) return { news: [] };
        pass += 1;
        // A different subset each pass, exactly the behaviour observed live.
        return {
          news:
            pass === 1
              ? [{ _id: "a", price: 1, created: "2026-01-01" }]
              : [{ _id: "c", price: 3, created: "2026-01-03" }],
        };
      },
    });

    const transfers = await client.getTransfers("c1", { passes: 2, delayMs: 0 });

    expect(transfers.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("respects maxPages so a non-terminating cursor cannot loop forever", async () => {
    const { client, calls } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      // Always a fresh id, so the feed never signals exhaustion.
      "/1/locker/pressroom": (_call, attempt) => ({
        news: [{ _id: `id-${attempt}`, price: 1 }],
      }),
    });

    await client.getTransfers("c1", { maxPages: 5 });

    expect(calls.filter((c) => c.endpoint === "/1/locker/pressroom")).toHaveLength(5);
  });
});

describe("getMoneyEvents", () => {
  it("advances the cursor over all news, not just the rows it keeps", async () => {
    const pages: Record<string, unknown[]> = {
      "": [
        { _id: "n1", styp: "transfer", data: {} },
        { _id: "n2", styp: "customize", data: { name: "A", amount: 500000 } },
      ],
      n2: [],
    };
    const { client } = makeClient({
      "/5/login/with_mail": () => OK_LOGIN,
      "/2/locker/news": (call) => ({
        news: pages[String(call.query.from ?? "")] ?? [],
      }),
    });

    const events = await client.getMoneyEvents("c1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ teamName: "A", amount: 500000 });
  });
});
