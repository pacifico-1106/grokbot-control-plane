import { NextResponse } from "next/server";
import { listApprovalsForTelegramDigest } from "@/lib/data";
import {
  escapeTelegramHtml,
  sendTelegramText,
} from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "cron_not_configured" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const approvals = await listApprovalsForTelegramDigest();
  const now = Date.now();
  const pending = approvals.filter((item) => item.status === "pending");
  const stale = pending.filter(
    (item) => now - new Date(item.createdAt).getTime() >= 24 * 60 * 60 * 1_000
  );
  const recent = approvals.filter(
    (item) =>
      item.resolvedAt &&
      now - new Date(item.resolvedAt).getTime() <= 12 * 60 * 60 * 1_000
  );
  const count = (status: string) =>
    recent.filter((item) => item.status === status).length;
  const items = pending.slice(0, 10).map(
    (item, index) =>
      `${index + 1}. ${escapeTelegramHtml(item.title)} <code>#${escapeTelegramHtml(item.id.slice(0, 8))}</code>`
  );
  const text = [
    "📋 <b>StaffPass 承認ダイジェスト</b>",
    `承認待ち: <b>${pending.length}</b>件（24時間以上: ${stale.length}件）`,
    `直近12時間: ✅ ${count("approved")} / ❌ ${count("rejected")} / ✏️ ${count("revision_requested")}`,
    ...(items.length ? ["", "<b>承認待ち 上位10件</b>", ...items] : ["", "承認待ちはありません。"]),
  ].join("\n");

  const sent = await sendTelegramText(text);
  return NextResponse.json({
    ok: sent.ok || sent.skipped === true,
    skipped: sent.skipped ?? false,
    pending: pending.length,
    stale: stale.length,
    error: sent.error,
  });
}
