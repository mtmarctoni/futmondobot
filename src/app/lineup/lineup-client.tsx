"use client";

import type { AnalysisReport } from "@/lib/engine";

import {
  Card,
  Empty,
  ErrorBox,
  Loading,
  PlayerRow,
  Pts,
  RefreshButton,
  Warnings,
  useAnalysis,
} from "../ui";

export function LineupClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const { lineup, lineupChanges, currentFormation, availableFormations } = data;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">
            {lineup.formation.label}
            <span className="ml-2 text-base font-normal text-zinc-400">
              <Pts value={lineup.expectedPoints} /> expected points
            </span>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">{lineup.summary}</p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {currentFormation && currentFormation !== lineup.formation.label && (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">
          Futmondo currently has {currentFormation}. Automation optimises within
          whatever formation is set and never changes shape, so switch to{" "}
          {lineup.formation.label} by hand to capture the difference.
        </p>
      )}

      <Card
        title="Changes to make"
        subtitle={
          lineupChanges.length === 0
            ? "The XI already matches the best selection."
            : "Each swap, and what it gains."
        }
      >
        {lineupChanges.length === 0 ? (
          <Empty>Nothing to change.</Empty>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {lineupChanges.map((change) => (
              <li
                key={`${change.playerOut.playerId}-${change.playerIn.playerId}`}
                className="flex items-center justify-between gap-3 border-b border-zinc-800/60 py-1.5 last:border-0"
              >
                <span className="min-w-0">
                  <span className="text-emerald-300">{change.playerIn.name}</span>
                  <span className="text-zinc-500"> in for </span>
                  <span className="text-rose-300">{change.playerOut.name}</span>
                  <span className="block text-xs text-zinc-500">
                    {change.reason}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-zinc-300">
                  +{change.gain.toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Starting XI">
        {lineup.starters.length === 0 ? (
          <Empty>No squad data. Run the daily sync.</Empty>
        ) : (
          <ul>
            {lineup.starters.map((player) => (
              <PlayerRow key={player.playerId} player={player} />
            ))}
          </ul>
        )}
      </Card>

      {lineup.bench.length > 0 && (
        <Card title="Bench" subtitle="Best players not in the XI.">
          <ul>
            {lineup.bench.map((player) => (
              <PlayerRow key={player.playerId} player={player} />
            ))}
          </ul>
        </Card>
      )}

      {lineup.excluded.length > 0 && (
        <Card
          title="Unavailable"
          subtitle="Left out because they cannot play."
        >
          <ul>
            {lineup.excluded.map((player) => (
              <PlayerRow key={player.playerId} player={player} />
            ))}
          </ul>
        </Card>
      )}

      {availableFormations.length > 0 && (
        <p className="text-xs text-zinc-500">
          Formations this league allows:{" "}
          {availableFormations.map((f) => f.label).join(", ")}. Every one is
          evaluated and the best total wins.
        </p>
      )}

      <Warnings warnings={data.warnings} />
    </div>
  );
}
