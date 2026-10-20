import { describe, expect, test } from "bun:test";
import { inboundNoticeDedupKey, inboundNoticeJobId } from "@/lib/inbound-notice/dedup";

describe("inbound notice dedup + jobId (channel + Slack ts)", () => {
  test("dedup key is channel + ts, not Slack event_id", () => {
    expect(inboundNoticeDedupKey("C_DUMMY", "1000000000.000001")).toBe(
      "inb:C_DUMMY:1000000000.000001"
    );
    expect(inboundNoticeDedupKey("C_DUMMY", "1000000000.000001")).not.toContain("Ev_");
  });

  test("missing channel or ts → null (fail closed)", () => {
    expect(inboundNoticeDedupKey("", "1000000000.000001")).toBeNull();
    expect(inboundNoticeDedupKey("C_DUMMY", "")).toBeNull();
  });

  test("jobId is auto-generated from the same channel + ts and stays within invoke charset", () => {
    const id = inboundNoticeJobId("C_DUMMY", "1000000000.000001");
    expect(id).toBe("inb_C_DUMMY_1000000000.000001");
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^[A-Za-z0-9_.:/-]+$/);
  });
});
