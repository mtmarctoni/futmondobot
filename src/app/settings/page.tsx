import type { Metadata } from "next";
import { hasDatabase } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "Settings — FutmondoBot",
};

export const dynamic = "force-dynamic";

interface EnvSpec {
  key: string;
  purpose: string;
  requirement: "required" | "recommended" | "optional";
}

/**
 * `FUTMONDO_FUNDS` and `FUTMONDO_DEADLINE` are deliberately gone: funds come
 * from /1/userteam/information and the deadline from the stored calendar, both
 * live. Hardcoding either is how the app used to give stale advice.
 */
const ENVS: EnvSpec[] = [
  { key: "FUTMONDO_EMAIL", purpose: "Futmondo login", requirement: "required" },
  { key: "FUTMONDO_PASSWORD", purpose: "Futmondo login", requirement: "required" },
  {
    key: "DATABASE_URL",
    purpose: "History: value trends, form, clause prices, rival funds",
    requirement: "required",
  },
  {
    key: "CRON_SECRET",
    purpose: "Protects the sync, cron and diagnostics routes",
    requirement: "required",
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    purpose: "Sends the matchday report and action buttons",
    requirement: "recommended",
  },
  {
    key: "TELEGRAM_CHAT_ID",
    purpose: "Who may command the bot. Empty means nobody",
    requirement: "recommended",
  },
  {
    key: "FUTMONDO_CHAMPIONSHIP_ID",
    purpose: "Only needed if the account has more than one championship",
    requirement: "optional",
  },
  {
    key: "FUTMONDO_USER_TEAM_ID",
    purpose: "Only needed if auto-discovery picks the wrong team",
    requirement: "optional",
  },
  {
    key: "LINEUP_WINDOW_HOURS",
    purpose: "How close to the deadline the lineup is written. Default 30",
    requirement: "optional",
  },
  {
    key: "FUTMONDO_NAME_OVERRIDES",
    purpose: 'JSON {"Scraped Name": "futmondoPlayerId"} for names that never match',
    requirement: "optional",
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET",
    purpose: "Webhook secret token. Falls back to CRON_SECRET",
    requirement: "optional",
  },
  {
    key: "FUTMONDO_MIN_INTERVAL_MS",
    purpose: "Delay between Futmondo calls. Default 300",
    requirement: "optional",
  },
];

const STATUS_STYLE = {
  set: "text-emerald-300 bg-emerald-400",
  missing: "text-rose-300 bg-rose-400",
  unset: "text-zinc-500 bg-zinc-600",
} as const;

export default function SettingsPage() {
  const rows = ENVS.map((spec) => {
    const value = process.env[spec.key];
    const set = typeof value === "string" && value.length > 0;
    const state = set
      ? "set"
      : spec.requirement === "optional"
        ? "unset"
        : "missing";
    return { ...spec, set, state } as const;
  });

  const missing = rows.filter((r) => r.state === "missing");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-50">Settings</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Read from the server environment. No secret value is ever sent to the
          browser — only whether it is present.
        </p>
      </div>

      {missing.length > 0 && (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3">
          <p className="font-medium text-rose-200">
            {missing.length} setting{missing.length > 1 ? "s" : ""} still needed
          </p>
          <p className="mt-1 text-sm text-rose-300/80">
            {missing.map((m) => m.key).join(", ")}
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/60 text-left text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Variable</th>
              <th className="px-4 py-2 font-medium">Purpose</th>
              <th className="px-4 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-4 py-2 font-mono text-xs text-zinc-200">
                  {row.key}
                </td>
                <td className="px-4 py-2 text-zinc-400">{row.purpose}</td>
                <td className="px-4 py-2 text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      STATUS_STYLE[row.state].split(" ")[0]
                    }`}
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        STATUS_STYLE[row.state].split(" ")[1]
                      }`}
                    />
                    {row.state === "set"
                      ? "Set"
                      : row.state === "missing"
                        ? "Missing"
                        : "Not set"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <h2 className="font-medium text-zinc-100">Getting started</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-400">
          <li>
            Set the credentials, then run{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-200">
              pnpm db:migrate
            </code>{" "}
            to create the history tables.
          </li>
          <li>
            Confirm the connection and find your ids:{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-200">
              curl -H &quot;Authorization: Bearer $CRON_SECRET&quot;
              localhost:3000/api/futmondo
            </code>
          </li>
          <li>
            Collect the first day of history:{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-200">
              curl -H &quot;Authorization: Bearer $CRON_SECRET&quot; -X POST
              localhost:3000/api/sync
            </code>
          </li>
          <li>
            Gather clause prices in batches, since they cost one request per
            player:{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-200">
              /api/sync?job=clauses
            </code>
          </li>
          <li>
            Point Telegram at the webhook so the buttons work:{" "}
            <code className="rounded bg-zinc-800 px-1 text-zinc-200">
              setWebhook?url=https://&lt;app&gt;/api/telegram&amp;secret_token=$CRON_SECRET
            </code>
          </li>
        </ol>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
        <h2 className="font-medium text-zinc-100">What runs by itself</h2>
        <ul className="mt-2 space-y-1.5 text-zinc-400">
          <li>
            <span className="text-zinc-200">Automatic:</span> setting the XI
            before the deadline. It is free and reversible.
          </li>
          <li>
            <span className="text-zinc-200">Always your tap:</span> bids, clause
            payments and sales. These spend budget irreversibly, so they arrive
            as Telegram buttons and need a confirmation.
          </li>
          <li>
            <span className="text-zinc-200">Never automatic:</span> blocking
            clauses. It costs 200 mondos a player a week, so the app lists which
            of your players is exposed as information and never spends on it.
          </li>
          <li>
            <span className="text-zinc-200">Never automatic:</span> changing
            formation. Futmondo&apos;s formation-write payload could not be
            verified, so the app reports a better shape instead of guessing at a
            write that might corrupt the lineup.
          </li>
        </ul>
        {!hasDatabase() && (
          <p className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-amber-200">
            No database is configured, so nothing is remembered between runs.
            Value trends, real form, clause prices and rival funds all need it.
          </p>
        )}
      </section>
    </div>
  );
}
