"use client";

import type { AnalysisReport } from "@/lib/engine";

import type { Action } from "@/lib/engine/today";
import {
  Card,
  CoverageNote,
  DepartedBanner,
  Empty,
  ErrorBox,
  Loading,
  Money,
  Pts,
  RefreshButton,
  Warnings,
  useAnalysis,
  money,
} from "./ui";

/**
 * The page the whole app exists for: what to do, in order, with the cost of
 * ignoring it stated in points. Everything else is a drill-down.
 */
export function DashboardClient({ initial }: { initial: AnalysisReport }) {
  const { data, loading, error, refresh } = useAnalysis(initial);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!data) return <ErrorBox error="No report was returned." onRetry={refresh} />;

  if (data.error) {
    return (
      <div className="space-y-4">
        <ErrorBox error={data.error} onRetry={refresh} />
        <p className="text-sm text-zinc-400">
          Check <code className="text-zinc-300">FUTMONDO_EMAIL</code> and{" "}
          <code className="text-zinc-300">FUTMONDO_PASSWORD</code>, then see{" "}
          <a href="/settings" className="text-emerald-400 underline">
            Settings
          </a>
          .
        </p>
      </div>
    );
  }

  const actionable = data.today.actions.filter((a) => a.kind !== "info");
  const notes = data.today.actions.filter((a) => a.kind === "info");

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-50">
            {data.today.headline}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            <Deadline
              hours={data.today.hoursToDeadline}
              round={data.nextRound?.number}
            />
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Funds" value={money(data.funds)} />
        <Stat label="Squad value" value={money(data.teamValue)} />
        <Stat label="Max offer" value={money(data.market.maxOffer)} />
        <Stat
          label="Points on the table"
          value={data.today.pointsAvailable.toFixed(1)}
          highlight={data.today.pointsAvailable >= 1}
        />
      </div>

      <DepartedBanner departed={data.departed} />

      <CoverageNote coverage={data.coverage} />

      <Card
        title="Do this"
        subtitle={
          actionable.length === 0
            ? undefined
            : "Ordered by what it costs to ignore."
        }
      >
        {actionable.length === 0 ? (
          <Empty>Nothing needs doing right now.</Empty>
        ) : (
          <ul className="space-y-2">
            {actionable.map((action) => (
              <ActionCard key={action.id} action={action} />
            ))}
          </ul>
        )}
      </Card>

      {notes.length > 0 && (
        <Card title="Already handled">
          <ul className="space-y-1.5 text-sm">
            {notes.map((note) => (
              <li key={note.id} className="text-zinc-400">
                <span className="text-zinc-200">{note.title}</span> — {note.detail}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Warnings warnings={data.warnings} />
    </div>
  );
}

function Deadline({
  hours,
  round,
}: {
  hours: number | null;
  round?: number;
}) {
  if (hours === null) {
    return <>No deadline known yet — run the calendar sync.</>;
  }
  const label = round ? `Jornada ${round}` : "Next round";
  if (hours < 0) return <>{label} has already started.</>;
  if (hours < 1) return <>{label} closes in {Math.round(hours * 60)} minutes.</>;
  if (hours < 48) return <>{label} closes in {Math.round(hours)} hours.</>;
  return <>{label} closes in {Math.round(hours / 24)} days.</>;
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <p className="text-xs text-zinc-500">{label}</p>
      <p
        className={`mt-0.5 tabular-nums font-medium ${
          highlight ? "text-amber-300" : "text-zinc-100"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

const URGENCY: Record<Action["urgency"], { dot: string; text: string }> = {
  now: { dot: "bg-rose-400", text: "now" },
  today: { dot: "bg-amber-400", text: "today" },
  whenever: { dot: "bg-zinc-500", text: "no rush" },
};

function ActionCard({ action }: { action: Action }) {
  const urgency = URGENCY[action.urgency];
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${urgency.dot}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="font-medium text-zinc-100">{action.title}</h3>
            <span className="text-xs uppercase tracking-wide text-zinc-500">
              {urgency.text}
            </span>
            {action.automatable && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                automated
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-400">{action.detail}</p>
        </div>
        <div className="shrink-0 text-right text-sm">
          {action.pointsAtStake !== undefined && action.pointsAtStake > 0 && (
            <div>
              <Pts value={action.pointsAtStake} />
              <span className="text-zinc-500"> pts</span>
            </div>
          )}
          {action.money !== undefined && action.money !== 0 && (
            <div
              className={`text-xs ${
                action.money < 0 ? "text-rose-300" : "text-emerald-300"
              }`}
            >
              <Money value={action.money} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
