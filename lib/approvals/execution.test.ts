import { test, expect, mock, beforeEach } from "bun:test";
import type { ApprovalRequest, Employee } from "@/lib/types";
let employee: Employee;
let credential: Record<string,unknown> | null;
let binding: Record<string,unknown>;
let billed = true;
let claims = 0, effects = 0;
let claimState = "";
const approval = (): ApprovalRequest => ({ id: "approval", orgId: "org", employeeId: "employee", credentialId: "credential",
 title: "test", purpose: "support", summary: "test", risk: "low", status: "approved", tool: "comm.reply", jobId: "job",
 revisionNote:null, revisionCount:0, parentApprovalId:null, telegramRef:null, telegramMessageId:null,
 statusToken:"", pollPath:"", createdAt:"2026-09-16", resolvedAt:"2026-09-16",resolvedBy:null,
 metadata: { invoke: { orgId: "org", employeeId: "employee", tool:"comm.reply", purpose:"support",args:{text:"fixture",channel:"CTEST"} } },
});
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data/employees", () => ({ getEmployee: async () => employee }));
mock.module("@/lib/billing/entitlements", () => ({ assertBillingAllowsGateway: async () => ({ok:billed}) }));
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => ({
 from: (table: string) => {
  const filters: Record<string,unknown> = {};
  const query = { select: () => query, eq: (k:string,v:unknown) => { filters[k]=v;return query; }, maybeSingle: async () => {
   if (filters.org_id !== "org") return {data:null,error:null};
   return { data: table === "credentials" ? (filters.employee_id === "employee" && filters.id === "credential" ? credential : null) : table === "employees" ? employee : binding, error:null };
  } }; return query;
 },
 rpc: async (name: string, args: Record<string,unknown>) => {
   if (name === "claim_approval_execution") {
    claims++;
    if (claimState && claimState !== "failed") return {data:{state:claimState},error:null};
    claimState="running";
    const a=approval();
    return { data:{ state:"claimed", approval:{id:a.id,org_id:a.orgId,employee_id:a.employeeId,credential_id:a.credentialId,status:a.status,tool:a.tool,purpose:a.purpose,metadata:a.metadata} },error:null };
   }
   if (name === "finish_approval_execution") { claimState=String(args.p_state); return {data:true,error:null}; }
   throw new Error("unexpected_rpc");
 },
}) }));
const { executeApproval } = await import("./execution");
beforeEach(() => {
 employee={id:"employee",orgId:"org",status:"active",scopes:["slack:post"],allowedPurposes:["support"]} as Employee;
 credential={secret_hash:"hash",revoked_at:null,expires_at:null};
 binding={status:"linked",credential_fingerprint:"hash"};
 billed=true;claims=0;effects=0;claimState="";
});
const send = async () => { effects++; return {ok:true}; };
test("valid execution succeeds; concurrent callers share one claim and cause one external effect", async () => {
 const results=await Promise.allSettled([executeApproval(approval(),send),executeApproval(approval(),send)]);
 expect(results.filter(r=>r.status==="fulfilled").length).toBe(1);
 expect(effects).toBe(1);expect(claimState).toBe("succeeded");
});
test("revoked, expired, missing and mismatched credentials cannot claim or execute", async () => {
 for (const invalid of [{secret_hash:"hash",revoked_at:"2026-09-15"},{secret_hash:"hash",expires_at:"2000-01-01"},null,{secret_hash:"rotated"}]) {
  credential=invalid;
  await expect(executeApproval(approval(),send)).rejects.toThrow();
 }
 expect(effects).toBe(0);expect(claims).toBe(0);
});
test("suspended employees, removed scope/binding, denied tool, purpose or trial cannot execute", async () => {
 employee.status="suspended"; await expect(executeApproval(approval(),send)).rejects.toThrow(); employee.status="active";
 employee.scopes=[]; await expect(executeApproval(approval(),send)).rejects.toThrow(); employee.scopes=["slack:post"];
 employee.allowedPurposes=["other"]; await expect(executeApproval(approval(),send)).rejects.toThrow(); employee.allowedPurposes=[];
 binding.status="revoked"; await expect(executeApproval(approval(),send)).rejects.toThrow(); binding.status="linked";
 employee.toolApprovalDefaults={"comm.reply":"deny"}; await expect(executeApproval(approval(),send)).rejects.toThrow(); employee.toolApprovalDefaults={};
 billed=false; await expect(executeApproval(approval(),send)).rejects.toThrow();
 expect(effects).toBe(0);expect(claims).toBe(0);
});
test("tampered tenant, employee, tool and pending approval fail before DB mutation", async () => {
 for (const patch of [{orgId:"other"},{employeeId:"other"},{tool:"sns.publish"}]) {
  const a=approval();a.metadata.invoke={...(a.metadata.invoke as object),...patch};
  await expect(executeApproval(a,send)).rejects.toThrow();
 }
 const pending=approval();pending.status="pending";await expect(executeApproval(pending,send)).rejects.toThrow();
 const other=approval();other.orgId="other";other.metadata={};await expect(executeApproval(other,send)).rejects.toThrow();
 expect(effects).toBe(0);expect(claims).toBe(0);
});
test("unknown provider outcomes stop automatic retries; definite pre-send failures allow retry", async () => {
 await executeApproval(approval(), async () => {effects++;return {ok:false,error:"network_timeout"};});
 await expect(executeApproval(approval(),send)).rejects.toThrow();expect(effects).toBe(1);
 claimState="";
 await executeApproval(approval(), async () => ({ok:false,error:"missing_scope"}));
 expect(claimState).toBe("failed");
 await executeApproval(approval(),send);expect(effects).toBe(2);
});
