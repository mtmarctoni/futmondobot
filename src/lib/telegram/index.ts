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

/**
 * Trimmed because the token is interpolated straight into a URL, and a value
 * pasted with a stray space fails as "malformed URL" rather than as anything
 * that names the real cause.
 */
function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
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

/**
 * @param automationNotes What the scheduled run did by itself. Passed in rather
 * than read off the report because only the caller knows: a lineup write and a
 * clause block leave no trace in any Futmondo payload, so if the message does
 * not say they happened, nothing does.
 */
export function formatReport(
  report: AnalysisReport,
  automationNotes: string[] = [],
): string {
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

  const departures = formatDepartures(report);
  if (departures) lines.push(departures);

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

  lines.push(formatXI(report));

  // State what was automated, so nothing happens silently.
  const done = report.today.actions.filter(
    (a) => a.kind === "info" && a.detail.includes("Applied automatically"),
  );
  for (const action of done) {
    lines.push(`\n✓ ${escapeHtml(action.title)}`);
  }
  for (const note of automationNotes.slice(0, 4)) {
    lines.push(`\n✓ ${escapeHtml(note)}`);
  }

  if (report.warnings.length > 0) {
    lines.push(`\n<i>${escapeHtml(report.warnings.slice(0, 3).join(" · "))}</i>`);
  }

  return lines.join("\n");
}

/**
 * Players who are no longer in the competition.
 *
 * Given its own block above everything else rather than left to the action
 * list, because it is the one thing here that is invisible in Futmondo itself:
 * the player's card looks normal, so nothing prompts you to check, and the
 * cost accrues quietly for as long as nobody notices.
 */
export function formatDepartures(report: AnalysisReport): string {
  if (report.departed.length === 0) return "";

  const lines: string[] = [""];
  for (const player of report.departed) {
    const at = player.clubName ? ` (now at ${escapeHtml(player.clubName)})` : "";
    lines.push(
      `!! <b>${escapeHtml(player.name)}</b> has left the competition${at} — ${fmtMoney(player.value)} that cannot score.`,
    );
    lines.push(
      player.onMarket
        ? `   Already on the market${player.askPrice !== null ? ` at ${fmtMoney(player.askPrice)}` : ""}. Take the best offer.`
        : `   List him on the market — there is a button for it below.`,
    );
  }
  return lines.join("\n");
}

/**
 * The XI to field, in full, every day.
 *
 * This is the point of the whole app for a league like this one: bench is
 * disabled, so the automatic lineup writer can only ever swap a starter for a
 * substitute and there are no substitutes to swap in. Nothing can be applied
 * for you, which makes the recommendation itself the deliverable -- and reading
 * it off a phone has to be enough to set the lineup without opening the report.
 *
 * Ordered keeper first then back to front, the way the Futmondo pitch is laid
 * out, so it can be entered top to bottom without re-sorting.
 */
export function formatXI(report: AnalysisReport): string {
  const { lineup } = report;
  if (lineup.starters.length === 0) return "";

  const lines: string[] = [
    `\n<b>Field this XI</b> (${escapeHtml(lineup.formation.label)}, ${lineup.expectedPoints.toFixed(1)} pts)`,
  ];

  if (
    report.currentFormation &&
    report.currentFormation !== lineup.formation.label
  ) {
    // Formation writes are not automated: the payload could not be verified,
    // and guessing it could corrupt a lineup. So it is asked for explicitly.
    lines.push(
      `<i>Change formation from ${escapeHtml(report.currentFormation)} to ${escapeHtml(lineup.formation.label)} first.</i>`,
    );
  }

  for (const p of lineup.starters) {
    const opponent = p.nextOpponent
      ? ` — ${p.fixtureDifficulty > 0.65 ? "hard" : p.fixtureDifficulty < 0.45 ? "easy" : "even"} ${escapeHtml(p.nextOpponent)}`
      : "";
    lines.push(
      `${p.role}  <b>${escapeHtml(p.name)}</b>  ${p.expectedPoints.toFixed(1)}${opponent}`,
    );
  }

  // Anyone left out for a reason the user should know about, rather than
  // silently: an injury doubt they may be able to check themselves. Players
  // who have left the competition are skipped here because they already have
  // their own block, and their reason reads as a parenthetical inside one.
  const departedIds = new Set(report.departed.map((p) => p.playerId));
  const sidelined = lineup.excluded.filter(
    (p) => p.unavailableReason && !departedIds.has(p.playerId),
  );
  if (sidelined.length > 0) {
    // "out" and "doubtful" are different decisions for the reader: one is a
    // hole to fill, the other is a judgement they may be able to make better
    // than we can with an hour to go.
    const label = (p: (typeof sidelined)[number]) =>
      p.availability === "doubt"
        ? "doubtful"
        : escapeHtml(p.unavailableReason ?? "out");
    lines.push(
      `<i>Left out: ${sidelined
        .map((p) => `${escapeHtml(p.name)} (${label(p)})`)
        .join(", ")}</i>`,
    );
  }

  // A doubt that made the XI anyway is worth naming too: the projection is
  // already discounted for it, but the reader may know more than we do.
  const doubtfulStarters = lineup.starters.filter((p) => p.availability === "doubt");
  if (doubtfulStarters.length > 0) {
    lines.push(
      `<i>Fitness doubts in the XI: ${doubtfulStarters
        .map((p) => escapeHtml(p.name))
        .join(", ")} — still the best available.</i>`,
    );
  }

  if (lineup.incomplete) {
    const missing = Object.entries(lineup.shortfall)
      .map(([role, count]) => `${count} ${role}`)
      .join(", ");
    lines.push(`<i>Short of ${escapeHtml(missing)} — this XI is not complete.</i>`);
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
      action.kind === "steal_clause" || action.kind === "clause_bet"
        ? "clause"
        : action.kind === "buy"
          ? "bid"
          : action.kind === "sell"
            ? "sell"
            : null;
    if (!verb) continue;

    // The bid, not the asking price: a button that offers the floor loses every
    // contested auction, which is what it used to do.
    const price = action.bid ?? Math.abs(action.money ?? 0);
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

export async function sendReport(
  report: AnalysisReport,
  automationNotes: string[] = [],
): Promise<{ sent: number }> {
  return notify(formatReport(report, automationNotes), buildActionButtons(report));
}
