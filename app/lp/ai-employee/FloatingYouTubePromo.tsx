"use client";

import { useState, useEffect } from "react";
import Image from "next/image";

const STORAGE_KEY = "ai-emp-yt-float-collapsed";
const YOUTUBE_VIDEO_ID = "l4fVZ1-VRcU";
const YOUTUBE_EMBED_URL = `https://www.youtube-nocookie.com/embed/${YOUTUBE_VIDEO_ID}?rel=0`;
const YOUTUBE_WATCH_URL = `https://youtu.be/${YOUTUBE_VIDEO_ID}`;
const THUMBNAIL_SRC = "/lp/ai-employee/youtube-ai-agents-100cho.jpg";

export function FloatingYouTubePromo() {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const wasCollapsed = sessionStorage.getItem(STORAGE_KEY) === "1";
    setCollapsed(wasCollapsed);
    setMounted(true);

    const mql = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mql.matches);

    const handleChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handleChange);

    return () => mql.removeEventListener("change", handleChange);
  }, []);

  const handleCollapse = () => {
    sessionStorage.setItem(STORAGE_KEY, "1");
    setCollapsed(true);
  };

  const handleExpand = () => {
    sessionStorage.setItem(STORAGE_KEY, "0");
    setCollapsed(false);
  };

  if (!mounted) return null;

  if (collapsed) {
    return (
      <div
        className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6 animate-fade-in"
        role="complementary"
        aria-label="YouTube動画プロモーション"
      >
        <CollapsedChip onExpand={handleExpand} />
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6 animate-fade-in"
      role="complementary"
      aria-label="YouTube動画プロモーション"
    >
      {isDesktop ? (
        <DesktopPlayer onCollapse={handleCollapse} />
      ) : (
        <MobilePlayer onCollapse={handleCollapse} />
      )}
    </div>
  );
}

function CollapsedChip({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      className="group flex items-center gap-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-full px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.4)] hover:shadow-[0_12px_40px_rgba(0,0,0,0.5)] transition-all hover:scale-105"
      aria-label="動画を開く"
      type="button"
    >
      <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center shrink-0">
        <svg
          className="w-4 h-4 text-white ml-0.5"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
      <span className="text-sm font-medium text-[var(--text)] whitespace-nowrap pr-1">
        動画を見る
      </span>
    </button>
  );
}

function DesktopPlayer({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="relative w-[360px] rounded-2xl overflow-hidden bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
      <CollapseButton onCollapse={onCollapse} />
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

function MobilePlayer({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="relative bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,0.5)] w-[280px]">
      <CollapseButton onCollapse={onCollapse} />
      <a
        href={YOUTUBE_WATCH_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group block"
        aria-label="YouTubeで動画を見る: AIエージェント100兆個の話を、現場の経営者向けに翻訳する"
      >
        <div className="relative w-full aspect-video">
          <Image
            src={THUMBNAIL_SRC}
            alt=""
            fill
            sizes="280px"
            className="object-cover"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
            <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center shadow-lg">
              <svg
                className="w-6 h-6 text-white ml-1"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm muted leading-snug line-clamp-2">
            AIエージェント100兆個の話を、現場の経営者向けに翻訳する
          </p>
          <p className="mt-1 text-xs text-[var(--accent-strong)] font-medium">
            YouTubeで見る →
          </p>
        </div>
      </a>
    </div>
  );
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <button
      onClick={onCollapse}
      className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-[var(--bg)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-soft)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-strong)] focus:ring-offset-2 focus:ring-offset-[var(--bg-elevated)]"
      aria-label="最小化"
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
