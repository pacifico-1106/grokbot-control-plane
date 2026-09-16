import { test, expect, mock } from "bun:test";
let agent: Record<string,unknown> | null={id:"agent",status:"linked",credential_fingerprint:"fixture-hash",credential_generation:2,grok_bot_agent_id:"bot"};
mock.module("@/lib/supabase",()=>({createSupabaseAdminClient:()=>({from:()=>{const filters:Record<string,unknown>={};const query={select:()=>query,eq:(k:string,v:unknown)=>{filters[k]=v;return query;},maybeSingle:async()=>({data:filters.org_id==="org"&&filters.id==="agent"?agent:null,error:null})};return query;}})}));
const { isApprovalAuthorityCurrent } = await import("./approval-authority");
const approval={orgId:"org",employeeId:"",credentialId:"",purpose:"admin.policy",metadata:{auditClass:"admin",adminRequester:{kind:"admin_agent",actorId:"agent",grokBotAgentId:"bot",credentialGeneration:2}}};
test("worker admin authority requires current tenant, requester, generation and active binding",async()=>{
 expect(await isApprovalAuthorityCurrent(approval)).toBe(true);
 expect(await isApprovalAuthorityCurrent({...approval,orgId:"other"})).toBe(false);
 for (const patch of [{status:"revoked"},{status:"needs_reauth"},{credential_generation:3},{grok_bot_agent_id:"rebound"},{credential_fingerprint:null}]) {
  const original=agent;agent={...agent,...patch};expect(await isApprovalAuthorityCurrent(approval)).toBe(false);agent=original;
 }
 agent=null;expect(await isApprovalAuthorityCurrent(approval)).toBe(false);
});
