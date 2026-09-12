"use client";

import type { AnalysisReport } from "@/lib/engine";

import {
  Card,
  Empty,
  ErrorBox,
  Loading,
  Money,
  RefreshButton,
  Warnings,
  useAnalysis,
} from "../ui";

/**
 * Estimated rival cash.
 *
 * This league hides funds, so these figures are reconstructed from the transfer
 * ledger and prize payouts rather than read. That makes them the app's most
 * valuable output and its least certain one, so the page says so plainly and
 * shows the working: what each team spent, received and won.
 */
export function RivalsClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const rivals = [...data.rivalFunds].sort(
    (a, b) => b.estimatedFunds - a.estimatedFunds,
  );
  const thin = rivals.filter((r) => r.ledgerRows < 5).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Rivals</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Your league hides funds, so these are reconstructed: starting budget,
            minus what each team spent, plus what they received and won. The
            ordering is dependable; the amounts are approximate.
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      <Card
        title="Estimated spending power"
        subtitle={`Assumes a ${(data.rules.budget / 1_000_000).toFixed(0)}M starting budget and ${data.coverage.transfersKnown} known transfers.`}
      >
        {rivals.length === 0 ? (
          <Empty>
            No ledger data yet. Run the ledger sync a few times — pressroom
            pagination returns different rows on different calls, so coverage
            builds up over several runs.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Team</th>
                  <th className="py-2 pr-3 text-right font-medium">Estimated cash</th>
                  <th className="py-2 pr-3 text-right font-medium">Spent</th>
                  <th className="py-2 pr-3 text-right font-medium">Received</th>
                  <th className="py-2 pr-3 text-right font-medium">Prizes</th>
                  <th className="py-2 text-right font-medium">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {rivals.map((rival) => {
                  const isMe = rival.teamId === data.scope?.userteamId;
                  return (
                    <tr key={rival.teamId} className={isMe ? "bg-emerald-950/20" : undefined}>
                      <td className="py-2 pr-3">
                        <span className={isMe ? "font-medium text-emerald-300" : "text-zinc-100"}>
                          {rival.teamName ?? rival.teamId}
                        </span>
                        {isMe && <span className="ml-2 text-xs text-emerald-400/70">you</span>}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-zinc-100">
                        <Money value={rival.estimatedFunds} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-rose-300/80">
                        <Money value={rival.spent} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-emerald-300/80">
                        <Money value={rival.received} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">
                        <Money value={rival.prizes} />
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums text-xs ${
                          rival.ledgerRows < 5 ? "text-amber-400" : "text-zinc-500"
                        }`}
                        title={
                          rival.ledgerRows < 5
                            ? "Few ledger rows, so this estimate is weak"
                            : undefined
                        }
                      >
                        {rival.ledgerRows}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {thin > 0 && (
        <p className="text-xs text-zinc-500">
          {thin} team{thin > 1 ? "s have" : " has"} fewer than five known
          transfers, so their estimate rests on little. Futmondo&apos;s pressroom
          pagination is non-deterministic — repeated ledger syncs keep finding
          rows earlier ones missed.
        </p>
      )}

      <p className="text-xs text-zinc-500">
        Why it matters: a rival who cannot afford your player&apos;s clause is
        not a threat, so this is what decides which of your players are at
        risk.
      </p>

      <Warnings warnings={data.warnings} />
    </div>
  );
}
