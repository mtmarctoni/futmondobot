"use client";

import { useAnalysis, Money } from "../use-analysis";

const roleOrder = ["POR", "DEF", "MED", "DEL"] as const;
const roleLabels: Record<string, string> = {
  POR: "Goalkeepers",
  DEF: "Defenders",
  MED: "Midfielders",
  DEL: "Forwards",
};

export function LineupClient() {
  const { data, loading, error } = useAnalysis();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Suggested lineup</h1>

      {loading && !data && <p className="text-zinc-400">Loading…</p>}
      {error && <p className="text-red-300">{error}</p>}
      {!data && !loading && !error && <p className="text-zinc-400">No data.</p>}

      {data && (
        <>
          <div className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3 text-sm">
            Formation: <span className="font-semibold">{data.lineup.formation.join("-")}</span>
            {" · "}
            {data.lineup.lineupMessage}
          </div>

          {roleOrder.map((role) => {
            const players = data.lineup.players.filter((p) => p.role === role);
            if (players.length === 0) return null;
            return (
              <section key={role}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  {roleLabels[role]}
                </h2>
                <div className="space-y-2">
                  {players.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-2.5"
                    >
                      <div>
                        <span className="font-medium">{p.name}</span>
                        <span className="ml-2 text-xs text-zinc-500">{p.team}</span>
                        {p.injuryRisk >= 0.5 && (
                          <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-300">
                            Injured
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-sm text-zinc-400">
                        <span title="Score">
                          <Money value={p.value} />
                        </span>
                        <span title="Avg points">⭐ {p.average.toFixed(1)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {data.lineup.injuredExcluded.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-400">
                Injured / unavailable
              </h2>
              <div className="space-y-2">
                {data.lineup.injuredExcluded.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2.5"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-zinc-400">{p.team}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
