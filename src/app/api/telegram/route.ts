import { NextRequest, NextResponse } from "next/server";
import { runAnalysis } from "@/lib/engine";
import { formatReportMessage, notify } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TgUpdate {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const candidate = req.headers.get("x-telegram-bot-api-secret-token");
    if (secret && candidate !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const update = (await req.json().catch(() => null)) as TgUpdate | null;
    const text = update?.message?.text ?? "";
    const chatId = update?.message?.chat?.id;

    if (!chatId) return NextResponse.json({ ok: true });

    if (text === "/start") {
      await notify(`👋 FutmondoBot online. Ask me for <code>/status</code>.`);
      return NextResponse.json({ ok: true });
    }

    if (text === "/status" || text === "status") {
      const report = await runAnalysis();
      const msg = formatReportMessage(report);
      await notify(msg);
      return NextResponse.json({ ok: true });
    }

    await notify(`Unknown command: <code>${text}</code>`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
