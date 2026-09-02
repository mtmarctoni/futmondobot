"use client";

import { useCallback, useEffect, useState } from "react";
import type { AnalysisReport } from "@/lib/engine";

interface State {
  data: AnalysisReport | null;
  loading: boolean;
  error: string | null;
}

async function fetchAnalysisReport(): Promise<AnalysisReport> {
  const res = await fetch("/api/analyze", { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error ?? `HTTP ${res.status}`);
  }
  return json as AnalysisReport;
}

export function useAnalysis() {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        const data = await fetchAnalysisReport();
        if (active) {
          setState({ data, loading: false, error: null });
        }
      } catch (err) {
        if (active) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    run();
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchAnalysisReport()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((err) =>
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }, []);

  return { ...state, refresh };
}

export function Money({ value }: { value: number }) {
  if (value >= 1_000_000)
    return <span>{(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M€</span>;
  if (value >= 1_000) return <span>{Math.round(value / 1_000)}k€</span>;
  return <span>{Math.round(value)}€</span>;
}

export function ScorePill({ score }: { score: number }) {
  const color =
    score >= 70
      ? "bg-emerald-500/20 text-emerald-300"
      : score >= 50
        ? "bg-amber-500/20 text-amber-300"
        : "bg-zinc-700 text-zinc-300";
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {Math.round(score)}
    </span>
  );
}
