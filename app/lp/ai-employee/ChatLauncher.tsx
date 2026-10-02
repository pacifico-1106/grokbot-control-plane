"use client";

/**
 * LP AI consultation chat launcher (PR-1d).
 *
 * Rendered only when LP_CHAT_ENABLED is ON (the server page decides). The
 * guest must accept the AI disclosure and privacy policy before a journey is
 * created. Nothing here can purchase or confirm a handoff: proposal cards link
 * to the checkout confirm page, and handoff cards open the confirm page where
 * the guest reviews and approves what is shared.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LP_CSRF_HEADER,
  LP_PRIVACY_VERSION,
  LP_CHAT_GREETING,
  buildTurnHistory,
  isSafeLpPath,
  parseChatCard,
  readCsrfCookie,
  type ChatCard,
} from "@/lib/lp/client-session";
import { createTurnstileController, type TurnstileApi, type TurnstileController } from "@/lib/lp/turnstile-client";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  cards?: ChatCard[];
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function yen(n: number | null): string {
  return n === null ? "—" : `${n.toLocaleString("ja-JP")}円（税抜）`;
}

export function ChatLauncher({
  handoffEnabled,
  turnstileSiteKey,
}: {
  handoffEnabled: boolean;
  turnstileSiteKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileCtl = useRef<TurnstileController | null>(null);
  if (turnstileSiteKey && !turnstileCtl.current) {
    turnstileCtl.current = createTurnstileController({
      sitekey: turnstileSiteKey,
      getApi: () => window.turnstile,
      onTokenChange: setTurnstileToken,
      onError: ({ gaveUp }) => {
        if (gaveUp) setError("認証を完了できませんでした。ページを再読み込みしてお試しください。");
      },
    });
  }
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  // Load Cloudflare Turnstile only when a site key is configured and the consent step is visible.
  // The consent step's container is a new element each time it is shown (e.g. after a 401), so the
  // controller removes the old widget on unmount and renders a fresh one with a fresh token.
  useEffect(() => {
    const ctl = turnstileCtl.current;
    if (!open || csrfToken || !ctl || !turnstileRef.current) return;
    const el = turnstileRef.current;
    let cancelled = false;
    let script: HTMLScriptElement | null = null;
    const render = () => {
      if (!cancelled) ctl.mount(el);
    };
    if (window.turnstile) {
      render();
    } else {
      script = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = TURNSTILE_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
    }
    return () => {
      cancelled = true;
      script?.removeEventListener("load", render);
      ctl.unmount();
    };
  }, [open, csrfToken]);

  const startJourney = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Turnstile tokens are single-use: take it for this attempt (clears it and resets the widget).
    const ctl = turnstileCtl.current;
    const attemptToken = ctl ? ctl.takeToken() : null;
    let started = false;
    try {
      const res = await fetch("/api/journeys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          aiDisclosureAccepted: true,
          privacyVersion: LP_PRIVACY_VERSION,
          turnstileToken: attemptToken ?? undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || typeof data.csrfToken !== "string") {
        setError(data?.message ?? "チャットを開始できませんでした。時間をおいてお試しください。");
        return;
      }
      started = true;
      setCsrfToken(data.csrfToken);
      setMessages([
        { id: "greeting", role: "assistant", text: LP_CHAT_GREETING },
      ]);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      // Any failed start (400 turnstile_failed, 401/403/429/5xx, network) needs a fresh challenge.
      if (!started) ctl?.reset();
      setBusy(false);
    }
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const token = csrfToken ?? readCsrfCookie(document.cookie);
    if (!token) {
      setError("セッションが切れました。もう一度開始してください。");
      setCsrfToken(null);
      return;
    }
    setInput("");
    setBusy(true);
    setError(null);
    const clientTurnId = crypto.randomUUID();
    // The server keeps no message text, so the transcript so far goes with each turn.
    const history = buildTurnHistory(messages);
    setMessages((m) => [...m, { id: clientTurnId, role: "user", text }]);
    try {
      const res = await fetch("/api/chat/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", [LP_CSRF_HEADER]: token },
        credentials: "same-origin",
        body: JSON.stringify({ text, clientTurnId, history }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        if (res.status === 401) setCsrfToken(null);
        setError(data?.message ?? "エラーが発生しました。");
        return;
      }
      const cards = Array.isArray(data.cards)
        ? data.cards.map(parseChatCard).filter((c: ChatCard | null): c is ChatCard => c !== null)
        : [];
      setMessages((m) => [
        ...m,
        { id: `${clientTurnId}-r`, role: "assistant", text: String(data.reply ?? ""), cards },
      ]);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  }, [input, busy, csrfToken, messages]);

  const requestHandoff = useCallback(
    async (card: Extract<ChatCard, { type: "handoff_preview" }>) => {
      const token = csrfToken ?? readCsrfCookie(document.cookie);
      if (!token) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/lp/handoff", {
          method: "POST",
          headers: { "Content-Type": "application/json", [LP_CSRF_HEADER]: token },
          credentials: "same-origin",
          body: JSON.stringify({ reason: card.reason, summaryDraft: card.summaryDraft }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !isSafeLpPath(data?.confirmUrl)) {
          setError("相談の準備に失敗しました。");
          return;
        }
        window.location.assign(data.confirmUrl);
      } catch {
        setError("通信に失敗しました。");
      } finally {
        setBusy(false);
      }
    },
    [csrfToken]
  );

  return (
    <>
      {/* Phones: reserve the space the fixed dock covers so the footer can scroll clear of it. */}
      <div aria-hidden="true" className="h-[var(--lp-chat-dock-h)] sm:hidden" />
      {/*
        Phones (< sm): the launcher sits in its own fixed bottom bar next to a
        相談する link instead of floating over the page, so it can never cover the
        page's full-width 相談する CTAs or the YouTube promo (which is lifted above
        the bar via --lp-chat-dock-h). From sm up the bar is display:contents and
        the launcher floats bottom-left as before.
      */}
      <div
        data-testid="lp-chat-dock"
        className="fixed inset-x-0 bottom-0 z-[45] h-[var(--lp-chat-dock-h)] flex items-start gap-2 px-4 pt-2 border-t border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_88%,transparent)] backdrop-blur-xl sm:contents"
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`btn shrink-0 bg-transparent text-[var(--accent-strong)] border-[color-mix(in_oklab,var(--accent-strong)_45%,var(--border))]! sm:fixed sm:bottom-6 sm:left-6 sm:z-[45] sm:bg-[linear-gradient(135deg,var(--accent),#79eaf3)] sm:text-[var(--accent-fg)] sm:font-bold! sm:border-transparent! sm:shadow-lg ${open ? "sm:hidden!" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="AIに相談する"
          data-testid="lp-chat-launcher"
        >
          <svg className="w-4 h-4 shrink-0 sm:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 10h8M8 14h5M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.83L3 20l1.4-3.73A7.6 7.6 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span className="sm:hidden">AI相談</span>
          <span className="hidden sm:inline">AIに相談する</span>
        </button>
        <Link href="/lp/ai-employee/consult" className="btn btn-primary flex-1 min-w-0 sm:hidden!">
          相談する
        </Link>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="AI相談窓口"
          data-testid="lp-chat-panel"
          className="fixed left-4 right-4 z-50 bottom-[calc(var(--lp-chat-dock-h)+0.5rem)] max-h-[min(80vh,calc(100dvh-var(--lp-chat-dock-h)-1.5rem))] sm:right-auto sm:bottom-6 sm:left-6 sm:w-[380px] sm:max-h-[80vh] flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-soft)]">
            <div>
              <div className="text-sm font-semibold">AI相談窓口</div>
              <div className="text-xs faint">応答するのはAIです（人ではありません）</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm faint hover:text-[var(--text)]"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>

          {!csrfToken ? (
            <div className="p-4 flex flex-col gap-3 text-sm" data-testid="lp-chat-consent">
              <p>
                この窓口ではAIがご質問にお答えします。料金や契約は画面で確認してから確定し、会話だけで申込は成立しません。
                パスワードやカード番号は入力しないでください。
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consented}
                  onChange={(e) => setConsented(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  AIが応答することを理解し、
                  <Link href="/legal/privacy" target="_blank" className="underline">
                    プライバシーポリシー
                  </Link>
                  に同意します。
                </span>
              </label>
              {turnstileSiteKey && <div ref={turnstileRef} />}
              <button
                type="button"
                className="btn btn-primary"
                disabled={!consented || busy || (!!turnstileSiteKey && !turnstileToken)}
                onClick={startJourney}
              >
                相談をはじめる
              </button>
            </div>
          ) : (
            <>
              <div ref={listRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 text-sm" aria-live="polite">
                {messages.map((m) => (
                  <div key={m.id} className={m.role === "user" ? "self-end max-w-[85%]" : "self-start max-w-[90%]"}>
                    <div
                      className={
                        m.role === "user"
                          ? "rounded-xl px-3 py-2 bg-[var(--accent-strong)] text-white whitespace-pre-wrap"
                          : "rounded-xl px-3 py-2 bg-[var(--bg-soft)] whitespace-pre-wrap"
                      }
                    >
                      {m.text}
                    </div>
                    {m.cards?.map((card, i) =>
                      card.type === "proposal_card" ? (
                        <div key={i} className="mt-2 rounded-xl border border-[var(--border)] p-3" data-testid="lp-chat-proposal">
                          <div className="font-semibold">{card.displayName}</div>
                          <div className="text-xs faint mt-1">
                            初期 {yen(card.setupAmountExTax)} ／ 月額 {yen(card.monthlyAmountExTax)}
                          </div>
                          {card.note && <div className="text-xs faint mt-1">{card.note}</div>}
                          <Link href={card.checkoutUrl} className="btn btn-primary text-xs mt-2 inline-block">
                            申込内容を確認する
                          </Link>
                        </div>
                      ) : handoffEnabled ? (
                        <div key={i} className="mt-2 rounded-xl border border-[var(--border)] p-3" data-testid="lp-chat-handoff">
                          <div className="text-xs faint">担当者に共有する内容（次の画面で編集できます）</div>
                          <div className="mt-1 whitespace-pre-wrap">{card.summaryDraft}</div>
                          <button
                            type="button"
                            className="btn btn-primary text-xs mt-2"
                            disabled={busy}
                            onClick={() => requestHandoff(card)}
                          >
                            内容を確認して相談を依頼する
                          </button>
                        </div>
                      ) : null
                    )}
                  </div>
                ))}
                {busy && <div className="self-start text-xs faint">考えています…</div>}
              </div>
              <form
                className="flex gap-2 p-3 border-t border-[var(--border-soft)]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  maxLength={2000}
                  placeholder="任せたい業務を入力"
                  className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
                  aria-label="メッセージ"
                />
                <button type="submit" className="btn btn-primary text-sm" disabled={busy || !input.trim()}>
                  送信
                </button>
              </form>
            </>
          )}
          {error && (
            <div className="px-4 pb-3 text-xs text-red-500" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </>
  );
}
