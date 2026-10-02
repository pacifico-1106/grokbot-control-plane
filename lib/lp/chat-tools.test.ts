import { describe, expect, test } from "bun:test";
import {
  executeKnowledgeSearch,
  executeRecommendPlan,
  RECOMMEND_PLAN_UPGRADE_NOTE,
  TOOL_DEFINITIONS,
} from "./chat-tools";

type PlanData = { sku: string; reasons: string[]; upgradePath?: string[]; requiresConsultation: boolean; unknowns: string[] };
const plan = async (args: Parameters<typeof executeRecommendPlan>[0]) =>
  (await executeRecommendPlan(args)).data as PlanData;

describe("recommend_plan", () => {
  test("one simple area → intern", async () => {
    const r = await plan({ taskAreas: ["日報"], complexity: "simple" });
    expect(r.sku).toBe("intern");
    expect(r.upgradePath).toBeUndefined();
  });

  test("a few routine areas → proper", async () => {
    const r = await plan({ taskAreas: ["日報", "議事録", "予定調整"], complexity: "moderate" });
    expect(r.sku).toBe("proper");
    expect(r.reasons).toContain("複数の定型業務に対応");
    expect(r.upgradePath).toBeUndefined();
  });

  test("more than 3 areas alone stays proper with an upgrade note", async () => {
    const r = await plan({ taskAreas: ["日報", "議事録", "予定調整", "経費精算", "社内案内"], complexity: "simple" });
    expect(r.sku).toBe("proper");
    expect(r.reasons).toContain(RECOMMEND_PLAN_UPGRADE_NOTE);
    expect(r.upgradePath).toEqual(["executive", "custom"]);
  });

  test("'complex' alone (秘書業務全般) stays proper with an upgrade note", async () => {
    const r = await plan({ taskAreas: ["秘書業務全般"], complexity: "complex" });
    expect(r.sku).toBe("proper");
    expect(r.reasons).toContain(RECOMMEND_PLAN_UPGRADE_NOTE);
  });

  test("explicit executive signals → executive with matching reasons", async () => {
    const dev = await plan({ taskAreas: ["社内システム"], complexity: "simple", executiveSignals: ["development"] });
    expect(dev.sku).toBe("executive");
    expect(dev.reasons).toEqual(["システムの開発・保守に対応"]);

    const auth = await plan({ taskAreas: ["経費承認"], executiveSignals: ["decision_authority", "heavy_model"] });
    expect(auth.sku).toBe("executive");
    expect(auth.reasons).toEqual([
      "決められた上限までの承認権限を任せる業務に対応",
      "高性能なAIモデルや大量の処理が必要な業務に対応",
    ]);
    expect(auth.upgradePath).toBeUndefined();
  });

  test("unknown signal values are ignored", async () => {
    const r = await plan({ taskAreas: ["日報"], complexity: "simple", executiveSignals: ["many_tasks"] });
    expect(r.sku).toBe("intern");
  });

  test("no task areas → requires consultation", async () => {
    const r = await plan({ taskAreas: [] });
    expect(r.requiresConsultation).toBe(true);
    expect(r.unknowns).toContain("任せたい業務が不明です");
  });

  test("tool definition exposes executiveSignals enum", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === "recommend_plan")!;
    const props = def.function.parameters.properties as unknown as Record<string, { items?: { enum?: string[] }; description?: string }>;
    expect(props.executiveSignals.items?.enum).toEqual(["decision_authority", "pre_decision_full", "heavy_model", "development"]);
    expect(props.executiveSignals.description).toContain("never an executive signal");
  });
});

describe("knowledge_search not found", () => {
  test("guidance tells the model to answer via staff without exposing internals", async () => {
    const res = await executeKnowledgeSearch({ query: "GitHub 監視" }, async () => ({
      releaseId: "rel",
      releaseKey: "k",
      status: "not_found",
      passages: [],
    }));
    const data = res.data as { found: boolean; message: string };
    expect(data.found).toBe(false);
    expect(data.message).toContain("詳細は個別に確認のうえ、担当よりご回答いたします");
    expect(data.message).not.toContain("承認済みの情報が見つかりませんでした");
  });
});
