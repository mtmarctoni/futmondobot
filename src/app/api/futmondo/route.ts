import { NextRequest, NextResponse } from "next/server";
import { authFailureReason, isAuthorizedRequest } from "@/lib/auth";
import { dbTokenStore } from "@/lib/db/token-store";
import { FutmondoClient } from "@/lib/futmondo/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Setup and diagnosis: proves the credentials work and prints the ids to put
 * in the environment. Raw Futmondo payloads can contain account details, so
 * this is behind the same secret as the cron routes.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedRequest(req)) {
    return NextResponse.json(
      { ok: false, error: authFailureReason() },
      { status: 401 },
    );
  }

  const client = new FutmondoClient({ tokenStore: dbTokenStore });

  try {
    await client.authenticate();
  } catch (err) {
    return NextResponse.json(
      { ok: false, step: "login", error: message(err) },
      { status: 502 },
    );
  }

  const championships = await client.getActiveChampionships();
  const scope = await client.resolveScope().catch(() => null);

  if (!scope) {
    return NextResponse.json({
      ok: true,
      loggedIn: true,
      championships: championships.map((c) => ({
        championshipId: c.id,
        name: c.name,
        userteamId: c.userteamId,
      })),
      next: "Set FUTMONDO_CHAMPIONSHIP_ID and FUTMONDO_USER_TEAM_ID from the list above.",
    });
  }

  const [info, roster, market, strategies, rounds] = await Promise.allSettled([
    client.getUserTeamInformation(scope),
    client.getRoster(scope.championshipId, scope.userteamId),
    client.getMarket(scope),
    client.getAvailableStrategies(scope.championshipId),
    client.getLeagueMatches(),
  ]);

  return NextResponse.json({
    ok: true,
    loggedIn: true,
    scope,
    championships: championships.map((c) => ({
      championshipId: c.id,
      name: c.name,
      userteamId: c.userteamId,
    })),
    checks: {
      funds: settled(info, (v) => ({ funds: v.funds, teamValue: v.teamValue })),
      squad: settled(roster, (v) => ({ players: v.length, sample: v.slice(0, 3).map((p) => p.name) })),
      market: settled(market, (v) => ({ listings: v.length })),
      formations: settled(strategies, (v) => v),
      calendar: settled(rounds, (v) => ({
        rounds: v.length,
        nextDeadline:
          v
            .flatMap((r) => r.matches.map((m) => m.date))
            .filter((d): d is string => Boolean(d))
            .sort()
            .find((d) => new Date(d) > new Date()) ?? null,
      })),
    },
  });
}

function settled<T, R>(
  result: PromiseSettledResult<T>,
  map: (value: T) => R,
): { ok: true; value: R } | { ok: false; error: string } {
  return result.status === "fulfilled"
    ? { ok: true, value: map(result.value) }
    : { ok: false, error: message(result.reason) };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
