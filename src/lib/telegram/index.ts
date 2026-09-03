/**
 * Telegram transport and message formatting.
 *
 * The report is the product, so the message is written to be read on a phone
 * at speed: a headline you can act on without scrolling, then the actions in
 * priority order, then buttons for the ones that cost money. Anything the app
 * did by itself is stated plainly so an automated change is never a surprise.
 */
import type { AnalysisReport } from "../engine";
import type { Action } from "../engine/today";
import { fmtMoney } from "../engine/types";
import { encodeCallback, needsConfirmation, type CallbackVerb } from "./callbacks";

const TG_API = "https://api.telegram.org/bot";

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramError("TELEGRAM_BOT_TOKEN is not set.");
  return token;
}

/** Chats allowed to command the bot, and to receive reminders. */
export function allowedChatIds(): string[] {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedChat(chatId: string | number | undefined): boolean {
  if (chatId === undefined) return false;
  const allowed = allowedChatIds();
  // With no allowlist configured, refuse everything rather than obey anyone:
  // this bot can spend money.
  if (allowed.length === 0) return false;
  return allowed.includes(String(chatId));
}

async function call(
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${TG_API}${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && typeof body === "object" && (body as { ok?: boolean }).ok === false)) {
    const detail =
      body && typeof body === "object"
        ? String((body as { description?: string }).description ?? "")
        : "";
    throw new TelegramError(`Telegram ${method} failed (${res.status}): ${detail}`);
  }
  return body;
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  buttons: InlineButton[][] = [],
): Promise<void> {
  await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

/** Clears the button's spinner. Telegram shows an error if this is skipped. */
export async function answerCallback(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: false } : {}),
  });
}

/** Sends to every allowed chat. */
export async function notify(
  text: string,
  buttons: InlineButton[][] = [],
): Promise<{ sent: number }> {
  const ids = allowedChatIds();
  if (ids.length === 0) {
    throw new TelegramError(
      "TELEGRAM_CHAT_ID is not set. Add your chat id to receive reminders.",
    );
  }
  let sent = 0;
  for (const id of ids) {
    await sendMessage(id, text, buttons);
    sent += 1;
  }
  return { sent };
}

const URGENCY_MARK: Record<Action["urgency"], string> = {
  now: "!!",
  today: "•",
  whenever: "◦",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [];

  if (report.error) {
    return `<b>FutmondoBot could not run</b>\n${escapeHtml(report.error)}`;
  }

  lines.push(`<b>${escapeHtml(report.today.headline)}</b>`);

  const { hoursToDeadline } = report.today;
  if (report.nextRound && hoursToDeadline !== null) {
    const when =
      hoursToDeadline < 0
        ? "started"
        : hoursToDeadline < 24
          ? `in ${Math.round(hoursToDeadline)}h`
          : `in ${Math.round(hoursToDeadline / 24)}d`;
    lines.push(`Jornada ${report.nextRound.number} ${when}.`);
  }

  lines.push(
    `Funds ${fmtMoney(report.funds)} · squad ${fmtMoney(report.teamValue)} · max offer ${fmtMoney(report.market.maxOffer)}`,
  );

  const actionable = report.today.actions.filter((a) => a.kind !== "info");
  if (actionable.length === 0) {
    lines.push("\nNothing needs doing.");
  } else {
    lines.push("");
    for (const action of actionable.slice(0, 6)) {
      const stake =
        action.pointsAtStake && action.pointsAtStake > 0
          ? ` <i>(+${action.pointsAtStake.toFixed(1)} pts)</i>`
          : "";
      lines.push(
        `${URGENCY_MARK[action.urgency]} <b>${escapeHtml(action.title)}</b>${stake}`,
      );
      lines.push(`   ${escapeHtml(action.detail)}`);
    }
  }

  // State what was automated, so nothing happens silently.
  const done = report.today.actions.filter(
    (a) => a.kind === "info" && a.detail.includes("Applied automatically"),
  );
  for (const action of done) {
    lines.push(`\n✓ ${escapeHtml(action.title)}`);
  }

  if (report.warnings.length > 0) {
    lines.push(`\n<i>${escapeHtml(report.warnings.slice(0, 3).join(" · "))}</i>`);
  }

  return lines.join("\n");
}

/**
 * One button per money action, so acting takes a tap rather than opening
 * Futmondo. Lineups and clause blocks are already automated, so they get no
 * button.
 */
export function buildActionButtons(report: AnalysisReport): InlineButton[][] {
  const rows: InlineButton[][] = [];

  for (const action of report.today.actions) {
    if (!action.playerId) continue;

    const verb: CallbackVerb | null =
      action.kind === "steal_clause"
        ? "clause"
        : action.kind === "buy"
          ? "bid"
          : action.kind === "sell"
            ? "sell"
            : null;
    if (!verb) continue;

    const price = Math.abs(action.money ?? 0);
    const label =
      verb === "clause"
        ? `Pay clause: ${action.playerName} (${fmtMoney(price)})`
        : verb === "bid"
          ? `Bid ${fmtMoney(price)} for ${action.playerName}`
          : `Sell ${action.playerName} (${fmtMoney(price)})`;

    try {
      rows.push([
        {
          text: label,
          callback_data: encodeCallback({
            verb,
            playerId: action.playerId,
            price,
            confirmed: false,
          }),
        },
      ]);
    } catch {
      // An id too long to encode simply gets no button; the text still tells
      // the user what to do.
    }
    if (rows.length >= 4) break;
  }

  rows.push([
    { text: "Refresh", callback_data: encodeCallback({ verb: "refresh", confirmed: false }) },
  ]);
  return rows;
}

/** The second tap: restates the cost and offers the irreversible action. */
export function buildConfirmButtons(
  verb: CallbackVerb,
  playerId: string,
  price: number,
): InlineButton[][] {
  if (!needsConfirmation(verb)) return [];
  return [
    [
      {
        text: `Yes, ${verb === "sell" ? "sell" : "spend"} ${fmtMoney(price)}`,
        callback_data: encodeCallback({ verb, playerId, price, confirmed: true }),
      },
    ],
    [{ text: "Cancel", callback_data: encodeCallback({ verb: "refresh", confirmed: false }) }],
  ];
}

export async function sendReport(report: AnalysisReport): Promise<{ sent: number }> {
  return notify(formatReport(report), buildActionButtons(report));
}
