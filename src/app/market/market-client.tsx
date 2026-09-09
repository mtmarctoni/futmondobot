"use client";

import type { AnalysisReport } from "@/lib/engine";

import { LOW_VALUE_CEILING } from "@/lib/engine/radar";

import {
  Card,
  Delta,
  Empty,
  ErrorBox,
  Loading,
  Money,
  OpportunityToast,
  Pts,
  RefreshButton,
  Role,
  Warnings,
  useAnalysis,
  useIsBrowser,
  money,
} from "../ui";

export function MarketClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);
  // Above the early returns: hooks cannot be called conditionally, and the
  // toast has to survive a refresh that briefly has no data.
  const radar = data?.market.radar ?? { opportunities: [], unknownChange: 0 };
  const isBrowser = useIsBrowser();
  // Keyed on the id list so a market that has genuinely changed asks the
  // question again, and one that has not does not.
  const radarKey = radar.opportunities.map((o) => o.playerId).join(",");

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const { market } = data;
  const affordable = market.buys.filter((b) => b.affordable);
  const outOfReach = market.buys.filter((b) => !b.affordable);
  // A player already on the market is a sale in progress, not a sale to make.
  const freeSells = market.sells.filter((s) => s.cost === 0 && !s.alreadyListed);
  const costlySells = market.sells.filter((s) => s.cost > 0);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">Market</h1>
          <p className="mt-1 text-sm text-zinc-400">{market.headline}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {money(market.funds)} available
            {market.committed > 0 && (
              <> · {money(market.committed)} held by standing bids</>
            )}{" "}
            · ceiling {money(market.maxOffer)} (funds plus half the squad value)
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {market.listings.length > 0 && (
        <Card
          title="Your listings"
          subtitle="What is on the market from your squad, and what has been offered for it. Bids are sealed: the price is visible, the bidder is not."
        >
          <ul>
            {market.listings.map((listing) => (
              <li
                key={listing.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-100">
                    {listing.name}
                  </p>
                  <p className="text-xs text-zinc-500">{listing.reason}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div
                    className={
                      listing.topBid !== null ? "text-emerald-300" : "text-zinc-400"
                    }
                  >
                    {listing.topBid !== null ? (
                      <Money value={listing.topBid} />
                    ) : (
                      "no bids"
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">
                    asking <Money value={listing.price} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}


      <Card
        title="Speculation opportunities"
        subtitle={`Listings at or under ${money(LOW_VALUE_CEILING)} whose value rose today, best percentage gain first. A bet on the price, not on the XI: nothing here is judged on whether the player would start.`}
      >
        {radar.opportunities.length === 0 ? (
          <Empty>
            {radar.unknownChange > 0
              ? `Nothing is rising in the cheap end of the market. ${radar.unknownChange} listing(s) had no readable daily change and could not be judged.`
              : "Nothing is rising in the cheap end of the market."}
          </Empty>
        ) : (
          <>
            <ul>
              {radar.opportunities.map((o) => (
                <li
                  key={o.playerId}
                  className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
                >
                  <Role role={o.role} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-zinc-100">{o.name}</p>
                    <p className="text-xs text-zinc-500">
                      {o.clubName ?? "Club unknown"} · rose{" "}
                      {(o.dailyChangePct * 100).toFixed(1)}% today
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <div className="text-zinc-100">
                      <Money value={o.suggestedBid} />
                    </div>
                    {/* Both figures, because the ask is the auction floor and
                        bidding it loses every contested listing. */}
                    <div className="text-xs text-zinc-500">
                      asking <Money value={o.price} /> · value{" "}
                      <Money value={o.value} />
                    </div>
                    <div className="text-xs text-emerald-300">
                      +<Money value={o.dailyChange} /> today
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {radar.unknownChange > 0 && (
              <p className="mt-2 text-xs text-zinc-500">
                {radar.unknownChange} more cheap listing(s) had no readable
                daily change, so they were not judged.
              </p>
            )}
          </>
        )}
      </Card>

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
                  {/* The bid, then the asking price it is built on. Offering
                      the ask is the auction's floor and loses every contested
                      listing, so the number to act on comes first. */}
                  <div className="text-zinc-100">
                    <Money value={buy.suggestedBid} />
                  </div>
                  <div className="text-xs text-zinc-500">
                    asking <Money value={buy.price} /> · worth{" "}
                    <Money value={buy.ceiling} />
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
      {isBrowser && (
        <OpportunityToast key={radarKey} opportunities={radar.opportunities} />
      )}
    </div>
  );
}
