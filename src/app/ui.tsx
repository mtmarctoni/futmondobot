"use client";

import { useCallback, useState } from "react";
import type { AnalysisReport, Coverage, DepartedPlayer } from "@/lib/engine";
import type { Evaluated } from "@/lib/engine/types";

// ------------------------------------------------------------------ data ----

interface State {
  data: AnalysisReport | null;
  loading: boolean;
  error: string | null;
}

async function fetchReport(): Promise<AnalysisReport> {
  const res = await fetch("/api/analyze", { cache: "no-store" });
  const json = await res.json();
  // The route returns a full report even on failure, describing what broke,
  // which is more useful than a bare status code.
  if (!res.ok && !json?.today) {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json as AnalysisReport;
}

/**
 * Holds the report and reloads it on demand.
 *
 * The first report is rendered on the server and handed in, so there is no
 * fetch-on-mount effect and no loading flash: the page arrives with data.
 * Refreshing is a user action, which is the only time this sets state.
 */
export function useAnalysis(initial: AnalysisReport) {
  const [state, setState] = useState<State>({
    data: initial,
    loading: false,
    error: null,
  });

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchReport()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) =>
        setState((s) => ({
          // Keep the report already on screen: a failed refresh should not
          // replace working advice with an empty page.
          data: s.data,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      );
  }, []);

  return { ...state, refresh };
}

// --------------------------------------------------------------- format ----

export function money(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M€`;
  }
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k€`;
  return `${sign}${Math.round(abs)}€`;
}

export function Money({ value }: { value: number }) {
  return <span className="tabular-nums">{money(value)}</span>;
}

/** Expected points. The unit every recommendation is denominated in. */
export function Pts({ value }: { value: number }) {
  return (
    <span className="tabular-nums font-medium text-zinc-100">
      {value.toFixed(1)}
    </span>
  );
}

export function Delta({ value }: { value: number }) {
  if (Math.abs(value) < 50_000) return <span className="text-zinc-500">—</span>;
  const rising = value > 0;
  return (
    <span className={rising ? "text-emerald-400" : "text-rose-400"}>
      {rising ? "▲" : "▼"} {money(Math.abs(value))}
    </span>
  );
}

// ----------------------------------------------------------- primitives ----

export function Card({
  title,
  subtitle,
  children,
  right,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-zinc-800 px-4 py-3">
          <div>
            {title && <h2 className="font-medium text-zinc-100">{title}</h2>}
            {subtitle && (
              <p className="mt-0.5 text-sm text-zinc-400">{subtitle}</p>
            )}
          </div>
          {right}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}

export function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40"
        />
      ))}
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3">
      <p className="font-medium text-rose-200">Could not load the report</p>
      <p className="mt-1 text-sm text-rose-300/80">{error}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-rose-800 px-3 py-1.5 text-sm text-rose-200 transition hover:bg-rose-900/40"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Players who are no longer in the competition.
 *
 * Deliberately the loudest thing on the page and placed above the action list:
 * Futmondo gives no hint that a player has been transferred out of the league,
 * so this is the only place it can be seen, and it costs a squad slot plus the
 * capital for every day it goes unnoticed.
 */
export function DepartedBanner({ departed }: { departed: DepartedPlayer[] }) {
  if (departed.length === 0) return null;
  return (
    <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3">
      <p className="font-medium text-rose-100">
        {departed.length === 1
          ? "A player has left the competition"
          : `${departed.length} players have left the competition`}
      </p>
      <ul className="mt-2 space-y-2">
        {departed.map((player) => (
          <li key={player.playerId} className="text-sm">
            <span className="font-medium text-rose-100">{player.name}</span>
            <span className="text-rose-200/80">
              {player.clubName ? ` is at ${player.clubName} now` : " is not in this league"}
              {" — "}
              <Money value={player.value} /> that cannot score another point.
            </span>
            <span className="block text-xs text-rose-300/70">
              {player.onMarket
                ? `Already on the market${player.askPrice !== null ? ` at ${money(player.askPrice)}` : ""}. Take the best offer rather than holding for full value.`
                : "Sell him: he holds a squad slot and earns nothing."}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-4 py-3">
      <summary className="cursor-pointer text-sm text-amber-200">
        {warnings.length} thing{warnings.length > 1 ? "s" : ""} the engine could
        not see
      </summary>
      <ul className="mt-2 space-y-1 text-sm text-amber-200/80">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * How much history exists. Advice is only as good as the data behind it, so
 * thin coverage is stated rather than hidden — a value trend from one day of
 * snapshots is not a trend.
 */
export function CoverageNote({ coverage }: { coverage: Coverage }) {
  const gaps: string[] = [];
  if (!coverage.hasDatabase) gaps.push("no database, so nothing is remembered");
  else {
    if (coverage.snapshotDays < 3) {
      gaps.push(`${coverage.snapshotDays} day(s) of value history`);
    }
    if (coverage.roundsWithPoints === 0) gaps.push("no per-round points yet");
    if (coverage.playersWithClause === 0) gaps.push("no clause prices yet");
    if (!coverage.hasOdds) gaps.push("no odds yet");
    if (!coverage.hasProbableLineups) gaps.push("no probable lineups yet");
  }

  if (gaps.length === 0) return null;

  return (
    <p className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-400">
      Data still filling in: {gaps.join(", ")}. Recommendations sharpen as the
      sync runs.
    </p>
  );
}

// -------------------------------------------------------------- players ----

const ROLE_STYLE: Record<string, string> = {
  POR: "bg-amber-500/15 text-amber-300",
  DEF: "bg-sky-500/15 text-sky-300",
  MED: "bg-emerald-500/15 text-emerald-300",
  DEL: "bg-rose-500/15 text-rose-300",
};

export function Role({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex w-11 justify-center rounded px-1.5 py-0.5 text-xs font-medium ${
        ROLE_STYLE[role] ?? "bg-zinc-700 text-zinc-300"
      }`}
    >
      {role}
    </span>
  );
}

export function PlayerRow({
  player,
  trailing,
}: {
  player: Evaluated;
  trailing?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-zinc-800/60 py-2 last:border-0">
      <Role role={player.role} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-zinc-100">
            {player.name}
          </span>
          {player.unavailableReason && (
            // A doubt and an absence are different facts and used to render
            // identically, which made a fit player carrying a knock look like
            // an injury. Amber for one, rose for the other.
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                player.availability === "doubt"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-rose-500/15 text-rose-300"
              }`}
              title={player.unavailableReason}
            >
              {player.unavailableReason.startsWith("no longer in the competition")
                ? "left the league"
                : player.availability === "doubt"
                  ? "doubtful"
                  : "out"}
            </span>
          )}
          {player.clauseLocked && (
            <span
              className="shrink-0 text-xs text-zinc-500"
              title="Clause blocked"
            >
              locked
            </span>
          )}
        </div>
        {/* Wraps rather than truncating: the notes are the reasoning behind
            the number, and clipping them was what made the projection look
            arbitrary. */}
        <p className="text-xs leading-relaxed text-zinc-500">
          {player.clubName ?? "—"} · {player.notes.join(" · ")}
        </p>
      </div>
      <div className="shrink-0 text-right text-sm">
        {trailing ?? (
          <>
            <div>
              <Pts value={player.expectedPoints} />
              <span className="text-zinc-500"> pts</span>
            </div>
            <div className="text-xs text-zinc-500">
              <Money value={player.value} />
            </div>
          </>
        )}
      </div>
    </li>
  );
}

export function RefreshButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
    >
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  );
}
