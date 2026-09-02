import type { AnalysisReport } from "./engine";

const TG_API = "https://api.telegram.org/bot";

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramError("TELEGRAM_BOT_TOKEN is not set.");
  return token;
}

function chatIds(): string[] {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = botToken();
  const res = await fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramError(`Telegram sendMessage failed (${res.status}): ${body}`);
  }
}

/** Send a plain message to all configured chats. */
export async function notify(text: string): Promise<{ sent: number }> {
  const ids = chatIds();
  let sent = 0;
  for (const id of ids) {
    await sendMessage(id, text);
    sent++;
  }
  if (ids.length === 0) {
    throw new TelegramError(
      "TELEGRAM_CHAT_ID is not set. Add your chat id(s) to receive reminders.",
    );
  }
  return { sent };
}

/** Format an analysis report as a Telegram summary message. */
export function formatReportMessage(report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push(`<b>⚽ FutmondoBot — ${report.today.headline}</b>`);

  if (report.deadline) {
    lines.push(`\n<b>⏰ Deadline:</b> ${report.deadline}`);
  }

  const actions = report.today.actions;
  for (const a of actions) {
    const icon =
      a.priority === "high" ? "🔴" : a.priority === "medium" ? "🟠" : "🟡";
    lines.push(`\n${icon} <b>${a.title}</b>\n   ${a.detail}`);
  }

  if (report.warning) {
    lines.push(`\n<i>⚠️ ${report.warning}</i>`);
  }

  return lines.join("\n");
}

/** Deadline reminder with the current action summary. */
export async function sendDeadlineReminder(
  report: AnalysisReport,
): Promise<{ sent: number }> {
  const msg = formatReportMessage(report);
  return notify(msg);
}
