import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings — FutmondoBot",
};

function isSet(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

const envs: { key: string; label: string; required: boolean }[] = [
  { key: "FUTMONDO_EMAIL", label: "Futmondo email", required: true },
  { key: "FUTMONDO_PASSWORD", label: "Futmondo password", required: true },
  { key: "FUTMONDO_CHAMPIONSHIP_ID", label: "Championship ID", required: false },
  { key: "FUTMONDO_USER_TEAM_ID", label: "User team ID", required: false },
  { key: "FUTMONDO_FUNDS", label: "Current funds (€)", required: false },
  { key: "FUTMONDO_DEADLINE", label: "Matchday deadline (ISO)", required: false },
  { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", required: true },
  { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID(s)", required: true },
  { key: "API_FOOTBALL_KEY", label: "API-Football key (optional stats)", required: false },
  { key: "LEAGUE_ID", label: "League ID for stats (API-Football)", required: false },
  { key: "CRON_SECRET", label: "Cron secret", required: false },
];

export default function SettingsPage() {
  const list = envs.map((e) => ({
    ...e,
    set: isSet(process.env[e.key]),
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="text-sm text-zinc-400">
        Configure these environment variables in your hosting provider. Secrets never
        reach the browser.
      </p>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Variable</th>
              <th className="px-4 py-2 font-medium">Purpose</th>
              <th className="px-4 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {list.map((e) => (
              <tr key={e.key} className="bg-zinc-950/40">
                <td className="px-4 py-2 font-mono text-xs">{e.key}</td>
                <td className="px-4 py-2 text-zinc-300">{e.label}</td>
                <td className="px-4 py-2 text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs ${
                      e.set ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        e.set ? "bg-emerald-400" : "bg-red-400"
                      }`}
                    />
                    {e.set ? "Set" : e.required ? "Missing" : "Optional"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <h2 className="mb-2 font-semibold text-zinc-100">How to find your IDs</h2>
        <ul className="list-inside list-disc space-y-1 text-zinc-400">
          <li>
            Run the app once with only credentials set and call{" "}
            <code className="rounded bg-zinc-800 px-1">/api/futmondo</code> to list your
            leagues, then copy the championship ID.
          </li>
          <li>
            The user team ID is auto-resolved from the league list; set it manually if
            discovery fails.
          </li>
          <li>
            Get your Telegram chat ID from <code className="rounded bg-zinc-800 px-1">@userinfobot</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}
