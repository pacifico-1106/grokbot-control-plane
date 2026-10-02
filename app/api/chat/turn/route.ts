/**
 * POST /api/chat/turn
 * 
 * Send a chat message and get AI response.
 * Feature flag LP_CHAT_ENABLED must be ON.
 * 
 * Uses OpenAI chat completions with tool calling.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isLpChatEnabled, isLpChatToolsEnabled, isLpHandoffEnabled } from "@/lib/feature-flags";
import {
  getJourneyByTokenHash,
  parseGuestCookie,
  verifySignature,
  hashToken,
  incrementTurnCount,
  recordChatTurn,
} from "@/lib/lp/journeys";
import { executeTool } from "@/lib/lp/chat-tools";
import { getPublishedRelease } from "@/lib/lp/knowledge-base";
import { sanitizeHistory, type ChatCapabilities } from "@/lib/lp/chat-prompt";
import { resolveChatModel } from "@/lib/lp/chat-model";
import { ChatModelError, runChatTurn } from "@/lib/lp/chat-turn";
import { HANDOFF_OFF_REPLY, contactLinkCard, detectHandoffIntent } from "@/lib/lp/handoff-intent";

const GUEST_COOKIE_NAME = "lp_guest";
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_COOKIE_NAME = "lp_csrf";

// System prompt, tool selection and history handling live in lib/lp/chat-prompt.ts;
// the OpenAI tool loop and handoff guarantees in lib/lp/chat-turn.ts.

export async function POST(req: Request) {
  if (!isLpChatEnabled()) {
    return NextResponse.json(
      { ok: false, error: "feature_disabled", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey.startsWith("replace_me")) {
    return NextResponse.json(
      { ok: false, error: "chat_unavailable", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const cookieStore = await cookies();
  const guestCookie = cookieStore.get(GUEST_COOKIE_NAME)?.value;

  if (!guestCookie) {
    return NextResponse.json(
      { ok: false, error: "auth_required", message: "セッションが必要です" },
      { status: 401 }
    );
  }

  const parsed = parseGuestCookie(guestCookie);
  if (!parsed || !verifySignature(parsed.token, parsed.signature)) {
    return NextResponse.json(
      { ok: false, error: "invalid_session", message: "無効なセッションです" },
      { status: 401 }
    );
  }

  const csrfHeader = req.headers.get(CSRF_HEADER_NAME);
  const csrfCookie = cookieStore.get(CSRF_COOKIE_NAME)?.value;

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
    return NextResponse.json(
      { ok: false, error: "csrf_invalid", message: "無効なリクエストです" },
      { status: 403 }
    );
  }

  const tokenHash = hashToken(parsed.token);
  const journey = await getJourneyByTokenHash(tokenHash);

  if (!journey) {
    return NextResponse.json(
      { ok: false, error: "session_expired", message: "セッションの有効期限が切れました" },
      { status: 401 }
    );
  }

  let body: { text?: string; clientTurnId?: string; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { text, clientTurnId } = body;
  const history = sanitizeHistory(body.history);

  if (!text || typeof text !== "string") {
    return NextResponse.json(
      { ok: false, error: "text_required", message: "メッセージを入力してください" },
      { status: 400 }
    );
  }

  if (text.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "text_too_long", message: "メッセージは2000文字以内で入力してください" },
      { status: 400 }
    );
  }

  const turnNumber = await incrementTurnCount(journey.id);
  if (turnNumber === null) {
    return NextResponse.json(
      { ok: false, error: "turn_limit_exceeded", message: "このセッションの上限に達しました。新しいセッションを開始してください。" },
      { status: 429 }
    );
  }

  const kbRelease = await getPublishedRelease();
  const model = resolveChatModel();

  const caps: ChatCapabilities = {
    toolsEnabled: isLpChatToolsEnabled(),
    handoffEnabled: isLpHandoffEnabled(),
  };

  // With LP_HANDOFF_ENABLED OFF an explicit request for a person gets the contact form
  // card without a model call (prod smoke 2026-10-02 turn 3).
  if (detectHandoffIntent(text) && !caps.handoffEnabled) {
    await recordChatTurn({
      journeyId: journey.id,
      turnNumber,
      clientTurnId,
      kbReleaseId: kbRelease?.releaseId,
      model: "rule:handoff_disabled",
      toolCalls: ["contact_link"],
    });
    return NextResponse.json({
      ok: true,
      reply: HANDOFF_OFF_REPLY,
      cards: [contactLinkCard()],
      kbReleaseId: kbRelease?.releaseId,
      turnNumber,
    });
  }

  try {
    const result = await runChatTurn({
      model,
      openaiKey,
      caps,
      history,
      text,
      runTool: (name, args) => executeTool(name, args, { journeyId: journey.id }),
    });

    await recordChatTurn({
      journeyId: journey.id,
      turnNumber,
      clientTurnId,
      kbReleaseId: kbRelease?.releaseId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model,
      toolCalls: result.toolCallsUsed.length > 0 ? result.toolCallsUsed : undefined,
    });

    return NextResponse.json({
      ok: true,
      reply: result.reply,
      citations: result.citations.length > 0 ? result.citations : undefined,
      cards: result.cards.length > 0 ? result.cards : undefined,
      kbReleaseId: kbRelease?.releaseId,
      turnNumber,
    });
  } catch (error) {
    if (error instanceof ChatModelError) {
      console.error("[chat] OpenAI API error:", error.status ?? "no_choice");
      return NextResponse.json(
        { ok: false, error: "ai_error", message: "AI応答の取得に失敗しました" },
        { status: 502 }
      );
    }
    console.error("[chat] Chat error:", error);
    return NextResponse.json(
      { ok: false, error: "chat_error", message: "エラーが発生しました" },
      { status: 500 }
    );
  }
}
