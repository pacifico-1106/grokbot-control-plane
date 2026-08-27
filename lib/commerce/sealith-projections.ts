import { createHash } from "node:crypto";
import {
  CrossProductEventError,
  parseCommerceProjectionEvent,
  parseTenantMap,
  resolveStaffpassTenant,
  verifyCrossProductRequest,
} from "@/lib/commerce/cross-product-events";
import { getApprovalById } from "@/lib/data/approvals";
import { createSupabaseAdminClient } from "@/lib/supabase";

export async function receiveSealithCommerceProjection(input: {
  rawBody: string;
  eventIdHeader: string | null;
  timestampHeader: string | null;
  signatureHeader: string | null;
  now?: Date;
}) {
  if (process.env.STAFFPASS_SEALITH_PROJECTIONS_ENABLED !== "true") {
    throw new CrossProductEventError("sealith_projections_disabled", 404);
  }
  const verified = verifyCrossProductRequest({
    ...input,
    secret: process.env.SEALITH_STAFFPASS_EVENT_SECRET ?? "",
  });
  const event = parseCommerceProjectionEvent(verified.parsed);
  const expectedEnvironment = process.env.CROSS_PRODUCT_EVENT_ENVIRONMENT;
  if (
    (expectedEnvironment !== "staging" && expectedEnvironment !== "production") ||
    event.producer.environment !== expectedEnvironment
  ) {
    throw new CrossProductEventError("event_environment_mismatch", 403);
  }
  const tenantMap = parseTenantMap(process.env.STAFFPASS_SEALITH_TENANT_MAP);
  const staffpassOrgId = resolveStaffpassTenant(
    tenantMap,
    event.producer.tenantId,
  );
  const approvalRef = event.correlation.approvalRef;
  if (!approvalRef || approvalRef.system !== "staffpass") {
    throw new CrossProductEventError("staffpass_approval_reference_required", 403);
  }
  const approval = await getApprovalById(approvalRef.id, staffpassOrgId);
  if (!approval || approval.jobId !== event.correlation.jobId) {
    throw new CrossProductEventError("approval_tenant_or_job_mismatch", 403);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new CrossProductEventError("supabase_not_configured", 503);
  const inboxId = createHash("sha256")
    .update(`sealith:${event.producer.environment}:${event.eventId}`)
    .digest("hex");
  const reportedStatus = String(
    event.data.status ?? event.data.orderStatus ?? "unknown",
  );
  const { data, error } = await admin.rpc("accept_sealith_commerce_event", {
    p_inbox_id: inboxId,
    p_org_id: staffpassOrgId,
    p_event_id: event.eventId,
    p_event_type: event.eventType,
    p_body_hash: verified.bodyHash,
    p_aggregate_id: event.aggregate.id,
    p_aggregate_version: event.aggregate.version,
    p_order_id: event.correlation.orderId,
    p_job_id: event.correlation.jobId,
    p_approval_id: approvalRef.id,
    p_reported_status: reportedStatus,
    p_payment_event_id:
      typeof event.data.paymentEventId === "string"
        ? event.data.paymentEventId
        : null,
    p_payload: event,
  });
  if (error) {
    if (error.message.includes("event_id_body_conflict")) {
      throw new CrossProductEventError("event_id_body_conflict", 409);
    }
    throw new CrossProductEventError("projection_persistence_failed", 500);
  }
  return data;
}
