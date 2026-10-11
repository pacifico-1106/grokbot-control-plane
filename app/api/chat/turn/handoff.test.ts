/**
 * Handoff requests must always produce a working path.
 *
 * Regression for prod smoke 2026-10-02 20:04 JST (journey 41063396…, turn 3):
 * 「担当の方と話したいです」 → gpt-4o-mini answered in text with a fake 「要約案 … この要約で
 * よろしければ、承認をお願い致します。」 and tool_calls=null, so no handoff card appeared.
 * The fake model below does exactly that unless tool_choice forces handoff_offer.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
// IP_HASH_KEY is required (no dev fallback); fixture key for this test process.
process.env.IP_HASH_KEY = "test-ip-hash-key-fixture-0123456789";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const JOURNEY = { id: "j1", tenantId: "t", tokenHash: "hash:tok", activeAgent: "sales", kbReleaseId: "rel" };
let turnCount = 0;
const recorded: Array<{ toolCalls?: string[]; model?: string }> = [];

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => ({ lp_guest: { value: "tok.good" }, lp_csrf: { value: "c1" } } as Record<string, { value: string }>)[n],
  }),
}));
mock.module("@/lib/lp/journeys", () => ({
  parseGuestCookie: (v: string) => ({ token: v.split(".")[0], signature: v.split(".")[1] }),
  verifySignature: (_t: string, s: string) => s === "good",
  hashToken: (t: string) => `hash:${t}`,
  getJourneyByTokenHash: async (h: string) => (h === "hash:tok" ? JOURNEY : null),
  incrementTurnCount: async () => ++turnCount,
  recordChatTurn: async (input: { toolCalls?: string[]; model?: string }) => {
    recorded.push(input);
    return true;
  },
}));
mock.module("@/lib/lp/knowledge-base", () => ({
  getPublishedRelease: async () => ({ releaseId: "rel", releaseKey: "2026-10-01-initial" }),
  searchKnowledgeBase: async () => ({ releaseId: "rel", releaseKey: "k", status: "not_found", passages: [] }),
}));
type HandoffRow = { id: string; journeyId: string; status: string; reason: string; summaryDraft: string; createdAt: string; confirmedAt?: string };
const handoffRows = new Map<string, HandoffRow>();
mock.module("@/lib/lp/handoffs", () => ({
  createHandoff: async (i: { journeyId: string; reason: string; summaryDraft: string }) => {
    const row = { id: "11111111-2222-3333-4444-555555555555", status: "pending_confirmation", createdAt: "now", ...i };
    handoffRows.set(row.id, row);
    return row;
  },
  getHandoff: async (id: string) => handoffRows.get(id) ?? null,
  confirmHandoff: async (i: { handoffId: string }) => {
    const row = handoffRows.get(i.handoffId);
    if (!row || row.status !== "pending_confirmation") return null;
    row.status = "confirmed";
    row.confirmedAt = "now";
    return row;
  },
  cancelHandoff: async () => true,
}));
const notified: string[] = [];
mock.module("@/lib/lp/outbox-processor", () => ({
  enqueueHandoffNotification: async (h: { id: string }) => {
    notified.push(h.id);
  },
}));

const PROD_FAKE_TEXT =
  "担当者との相談をお手伝いします。以下の要約をご確認ください。\n\n**要約案:**\n- AI社員で任せられる業務と料金の目安を確認したい\n\nこの要約でよろしければ、承認をお願い致します。";

type Msg = { role: string; content: string; tool_calls?: unknown[] };
type ReqBody = { messages: Msg[]; tools?: Array<{ function: { name: string } }>; tool_choice?: unknown };
const openAiRequests: ReqBody[] = [];
let stubborn = false; // ignores even a forced tool_choice

function completion(message: Record<string, unknown>, finish: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 1077, completion_tokens: 62 } }),
    { status: 200 }
  );
}

/** Reproduces prod turn 3: answers handoff requests with a fake text summary. */
function turn3Model(body: ReqBody): Response {
  const forced = body.tool_choice as { function?: { name?: string } } | string | undefined;
  const lastIsTool = body.messages.at(-1)?.role === "tool";
  if (lastIsTool) return completion({ content: "下のカードから内容を確認してください。" }, "stop");
  if (!stubborn && typeof forced === "object" && forced?.function?.name === "handoff_offer") {
    return completion(
      { content: null, tool_calls: [{ id: "call_h", type: "function", function: { name: "handoff_offer", arguments: JSON.stringify({ reason: "担当者との相談希望", summaryDraft: "業務と料金の目安を確認したい" }) } }] },
      "tool_calls"
    );
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user")!.content;
  if (/担当|話したい|よろしく/.test(lastUser)) return completion({ content: PROD_FAKE_TEXT }, "stop");
  return completion({ content: `回答: ${lastUser}` }, "stop");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith("https://api.openai.com/")) throw new Error("unexpected_network");
  const body = JSON.parse(String(init?.body)) as ReqBody;
  openAiRequests.push(body);
  return turn3Model(body);
}) as typeof fetch;

const envKeys = ["LP_CHAT_ENABLED", "LP_CHAT_TOOLS_ENABLED", "LP_HANDOFF_ENABLED", "OPENAI_API_KEY"] as const;
const envBackup = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
process.env.LP_CHAT_ENABLED = "1";
process.env.OPENAI_API_KEY = "sk-test-not-real";

const chatRoute = await import("@/app/api/chat/turn/route");
const handoffRoute = await import("@/app/api/lp/handoff/route");
const cs = await import("@/lib/lp/client-session");
const { detectHandoffIntent, looksLikeFakeHandoffText } = await import("@/lib/lp/handoff-intent");

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of envKeys) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

beforeEach(() => {
  process.env.LP_CHAT_TOOLS_ENABLED = "1";
  process.env.LP_HANDOFF_ENABLED = "1";
  openAiRequests.length = 0;
  recorded.length = 0;
  handoffRows.clear();
  notified.length = 0;
  stubborn = false;
  turnCount = 2;
});

const HISTORY = [
  { role: "assistant", text: "AI相談窓口です。どの業務を任せたいですか。" },
  { role: "user", text: "StaffpassのAI社員でどんな業務を任せられますか？" },
  { role: "assistant", text: "日報・議事録などの下書きを任せられます。" },
  { role: "user", text: "料金の目安も教えてください" },
  { role: "assistant", text: "インターンは月額50,000円（税別）です。" },
];

async function chat(text: string) {
  const res = await chatRoute.POST(
    new Request("https://staffpass.example/api/chat/turn", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "c1" },
      body: JSON.stringify({ text, clientTurnId: crypto.randomUUID(), history: HISTORY }),
    })
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; reply: string; cards?: unknown[] } };
}

function cardsOf(body: { cards?: unknown[] }) {
  return (body.cards ?? []).map(cs.parseChatCard).filter((c): c is NonNullable<typeof c> => c !== null);
}

describe("turn 3 「担当の方と話したいです」 with LP_HANDOFF_ENABLED ON", () => {
  test("forces handoff_offer and returns a handoff card (not the fake text approval)", async () => {
    const { status, body } = await chat("担当の方と話したいです");
    expect(status).toBe(200);
    expect(openAiRequests[0].tool_choice).toEqual({ type: "function", function: { name: "handoff_offer" } });
    const cards = cardsOf(body);
    expect(cards.map((c) => cs.chatCardView(c, true))).toEqual(["handoff"]);
    expect(body.reply).not.toContain("承認をお願い");
    expect(recorded.at(-1)?.toolCalls).toEqual(["handoff_offer"]);
  });

  test("model that ignores the forced tool still yields a server-built handoff card", async () => {
    stubborn = true;
    const { body } = await chat("担当の方と話したいです");
    const cards = cardsOf(body);
    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe("handoff_preview");
    const card = cards[0] as Extract<typeof cards[0], { type: "handoff_preview" }>;
    expect(card.summaryDraft).toContain("料金の目安も教えてください");
    expect(card.summaryDraft).toContain("担当の方と話したいです");
    expect(body.reply).not.toContain("承認をお願い");
    expect(body.reply).not.toContain("要約案");
    expect(recorded.at(-1)?.toolCalls).toEqual(["handoff_offer:server"]);
  });

  test("fake approval text on a message the detector missed is replaced by a real card", async () => {
    const { body } = await chat("よろしくお願いします");
    expect(cardsOf(body).map((c) => c.type)).toEqual(["handoff_preview"]);
    expect(body.reply).not.toContain("承認をお願い");
  });

  test("end to end: card → POST /api/lp/handoff → confirm page state → PUT confirm", async () => {
    const { body } = await chat("担当の方と話したいです");
    const card = cardsOf(body)[0] as { type: "handoff_preview"; reason: string; summaryDraft: string };
    const headers = { "content-type": "application/json", "x-csrf-token": "c1" };
    const post = await handoffRoute.POST(
      new Request("https://staffpass.example/api/lp/handoff", { method: "POST", headers, body: JSON.stringify({ reason: card.reason, summaryDraft: card.summaryDraft }) }) as never
    );
    expect(post.status).toBe(200);
    const created = (await post.json()) as { id: string; confirmUrl: string };
    expect(cs.isSafeLpPath(created.confirmUrl)).toBe(true);

    const get = await handoffRoute.GET(new Request(`https://staffpass.example/api/lp/handoff?id=${created.id}`) as never);
    const view = (await get.json()) as { status: string; summaryDraft: string };
    expect(view.summaryDraft).toBe(card.summaryDraft);
    // The confirm form is editable only if this is true (it compared with "pending" before).
    expect(cs.isHandoffAwaitingConfirmation(view.status)).toBe(true);

    const put = await handoffRoute.PUT(
      new Request("https://staffpass.example/api/lp/handoff", { method: "PUT", headers, body: JSON.stringify({ handoffId: created.id, summaryFinal: view.summaryDraft, contactEmail: "guest@example.com" }) }) as never
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { status: string }).status).toBe("confirmed");
    expect(notified).toEqual([created.id]);
  });
});

describe("LP_HANDOFF_ENABLED OFF", () => {
  test("handoff request gets the contact form card without calling the model", async () => {
    delete process.env.LP_HANDOFF_ENABLED;
    const { body } = await chat("担当の方と話したいです");
    expect(openAiRequests.length).toBe(0);
    const cards = cardsOf(body);
    expect(cards.map((c) => cs.chatCardView(c, false))).toEqual(["contact"]);
    expect((cards[0] as { href: string }).href).toBe("/lp/ai-employee/consult");
    expect(body.reply).toContain("相談フォーム");
    expect(body.reply).not.toContain("承認");
  });

  test("fake approval text from the model is replaced by the contact path", async () => {
    delete process.env.LP_HANDOFF_ENABLED;
    const { body } = await chat("よろしくお願いします");
    expect(cardsOf(body).map((c) => c.type)).toEqual(["contact_link"]);
    expect(body.reply).not.toContain("承認をお願い");
  });

  test("a stray handoff_preview card renders as the contact link, never a dead approve button", () => {
    const card = cs.parseChatCard({ type: "handoff_preview", reason: "r", summaryDraft: "s" })!;
    expect(cs.chatCardView(card, false)).toBe("contact");
  });
});

describe("intent detection", () => {
  test("requests for a person / contact are detected", () => {
    for (const t of [
      "担当の方と話したいです", "担当者に繋いでください", "人と話したい", "人間と話せますか", "営業の方から連絡がほしい",
      "見積もりがほしいです", "見積りをお願いします", "電話してほしい", "問い合わせしたい", "担当者と相談したい",
      "折り返し連絡ください", "オペレーターにつないで", "デモを希望します", "担当者に業務を相談したい",
    ]) expect([t, detectHandoffIntent(t)]).toEqual([t, true]);
  });

  test("task descriptions and ordinary questions are not handoffs", () => {
    for (const t of [
      "StaffpassのAI社員でどんな業務を任せられますか？", "料金の目安も教えてください", "電話対応を任せたい",
      "見積書作成を自動化したい", "問い合わせ対応をAIに任せたい", "経理担当の業務を任せたい", "人の代わりになりますか",
      "何人で使えますか", "相談したいです", "担当者は付きますか",
    ]) expect([t, detectHandoffIntent(t)]).toEqual([t, false]);
  });

  test("fake handoff text detector matches the prod reply", () => {
    expect(looksLikeFakeHandoffText(PROD_FAKE_TEXT)).toBe(true);
    expect(looksLikeFakeHandoffText("インターンは月額50,000円（税別）です。")).toBe(false);
  });
});

describe("UI wiring", () => {
  const launcher = readFileSync(join(process.cwd(), "app/lp/ai-employee/ChatLauncher.tsx"), "utf8");
  const confirm = readFileSync(join(process.cwd(), "app/lp/ai-employee/handoff/confirm/HandoffConfirmClient.tsx"), "utf8");
  test("launcher renders handoff and contact cards via chatCardView", () => {
    expect(launcher).toContain('chatCardView(card, handoffEnabled) === "handoff"');
    expect(launcher).toContain('data-testid="lp-chat-contact"');
    expect(launcher).toContain("href={LP_CONSULT_PATH}");
    expect(launcher).toContain("onClick={() => requestHandoff(card)}");
  });
  test("confirm page uses the real pending status", () => {
    expect(confirm).toContain("isHandoffAwaitingConfirmation(state.status)");
    expect(confirm).not.toContain('state.status === "pending"');
  });
});
