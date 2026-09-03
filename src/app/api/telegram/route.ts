import { NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/engine";
import { dbTokenStore } from "@/lib/db/token-store";
import * as repo from "@/lib/db/repo";
import { FutmondoClient } from "@/lib/futmondo/client";
import { fmtMoney } from "@/lib/engine/types";
import {
  answerCallback,
  buildActionButtons,
  buildConfirmButtons,
  escapeHtml,
  formatReport,
  isAllowedChat,
  sendMessage,
} from "@/lib/telegram";
import { decodeCallback, needsConfirmation, type CallbackAction } from "@/lib/telegram/callbacks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface TelegramUpdate {
  message?: { chat?: { id?: number }; text?: string };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number } };
  };
}

/**
 * Telegram retries a webhook it thinks failed, which would replay a bid. Ids
 * seen in this instance are remembered so a retry is a no-op. Cold starts lose
 * the set, which is why money actions also require an explicit confirm tap.
 */
const handledUpdates = new Set<string>();

/** Bounded so a long-lived warm instance cannot grow the set without limit. */
const MAX_HANDLED_UPDATES = 500;

function rememberUpdate(id: string): void {
  handledUpdates.add(id);
  if (handledUpdates.size > MAX_HANDLED_UPDATES) {
    // Insertion-ordered, so the oldest ids are the first to go.
    for (const stale of handledUpdates) {
      handledUpdates.delete(stale);
      if (handledUpdates.size <= MAX_HANDLED_UPDATES) break;
    }
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.CRON_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update) return NextResponse.json({ ok: true });

  const chatId =
    update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;

  // Anyone not on the allowlist is ignored silently: replying would confirm
  // the bot exists to whoever found it.
  if (!isAllowedChat(chatId)) {
    return NextResponse.json({ ok: true });
  }
  const chat = chatId as number;

  try {
    if (update.callback_query) {
      await handleCallback(chat, update.callback_query);
    } else if (update.message?.text) {
      await handleCommand(chat, update.message.text.trim());
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Always answer 200: a 500 makes Telegram retry, and a retry on a money
    // action is the one thing we must never risk.
    await sendMessage(chat, `Something went wrong: ${escapeHtml(detail)}`).catch(
      () => undefined,
    );
  }

  return NextResponse.json({ ok: true });
}

const HELP = [
  "<b>FutmondoBot</b>",
  "",
  "/today — what to do now, with buttons for money moves",
  "/lineup — the suggested XI and why",
  "/market — buy and sell picks",
  "/clauses — steal targets and your exposed players",
  "/funds — your money and the rivals' estimated cash",
  "/log — the last automated actions",
  "",
  "Lineups and clause blocks happen automatically. Bids, clause payments and sales always need your tap.",
].join("\n");

async function handleCommand(chat: number, text: string): Promise<void> {
  const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");

  if (command === "/start" || command === "/help") {
    await sendMessage(chat, HELP);
    return;
  }

  if (command === "/log") {
    const rows = await repo.getRecentActions(10).catch(() => []);
    if (rows.length === 0) {
      await sendMessage(chat, "No automated actions recorded yet.");
      return;
    }
    const lines = rows.map(
      (r) =>
        `${r.ok ? "✓" : "✗"} ${escapeHtml(r.action)} — ${new Date(r.createdAt).toLocaleString("es-ES")}${
          r.error ? `\n   ${escapeHtml(r.error)}` : ""
        }`,
    );
    await sendMessage(chat, `<b>Recent actions</b>\n${lines.join("\n")}`);
    return;
  }

  const report = await runAnalysis();

  switch (command) {
    case "/today":
    case "/status":
      await sendMessage(chat, formatReport(report), buildActionButtons(report));
      return;

    case "/lineup": {
      const lines = [
        `<b>${report.lineup.formation.label}</b> — ${escapeHtml(report.lineup.summary)}`,
        "",
        ...report.lineup.starters.map(
          (p) =>
            `${p.role} <b>${escapeHtml(p.name)}</b> ${p.expectedPoints.toFixed(1)} pts — ${escapeHtml(p.notes.join(", "))}`,
        ),
      ];
      if (report.lineup.bench.length > 0) {
        lines.push(
          "",
          `<i>Bench: ${report.lineup.bench
            .map((p) => `${escapeHtml(p.name)} ${p.expectedPoints.toFixed(1)}`)
            .join(", ")}</i>`,
        );
      }
      await sendMessage(chat, lines.join("\n"));
      return;
    }

    case "/market": {
      const lines = [`<b>${escapeHtml(report.market.headline)}</b>`, ""];
      const buys = report.market.buys.slice(0, 5);
      if (buys.length === 0) lines.push("Nothing in today's market improves the XI.");
      for (const buy of buys) {
        lines.push(
          `${buy.affordable ? "•" : "✗"} <b>${escapeHtml(buy.player.name)}</b> ${fmtMoney(buy.price)} — ${escapeHtml(buy.reason)}`,
        );
      }
      const sells = report.market.sells.filter((s) => s.cost === 0).slice(0, 4);
      if (sells.length > 0) {
        lines.push("", "<b>Worth selling</b>");
        for (const sell of sells) {
          lines.push(
            `• <b>${escapeHtml(sell.player.name)}</b> ${fmtMoney(sell.player.value)} — ${escapeHtml(sell.reason)}`,
          );
        }
      }
      await sendMessage(chat, lines.join("\n"), buildActionButtons(report));
      return;
    }

    case "/clauses": {
      const lines = [`<b>${escapeHtml(report.clauses.headline)}</b>`, ""];
      const steals = report.clauses.steals.slice(0, 5);
      if (steals.length === 0) lines.push("No clause targets known. Run the clause sync.");
      for (const steal of steals) {
        lines.push(
          `${steal.affordable ? "•" : "✗"} <b>${escapeHtml(steal.player.name)}</b> ${fmtMoney(steal.clausePrice)} — ${escapeHtml(steal.reason)}`,
        );
      }
      const exposed = report.clauses.exposed.filter((e) => e.threats.length > 0).slice(0, 5);
      if (exposed.length > 0) {
        lines.push("", "<b>Yours at risk</b>");
        for (const risk of exposed) {
          lines.push(
            `${risk.alreadyLocked ? "[blocked]" : "•"} <b>${escapeHtml(risk.player.name)}</b> — ${escapeHtml(risk.reason)}`,
          );
        }
      }
      await sendMessage(chat, lines.join("\n"), buildActionButtons(report));
      return;
    }

    case "/funds": {
      const lines = [
        `<b>Your money</b>`,
        `Available ${fmtMoney(report.funds)} · squad ${fmtMoney(report.teamValue)}`,
        `Committed to bids ${fmtMoney(report.reserved)} · max offer ${fmtMoney(report.market.maxOffer)}`,
      ];
      const rivals = report.rivalFunds
        .filter((r) => r.teamId !== report.scope?.userteamId)
        .sort((a, b) => b.estimatedFunds - a.estimatedFunds)
        .slice(0, 13);
      if (rivals.length > 0) {
        lines.push(
          "",
          "<b>Rivals, estimated</b>",
          ...rivals.map(
            (r) =>
              `${escapeHtml(r.teamName ?? r.teamId)} ~${fmtMoney(r.estimatedFunds)}${
                r.ledgerRows < 5 ? " <i>(thin data)</i>" : ""
              }`,
          ),
          "",
          "<i>Reconstructed from the transfer ledger, since this league hides funds. Ranking is reliable; absolute figures are approximate.</i>",
        );
      }
      await sendMessage(chat, lines.join("\n"));
      return;
    }

    default:
      await sendMessage(chat, HELP);
  }
}

async function handleCallback(
  chat: number,
  query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  const queryId = query.id;
  if (queryId) {
    if (handledUpdates.has(queryId)) {
      await answerCallback(queryId);
      return;
    }
    rememberUpdate(queryId);
  }

  const action = query.data ? decodeCallback(query.data) : null;
  if (!action) {
    if (queryId) await answerCallback(queryId, "Unrecognised button.");
    return;
  }

  if (action.verb === "refresh") {
    if (queryId) await answerCallback(queryId, "Refreshing");
    const report = await runAnalysis();
    await sendMessage(chat, formatReport(report), buildActionButtons(report));
    return;
  }

  if (!action.playerId) {
    if (queryId) await answerCallback(queryId, "That button is missing a player.");
    return;
  }

  // First tap on a money action: ask again with the amount spelled out.
  if (needsConfirmation(action.verb) && !action.confirmed) {
    if (queryId) await answerCallback(queryId);
    const price = action.price ?? 0;
    await sendMessage(
      chat,
      [
        `<b>Confirm ${action.verb === "sell" ? "sale" : "payment"} of ${fmtMoney(price)}?</b>`,
        action.verb === "sell"
          ? "The player leaves your squad."
          : "This spends real budget and cannot be undone.",
      ].join("\n"),
      buildConfirmButtons(action.verb, action.playerId, price),
    );
    return;
  }

  if (queryId) await answerCallback(queryId, "Working on it");
  await execute(chat, action);
}

async function execute(chat: number, action: CallbackAction): Promise<void> {
  const client = new FutmondoClient({ tokenStore: dbTokenStore });
  const scope = await client.resolveScope();
  const playerId = action.playerId as string;
  const price = action.price ?? 0;

  // Re-check affordability now rather than trusting a price from a message
  // that may be hours old and predate other spending.
  if (action.verb !== "sell" && action.verb !== "lock") {
    const info = await client.getUserTeamInformation(scope);
    if (price > info.funds) {
      await sendMessage(
        chat,
        `Not doing that: it needs ${fmtMoney(price)} but only ${fmtMoney(info.funds)} is available now.`,
      );
      return;
    }
  }

  // A slug is required alongside the id for market writes, and is only learned
  // from /1/player/summary.
  let slug: string | undefined;
  if (action.verb === "bid" || action.verb === "clause") {
    const summary = await client.getPlayerSummary(scope, playerId);
    slug = summary?.slug;
    if (!slug) {
      await sendMessage(
        chat,
        "Futmondo did not return this player's slug, which is required to bid. Try again in a moment.",
      );
      return;
    }
  }

  try {
    switch (action.verb) {
      case "clause":
        await client.payClause(scope, { playerId, playerSlug: slug as string, price });
        await sendMessage(chat, `✓ Clause paid: ${fmtMoney(price)}.`);
        break;
      case "bid":
        await client.placeBid(scope, {
          playerId,
          playerSlug: slug as string,
          price,
        });
        await sendMessage(chat, `✓ Bid placed: ${fmtMoney(price)}.`);
        break;
      case "sell":
        await client.putOnMarket(scope, { playerId, price });
        await sendMessage(chat, `✓ Listed for ${fmtMoney(price)}.`);
        break;
      case "lock":
        await client.lockPlayer(scope.championshipId, playerId);
        await sendMessage(chat, "✓ Clause blocked.");
        break;
      default:
        return;
    }
    await repo
      .logAction({
        action: `telegram:${action.verb}`,
        target: playerId,
        detail: { price },
        ok: true,
      })
      .catch(() => undefined);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await sendMessage(chat, `Futmondo rejected it: ${escapeHtml(detail)}`);
    await repo
      .logAction({
        action: `telegram:${action.verb}`,
        target: playerId,
        detail: { price },
        ok: false,
        error: detail,
      })
      .catch(() => undefined);
  }
}
