"use client";

import type { AnalysisReport } from "@/lib/engine";

import {
  Card,
  Empty,
  ErrorBox,
  Loading,
  Money,
  Pts,
  RefreshButton,
  Role,
  Warnings,
  useAnalysis,
  money,
} from "../ui";

/**
 * Clauses run in both directions, so the page does too: what you can take, and
 * what can be taken from you. In a league with unlimited blocking, the defence
 * half is the part most often left unplayed.
 */
export function ClausesClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const { clauses } = data;
  const affordable = clauses.steals.filter((s) => s.affordable);
  const outOfReach = clauses.steals.filter((s) => !s.affordable);
  const atRisk = clauses.exposed.filter((e) => e.threats.length > 0);
  const safe = clauses.exposed.filter((e) => e.threats.length === 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Clauses</h1>
          <p className="mt-1 text-sm text-zinc-400">{clauses.headline}</p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {clauses.windowNote && (
        <p className="rounded-lg border border-sky-900/50 bg-sky-950/20 px-3 py-2 text-sm text-sky-200">
          {clauses.windowNote} A clause has a date before which nobody can pay
          it, in either direction — so there is nothing to take and nothing to
          defend until then.
        </p>
      )}

      {data.coverage.playersWithClause === 0 && (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">
          No clause prices collected yet. A clause price is only available one
          player at a time, so the sync gathers them in batches — run{" "}
          <code className="text-amber-100">/api/sync?job=clauses</code> a few
          times.
        </p>
      )}

      <Card
        title="Take these"
        subtitle="Rivals' players you can buy outright for their clause, with no bidding."
      >
        {affordable.length === 0 ? (
          <Empty>
            {clauses.steals.length === 0
              ? "No unlocked rival player would improve your XI."
              : "Every worthwhile target costs more than you have."}
          </Empty>
        ) : (
          <ul>
            {affordable.map((steal) => (
              <li
                key={steal.player.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <Role role={steal.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-100">
                    {steal.player.name}
                    {steal.ownerName && (
                      <span className="ml-2 text-xs font-normal text-zinc-500">
                        at {steal.ownerName}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500">{steal.reason}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="text-zinc-100">
                    <Money value={steal.clausePrice} />
                  </div>
                  <div className="text-xs text-emerald-300">
                    +<Pts value={steal.upgrade} /> pts
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {clauses.pendingSteals.length > 0 && (
        <Card
          title="Opens later"
          subtitle="Worth taking, but the clause is not payable yet. Planning information, not something to do today."
        >
          <ul className="space-y-1 text-sm">
            {clauses.pendingSteals.slice(0, 6).map((steal) => (
              <li key={steal.player.playerId} className="text-zinc-400">
                <span className="text-zinc-200">{steal.player.name}</span>{" "}
                <Money value={steal.clausePrice} /> — +
                {steal.upgrade.toFixed(1)} pts, from{" "}
                {new Date(steal.availableFrom as string)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 16)}
                Z
              </li>
            ))}
          </ul>
        </Card>
      )}

      {outOfReach.length > 0 && (
        <Card title="Out of reach" subtitle="Good targets you cannot pay for yet.">
          <ul className="space-y-1 text-sm">
            {outOfReach.slice(0, 6).map((steal) => (
              <li key={steal.player.playerId} className="text-zinc-400">
                <span className="text-zinc-200">{steal.player.name}</span>{" "}
                <Money value={steal.clausePrice} /> — +
                {steal.upgrade.toFixed(1)} pts
                {steal.ownerName ? `, at ${steal.ownerName}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Yours at risk"
        subtitle="Blocking costs nothing and this league allows unlimited blocks."
      >
        {atRisk.length === 0 ? (
          <Empty>
            {clauses.exposed.length === 0
              ? "No clause prices known for your own squad yet."
              : "No rival is estimated to afford any of your players."}
          </Empty>
        ) : (
          <ul>
            {atRisk.map((risk) => (
              <li
                key={risk.player.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <Role role={risk.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium text-zinc-100">
                    {risk.player.name}
                    {risk.alreadyLocked ? (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                        blocked
                      </span>
                    ) : (
                      <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-300">
                        open
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {risk.reason}
                    {risk.threats.length > 0 && (
                      <>
                        {" "}
                        Highest: {risk.threats[0].teamName ?? "a rival"} at ~
                        {money(risk.threats[0].funds)}.
                      </>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="text-zinc-100">
                    <Money value={risk.clausePrice} />
                  </div>
                  <div className="text-xs text-zinc-500">
                    {risk.efficiency.toFixed(2)} pts/M
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {safe.length > 0 && (
        <p className="text-xs text-zinc-500">
          {safe.length} of your players have a clause no rival is estimated to
          afford. Rival cash is reconstructed from the transfer ledger because
          this league hides funds, so treat the ordering as reliable and the
          amounts as approximate.
        </p>
      )}

      <Warnings warnings={data.warnings} />
    </div>
  );
}
