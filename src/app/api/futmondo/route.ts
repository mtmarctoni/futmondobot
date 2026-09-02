import { NextResponse } from "next/server";
import { FutmondoClient } from "@/lib/futmondo/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const client = new FutmondoClient();
    await client.login();

    const leagueId = process.env.FUTMONDO_CHAMPIONSHIP_ID;
    if (!leagueId) {
      return NextResponse.json({
        leagues: await client.getLeagueList(),
      });
    }

    const [leagues, players, market, teams] = await Promise.all([
      client.getLeagueList(),
      client.getChampionshipPlayers(leagueId),
      client.getMarketPlayers(leagueId),
      client.getChampionshipTeams(leagueId),
    ]);

    return NextResponse.json({ leagues, players, market, teams });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
