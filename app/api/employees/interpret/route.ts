import { NextResponse } from "next/server";
import { buildEmployeePolicyDraft } from "@/lib/employees/policy-draft";

export const runtime = "nodejs";

/**
 * Natural language (Japanese) → permission Draft.
 * Deterministic rules engine (Sealith interpret pattern, Grok Bot scopes).
 * Demo-safe: no LLM key required.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { input?: string };
  const input = (body.input || "").trim();
  if (!input) {
    return NextResponse.json({ error: "input_required" }, { status: 400 });
  }
  if (input.length > 1500) {
    return NextResponse.json({ error: "input_too_long" }, { status: 400 });
  }
  if (/(?:sk-|api[_-]?key|秘密鍵|プライベートキー|password\s*=)/i.test(input)) {
    return NextResponse.json({ error: "sensitive_input_not_allowed" }, { status: 400 });
  }

  const draft = buildEmployeePolicyDraft(input);
  return NextResponse.json({ draft, source: "rules" });
}
