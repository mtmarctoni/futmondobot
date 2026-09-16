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

/**
 * Clauses run in both directions, so the page does too: what you can take, and
 * what can be taken from you. Blocking now costs 200 mondos a player a week,
 * so the defence half is information, not advice: who could take your players
 * is listed, and no block is recommended, automated or offered as a button.
 *
 * The attack half leads with the golden tier — clauses the market has already
 * overtaken — in the one accented card on the page. These used to render in
 * the same grey as the speculative bets around them, which is exactly how a
 * clause worth paying today gets scrolled past.
 */
/**
 * The countdown, in the same words the engine uses. A clause opportunity is
 * really a date, and a reader acts on "3 days" in a way they never act on
 * "0.83x".
 */
function countdown(days: number | null): string {
  if (days === null) return "not closing";
  if (days === 0) return "now";
  if (days < 1.5) return "under a day";
  return `~${Math.round(days)} days`;
}

export function ClausesClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;
  if (data.error) return <ErrorBox error={data.error} onRetry={refresh} />;

  const { clauses } = data;
  const affordable = clauses.steals.filter((s) => s.affordable);
  const outOfReach = clauses.steals.filter((s) => !s.affordable);
  // The engine decides what counts as takeable, because the rule is not "some
  // rival is estimated to afford it" — see ExposedPlayer.atRisk. The card then
  // shows only the ones on the countdown: a squad of fifteen plus reserves is
  // mostly players a rival could technically pay for and would never want, and
  // listing all of them is how the three that matter get scrolled past.
  const atRisk = clauses.exposed.filter((e) => e.atRisk && e.tier !== "priced");
  const rest = clauses.exposed.filter((e) => !atRisk.includes(e));
  const shut = rest.filter((e) => e.availableFrom !== null).length;
  const unwanted = rest.length - shut;

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
          it, in either direction — so there is nothing to take until then.
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

      {clauses.golden.length > 0 && (
        <Card
          accent="amber"
          title="At or under value"
          subtitle="Clauses the market has already overtaken: paying buys the player for about what he is worth, or less. Nothing has to be believed about the future, and it lasts only until the owner reprices the clause. Best gap first, affordable first."
        >
          <ul>
            {clauses.golden.map((bet) => (
              <li
                key={bet.player.playerId}
                className="flex items-center gap-3 border-b border-amber-900/30 py-2 last:border-0"
              >
                <Role role={bet.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-zinc-100">
                    {bet.player.name}
                    {bet.ownerName && (
                      <span className="text-xs font-normal text-zinc-500">
                        at {bet.ownerName}
                      </span>
                    )}
                    <span className="shrink-0 rounded bg-amber-400/20 px-1.5 py-0.5 text-xs font-medium text-amber-200">
                      {bet.discount >= 0 ? "under value" : "at value"}
                    </span>
                    {!bet.affordable && (
                      <span className="shrink-0 rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-400">
                        out of reach
                      </span>
                    )}
                    {bet.availableFrom && (
                      <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-200">
                        opens {bet.availableFrom.replace("T", " ").slice(0, 16)}Z
                      </span>
                    )}
                  </p>
                  <p className="text-xs leading-relaxed text-zinc-400">
                    {bet.reason}
                  </p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="font-medium text-amber-100">
                    <Money value={bet.clausePrice} />
                  </div>
                  <div className="text-xs text-zinc-400">
                    value <Money value={bet.player.value} /> ·{" "}
                    {bet.ratio.toFixed(2)}x
                  </div>
                  <div className="text-xs text-zinc-500">
                    7d <Delta value={bet.player.valueDelta} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
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

      {clauses.trendBets.length > 0 && (
        <Card
          title="Next to cross"
          subtitle="Rivals' players whose value is climbing towards a clause the owner left pinned, and is on course to reach it within four weeks. These are the ones that become free value next — ordered by how soon they cross, weighted by whether the player is worth having when they do. Paying now buys the crossing early, and the bet pays only if value keeps rising."
        >
          <ul>
            {clauses.trendBets.map((bet) => (
              <li
                key={bet.player.playerId}
                className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0"
              >
                <Role role={bet.player.role} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 truncate font-medium text-zinc-100">
                    {bet.player.name}
                    {bet.ownerName && (
                      <span className="text-xs font-normal text-zinc-500">
                        at {bet.ownerName}
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                        bet.affordable
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-zinc-700/50 text-zinc-400"
                      }`}
                    >
                      {bet.affordable ? "affordable" : "out of reach"}
                    </span>
                  </p>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    {bet.reason}
                  </p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <div className="text-zinc-100">
                    <Money value={bet.clausePrice} />
                  </div>
                  <div className="text-xs font-medium text-amber-200/80">
                    crosses {countdown(bet.daysToValue)}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {bet.ratio.toFixed(2)}x · opp {bet.opportunity.toFixed(1)} ·{" "}
                    <Delta value={bet.player.valueDelta} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
                {steal.availableFrom
                  ? `${steal.availableFrom.replace("T", " ").slice(0, 16)}Z`
                  : ""}
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
        accent={atRisk.some((e) => e.tier === "golden") ? "amber" : "none"}
        title="Yours at risk"
        subtitle="Your own squad run through the same arithmetic, pointed the other way: this is the order a rival raids you in, soonest to cross first. Blocking costs 200 mondos a player a week, so the budget is held instead — this list informs, it does not advise."
      >
        {atRisk.length === 0 ? (
          <Empty>
            {clauses.exposed.length === 0
              ? "No clause prices known for your own squad yet."
              : "Every clause of yours is still comfortably above what the player is worth."}
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
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-zinc-100">
                    {risk.player.name}
                    {risk.alreadyLocked ? (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                        blocked
                      </span>
                    ) : risk.tier === "golden" ? (
                      <span className="shrink-0 rounded bg-amber-400/20 px-1.5 py-0.5 text-xs font-medium text-amber-200">
                        under value now
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
                  <div
                    className={`text-xs font-medium ${
                      risk.tier === "golden"
                        ? "text-amber-200"
                        : risk.tier === "trend"
                          ? "text-amber-200/70"
                          : "text-zinc-500"
                    }`}
                  >
                    crosses {countdown(risk.daysToValue)}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {risk.ratio.toFixed(2)}x · value{" "}
                    <Money value={risk.player.value} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {rest.length > 0 && (
        <p className="text-xs text-zinc-500">
          {unwanted > 0 && (
            <>
              {unwanted} more of your players carry a clause still well above
              what they are worth, with nothing closing the gap.{" "}
            </>
          )}
          {shut > 0 && (
            <>
              {shut} cannot be paid for by anyone yet, whatever they look
              like.{" "}
            </>
          )}
          Rival cash is reconstructed from the transfer ledger because this
          league hides funds, and no prize money has been captured into it yet,
          so those estimates are low — which is why a clause at or under value
          is listed above regardless of what the estimate says.
        </p>
      )}

      <Warnings warnings={data.warnings} />
    </div>
  );
}
