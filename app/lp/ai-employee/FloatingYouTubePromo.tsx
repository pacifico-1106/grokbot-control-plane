"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { getLpVariant, type LpPromoVideo } from "./variants";
import { VideoModal } from "./VideoModal";

const DEFAULT_VIDEO = getLpVariant("ai-employee").video;

/**
 * @param video which video (per LP variant). `expandToModal` makes a click open the
 *   large VideoModal; otherwise desktop plays inline and mobile links to YouTube (pattern A).
 * @param liftForChatDock when a fixed bottom bar is shown on phones (chat dock, sticky
 *   CTA), lift the promo above it so the two never overlap.
 */
export function FloatingYouTubePromo({
  video = DEFAULT_VIDEO,
  liftForChatDock = false,
}: { video?: LpPromoVideo; liftForChatDock?: boolean } = {}) {
  const STORAGE_KEY = video.storageKey;
  const [modalOpen, setModalOpen] = useState(false);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
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
  }, [STORAGE_KEY]);

  const handleCollapse = () => {
    sessionStorage.setItem(STORAGE_KEY, "1");
    setCollapsed(true);
  };

  const handleExpand = () => {
    sessionStorage.setItem(STORAGE_KEY, "0");
    setCollapsed(false);
  };

  if (!mounted) return null;

  const bottomClass = liftForChatDock ? "bottom-[calc(var(--lp-chat-dock-h)+1rem)]" : "bottom-4";

  if (collapsed) {
    return (
      <div
        className={`fixed right-4 z-40 sm:bottom-6 sm:right-6 animate-fade-in ${bottomClass}`}
        role="complementary"
        aria-label="YouTube動画プロモーション"
      >
        <CollapsedChip onExpand={handleExpand} />
      </div>
    );
  }

  const onExpand = video.expandToModal ? () => setModalOpen(true) : undefined;
  const player = (
    <div
      ref={triggerWrapRef}
      className={`fixed right-4 z-40 sm:bottom-6 sm:right-6 animate-fade-in ${bottomClass}`}
      role="complementary"
      aria-label="YouTube動画プロモーション"
    >
      {isDesktop ? (
        <PromoDesktopPlayer video={video} onCollapse={handleCollapse} onExpand={onExpand} />
      ) : (
        <PromoMobilePlayer video={video} onCollapse={handleCollapse} onExpand={onExpand} />
      )}
    </div>
  );
  if (!video.expandToModal) return player;
  // The dialog is a sibling (not inside the animated container, whose transform
  // would trap position:fixed). Closing unmounts the iframe = playback stops, and
  // VideoModal returns focus to the trigger in the small player.
  return (
    <>
      {player}
      <VideoModal
        open={modalOpen} videoId={video.id} title={video.title} onClose={() => setModalOpen(false)}
        returnFocusTo={() => triggerWrapRef.current?.querySelector<HTMLElement>('[data-testid="lp-video-expand"]') ?? null}
      />
    </>
  );
}

type PlayerProps = { video: LpPromoVideo; onCollapse: () => void; onExpand?: () => void };

/** Thumbnail button that opens the dialog (pattern B). */
function ExpandTrigger({ video, onExpand, compact }: { video: LpPromoVideo; onExpand: () => void; compact: boolean }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      data-testid="lp-video-expand"
      aria-haspopup="dialog"
      aria-label={`動画を大きく再生: ${video.title}`}
      className="group block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-strong)]"
    >
      <div className="relative w-full aspect-video">
        <Image src={video.thumbnail} alt="" fill sizes={compact ? "280px" : "360px"} className="object-cover" />
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
          <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center shadow-lg">
            <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </div>
      <div className="px-4 py-3">
        <p className={`${compact ? "text-sm" : "text-xs"} muted leading-snug line-clamp-2`}>{video.title}</p>
        <p className="mt-1 text-xs text-[var(--accent-strong)] font-medium">{compact ? "タップで大きく再生" : "クリックで大きく再生"}</p>
      </div>
    </button>
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

export function PromoDesktopPlayer({ video, onCollapse, onExpand }: PlayerProps) {
  if (video.expandToModal && onExpand) {
    return (
      <div className="relative w-[360px] rounded-2xl overflow-hidden bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
        <CollapseButton onCollapse={onCollapse} />
        <ExpandTrigger video={video} onExpand={onExpand} compact={false} />
      </div>
    );
  }
  return (
    <div className="relative w-[360px] rounded-2xl overflow-hidden bg-[var(--bg-elevated)] border border-[var(--border)] shadow-[0_16px_60px_rgba(0,0,0,0.55)]">
      <CollapseButton onCollapse={onCollapse} />
      <div className="aspect-video">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${video.id}?rel=0`}
          title={video.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="w-full h-full border-0"
        />
      </div>
      <div className="px-4 py-3">
        <p className="text-xs muted leading-snug line-clamp-2">
          {video.title}
        </p>
      </div>
    </div>
  );
}

export function PromoMobilePlayer({ video, onCollapse, onExpand }: PlayerProps) {
  if (video.expandToModal && onExpand) {
    return (
      <div className="relative bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,0.5)] w-[280px]">
        <CollapseButton onCollapse={onCollapse} />
        <ExpandTrigger video={video} onExpand={onExpand} compact />
      </div>
    );
  }
  return (
    <div className="relative bg-[var(--bg-elevated)] border border-[var(--border)] rounded-2xl overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,0.5)] w-[280px]">
      <CollapseButton onCollapse={onCollapse} />
      <a
        href={`https://youtu.be/${video.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="group block"
        aria-label={`YouTubeで動画を見る: ${video.title}`}
      >
        <div className="relative w-full aspect-video">
          <Image
            src={video.thumbnail}
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
            {video.title}
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
