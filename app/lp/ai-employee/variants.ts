import type { LpPage } from "@/lib/lp/lp-page";

/**
 * LP pattern A (/lp/ai-employee) and B (/lp/ai-employee-corp) share every component;
 * this config is the only place they differ.
 */
export interface LpPromoVideo {
  id: string;
  title: string;
  /** Local thumbnail (mobile card; B desktop card too). */
  thumbnail: string;
  /** sessionStorage key for "collapsed"; separate per video so B does not inherit A's state. */
  storageKey: string;
  /** Click opens the large VideoModal instead of an inline iframe / YouTube link. */
  expandToModal: boolean;
}

export interface LpVariant {
  page: LpPage;
  video: LpPromoVideo;
  /** Top 先行100枠 ribbon (campaign). */
  showCampaignBanner: boolean;
  /** Expert-supervision ribbon, profile, lenses and gallery. */
  showSupervision: boolean;
  /** Extra 相談 CTA right under the hero + sticky / following CTA. */
  quickConsultCta: boolean;
  /** Service name used in hero, pillars, copy and footer. */
  serviceName: string;
  heroName: string;
  footerName: string;
}

export const SERVICE_FULL_NAME = "Staffpass（AIエージェントの社員証）";

const VARIANTS: Record<LpPage, LpVariant> = {
  "ai-employee": {
    page: "ai-employee",
    video: {
      id: "l4fVZ1-VRcU",
      title: "AIエージェント100兆個の話を、現場の経営者向けに翻訳する",
      thumbnail: "/lp/ai-employee/youtube-ai-agents-100cho.jpg",
      storageKey: "ai-emp-yt-float-collapsed",
      expandToModal: false,
    },
    showCampaignBanner: true,
    showSupervision: true,
    quickConsultCta: false,
    serviceName: "Staffpass",
    heroName: "AI社員 by Staffpass",
    footerName: "Staffpass by Sealith",
  },
  "ai-employee-corp": {
    page: "ai-employee-corp",
    video: {
      id: "UFKh_CK9uxw",
      title: "Staffpass 紹介動画",
      thumbnail: "/lp/ai-employee-corp/staffpass-mv.jpg",
      storageKey: "ai-emp-corp-yt-float-collapsed",
      expandToModal: true,
    },
    showCampaignBanner: false,
    showSupervision: false,
    quickConsultCta: true,
    serviceName: SERVICE_FULL_NAME,
    heroName: SERVICE_FULL_NAME,
    footerName: `${SERVICE_FULL_NAME} by Sealith`,
  },
};

export function getLpVariant(page: LpPage): LpVariant {
  return VARIANTS[page];
}
