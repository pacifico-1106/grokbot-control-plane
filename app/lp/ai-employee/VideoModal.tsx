"use client";

import { useEffect, useId, useRef, type MouseEvent } from "react";

/**
 * Large centred YouTube dialog (reusable; enabled on LP pattern B only for now).
 * - role=dialog + aria-modal + aria-labelledby (visible title).
 * - Closes with the ✕ button, a click/tap on the backdrop, or Esc.
 * - Focus moves to ✕ on open, Tab is trapped inside, and focus goes back to the
 *   element that opened it (the caller's trigger) on close. Body scroll is locked.
 * - Opened by a user click, so autoplay=1 plays with sound. Closing unmounts the
 *   iframe, which stops playback.
 * youtube-nocookie fits the current CSP (LP pages set no frame-src / CSP), so no CSP change.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export function modalEmbedUrl(videoId: string): string {
  if (!VIDEO_ID.test(videoId)) throw new Error("invalid YouTube video id");
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

/**
 * Where focus must go for a Tab / Shift+Tab inside the dialog, or null to let the
 * browser move it. Pure so it can be unit-tested without a DOM.
 */
export function trapFocusTarget<T>(focusables: readonly T[], active: T | null, shiftKey: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const idx = active == null ? -1 : focusables.indexOf(active);
  if (idx < 0) return shiftKey ? last : first;
  if (focusables.length === 1) return first;
  if (shiftKey && idx === 0) return last;
  if (!shiftKey && idx === focusables.length - 1) return first;
  return null;
}

const FOCUSABLE = 'a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

export function VideoModal({
  open,
  videoId,
  title,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  videoId: string;
  title: string;
  onClose: () => void;
  /** Element to focus after closing (Safari does not focus a clicked button, so activeElement alone is not enough). */
  returnFocusTo?: () => HTMLElement | null;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnRef = useRef(returnFocusTo);
  returnRef.current = returnFocusTo;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = trapFocusTarget(items, active, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.overflow = prevOverflow;
      const target = returnRef.current?.() ?? opener;
      if (target && target.isConnected) target.focus();
    };
  }, [open]);

  if (!open) return null;

  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      data-testid="lp-video-modal-backdrop"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-6 animate-fade-in"
      onClick={onBackdrop}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[1100px] overflow-hidden bg-black sm:rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-[var(--bg-elevated)]">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="動画を閉じる"
            className="shrink-0 w-9 h-9 rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-strong)]"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="aspect-video w-full">
          <iframe
            src={modalEmbedUrl(videoId)}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            className="w-full h-full border-0"
          />
        </div>
      </div>
    </div>
  );
}
