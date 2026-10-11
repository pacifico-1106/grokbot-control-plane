import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoModal, modalEmbedUrl, trapFocusTarget } from "@/app/lp/ai-employee/VideoModal";
import { PromoDesktopPlayer, PromoMobilePlayer } from "@/app/lp/ai-employee/FloatingYouTubePromo";
import { getLpVariant } from "@/app/lp/ai-employee/variants";

/**
 * Reusable large-video dialog (八坂さん 10/12 02:31). Enabled on pattern B only.
 * Browser interactions (open / ✕ / backdrop / Esc / focus return / scroll lock) are in
 * e2e/lp-video-modal.spec.ts; this file covers markup, embed URL and the focus-trap rule.
 */
const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

describe("VideoModal markup", () => {
  const open = html(createElement(VideoModal, { open: true, videoId: "UFKh_CK9uxw", title: "StaffPass MV", onClose: noop }));

  test("role=dialog, aria-modal, labelled by the visible title", () => {
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-modal="true"');
    const id = open.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(open).toMatch(new RegExp(`id="${id}"[^>]*>StaffPass MV<`));
  });

  test("16:9 iframe, youtube-nocookie, autoplay with sound, allow + allowfullscreen", () => {
    expect(open.replace(/&amp;/g, "&")).toContain(`src="${modalEmbedUrl("UFKh_CK9uxw")}"`);
    expect(modalEmbedUrl("UFKh_CK9uxw")).toBe("https://www.youtube-nocookie.com/embed/UFKh_CK9uxw?autoplay=1&rel=0&playsinline=1");
    expect(modalEmbedUrl("UFKh_CK9uxw")).not.toContain("mute");
    expect(open).toContain('allow="autoplay; encrypted-media; picture-in-picture; fullscreen"');
    expect(open).toContain('allowFullScreen=""');
    expect(open).toContain("aspect-video");
    expect(open).toContain("w-full");
    expect(open).toMatch(/max-w-\[?[0-9a-z]+/);
  });

  test("✕ close button and a backdrop", () => {
    expect(open).toContain('aria-label="動画を閉じる"');
    expect(open).toContain('data-testid="lp-video-modal-backdrop"');
  });

  test("closed → nothing rendered (iframe unmounted = playback stopped)", () => {
    expect(html(createElement(VideoModal, { open: false, videoId: "UFKh_CK9uxw", title: "t", onClose: noop }))).toBe("");
  });

  test("embed id is validated (no injection into the iframe URL)", () => {
    expect(() => modalEmbedUrl("x\"><script>")).toThrow();
    expect(() => modalEmbedUrl("../../evil")).toThrow();
  });
});

describe("focus trap rule", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  test("Tab on the last element wraps to the first; Shift+Tab on the first wraps to the last", () => {
    expect(trapFocusTarget([a, b, c], c, false)).toBe(a);
    expect(trapFocusTarget([a, b, c], a, true)).toBe(c);
  });
  test("inside the list: let the browser move focus", () => {
    expect(trapFocusTarget([a, b, c], b, false)).toBeNull();
    expect(trapFocusTarget([a, b, c], b, true)).toBeNull();
  });
  test("focus outside the dialog is pulled back in", () => {
    expect(trapFocusTarget([a, b, c], { id: "outside" }, false)).toBe(a);
    expect(trapFocusTarget([a, b, c], null, true)).toBe(c);
  });
  test("single focusable stays put", () => {
    expect(trapFocusTarget([a], a, false)).toBe(a);
    expect(trapFocusTarget([a], a, true)).toBe(a);
  });
});

describe("floating promo: modal trigger on B only", () => {
  const corp = getLpVariant("ai-employee-corp");
  const orig = getLpVariant("ai-employee");
  test("variant config", () => {
    expect(corp.video.expandToModal).toBe(true);
    expect(orig.video.expandToModal).toBe(false);
    expect(corp.video.title).toBe("StaffPass MV");
  });
  test("B desktop + mobile: a button that opens the dialog (no inline iframe, no off-site link)", () => {
    for (const P of [PromoDesktopPlayer, PromoMobilePlayer]) {
      const h = html(createElement(P, { video: corp.video, onCollapse: noop, onExpand: noop }));
      expect(h).toContain('data-testid="lp-video-expand"');
      expect(h).toContain('aria-haspopup="dialog"');
      expect(h).not.toContain("<iframe");
      expect(h).not.toContain("youtu.be");
      expect(h).toContain(encodeURIComponent("/lp/ai-employee-corp/staffpass-mv.jpg"));
    }
  });
  test("A desktop keeps the inline iframe, A mobile keeps the YouTube link (unchanged)", () => {
    const d = html(createElement(PromoDesktopPlayer, { video: orig.video, onCollapse: noop }));
    expect(d).toContain('<iframe src="https://www.youtube-nocookie.com/embed/l4fVZ1-VRcU?rel=0"');
    expect(d).not.toContain("lp-video-expand");
    const m = html(createElement(PromoMobilePlayer, { video: orig.video, onCollapse: noop }));
    expect(m).toContain('href="https://youtu.be/l4fVZ1-VRcU"');
    expect(m).not.toContain("lp-video-expand");
  });
});
