import { FutmondoClient } from "../futmondo/client";
import type { LeagueInfo, MarketPlayer, RosterPlayer } from "../futmondo/types";
import { getStatsProvider } from "../stats";
import { runClauseAnalysis, type ClauseReport } from "./clauses";
import { runLineup, type LineupResult } from "./lineup";
import { runMarketAnalysis, type MarketReport } from "./market";
import { buildTodayActions, type TodayReport, type Action } from "./today";

export interface AnalysisReport {
  leagues: LeagueInfo[];
  championshipId?: string;
  userTeamId?: string;
  userTeamName?: string;
  roster: RosterPlayer[];
  market: MarketPlayer[];
  fixtureDifficulty: Record<string, { difficulty: number }>;
  lineup: LineupResult;
  marketReport: MarketReport;
  clauseReport: ClauseReport;
  today: TodayReport;
  deadline?: string;
  warning?: string;
  error?: string;
}

export async function runAnalysis(): Promise<AnalysisReport> {
  const client = new FutmondoClient();
  const warning: string[] = [];

  let leagues: LeagueInfo[] = [];
  try {
    await client.login();
    leagues = await client.getLeagueList();
  } catch (err) {
    return {
      leagues: [],
      roster: [],
      market: [],
      fixtureDifficulty: {},
      lineup: runLineup({ roster: [] }),
      marketReport: runMarketAnalysis({ market: [], roster: [], funds: 0, teamValue: 0 }),
      clauseReport: runClauseAnalysis({ players: [] }),
      today: {
        actions: [],
        headline: "Unable to reach Futmondo",
      },
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const championshipId =
    process.env.FUTMONDO_CHAMPIONSHIP_ID ?? leagues[0]?._id;
  if (!championshipId) {
    return {
      leagues,
      roster: [],
      market: [],
      fixtureDifficulty: {},
      lineup: runLineup({ roster: [] }),
      marketReport: runMarketAnalysis({ market: [], roster: [], funds: 0, teamValue: 0 }),
      clauseReport: runClauseAnalysis({ players: [] }),
      today: { actions: [], headline: "No championship found" },
      warning: "Could not determine championship. Set FUTMONDO_CHAMPIONSHIP_ID.",
    };
  }

  let userTeamId = process.env.FUTMONDO_USER_TEAM_ID;
  let userTeamName: string | undefined;

  // Try to resolve user team from league list rounds/team info
  const league = leagues.find((l) => l._id === championshipId);
  if (league) {
    const teamish = (league as Record<string, unknown>).userTeam as
      | Record<string, unknown>
      | undefined;
    if (teamish) {
      userTeamId = userTeamId ?? String(teamish._id ?? teamish.id ?? "");
      userTeamName = String(teamish.name ?? teamish.userTeamName ?? "");
    }
  }

  if (!userTeamId) {
    warning.push(
      "Could not resolve your user team id. Set FUTMONDO_USER_TEAM_ID.",
    );
  }

  let roster: RosterPlayer[] = [];
  let market: MarketPlayer[] = [];
  let playersAll: RosterPlayer[] = [];
  let markets: MarketPlayer[] = [];

  const [rosterRes, marketRes, playersRes] = await Promise.allSettled([
    userTeamId
      ? client.getUserTeamRoster(championshipId, userTeamId)
      : Promise.resolve([] as RosterPlayer[]),
    userTeamId
      ? client.getMarketPlayers(championshipId)
      : Promise.resolve([] as MarketPlayer[]),
    client.getChampionshipPlayers(championshipId),
  ]);

  roster = rosterRes.status === "fulfilled" ? rosterRes.value : [];
  market = marketRes.status === "fulfilled" ? marketRes.value : [];
  playersAll = playersRes.status === "fulfilled" ? playersRes.value : [];
  markets = market;

  if (rosterRes.status === "rejected")
    warning.push(`Roster fetch failed: ${rosterRes.reason}`);
  if (marketRes.status === "rejected")
    warning.push(`Market fetch failed: ${marketRes.reason}`);
  if (playersRes.status === "rejected")
    warning.push(`Players fetch failed: ${playersRes.reason}`);

  // Resolve my team id from market ownership for clause analysis if needed
  const myTeamId =
    userTeamId ??
    (markets.find((m) => m.ownerTeamId)?.ownerTeamId as string | undefined);

  // ---------- Stats: fixture difficulty ----------
  const fixtureDifficulty: Record<string, { difficulty: number }> = {};
  const provider = getStatsProvider();
  if (provider) {
    const leagueId = Number(process.env.LEAGUE_ID ?? 0);
    if (leagueId) {
      const teamIds = Array.from(
        new Set(
          [...roster, ...markets]
            .map((p) => Number(p.teamId ?? 0))
            .filter((id) => id > 0),
        ),
      );
      await Promise.all(
        teamIds.slice(0, 10).map(async (tid) => {
          try {
            const d = await provider.getFixtureDifficulty(leagueId, tid, 3);
            if (d && tid) {
              fixtureDifficulty[String(tid)] = {
                difficulty: d.difficulty,
              };
            }
          } catch {
            /* ignore stats errors */
          }
        }),
      );
    } else {
      warning.push("LEAGUE_ID not set; fixture difficulty skipped.");
    }
  }

  // Map teamId -> team name to let engines key by name too
  const idToName = new Map<string, string>();
  for (const p of [...roster, ...markets]) {
    if (p.teamId && p.team) idToName.set(String(p.teamId), p.team);
  }
  const fixtureByTeam: Record<string, { difficulty: number }> = {};
  for (const [id, v] of Object.entries(fixtureDifficulty)) {
    const name = idToName.get(id);
    if (name) fixtureByTeam[name] = v;
  }
  const effectiveFixture = { ...fixtureDifficulty, ...fixtureByTeam };

  // ---------- Run engines ----------
  const lineup = runLineup({
    roster,
    fixtureDifficulty: effectiveFixture,
  });

  const funds = Number(process.env.FUTMONDO_FUNDS ?? (league as Record<string, unknown>)?.budget ?? 0);
  const teamValue = roster.reduce((s, p) => s + (p.value ?? 0), 0);

  const marketReport = runMarketAnalysis({
    market,
    roster,
    funds,
    teamValue,
    fixtureDifficulty: effectiveFixture,
  });

  const clauseReport = runClauseAnalysis({
    players: playersAll,
    myTeamId,
  });

  const today = buildTodayActions({
    lineup,
    market: marketReport,
    clauses: clauseReport,
    deadline: process.env.FUTMONDO_DEADLINE,
    fixtureDifficulty: effectiveFixture,
  });

  return {
    leagues,
    championshipId,
    userTeamId,
    userTeamName,
    roster,
    market,
    fixtureDifficulty: effectiveFixture,
    lineup,
    marketReport,
    clauseReport,
    today,
    deadline: process.env.FUTMONDO_DEADLINE,
    warning: warning.length ? warning.join(" ") : undefined,
  };
}

export type { Action, TodayReport };
