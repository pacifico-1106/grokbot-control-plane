/**
 * LP Chat tool definitions and handlers.
 * Tools are server-side only; clients cannot inject arbitrary tools.
 */

import { searchKnowledgeBase, getPublishedRelease, type KbSearchResult } from "./knowledge-base";
import { getCatalog, getCatalogItem, type Catalog, type CatalogItem } from "./catalog";

export const ALLOWED_TOOLS = [
  "knowledge_search",
  "catalog_get",
  "recommend_plan",
  "proposal_prepare",
  "handoff_offer",
  "order_status_get",
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is AllowedToolName {
  return ALLOWED_TOOLS.includes(name as AllowedToolName);
}

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "knowledge_search",
      description: "Search the approved knowledge base for information about Staffpass AI社員. Returns citations.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query in Japanese (max 500 chars)",
          },
          topic: {
            type: "string",
            enum: ["features", "scope", "process", "support"],
            description: "Optional topic filter",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "catalog_get",
      description: "Get the current product catalog with pricing. Prices are authoritative from the catalog, not from conversation.",
      parameters: {
        type: "object",
        properties: {
          sku: {
            type: "string",
            description: "Optional SKU to get specific plan (intern, proper, executive, custom)",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recommend_plan",
      description: "Recommend a plan based on user requirements. Returns recommendation with reasons.",
      parameters: {
        type: "object",
        properties: {
          taskAreas: {
            type: "array",
            items: { type: "string" },
            description: "Areas of work to delegate",
          },
          complexity: {
            type: "string",
            enum: ["simple", "moderate", "complex"],
            description: "Complexity level",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Tools/services to integrate",
          },
          timing: {
            type: "string",
            description: "Desired start timing",
          },
        },
        required: ["taskAreas"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proposal_prepare",
      description: "Prepare a proposal card for user review. Does not start payment.",
      parameters: {
        type: "object",
        properties: {
          sku: {
            type: "string",
            enum: ["intern", "proper", "executive"],
            description: "Selected plan SKU",
          },
          billingPreference: {
            type: "string",
            enum: ["monthly", "annual"],
            description: "Billing preference",
          },
          requirements: {
            type: "string",
            description: "Summary of requirements discussed",
          },
        },
        required: ["sku"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "handoff_offer",
      description: "Offer to hand off to human consultation. Does not send data without user confirmation.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Reason for handoff (custom requirements, unclear pricing, etc)",
          },
          summaryDraft: {
            type: "string",
            description: "Draft summary of conversation for user review",
          },
        },
        required: ["reason", "summaryDraft"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "order_status_get",
      description: "Get order status for the current journey only. Cannot query other orders.",
      parameters: {
        type: "object",
        properties: {
          orderReference: {
            type: "string",
            description: "Order reference from this journey",
          },
        },
      },
    },
  },
];

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  citations?: Array<{ title: string; url: string | null }>;
}

/** Split a free-text query into up to 4 distinct terms (>= 2 chars) on whitespace and punctuation. */
export function splitSearchTerms(query: string): string[] {
  const terms = query
    .split(/[\s\u3000、。,.・/／?？!！「」『』()（）]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return [...new Set(terms)].slice(0, 4);
}

export async function executeKnowledgeSearch(args: { query?: string; topic?: string }): Promise<ToolResult> {
  if (!args.query || args.query.length > 500) {
    return { success: false, error: "invalid_query" };
  }

  let result = await searchKnowledgeBase(args.query, 3);

  // search_published_kb is a substring match on the whole query, so a multi-word query
  // ("AI社員 業務 範囲") rarely matches. Fall back to the individual terms.
  if (result.status === "not_found") {
    const terms = splitSearchTerms(args.query);
    if (terms.length > 1) {
      const seen = new Set<string>();
      const passages: KbSearchResult["passages"] = [];
      let hit: KbSearchResult | null = null;
      for (const term of terms) {
        const r = await searchKnowledgeBase(term, 3);
        if (r.status === "error") continue;
        for (const p of r.passages) {
          if (seen.has(p.documentId) || passages.length >= 3) continue;
          seen.add(p.documentId);
          passages.push(p);
        }
        if (r.status === "found") hit = r;
      }
      if (hit && passages.length > 0) result = { ...hit, passages };
    }
  }

  if (result.status === "error") {
    return { success: false, error: "search_failed" };
  }

  if (result.status === "not_found" || result.passages.length === 0) {
    return {
      success: true,
      data: {
        found: false,
        message: "承認済みの情報が見つかりませんでした。詳細は相談窓口でご確認ください。",
      },
    };
  }

  return {
    success: true,
    data: {
      found: true,
      releaseKey: result.releaseKey,
      passages: result.passages.map((p) => ({
        title: p.title,
        content: p.content,
      })),
    },
    citations: result.passages.map((p) => ({
      title: p.title,
      url: p.sourceUrl,
    })),
  };
}

export async function executeCatalogGet(args: { sku?: string }): Promise<ToolResult> {
  if (args.sku) {
    const item = await getCatalogItem(args.sku);
    if (!item) {
      return { success: false, error: "sku_not_found" };
    }

    return {
      success: true,
      data: {
        sku: item.sku,
        displayName: item.displayNameJa,
        monthlyAmountExTax: item.monthlyAmountExTax,
        setupAmountExTax: item.setupAmountExTax,
        requiresQuote: item.requiresQuote,
        currency: "JPY",
        taxNote: "税別",
      },
    };
  }

  const catalog = await getCatalog();

  return {
    success: true,
    data: {
      version: catalog.versionKey,
      items: catalog.items.map((item) => ({
        sku: item.sku,
        displayName: item.displayNameJa,
        monthlyAmountExTax: item.monthlyAmountExTax,
        setupAmountExTax: item.setupAmountExTax,
        requiresQuote: item.requiresQuote,
      })),
      currency: "JPY",
      taxNote: "税別",
      purchaseEnabled: catalog.purchaseEnabled,
    },
  };
}

export async function executeRecommendPlan(args: {
  taskAreas?: string[];
  complexity?: string;
  tools?: string[];
  timing?: string;
}): Promise<ToolResult> {
  const taskAreas = args.taskAreas || [];
  const complexity = args.complexity || "moderate";

  let recommendedSku: string;
  const reasons: string[] = [];
  const unknowns: string[] = [];
  let requiresConsultation = false;

  if (taskAreas.length === 0) {
    unknowns.push("任せたい業務が不明です");
    requiresConsultation = true;
  }

  if (taskAreas.length <= 1 && complexity === "simple") {
    recommendedSku = "intern";
    reasons.push("定型1領域に対応");
  } else if (taskAreas.length <= 3 && complexity !== "complex") {
    recommendedSku = "proper";
    reasons.push("複数の定型業務に対応");
  } else if (complexity === "complex" || taskAreas.length > 3) {
    recommendedSku = "executive";
    reasons.push("高度な運用や複数業務の個別設計に対応");
  } else {
    recommendedSku = "proper";
    reasons.push("標準的な業務範囲に対応");
  }

  if (args.tools && args.tools.length > 0) {
    unknowns.push("使用ツールの確認が必要です");
  }

  if (args.timing) {
    unknowns.push("開始時期は個別に確認が必要です");
  }

  return {
    success: true,
    data: {
      sku: recommendedSku,
      reasons,
      unknowns,
      requiresConsultation: requiresConsultation || unknowns.length > 0,
      note: "プランは候補です。業務適合や成果を保証するものではありません。",
    },
  };
}

export async function executeProposalPrepare(args: {
  sku?: string;
  billingPreference?: string;
  requirements?: string;
}): Promise<ToolResult> {
  if (!args.sku || !["intern", "proper", "executive"].includes(args.sku)) {
    return { success: false, error: "invalid_sku" };
  }

  const item = await getCatalogItem(args.sku);
  if (!item) {
    return { success: false, error: "sku_not_found" };
  }

  return {
    success: true,
    data: {
      type: "proposal_card",
      sku: args.sku,
      displayName: item.displayNameJa,
      billingPreference: args.billingPreference || "monthly",
      setupAmountExTax: item.setupAmountExTax,
      monthlyAmountExTax: item.monthlyAmountExTax,
      requirements: args.requirements?.slice(0, 500) || "",
      checkoutUrl: `/lp/ai-employee/checkout?plan=${args.sku}`,
      purchaseEnabled: false,
      note: "決済は画面で確認してから行います。この会話だけでは契約は成立しません。",
    },
  };
}

export async function executeHandoffOffer(args: {
  reason?: string;
  summaryDraft?: string;
}): Promise<ToolResult> {
  if (!args.reason || !args.summaryDraft) {
    return { success: false, error: "missing_required_fields" };
  }

  if (args.summaryDraft.length > 2000) {
    return { success: false, error: "summary_too_long" };
  }

  return {
    success: true,
    data: {
      type: "handoff_preview",
      reason: args.reason,
      summaryDraft: args.summaryDraft.slice(0, 2000),
      destination: "async_consultation",
      confirmationRequired: true,
      note: "引継ぎを確定するには画面で確認が必要です。",
    },
  };
}

export async function executeOrderStatusGet(args: {
  orderReference?: string;
}, journeyId: string): Promise<ToolResult> {
  return {
    success: true,
    data: {
      status: "not_found",
      message: "このセッションに関連する注文は見つかりませんでした。",
    },
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: { journeyId: string }
): Promise<ToolResult> {
  if (!isAllowedTool(name)) {
    return { success: false, error: "tool_not_allowed" };
  }

  switch (name) {
    case "knowledge_search":
      return executeKnowledgeSearch(args as { query?: string; topic?: string });
    case "catalog_get":
      return executeCatalogGet(args as { sku?: string });
    case "recommend_plan":
      return executeRecommendPlan(args as { taskAreas?: string[]; complexity?: string; tools?: string[]; timing?: string });
    case "proposal_prepare":
      return executeProposalPrepare(args as { sku?: string; billingPreference?: string; requirements?: string });
    case "handoff_offer":
      return executeHandoffOffer(args as { reason?: string; summaryDraft?: string });
    case "order_status_get":
      return executeOrderStatusGet(args as { orderReference?: string }, context.journeyId);
    default:
      return { success: false, error: "unknown_tool" };
  }
}

export const MAX_TOOL_CALLS_PER_TURN = 5;
export const MAX_INPUT_TOKENS = 2048;
export const MAX_OUTPUT_TOKENS = 1024;
