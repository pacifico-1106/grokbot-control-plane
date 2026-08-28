import { describe, expect, test } from "bun:test";
import { DEMO_EMPLOYEES } from "@/lib/demo-data";
import { FRANK_VOICE, POLITE_VOICE, WHOAMI_VOICE_NOTE_JA } from "@/lib/employees/voice";
import { buildStaffpassWhoamiPayload } from "@/lib/mcp/whoami";

describe("staffpass_whoami voice", () => {
  test("whoami includes badge voice and externalFloor note", () => {
    const comm = DEMO_EMPLOYEES.find((item) => item.id === "emp_comm");
    expect(comm).toBeTruthy();
    const payload = buildStaffpassWhoamiPayload({
      employee: comm!,
      orgId: comm!.orgId,
      binding: {
        status: "linked",
        credentialGeneration: 1,
        grokBotAgentId: "agent_demo",
      },
    });
    expect(payload.ok).toBe(true);
    expect(payload.voice).toEqual(FRANK_VOICE);
    expect(payload.voiceNoteJa).toBe(WHOAMI_VOICE_NOTE_JA);
    expect((payload.voice as { register?: string }).register).toBe("frank");
  });

  test("sales employee whoami returns polite badge voice", () => {
    const sales = DEMO_EMPLOYEES.find((item) => item.id === "emp_sales");
    const payload = buildStaffpassWhoamiPayload({
      employee: sales!,
      orgId: sales!.orgId,
    });
    expect(payload.voice).toEqual(POLITE_VOICE);
  });
});
