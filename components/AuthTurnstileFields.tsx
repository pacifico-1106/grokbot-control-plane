"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import Script from "next/script";
import {
  AUTH_TURNSTILE_SCRIPT_SRC,
  createAuthTurnstilePair,
  startAuthTurnstileMountPoll,
  type AuthTurnstileApi,
  type AuthTurnstilePair,
} from "@/lib/auth/auth-turnstile-client";
import {
  SUPABASE_AUTH_CAPTCHA_ACTION,
  SUPABASE_AUTH_CAPTCHA_FIELD,
} from "@/lib/auth/supabase-auth-captcha";

function turnstileApi(): AuthTurnstileApi | undefined {
  return (window as Window & { turnstile?: AuthTurnstileApi }).turnstile;
}

export function AuthTurnstileFields({
  siteKey,
  localAction,
  needUnusedSupabase,
  pairRef,
}: {
  siteKey: string;
  localAction: string;
  needUnusedSupabase: boolean;
  pairRef: MutableRefObject<AuthTurnstilePair | null>;
}) {
  const visibleRef = useRef<HTMLDivElement>(null);
  const executeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pair = createAuthTurnstilePair({
      sitekey: siteKey,
      localAction,
      needUnusedSupabase,
      getApi: turnstileApi,
    });
    pairRef.current = pair;

    const tryMount = () => {
      if (!visibleRef.current) return false;
      if (!pair.mountVisible(visibleRef.current)) return false;
      if (needUnusedSupabase) {
        if (!executeRef.current) return false;
        return pair.mountExecute(executeRef.current);
      }
      return true;
    };

    const stopPoll = startAuthTurnstileMountPoll(tryMount, {
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (id) => window.clearInterval(id as number),
    });

    return () => {
      stopPoll();
      pair.unmount();
      if (pairRef.current === pair) pairRef.current = null;
    };
  }, [siteKey, localAction, needUnusedSupabase, pairRef]);

  return (
    <>
      <Script src={AUTH_TURNSTILE_SCRIPT_SRC} strategy="afterInteractive" />
      {/* No class="cf-turnstile": implicit render would double-draw with render=explicit. */}
      <div
        ref={visibleRef}
        data-auth-turnstile="visible"
        data-sitekey={siteKey}
        data-action={localAction}
        data-language="ja"
      />
      {needUnusedSupabase ? (
        <div
          ref={executeRef}
          data-sitekey={siteKey}
          data-action={SUPABASE_AUTH_CAPTCHA_ACTION}
          data-response-field-name={SUPABASE_AUTH_CAPTCHA_FIELD}
          data-execution="execute"
          data-appearance="execute"
          data-language="ja"
          aria-hidden="true"
        />
      ) : null}
    </>
  );
}
