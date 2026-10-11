/**
 * Shared channel-ledger mutation for channels.classify (admin MCP) and the
 * employee config.change_request channel path. Callers MUST already hold a
 * human approval — this module applies, it never decides.
 */
import { getEmployee } from "@/lib/data/employees";
import { upsertOrgChannel } from "@/lib/data/directory";
import {
  deleteSlackImEmployeeRoute,
  isSlackImChannelId,
  syncSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { isSlackDmAutorouteEnabled } from "@/lib/slack/dm-autoroute-flags";
import type { SlackImRouteSource } from "@/lib/data/slack-im-routes";
import type { ChannelClassification, ChannelLedgerSurface, OrgChannel } from "@/lib/types";

export type ApplyChannelClassificationInput = {
  orgId: string;
  surface: ChannelLedgerSurface;
  externalId: string;
  classification: ChannelClassification;
  mixed: boolean;
  /** Bound employee for an internal Slack 1:1 only. Omitted → IM ingress removed (fail-closed). */
  employeeId?: string | null;
  slackTeamId?: string | null;
  /**
   * Route provenance. Only SLACK_DM_AUTOROUTE (lib/slack/dm-autoroute.ts) passes
   * "auto_party". Human channels.classify leaves it unset: while the auto-route
   * flag is ON (migration applied) it is recorded as "manual" so a human decision
   * is never later removed by the auto-route cleanup.
   */
  routeSource?: SlackImRouteSource;
  counterpartSlackUserId?: string | null;
};

export type ApplyChannelClassificationResult = {
  channel: OrgChannel;
  routeEmployeeId: string | null;
};

export async function applyChannelClassification(
  input: ApplyChannelClassificationInput
): Promise<ApplyChannelClassificationResult> {
  const externalId = input.externalId.trim();
  if (!externalId) throw new Error("external_id_required");
  const employeeId = (input.employeeId || "").trim();
  const slackTeamId = (input.slackTeamId || "").trim();
  const isSlackIm = input.surface === "slack" && isSlackImChannelId(externalId);
  if (isSlackIm && employeeId && input.classification === "internal" && input.mixed !== true) {
    const employee = await getEmployee(employeeId, input.orgId);
    if (!employee) throw new Error("employee_not_found");
    if (employee.status !== "active") throw new Error("employee_not_active");
  }
  // Removing first makes an omitted employee fail closed even if a later
  // classification write fails. A new route is installed only after success.
  if (isSlackIm && (!employeeId || input.classification !== "internal" || input.mixed === true)) {
    await deleteSlackImEmployeeRoute({ orgId: input.orgId, slackChannelId: externalId });
  }
  const channel = await upsertOrgChannel({
    orgId: input.orgId,
    surface: input.surface,
    externalId,
    classification: input.classification,
    mixed: input.mixed === true,
  });
  const route = isSlackIm
    ? await syncSlackImEmployeeRoute({
        orgId: input.orgId,
        surface: "slack",
        slackChannelId: externalId,
        slackTeamId,
        classification: channel.classification,
        mixed: channel.mixed,
        employeeId,
        ...(input.routeSource !== undefined
          ? { source: input.routeSource, counterpartSlackUserId: input.counterpartSlackUserId ?? null }
          : isSlackDmAutorouteEnabled()
            ? { source: "manual" as const, counterpartSlackUserId: null }
            : {}),
      })
    : null;
  return { channel, routeEmployeeId: route?.employeeId ?? null };
}
