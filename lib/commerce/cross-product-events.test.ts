import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyInboxReplay,
  normalizeCommerceAuthorization,
  parseCommerceProjectionEvent,
  parseTenantMap,
  resolveStaffpassTenant,
  signCrossProductEvent,
  verifyCrossProductRequest,
} from "./cross-product-events";

const now = new Date("2026-08-27T06:00:00.000Z");
const secret = "test-only-cross-product-secret-32-bytes-minimum";

function projection() {
  return {
    specVersion: "sealith.cross-product-commerce-events.v1",
    eventId: "evt_projection_1",
    eventType: "commerce.payment.status_changed.v1",
    occurredAt: now.toISOString(),
    expiresAt: "2026-08-27T06:05:00.000Z",
    producer: {
      system: "sealith",
      kind: "commerce_ledger",
      environment: "staging",
      tenantId: "org_sealith_1",
    },
    correlation: {
      jobId: "job_1",
      approvalRef: { system: "staffpass", id: "apr_1", version: 1 },
      orderId: "ord_1",
    },
    aggregate: { type: "commerce_order", id: "ord_1", version: 2 },
    data: { orderId: "ord_1", status: "observed", paymentEventId: "pay_1" },
  };
}

describe("cross-product no-money contract", () => {
  test("normalizes a structured JPYC approval snapshot", () => {
    assert.equal(
      normalizeCommerceAuthorization({
        purpose: "business_trip_esim",
        amountJpy: 2500,
        now,
        value: {
          targetSystem: "sealith",
          currency: "JPYC",
          maxAmount: "3000",
          merchantPolicy: {
            allowedMerchantIds: ["tokyo307"],
            requiredSellerOfRecord: "tokyo307",
          },
          skuPolicy: { allowedSkuIds: ["esim.purchase"] },
          validUntil: "2026-08-27T06:05:00.000Z",
        },
      }).authorityMode,
      "external_reference",
    );
  });

  test("accepts a valid signed Sealith projection", () => {
    const raw = JSON.stringify(projection());
    const timestamp = "1787810400";
    const verified = verifyCrossProductRequest({
      rawBody: raw,
      eventIdHeader: "evt_projection_1",
      timestampHeader: timestamp,
      signatureHeader: `v1=${signCrossProductEvent(raw, timestamp, secret)}`,
      secret,
      now,
    });
    assert.equal(parseCommerceProjectionEvent(verified.parsed).correlation.orderId, "ord_1");
  });

  test("rejects tampering and expiry", () => {
    const raw = JSON.stringify(projection());
    const timestamp = "1787810400";
    assert.throws(
      () =>
        verifyCrossProductRequest({
          rawBody: raw.replace("observed", "confirmed"),
          eventIdHeader: "evt_projection_1",
          timestampHeader: timestamp,
          signatureHeader: `v1=${signCrossProductEvent(raw, timestamp, secret)}`,
          secret,
          now,
        }),
      /invalid_event_signature/,
    );
    const expired = projection();
    expired.expiresAt = "2026-08-27T05:59:59.000Z";
    const expiredRaw = JSON.stringify(expired);
    assert.throws(
      () =>
        verifyCrossProductRequest({
          rawBody: expiredRaw,
          eventIdHeader: "evt_projection_1",
          timestampHeader: timestamp,
          signatureHeader: `v1=${signCrossProductEvent(expiredRaw, timestamp, secret)}`,
          secret,
          now,
        }),
      /event_expired/,
    );
  });

  test("handles duplicate, conflict, stale and tenant mismatch", () => {
    assert.equal(
      classifyInboxReplay({
        existingBodyHash: "a".repeat(64),
        bodyHash: "a".repeat(64),
        incomingVersion: 2,
      }),
      "duplicate",
    );
    assert.throws(
      () =>
        classifyInboxReplay({
          existingBodyHash: "a".repeat(64),
          bodyHash: "b".repeat(64),
          incomingVersion: 2,
        }),
      /event_id_body_conflict/,
    );
    assert.equal(
      classifyInboxReplay({
        existingVersion: 3,
        bodyHash: "b".repeat(64),
        incomingVersion: 2,
      }),
      "stale",
    );
    const map = parseTenantMap('{"org_staffpass_1":"org_sealith_1"}');
    assert.equal(resolveStaffpassTenant(map, "org_sealith_1"), "org_staffpass_1");
    assert.throws(
      () => resolveStaffpassTenant(map, "org_other"),
      /sealith_tenant_not_mapped/,
    );
  });

  test("rejects unknown projection fields", () => {
    assert.throws(
      () => parseCommerceProjectionEvent({ ...projection(), paid: true }),
      /unknown_event_field/,
    );
  });
});
