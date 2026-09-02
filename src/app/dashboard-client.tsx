"use client";

import { useAnalysis, Money } from "./use-analysis";

const priorityStyles: Record<string, string> = {
  high: "border-red-500/40 bg-red-500/10",
  medium: "border-amber-500/40 bg-amber-500/10",
  low: "border-zinc-700 bg-zinc-800/40",
  info: "border-zinc-700 bg-zinc-800/40",
};

const kindLabels: Record<string, string> = {
  set_lineup: "Set lineup",
  buy: "Buy",
  sell: "Sell",
  steal: "Steal",
  info: "Info",
};

export function DashboardClient() {
  const { data, loading, error, refresh } = useAnalysis();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Today&apos;s actions</h1>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading && !data && (
        <p className="text-zinc-400">Fetching your league data from Futmondo…</p>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          <p className="font-semibold">Could not load data</p>
          <p className="mt-1">{error}</p>
          <p className="mt-1 text-red-300/70">
            Make sure Futmondo credentials and a valid championship are configured.
          </p>
        </div>
      )}

      {data && (
        <>
          {data.deadline && (
            <div className="rounded-md border border-zinc-700 bg-zinc-800/60 p-3 text-sm">
              <span className="font-medium text-zinc-300">⏰ Deadline:</span>{" "}
              {new Date(data.deadline).toLocaleString()}
            </div>
          )}

          {data.warning && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              ⚠️ {data.warning}
            </div>
          )}

          <div className="space-y-3">
            {data.today.actions.map((a) => (
              <div
                key={a.id}
                className={`rounded-lg border p-4 ${priorityStyles[a.priority] ?? priorityStyles.info}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-semibold">{a.title}</h2>
                  <span className="shrink-0 rounded-md bg-black/30 px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-300">
                    {kindLabels[a.kind] ?? a.kind}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-300">{a.detail}</p>
              </div>
            ))}
            {data.today.actions.length === 0 && (
              <p className="text-zinc-400">No recommended actions right now.</p>
            )}
          </div>
        </>
      )}

      {data && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="mb-3 text-lg font-semibold">Suggested lineup</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.lineup.players.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-md bg-zinc-800/60 px-3 py-2"
              >
                <div>
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-zinc-400">
                    {p.role} · {p.team}
                  </span>
                </div>
                <span className="text-xs text-zinc-400">
                  <Money value={p.value} />
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-500">{data.lineup.lineupMessage}</p>
        </div>
      )}
    </div>
  );
}
