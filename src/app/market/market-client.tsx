"use client";

import type { AnalysisReport } from "@/lib/engine";

import {
  Card,
  Delta,
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

export function MarketClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const { market } = data;
  const affordable = market.buys.filter((b) => b.affordable);
  const outOfReach = market.buys.filter((b) => !b.affordable);
  const freeSells = market.sells.filter((s) => s.cost === 0);
  const costlySells = market.sells.filter((s) => s.cost > 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Market</h1>
          <p className="mt-1 text-sm text-zinc-400">{market.headline}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {money(market.funds)} available · ceiling {money(market.maxOffer)}{" "}
            (funds plus half the squad value)
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      <Card
        title="Worth buying"
        subtitle="Only players who would improve the XI, judged against the starter they would replace."
      >
        {affordable.length === 0 ? (
          <Empty>
            {market.buys.length === 0
              ? "Nothing in today's market improves the XI."
              : "Every worthwhile target is out of reach right now."}
          </Empty>
        ) : (
          <ul>
            {affordable.map((buy) => (
              <li
                key={buy.player.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <Role role={buy.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-100">
                    {buy.player.name}
                  </p>
                  <p className="text-xs text-zinc-500">{buy.reason}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="text-zinc-100">
                    <Money value={buy.price} />
                  </div>
                  <div className="text-xs text-emerald-300">
                    +<Pts value={buy.upgrade} /> pts
                  </div>
                  <div className="text-xs">
                    <Delta value={buy.player.valueDelta} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {outOfReach.length > 0 && (
        <Card
          title="Out of reach"
          subtitle="Would improve the XI, but you cannot pay for them yet."
        >
          <ul className="space-y-1 text-sm">
            {outOfReach.slice(0, 6).map((buy) => (
              <li key={buy.player.playerId} className="text-zinc-400">
                <span className="text-zinc-200">{buy.player.name}</span> —{" "}
                {buy.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Worth selling"
        subtitle="Players who never start, so selling them costs no points."
      >
        {freeSells.length === 0 ? (
          <Empty>Every player in the squad is earning their place.</Empty>
        ) : (
          <ul>
            {freeSells.map((sell) => (
              <li
                key={sell.player.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <Role role={sell.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-100">
                    {sell.player.name}
                  </p>
                  <p className="text-xs text-zinc-500">{sell.reason}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="text-emerald-300">
                    <Money value={sell.player.value} />
                  </div>
                  <div className="text-xs">
                    <Delta value={sell.player.valueDelta} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {costlySells.length > 0 && (
        <Card
          title="Only if you need cash"
          subtitle="Selling these loses points."
        >
          <ul className="space-y-1 text-sm">
            {costlySells.slice(0, 5).map((sell) => (
              <li key={sell.player.playerId} className="text-zinc-400">
                <span className="text-zinc-200">{sell.player.name}</span>{" "}
                <Money value={sell.player.value} /> — {sell.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Warnings warnings={data.warnings} />
    </div>
  );
}
