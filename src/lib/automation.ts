/**
 * The scheduled routine: work out what to do, do the free and reversible parts,
 * and report the rest.
 *
 * The split is deliberate and load-bearing. Setting a lineup costs nothing and
 * can be undone, so it runs unattended. Bids, clause payments and sales spend
 * budget irreversibly, so they only ever become a button in Telegram. Blocking
 * a clause now costs 200 mondos a player a week, so it joins the money row:
 * exposure is reported as information and the budget is never spent on it.
 */
import { applyLineup, type ApplyLineupResult } from "./engine/apply";
import { runAnalysis, type AnalysisReport } from "./engine";
import { FutmondoClient } from "./futmondo/client";
import { dbTokenStore } from "./db/token-store";

export interface AutomationResult {
  report: AnalysisReport;
  lineup: ApplyLineupResult | null;
  /** Why an automated step was not attempted, when it was not. */
  notes: string[];
}

export interface AutomationOptions {
  /**
   * Only touch the lineup inside this many hours of the deadline. Running too
   * early wastes the change: form, injuries and probable lineups all move, and
   * the last write before kickoff is the one that counts.
   */
  lineupWindowHours?: number;
  /** Plan everything, write nothing. */
  dryRun?: boolean;
  client?: FutmondoClient;
}

export async function runAutomation(
  options: AutomationOptions = {},
): Promise<AutomationResult> {
  const {
    lineupWindowHours = Number(process.env.LINEUP_WINDOW_HOURS ?? 30),
    dryRun = false,
  } = options;

  const client = options.client ?? new FutmondoClient({ tokenStore: dbTokenStore });
  const notes: string[] = [];

  const report = await runAnalysis({ client });
  if (report.error || !report.scope) {
    return { report, lineup: null, notes: [report.error ?? "No scope"] };
  }

  // ------------------------------------------------------------- lineup ----
  let lineup: ApplyLineupResult | null = null;
  const hours = report.today.hoursToDeadline;

  if (report.squad.length === 0) {
    notes.push("No squad data, so the lineup was left alone.");
  } else if (hours === null) {
    notes.push(
      "No deadline is known yet, so the lineup was left alone. Run the calendar sync.",
    );
  } else if (hours < 0) {
    notes.push("The round has already started, so the lineup is locked.");
  } else if (hours > lineupWindowHours) {
    notes.push(
      `Deadline is ${Math.round(hours)}h away; the lineup is written inside ${lineupWindowHours}h so it reflects the latest news.`,
    );
  } else {
    try {
      const current = await client.getCurrentLineup(report.scope);
      lineup = await applyLineup({
        client,
        scope: report.scope,
        squad: report.squad,
        currentLineup: current,
        availableFormations: report.availableFormations,
        dryRun,
      });
      if (lineup.betterFormation) {
        notes.push(
          `Switching to ${lineup.betterFormation.label} by hand would add about ${lineup.betterFormation.gain.toFixed(
            1,
          )} points; automation does not change formation.`,
        );
      }
      if (lineup.skippedReason) notes.push(lineup.skippedReason);
      notes.push(...lineup.errors);
    } catch (err) {
      notes.push(
        `Could not read the current lineup, so nothing was written: ${message(err)}`,
      );
    }
  }

  // ------------------------------------------------------- clauses (info) ----
  // Blocking now costs 200 mondos a player a week, so nothing below is a write
  // or an instruction. Exposure is carried on the clauses page and in today's
  // headline as information; the only automation here passes the window note
  // through, so the message states when your squad becomes clausable and stops.
  if (report.clauses.windowNote) {
    notes.push(report.clauses.windowNote);
  }

  // Re-run so the message reflects what we just did rather than the state
  // before it. Cheap relative to being wrong about our own actions.
  const applied = Boolean(lineup?.applied);
  const finalReport = applied ? await runAnalysis({ client, lineupApplied: true }) : report;

  return { report: finalReport, lineup, notes };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
