"use client";

import { useAnalysis, Money, ScorePill } from "../use-analysis";

const roleLabels: Record<string, string> = {
  POR: "GK",
  DEF: "DEF",
  MED: "MED",
  DEL: "DEL",
};

export function MarketClient() {
  const { data, loading, error } = useAnalysis();

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">Market</h1>

      {loading && !data && <p className="text-zinc-400">Loading…</p>}
      {error && <p className="text-red-300">{error}</p>}
      {!data && !loading && !error && <p className="text-zinc-400">No data.</p>}

      {data && (
        <>
          <p className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3 text-sm text-zinc-200">
            {data.marketReport.recommendedAction}
          </p>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-emerald-300">🏆 Buy picks</h2>
            <div className="space-y-2">
              {data.marketReport.buys.map((b) => (
                <div
                  key={b.player.id}
                  className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-2.5"
                >
                  <div>
                    <span className="font-medium">{b.player.name}</span>
                    <span className="ml-2 text-xs text-zinc-500">
                      {roleLabels[b.player.role]} · {b.player.team}
                    </span>
                    <p className="mt-0.5 text-xs text-zinc-400">{b.reason}</p>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Money value={b.player.value} />
                    <ScorePill score={b.player.score} />
                  </div>
                </div>
              ))}
              {data.marketReport.buys.length === 0 && (
                <p className="text-zinc-500">No buy candidates detected.</p>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold text-red-300">📉 Sell picks</h2>
            <div className="space-y-2">
              {data.marketReport.sells.map((s) => (
                <div
                  key={s.player.id}
                  className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-2.5"
                >
                  <div>
                    <span className="font-medium">{s.player.name}</span>
                    <span className="ml-2 text-xs text-zinc-500">
                      {roleLabels[s.player.role]} · {s.player.team}
                    </span>
                    <p className="mt-0.5 text-xs text-zinc-400">{s.reason}</p>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Money value={s.player.value} />
                    <ScorePill score={s.player.score} />
                  </div>
                </div>
              ))}
              {data.marketReport.sells.length === 0 && (
                <p className="text-zinc-500">No sell candidates detected.</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
