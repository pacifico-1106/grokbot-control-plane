/**
 * F8 Approval Workflow Data Access Layer
 *
 * CRUD operations for workflow policies, instances, and ballots.
 */

import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type {
  ApprovalLane,
  ApprovalWorkflowBallot,
  ApprovalWorkflowInstance,
  BallotVote,
  OrgApprovalWorkflowPolicy,
  WorkflowInstanceStatus,
} from "@/lib/types";

const demoWorkflowPolicies = new Map<string, OrgApprovalWorkflowPolicy>();
const demoEmployeeWorkflowPolicies = new Map<string, OrgApprovalWorkflowPolicy>();
const demoInstances = new Map<string, ApprovalWorkflowInstance>();
const demoBallots = new Map<string, ApprovalWorkflowBallot>();

function mapPolicyRow(row: Record<string, unknown>): OrgApprovalWorkflowPolicy | null {
  if (!row || typeof row !== "object") return null;
  const policy = row as unknown as OrgApprovalWorkflowPolicy;
  if (!policy.version || !policy.policyId) return null;
  return policy;
}

function mapInstanceRow(row: Record<string, unknown>): ApprovalWorkflowInstance | null {
  if (!row || typeof row !== "object") return null;
  return {
    id: String(row.id || ""),
    approvalId: String(row.approval_id || ""),
    orgId: String(row.org_id || ""),
    policyId: String(row.policy_id || ""),
    policySnapshot: row.policy_snapshot as OrgApprovalWorkflowPolicy,
    currentStageIndex: Number(row.current_stage_index ?? 0),
    status: (row.status as WorkflowInstanceStatus) || "active",
    finalGoPending: Boolean(row.final_go_pending),
    finalGoUserId: row.final_go_user_id ? String(row.final_go_user_id) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function mapBallotRow(row: Record<string, unknown>): ApprovalWorkflowBallot | null {
  if (!row || typeof row !== "object") return null;
  return {
    id: String(row.id || ""),
    instanceId: String(row.instance_id || ""),
    orgId: String(row.org_id || ""),
    stageId: String(row.stage_id || ""),
    stageIndex: Number(row.stage_index ?? 0),
    voterUserId: String(row.voter_user_id || ""),
    vote: (row.vote as BallotVote) ?? null,
    votedAt: row.voted_at ? String(row.voted_at) : null,
    isFinalGo: Boolean(row.is_final_go),
    createdAt: String(row.created_at || new Date().toISOString()),
  };
}

export async function getOrgApprovalWorkflowPolicy(
  orgId: string
): Promise<OrgApprovalWorkflowPolicy | null> {
  if (isDemoMode()) {
    return demoWorkflowPolicies.get(orgId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("orgs")
    .select("approval_workflow_policy")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !data?.approval_workflow_policy) return null;
  return mapPolicyRow(data.approval_workflow_policy as Record<string, unknown>);
}

export async function getEmployeeApprovalWorkflowPolicy(
  employeeId: string,
  orgId: string
): Promise<OrgApprovalWorkflowPolicy | null> {
  if (isDemoMode()) {
    return demoEmployeeWorkflowPolicies.get(`${orgId}:${employeeId}`) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("employees")
    .select("approval_workflow_policy")
    .eq("id", employeeId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data?.approval_workflow_policy) return null;
  return mapPolicyRow(data.approval_workflow_policy as Record<string, unknown>);
}

export type ApprovalWorkflowPolicySource = "employee" | "org" | "none";

export interface EffectiveApprovalWorkflowPolicy {
  policy: OrgApprovalWorkflowPolicy | null;
  source: ApprovalWorkflowPolicySource;
  employeeOverride: OrgApprovalWorkflowPolicy | null;
  orgPolicy: OrgApprovalWorkflowPolicy | null;
}

export async function getEffectiveApprovalWorkflowPolicy(
  orgId: string,
  employeeId?: string | null
): Promise<EffectiveApprovalWorkflowPolicy> {
  const orgPolicy = await getOrgApprovalWorkflowPolicy(orgId);
  const employeeOverride = employeeId
    ? await getEmployeeApprovalWorkflowPolicy(employeeId, orgId)
    : null;

  if (employeeOverride) {
    return {
      policy: employeeOverride,
      source: "employee",
      employeeOverride,
      orgPolicy,
    };
  }

  if (orgPolicy) {
    return {
      policy: orgPolicy,
      source: "org",
      employeeOverride: null,
      orgPolicy,
    };
  }

  return {
    policy: null,
    source: "none",
    employeeOverride: null,
    orgPolicy: null,
  };
}

export async function setOrgApprovalWorkflowPolicy(
  orgId: string,
  policy: OrgApprovalWorkflowPolicy
): Promise<boolean> {
  if (isDemoMode()) {
    demoWorkflowPolicies.set(orgId, policy);
    return true;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return false;

  const { error } = await admin
    .from("orgs")
    .update({ approval_workflow_policy: policy })
    .eq("id", orgId);

  return !error;
}

export async function setEmployeeApprovalWorkflowPolicy(
  employeeId: string,
  orgId: string,
  policy: OrgApprovalWorkflowPolicy | null
): Promise<boolean> {
  if (isDemoMode()) {
    const key = `${orgId}:${employeeId}`;
    if (policy) {
      demoEmployeeWorkflowPolicies.set(key, policy);
    } else {
      demoEmployeeWorkflowPolicies.delete(key);
    }
    return true;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return false;

  const { error } = await admin
    .from("employees")
    .update({ approval_workflow_policy: policy })
    .eq("id", employeeId)
    .eq("org_id", orgId);

  return !error;
}

export async function createWorkflowInstance(input: {
  approvalId: string;
  orgId: string;
  policy: OrgApprovalWorkflowPolicy;
}): Promise<ApprovalWorkflowInstance | null> {
  const now = new Date().toISOString();
  const instance: ApprovalWorkflowInstance = {
    id: crypto.randomUUID(),
    approvalId: input.approvalId,
    orgId: input.orgId,
    policyId: input.policy.policyId,
    policySnapshot: input.policy,
    currentStageIndex: 0,
    status: "active",
    finalGoPending: false,
    finalGoUserId: input.policy.finalGoUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  if (isDemoMode()) {
    demoInstances.set(instance.id, instance);
    return instance;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_instances")
    .insert({
      id: instance.id,
      approval_id: instance.approvalId,
      org_id: instance.orgId,
      policy_id: instance.policyId,
      policy_snapshot: instance.policySnapshot,
      current_stage_index: instance.currentStageIndex,
      status: instance.status,
      final_go_pending: instance.finalGoPending,
      final_go_user_id: instance.finalGoUserId,
    })
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return mapInstanceRow(data as Record<string, unknown>);
}

export async function getWorkflowInstanceByApprovalId(
  approvalId: string
): Promise<ApprovalWorkflowInstance | null> {
  if (isDemoMode()) {
    for (const instance of demoInstances.values()) {
      if (instance.approvalId === approvalId) return instance;
    }
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_instances")
    .select("*")
    .eq("approval_id", approvalId)
    .maybeSingle();

  if (error || !data) return null;
  return mapInstanceRow(data as Record<string, unknown>);
}

export async function getWorkflowInstanceById(
  instanceId: string
): Promise<ApprovalWorkflowInstance | null> {
  if (isDemoMode()) {
    return demoInstances.get(instanceId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_instances")
    .select("*")
    .eq("id", instanceId)
    .maybeSingle();

  if (error || !data) return null;
  return mapInstanceRow(data as Record<string, unknown>);
}

export async function updateWorkflowInstance(
  instanceId: string,
  patch: {
    currentStageIndex?: number;
    status?: WorkflowInstanceStatus;
    finalGoPending?: boolean;
  }
): Promise<ApprovalWorkflowInstance | null> {
  if (isDemoMode()) {
    const instance = demoInstances.get(instanceId);
    if (!instance) return null;
    const updated = {
      ...instance,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    demoInstances.set(instanceId, updated);
    return updated;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.currentStageIndex !== undefined) {
    update.current_stage_index = patch.currentStageIndex;
  }
  if (patch.status !== undefined) {
    update.status = patch.status;
  }
  if (patch.finalGoPending !== undefined) {
    update.final_go_pending = patch.finalGoPending;
  }

  const { data, error } = await admin
    .from("approval_workflow_instances")
    .update(update)
    .eq("id", instanceId)
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return mapInstanceRow(data as Record<string, unknown>);
}

export async function createBallotsForStage(input: {
  instanceId: string;
  orgId: string;
  stage: ApprovalLane;
  stageIndex: number;
}): Promise<ApprovalWorkflowBallot[]> {
  const now = new Date().toISOString();
  const ballots: ApprovalWorkflowBallot[] = input.stage.voterUserIds.map(
    (voterUserId) => ({
      id: crypto.randomUUID(),
      instanceId: input.instanceId,
      orgId: input.orgId,
      stageId: input.stage.id,
      stageIndex: input.stageIndex,
      voterUserId,
      vote: null,
      votedAt: null,
      isFinalGo: false,
      createdAt: now,
    })
  );

  if (isDemoMode()) {
    for (const ballot of ballots) {
      demoBallots.set(ballot.id, ballot);
    }
    return ballots;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .insert(
      ballots.map((b) => ({
        id: b.id,
        instance_id: b.instanceId,
        org_id: b.orgId,
        stage_id: b.stageId,
        stage_index: b.stageIndex,
        voter_user_id: b.voterUserId,
        vote: b.vote,
        voted_at: b.votedAt,
        is_final_go: b.isFinalGo,
      }))
    )
    .select("*");

  if (error || !data) return [];
  return data.map((row) => mapBallotRow(row as Record<string, unknown>)!).filter(Boolean);
}

export async function createFinalGoBallot(input: {
  instanceId: string;
  orgId: string;
  finalGoUserId: string;
}): Promise<ApprovalWorkflowBallot | null> {
  const now = new Date().toISOString();
  const ballot: ApprovalWorkflowBallot = {
    id: crypto.randomUUID(),
    instanceId: input.instanceId,
    orgId: input.orgId,
    stageId: "final_go",
    stageIndex: -1,
    voterUserId: input.finalGoUserId,
    vote: null,
    votedAt: null,
    isFinalGo: true,
    createdAt: now,
  };

  if (isDemoMode()) {
    demoBallots.set(ballot.id, ballot);
    return ballot;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .insert({
      id: ballot.id,
      instance_id: ballot.instanceId,
      org_id: ballot.orgId,
      stage_id: ballot.stageId,
      stage_index: ballot.stageIndex,
      voter_user_id: ballot.voterUserId,
      vote: ballot.vote,
      voted_at: ballot.votedAt,
      is_final_go: ballot.isFinalGo,
    })
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return mapBallotRow(data as Record<string, unknown>);
}

export async function getBallotsByInstanceId(
  instanceId: string
): Promise<ApprovalWorkflowBallot[]> {
  if (isDemoMode()) {
    return Array.from(demoBallots.values()).filter(
      (b) => b.instanceId === instanceId
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .select("*")
    .eq("instance_id", instanceId)
    .order("stage_index", { ascending: true });

  if (error || !data) return [];
  return data.map((row) => mapBallotRow(row as Record<string, unknown>)!).filter(Boolean);
}

export async function getBallotForVoter(
  instanceId: string,
  stageId: string,
  voterUserId: string
): Promise<ApprovalWorkflowBallot | null> {
  if (isDemoMode()) {
    for (const ballot of demoBallots.values()) {
      if (
        ballot.instanceId === instanceId &&
        ballot.stageId === stageId &&
        ballot.voterUserId === voterUserId
      ) {
        return ballot;
      }
    }
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .select("*")
    .eq("instance_id", instanceId)
    .eq("stage_id", stageId)
    .eq("voter_user_id", voterUserId)
    .maybeSingle();

  if (error || !data) return null;
  return mapBallotRow(data as Record<string, unknown>);
}

export async function castBallot(
  ballotId: string,
  vote: BallotVote
): Promise<ApprovalWorkflowBallot | null> {
  const now = new Date().toISOString();

  if (isDemoMode()) {
    const ballot = demoBallots.get(ballotId);
    if (!ballot) return null;
    const updated = { ...ballot, vote, votedAt: now };
    demoBallots.set(ballotId, updated);
    return updated;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .update({ vote, voted_at: now })
    .eq("id", ballotId)
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return mapBallotRow(data as Record<string, unknown>);
}

export async function getPendingBallotsByVoter(
  voterUserId: string,
  orgId: string
): Promise<ApprovalWorkflowBallot[]> {
  if (isDemoMode()) {
    return Array.from(demoBallots.values()).filter(
      (b) => b.voterUserId === voterUserId && b.orgId === orgId && b.vote === null
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("approval_workflow_ballots")
    .select("*")
    .eq("voter_user_id", voterUserId)
    .eq("org_id", orgId)
    .is("vote", null);

  if (error || !data) return [];
  return data.map((row) => mapBallotRow(row as Record<string, unknown>)!).filter(Boolean);
}

export function resetDemoWorkflowData(): void {
  demoWorkflowPolicies.clear();
  demoEmployeeWorkflowPolicies.clear();
  demoInstances.clear();
  demoBallots.clear();
}

export async function listActiveWorkflowInstances(
  orgId: string
): Promise<ApprovalWorkflowInstance[]> {
  if (isDemoMode()) {
    return Array.from(demoInstances.values()).filter(
      (i) => i.orgId === orgId && i.status === "active"
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("approval_workflow_instances")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error || !data) return [];
  return data.map((row) => mapInstanceRow(row as Record<string, unknown>)!).filter(Boolean);
}
