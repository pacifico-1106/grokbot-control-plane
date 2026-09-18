"use client";

import { useState, useEffect } from "react";
import Image from "next/image";

const STORAGE_KEY = "ai-emp-yt-float-dismissed";
const YOUTUBE_VIDEO_ID = "l4fVZ1-VRcU";
const YOUTUBE_EMBED_URL = `https://www.youtube-nocookie.com/embed/${YOUTUBE_VIDEO_ID}?rel=0`;
const YOUTUBE_WATCH_URL = `https://youtu.be/${YOUTUBE_VIDEO_ID}`;
const THUMBNAIL_SRC = "/lp/ai-employee/youtube-ai-agents-100cho.jpg";

export function FloatingYouTubePromo() {
  const [dismissed, setDismissed] = useState(true);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const wasDismissed = sessionStorage.getItem(STORAGE_KEY) === "1";
    setDismissed(wasDismissed);

    const mql = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mql.matches);

    const handleChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handleChange);

    return () => mql.removeEventListener("change", handleChange);
  }, []);

  const handleDismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, "1");
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6 animate-fade-in"
      role="complementary"
      aria-label="YouTube動画プロモーション"
    >
      {isDesktop ? (
        <DesktopPlayer onDismiss={handleDismiss} />
      ) : (
        <MobileChip onDismiss={handleDismiss} />
      )}
    </div>
  );
}

function DesktopPlayer({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="relative w-[360px] rounded-2xl overflow-hidden bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
      <CloseButton onDismiss={onDismiss} />
      <div className="aspect-video">
        <iframe
          src={YOUTUBE_EMBED_URL}
          title="AIエージェント100兆個の話を、現場の経営者向けに翻訳する"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="w-full h-full border-0"
        />
      </div>
      <div className="px-4 py-3">
        <p className="text-xs muted leading-snug line-clamp-2">
          AIエージェント100兆個の話を、現場の経営者向けに翻訳する
        </p>
      </div>
    </div>
  );
}

function MobileChip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="relative flex items-center gap-3 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl p-2 pr-3 shadow-[0_12px_40px_rgba(0,0,0,0.5)] max-w-[280px]">
      <CloseButton onDismiss={onDismiss} />
      <a
        href={YOUTUBE_WATCH_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-3"
        aria-label="YouTubeで動画を見る: AIエージェント100兆個の話を、現場の経営者向けに翻訳する"
      >
        <div className="relative w-20 h-12 rounded-lg overflow-hidden shrink-0">
          <Image
            src={THUMBNAIL_SRC}
            alt=""
            fill
            sizes="80px"
            className="object-cover"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
            <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center">
              <svg
                className="w-3 h-3 text-white ml-0.5"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </div>
        <div className="min-w-0 pr-6">
          <p className="text-[11px] muted leading-tight line-clamp-2">
            AIエージェント100兆個の話
          </p>
          <p className="mt-1 text-[10px] text-[var(--accent-strong)]">
            YouTube →
          </p>
        </div>
      </a>
    </div>
  );
}

function CloseButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      onClick={onDismiss}
      className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-soft)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-strong)] focus:ring-offset-2 focus:ring-offset-[var(--bg-elevated)]"
      aria-label="閉じる"
      type="button"
    >
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    </button>
  );
}
