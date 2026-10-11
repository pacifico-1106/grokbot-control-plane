import type { Metadata } from "next";
import { AIEmployeeLanding } from "./AIEmployeeLanding";

export const metadata: Metadata = {
  title: "AI社員 導入パック — 中小企業336万社のミカタ | Staffpass",
  description:
    "AI社員の導入から運用まで、中小企業の経営者のためのマネージドパック。Staffpass（社員証・許可・記録）、会社メール、Grok Bot をまとめて導入。月50,000円から。",
};

export default function AIEmployeeLP() {
  return <AIEmployeeLanding variant="ai-employee" />;
}
