"use client";

import { useAnalysis, Money, ScorePill } from "../use-analysis";

export function ClausesClient() {
  const { data, loading, error } = useAnalysis();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Clause steal alerts</h1>

      {loading && !data && <p className="text-zinc-400">Loading…</p>}
      {error && <p className="text-red-300">{error}</p>}
      {!data && !loading && !error && <p className="text-zinc-400">No data.</p>}

      {data && (
        <>
          <p className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3 text-sm text-zinc-200">
            {data.clauseReport.recommendedAction}
          </p>

          <div className="space-y-2">
            {data.clauseReport.steals.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-2.5"
              >
                <div>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-zinc-500">
                    {c.role} · {c.team}
                  </span>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    Owner: {c.ownerName} · Avg last 5: {c.avgLastFive.toFixed(1)}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <div className="text-right">
                    <div className="text-zinc-300">
                      Clause <Money value={c.clause} />
                    </div>
                    <div className="text-xs text-zinc-500">
                      Suggested <Money value={c.suggestedClause} />
                    </div>
                  </div>
                  <ScorePill score={c.stealScore} />
                </div>
              </div>
            ))}
            {data.clauseReport.steals.length === 0 && (
              <p className="text-zinc-500">
                No unlocked, undervalued rival clauses right now.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
