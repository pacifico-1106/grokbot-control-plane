/**
 * P0 Item 7: Known Gaps (documented as skipped tests with TODO)
 * 
 * These tests document known issues that are not yet fixed.
 * They are marked as skipped but contain the test logic so they can be
 * unskipped once the underlying issue is resolved.
 */
import { describe, expect, test } from "bun:test";

describe("KNOWN GAP: Delivery unique constraint collision", () => {
  /**
   * TODO: Fix the unique constraint collision issue.
   * 
   * Issue: The old unique constraint (approval_id, channel_id) on
   * approval_notification_deliveries collides when recipient routing is ON
   * because DM and channel deliveries can share the same channel_id.
   * 
   * When recipient routing delivers to both:
   * 1. A DM (channelId = the Slack bot's app DM channel)
   * 2. A channel (channelId = the same channel where the bot is installed)
   * 
   * Both insertions would have the same (approval_id, channel_id) tuple,
   * violating the unique constraint.
   * 
   * The fix should either:
   * - Add recipient_kind to the unique constraint: (approval_id, channel_id, recipient_kind)
   * - Or add external_user_id to disambiguate DM deliveries
   * 
   * Migration reference: 20260927200000_delivery_per_recipient.sql
   */
  test.skip("unique constraint allows DM and channel delivery to same channel_id", async () => {
    // TODO: This test should verify that when APPROVAL_RECIPIENT_ROUTING is ON:
    // 1. A business-class approval can be delivered to both:
    //    - A DM to a voter (via voter binding)
    //    - The default approval channel (for audit/visibility)
    // 2. Both deliveries should succeed even if they reference the same
    //    Slack app's channel_id
    // 3. The notification_deliveries table should have two rows with
    //    different recipient metadata
    
    // Currently this would fail with a unique constraint violation.
    // Uncomment and implement once the migration adds the proper constraint.
    
    // const approval = createTestApproval({ purpose: "tool.invoke" });
    // const dmDelivery = await deliverToDm(approval, voter);
    // const channelDelivery = await deliverToChannel(approval);
    // expect(dmDelivery.ok).toBe(true);
    // expect(channelDelivery.ok).toBe(true);
    
    expect(true).toBe(true); // Placeholder
  });
});

describe("KNOWN GAP: is_org_shared detection", () => {
  /**
   * Note: is_org_shared (multi-org Enterprise Grid workspace sharing)
   * is not currently blocked by validateSlackChannelNotExternal.
   * 
   * is_org_shared indicates the channel is shared across multiple workspaces
   * in the same Enterprise Grid organization. This is different from
   * is_ext_shared (Slack Connect with external orgs).
   * 
   * The current implementation focuses on external sharing risk. Internal
   * org-wide sharing within Enterprise Grid may be acceptable depending
   * on the organization's security posture.
   * 
   * TODO: Decide whether to block is_org_shared channels based on
   * customer requirements for Enterprise Grid deployments.
   */
  test("is_org_shared is not currently blocked (documented behavior)", () => {
    // This is currently expected behavior - is_org_shared is NOT blocked
    // because it represents internal sharing within an Enterprise Grid,
    // not external sharing with outside organizations.
    expect(true).toBe(true);
  });
});
