import { describe, expect, test } from "bun:test";
import { mapAuditRow } from "@/lib/data/mappers";
import type { AuditEvent } from "@/lib/types";
import { presentAuditRow, presentAuditRows } from "./presentation";

const ORG = "org_a";

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, "action" | "summary">): AuditEvent {
  return {
    id: partial.id ?? "aud_1",
    orgId: partial.orgId ?? ORG,
    employeeId: partial.employeeId ?? "emp_sales",
    credentialId: partial.credentialId ?? "cred_1",
    actorEmail: partial.actorEmail ?? null,
    purpose: partial.purpose ?? "sales.outreach",
    metadata: partial.metadata ?? {},
    createdAt: partial.createdAt ?? "2026-10-16T03:34:00.000Z",
    ...partial,
  };
}

function leaked(view: unknown): string {
  return JSON.stringify(view);
}

describe("presentAuditRow", () => {
  test("AI row: Japanese operation, JST, result, employee name — no raw JSON fields", () => {
    const view = presentAuditRow(
      event({
        action: "tool.invoke",
        summary: "comm.reply を自動実行",
        metadata: {
          tool: "comm.reply",
          auto: true,
          jobId: "job_1",
          destination: "alice@example.com",
          pollPath: "/api/approvals/status?id=apr&token=SECRETTOKEN",
          statusToken: "st_secret_value",
          egress: { audience: "internal" },
        },
      }),
      { employeesById: new Map([["emp_sales", { displayName: "営業AI社員" }]]) }
    );
    expect(view.action.labelJa).toBe("Slackにメッセージを送信");
    expect(view.action.id).toBe("comm.reply");
    expect(view.createdAtJst).toMatch(/JST$/);
    expect(view.actor.kind).toBe("ai");
    expect(view.actor.name).toBe("営業AI社員");
    expect(view.result.kind).toBe("success");
    expect(view.approval).toMatchObject({ needed: false, status: "none" });
    expect(view.target.labelJa).toBe("—");
    const blob = leaked(view);
    expect(blob).not.toContain("pollPath");
    expect(blob).not.toContain("statusToken");
    expect(blob).not.toContain("SECRETTOKEN");
    expect(blob).not.toContain("st_secret_value");
    expect(blob).not.toContain("alice@example.com");
    expect(blob).not.toContain('"metadata"');
  });

  test("old row without tool falls back to action Japanese label", () => {
    const view = presentAuditRow(
      event({
        action: "credential.issued",
        summary: "営業AI社員の社員証を発行",
        metadata: {},
      })
    );
    expect(view.action.labelJa).toBe("社員証を発行");
    expect(view.result.kind).toBe("unknown");
  });

  test("denied / failure / pending skeletons use Japanese reasons", () => {
    expect(
      presentAuditRow(
        event({
          action: "secret_detection.blocked",
          summary: "秘密情報の可能性がある値を検出して拒否（aws_access_key）",
          metadata: { code: "secret_detected_in_payload" },
        })
      ).result
    ).toMatchObject({
      kind: "denied",
      reasonJa: "秘密情報の可能性がある値を検出して拒否しました",
    });
    expect(
      presentAuditRow(event({ action: "slack.post_failed", summary: "送信失敗", metadata: { code: "slack_post_failed" } }))
        .result.kind
    ).toBe("failure");
    expect(
      presentAuditRow(event({ action: "approval.requested", summary: "承認待ち", metadata: { approvalId: "apr_1" } }))
        .result
    ).toMatchObject({ kind: "pending", reasonJa: "人の承認待ち" });
  });

  test("masks emails inside summary and never keeps poll URLs", () => {
    const view = presentAuditRow(
      event({
        action: "approval.requested",
        summary: "alice@example.com へ /api/approvals/status?id=apr&token=SECRET を通知",
        metadata: { pollPath: "/api/approvals/status?id=apr&token=SECRET", approvalId: "apr_deadbeef" },
      })
    );
    expect(view.summary).toContain("a***@example.com");
    expect(view.summary).not.toContain("alice@example.com");
    expect(view.summary).not.toContain("SECRET");
    expect(view.safeMeta.approvalIdPrefix).toBe("apr_dead");
    expect(leaked(view)).not.toContain("/api/approvals/status");
  });

  test("human actor uses member name + masked email; system when both missing", () => {
    const human = presentAuditRow(
      event({
        employeeId: null,
        actorEmail: "owner@example.com",
        action: "member.updated",
        summary: "メンバーを更新",
      }),
      {
        membersByEmail: new Map([
          ["owner@example.com", { displayName: "山田 太郎", email: "owner@example.com" }],
        ]),
      }
    );
    expect(human.actor).toMatchObject({
      kind: "human",
      name: "山田 太郎",
      emailMasked: "o***@example.com",
    });
    const system = presentAuditRow(
      event({
        employeeId: null,
        actorEmail: null,
        action: "gateway.link_changed",
        summary: "連携を変更",
      })
    );
    expect(system.actor).toMatchObject({ kind: "system", name: "システム", emailMasked: null });
  });

  test("drops other-org events and does not copy unsafe safeMeta", () => {
    const foreign = presentAuditRows(
      [
        event({
          id: "aud_foreign",
          orgId: "org_b",
          action: "tool.invoke",
          summary: "leaked",
        }),
        event({
          id: "aud_own",
          purpose: "alice@example.com",
          action: "tool.invoke",
          summary: "ok",
          metadata: {
            jobId: "/api/approvals/status?token=SECRETTOKEN",
            audience: "bob@example.com",
            approvalId: "not a token but spaces fail",
          },
        }),
      ],
      { orgId: ORG }
    );
    expect(foreign.map((row) => row.id)).toEqual(["aud_own"]);
    expect(foreign[0].safeMeta.purpose).toBe("a***@example.com");
    expect(foreign[0].safeMeta.jobId).toBeNull();
    expect(foreign[0].safeMeta.audience).toBe("b***@example.com");
    expect(foreign[0].safeMeta.approvalIdPrefix).toBeNull();
    expect(JSON.stringify(foreign)).not.toContain("SECRETTOKEN");
    expect(JSON.stringify(foreign)).not.toContain("alice@example.com");
    expect(JSON.stringify(foreign)).not.toContain("bob@example.com");
  });

  test("mapAuditRow keeps actor_email for later masking", () => {
    const mapped = mapAuditRow({
      id: "x",
      org_id: ORG,
      employee_id: null,
      credential_id: null,
      actor_email: "owner@example.com",
      action: "member.updated",
      purpose: null,
      summary: "更新",
      metadata: { pollPath: "/hidden" },
      created_at: "2026-10-16T00:00:00.000Z",
    });
    expect(mapped.actorEmail).toBe("owner@example.com");
    const view = presentAuditRow(mapped);
    expect(view.actor.emailMasked).toBe("o***@example.com");
    expect(leaked(view)).not.toContain("pollPath");
    expect(leaked(view)).not.toContain("/hidden");
  });
});
