import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { DEMO_ORG, upsertRuntimeMember } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { createApproval, getApprovalById, resolveApproval } from "@/lib/data/approvals";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest, OrgApprovalWorkflowPolicy } from "@/lib/types";
import { getOrgApprovalWorkflowPolicy, resetDemoWorkflowData, setOrgApprovalWorkflowPolicy } from "./data";
let sent: string[]=[];
mock.module("@/lib/notify/channels",()=>({
  sendApprovalNotifications: async (a:ApprovalRequest)=>{sent.push(a.id);return [{ok:true,provider:"slack"}];},
  refreshWorkflowNotification:async()=>{},
  updateApprovalNotificationMessages:async()=>[],
}));
const { callAdminMcpTool }=await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin }=await import("@/lib/admin-mcp/fulfill-admin");
let cred:ResolvedAdminCredential;
const stages=[{id:"review",nameJa:"Review",voterUserIds:["fixture-reviewer"],quorum:{type:"any" as const},onReject:"fail_closed" as const}];
beforeEach(()=>{
 resetDemoWorkflowData();sent=[];
 upsertRuntimeMember({id:"fixture-reviewer",orgId:DEMO_ORG.id,email:"reviewer@example.invalid",displayName:"fixture",role:"member",status:"active",capabilities:["approve_actions"]});
 const agent=resetDemoAdminAgent({grokBotAgentId:"fixture-admin",status:"linked"});
 cred={orgId:DEMO_ORG.id,adminAgentId:agent.id,actorId:agent.id,grokBotAgentId:agent.grokBotAgentId,generation:agent.credentialGeneration,via:"bearer",agent};
});
afterEach(()=>resetDemoWorkflowData());
const data=(result:Awaited<ReturnType<typeof callAdminMcpTool>>)=>result.structuredContent as Record<string,unknown>;
const approve=(id:string)=>resolveApproval(id,"approved","reviewer@example.invalid",DEMO_ORG.id,{actorId:"fixture-reviewer"});

test("workflow patch is human-gated, rejects self-approval, fulfills after approval and is idempotent",async()=>{
 const queued=data(await callAdminMcpTool("approvalWorkflow.patch",{policyName:"Fixture",stages},cred));
 expect(queued.needs_approval).toBe(true);
 const id=String(queued.approvalId);
 expect(await fulfillApprovedAdmin((await getApprovalById(id,DEMO_ORG.id))!)).toBeNull();
 expect(await getOrgApprovalWorkflowPolicy(DEMO_ORG.id)).toBeNull();
 await expect(resolveApproval(id,"approved","requester",DEMO_ORG.id,{actorId:cred.actorId})).rejects.toThrow("self_approval_denied");
 await approve(id);
 expect(data(await callAdminMcpTool("approvalWorkflow.patch",{approvalId:id},cred)).ok).toBe(true);
 const policy=await getOrgApprovalWorkflowPolicy(DEMO_ORG.id);
 expect(policy?.stages).toEqual(stages);
 expect(data(await callAdminMcpTool("approvalWorkflow.patch",{approvalId:id},cred)).ok).toBe(true);
 expect(await getOrgApprovalWorkflowPolicy(DEMO_ORG.id)).toEqual(policy);
});

test("a removed/disabled voter blocks policy application after approval without a policy write",async()=>{
 const queued=data(await callAdminMcpTool("approvalWorkflow.patch",{policyName:"Fixture",stages},cred));
 const id=String(queued.approvalId);await approve(id);
 upsertRuntimeMember({id:"fixture-reviewer",orgId:DEMO_ORG.id,email:"reviewer@example.invalid",displayName:"fixture",role:"member",status:"disabled",capabilities:["approve_actions"]});
 const result=await fulfillApprovedAdmin((await getApprovalById(id,DEMO_ORG.id))!);
 expect(result?.ok).toBe(false);expect(result?.error).toBe("voter_not_authorized");
 expect(await getOrgApprovalWorkflowPolicy(DEMO_ORG.id)).toBeNull();
});

test("remind separates targetApprovalId from its approval ticket; sends once only after approval",async()=>{
 const policy:OrgApprovalWorkflowPolicy={version:1,policyId:"fixture",policyName:"Fixture",stages,
   match:{tools:["comm.reply"]},updatedAt:new Date().toISOString(),updatedBy:"fixture"};
 await setOrgApprovalWorkflowPolicy(DEMO_ORG.id,policy);
 const target=(await createApproval({orgId:DEMO_ORG.id,employeeId:"emp_sales",credentialId:"cred_sales",title:"Fixture",purpose:"fixture",
   risk:"low",summary:"Fixture",tool:"comm.reply",jobId:crypto.randomUUID()})).approval;
 const denied=data(await callAdminMcpTool("approvalWorkflow.remind",{targetApprovalId:target.id},{...cred,orgId:"other"}));
 expect(denied.code).toBe("target_approval_not_pending");
 const queued=data(await callAdminMcpTool("approvalWorkflow.remind",{targetApprovalId:target.id},cred));
 expect(queued.needs_approval).toBe(true);expect(queued.approvalId).not.toBe(target.id);
 expect(sent.filter(id=>id===target.id).length).toBe(0);
 const id=String(queued.approvalId);await approve(id);
 expect(data(await callAdminMcpTool("approvalWorkflow.remind",{approvalId:id},cred)).ok).toBe(true);
 expect(sent.filter(id=>id===target.id).length).toBe(1);
 expect(data(await callAdminMcpTool("approvalWorkflow.remind",{approvalId:id},cred)).ok).toBe(true);
 expect(sent.filter(id=>id===target.id).length).toBe(1);
});

test("remind rechecks the target on execution; resolved targets cause no reminder",async()=>{
 await setOrgApprovalWorkflowPolicy(DEMO_ORG.id,{version:1,policyId:"fixture",policyName:"Fixture",stages,
   match:{tools:["comm.reply"]},updatedAt:new Date().toISOString(),updatedBy:"fixture"});
 const target=(await createApproval({orgId:DEMO_ORG.id,employeeId:"emp_sales",credentialId:"cred_sales",title:"Fixture",purpose:"fixture",
   risk:"low",summary:"Fixture",tool:"comm.reply",jobId:crypto.randomUUID()})).approval;
 const queued=data(await callAdminMcpTool("approvalWorkflow.remind",{targetApprovalId:target.id},cred));
 await resolveApproval(target.id,"rejected","reviewer@example.invalid",DEMO_ORG.id,{actorId:"fixture-reviewer"});
 const id=String(queued.approvalId);await approve(id);
 const result=await fulfillApprovedAdmin((await getApprovalById(id,DEMO_ORG.id))!);
 expect(result?.ok).toBe(false);expect(result?.error).toBe("target_approval_not_pending");
 expect(sent.filter(id=>id===target.id).length).toBe(0);
});
