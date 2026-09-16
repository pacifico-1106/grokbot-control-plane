import { createHmac } from "node:crypto";
import { afterEach, expect, mock, test } from "bun:test";
import { DEMO_ORG, upsertRuntimeMember, getRuntimeAudit } from "@/lib/demo-data";
import { createApproval, getApprovalById } from "@/lib/data/approvals";
import { upsertNotificationChannel, recordNotificationDelivery } from "@/lib/data/notification-channels";
import { resetDemoWorkflowData, setOrgApprovalWorkflowPolicy, setDemoWorkflowVoterBinding,
  getWorkflowInstanceByApprovalId, getBallotsByInstanceId } from "@/lib/approval-workflow/data";
import type { ApprovalRequest, NotificationChannel, OrgApprovalWorkflowPolicy } from "@/lib/types";
import { executeApproval } from "@/lib/approvals/execution";

let effects=0, completionNotifications=0;
let slackMessages: string[]=[];
const execute = async (a: ApprovalRequest) => executeApproval(a, async () => { effects++;return {ok:true}; });
mock.module("@/lib/approvals/fulfill", () => ({
  fulfillIfApproved: async (a: ApprovalRequest) => { if(a.status==="approved") await execute(a); },
  fulfillApprovedInvoke: execute,
}));
mock.module("@/lib/admin-mcp/fulfill-admin", () => ({ fulfillApprovedAdmin: async () => null }));
mock.module("@/lib/approvals/resolve-side-effects", () => ({ runApprovalResolveSideEffects: async () => {completionNotifications++;return {};} }));
const { POST: slack } = await import("./slack/[ref]/route");
const { POST: telegram } = await import("./telegram/[ref]/route");
const { POST: line } = await import("./line/[ref]/route");
const { POST: globalTelegram } = await import("./telegram/route");
const { proxyResolveApproval } = await import("@/lib/admin/proxy-approve");
const originalFetch=globalThis.fetch;
afterEach(() => { globalThis.fetch=originalFetch;resetDemoWorkflowData(); });
const member = (id:string, status:"active"|"disabled"="active") => upsertRuntimeMember({id,orgId:DEMO_ORG.id,
  email:`${id}@example.invalid`,displayName:id,role:"member",status,capabilities:["approve_actions"]});
const policy = (): OrgApprovalWorkflowPolicy => ({version:1,policyId:"route-fixture",policyName:"Route fixture",updatedAt:new Date().toISOString(),updatedBy:"fixture",
  stages:[{id:"committee",nameJa:"Committee",voterUserIds:["v1","v2"],quorum:{type:"count",n:2},onReject:"fail_closed"},
  {id:"review",nameJa:"Review",voterUserIds:["v2"],quorum:{type:"any"},onReject:"fail_closed"}],finalGoUserId:"v3"});
async function ticket() {
  effects=completionNotifications=0;
  slackMessages=[];
  for(const id of ["v1","v2","v3"]) member(id);
  globalThis.fetch=(async(input,init) => {
    const url=String(input);
    if(!url.startsWith("https://slack.com/api/") && !url.startsWith("https://api.telegram.org/") && !url.startsWith("https://api.line.me/")) throw new Error("unexpected_fixture_endpoint");
    if(url.startsWith("https://slack.com/api/")) slackMessages.push(String(init?.body));
    return Response.json({ok:true,channel:"C_FIXTURE",ts:"123.45",result:{message_id:77}});
  }) as typeof fetch;
  await setOrgApprovalWorkflowPolicy(DEMO_ORG.id,policy());
  return (await createApproval({orgId:DEMO_ORG.id,employeeId:"emp_sales",credentialId:"cred_sales",title:"F8 fixture",
    purpose:"fixture",summary:"Fixture",risk:"low",tool:"comm.reply",jobId:crypto.randomUUID()})).approval;
}
function bind(channel:NotificationChannel,userId:string,memberId:string) {
  setDemoWorkflowVoterBinding({orgId:DEMO_ORG.id,provider:channel.provider,channelKey:channel.id,userId,memberId});
}
async function slackVote(c:NotificationChannel,a:ApprovalRequest,userId:string,validSignature=true) {
  const raw=JSON.stringify({type:"block_actions",user:{id:userId},channel:{id:"C_FIXTURE"},message:{ts:"123.45"},
    actions:[{action_id:"staffpass_approve",value:a.telegramRef}]});
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=`v0=${createHmac("sha256","fixture-slack-secret").update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return slack(new Request("https://fixture.invalid/webhook",{method:"POST",headers:{"content-type":"application/json",
    "x-slack-request-timestamp":timestamp,"x-slack-signature":validSignature?signature:"bad"},body:raw}),{params:Promise.resolve({ref:c.webhookRef})});
}

test("signed Slack/Telegram/LINE and proxy share multi-stage quorum and finalGo; denied votes have no business effects",async()=>{
  const a=await ticket();
  const sc=await upsertNotificationChannel({orgId:DEMO_ORG.id,provider:"slack",label:"Fixture",enabled:true,
    config:{channelId:"C_FIXTURE"},secrets:{botToken:"xoxb-fixture",signingSecret:"fixture-slack-secret"}});
  const tc=await upsertNotificationChannel({orgId:DEMO_ORG.id,provider:"telegram",label:"Fixture",enabled:true,
    config:{chatId:"-10042"},secrets:{botToken:"fixture-telegram-token",webhookSecret:"fixture-telegram-secret"}});
  const lc=await upsertNotificationChannel({orgId:DEMO_ORG.id,provider:"line",label:"Fixture",enabled:true,
    config:{destinationId:"G_FIXTURE"},secrets:{channelAccessToken:"fixture-line-token",channelSecret:"fixture-line-secret"}});
  for(const c of [sc,tc,lc]) await recordNotificationDelivery({approval:a,channelId:c.id,provider:c.provider,
    externalMessageId:c.provider==="slack"?"123.45":"77",context:c.provider==="slack"?{channel:"C_FIXTURE"}:{}});
  bind(sc,"U1","v1");bind(tc,"42","v2");bind(lc,"L2","v2");
  expect((await slackVote(sc,a,"U1",false)).status).toBe(401);
  await slackVote(sc,a,"unbound");member("v1","disabled");await slackVote(sc,a,"U1");member("v1");
  const instance=(await getWorkflowInstanceByApprovalId(a.id))!;
  expect((await getBallotsByInstanceId(instance.id)).filter(b=>b.vote!==null).length).toBe(0);
  await slackVote(sc,a,"U1");await slackVote(sc,a,"U1");
  expect((await getBallotsByInstanceId(instance.id)).filter(b=>b.vote!==null).length).toBe(1);
  expect(effects).toBe(0);expect(completionNotifications).toBe(0);
  await telegram(new Request("https://fixture.invalid/webhook",{method:"POST",headers:{"x-telegram-bot-api-secret-token":"fixture-telegram-secret"},
    body:JSON.stringify({callback_query:{id:"fixture",data:`a:${a.telegramRef}`,from:{id:42},message:{message_id:77,chat:{id:-10042}}}})}),{params:Promise.resolve({ref:tc.webhookRef})});
  expect((await getWorkflowInstanceByApprovalId(a.id))?.currentStageIndex).toBe(1);
  const raw=JSON.stringify({events:[{webhookEventId:"fixture-line-event",type:"postback",source:{groupId:"G_FIXTURE",userId:"L2"},postback:{data:`a:${a.telegramRef}`}}]});
  await line(new Request("https://fixture.invalid/webhook",{method:"POST",headers:{"x-line-signature":createHmac("sha256","fixture-line-secret").update(raw).digest("base64")},body:raw}),{params:Promise.resolve({ref:lc.webhookRef})});
  expect((await getWorkflowInstanceByApprovalId(a.id))?.finalGoPending).toBe(true);
  expect(slackMessages.some(s=>s.includes("1/2"))).toBe(true);
  expect(slackMessages.some(s=>s.includes("最終Go待ち"))).toBe(true);
  expect((await getApprovalById(a.id,DEMO_ORG.id))?.status).toBe("pending");expect(effects).toBe(0);
  const input={targetOrgId:DEMO_ORG.id,approvalId:a.id,decision:"approved" as const,mandate:"support" as const};
  expect((await proxyResolveApproval({...input,actor:{userId:"platform-only",email:"ops@example.invalid"}})).ok).toBe(false);
  expect(effects).toBe(0);expect(completionNotifications).toBe(0);
  expect((await proxyResolveApproval({...input,actor:{userId:"v3",email:"v3@example.invalid"}})).ok).toBe(true);
  expect((await getApprovalById(a.id,DEMO_ORG.id))?.status).toBe("approved");
  expect(effects).toBe(1);expect(completionNotifications).toBe(1);
});

test("global Telegram fallback also requires an explicit voter binding and cannot bypass quorum",async()=>{
  const a=await ticket();
  // No tenant channel matches this global chat. Fixture-only environment is restored.
  const keys=["TELEGRAM_BOT_TOKEN","TELEGRAM_APPROVAL_CHAT_ID","TELEGRAM_WEBHOOK_SECRET","TELEGRAM_ALLOWED_USER_IDS"];
  const saved=keys.map(k=>process.env[k]);
  const values=["fixture-token","-10077","fixture-secret","77"];
  keys.forEach((k,i)=>{process.env[k]=values[i];});
  try {
    setDemoWorkflowVoterBinding({orgId:DEMO_ORG.id,provider:"telegram",channelKey:"telegram:global",userId:"77",memberId:"v1"});
    const request=()=>new Request("https://fixture.invalid/webhook",{method:"POST",headers:{"x-telegram-bot-api-secret-token":"fixture-secret"},
      body:JSON.stringify({callback_query:{id:"fixture-global",data:`a:${a.telegramRef}`,from:{id:77},message:{message_id:77,chat:{id:-10077}}}})});
    await globalTelegram(request());await globalTelegram(request());
    const instance=(await getWorkflowInstanceByApprovalId(a.id))!;
    expect((await getBallotsByInstanceId(instance.id)).filter(b=>b.vote!==null).length).toBe(1);
    expect((await getApprovalById(a.id,DEMO_ORG.id))?.status).toBe("pending");expect(effects).toBe(0);expect(completionNotifications).toBe(0);
    const voted=await proxyResolveApproval({targetOrgId:DEMO_ORG.id,approvalId:a.id,decision:"approved",mandate:"support",note:"fixture-mandate",
      actor:{userId:"v2",email:"v2@example.invalid"}});
    expect(voted.ok).toBe(true);
    const audit=getRuntimeAudit().find(e=>e.action==="admin.proxy_approve" && e.metadata?.approvalId===a.id);
    expect(audit?.metadata?.mandate).toBe("support");expect(audit?.metadata?.workflowComplete).toBe(false);
    expect(effects).toBe(0);expect(completionNotifications).toBe(0);
  } finally { keys.forEach((k,i)=>{if(saved[i]===undefined) delete process.env[k];else process.env[k]=saved[i];}); }
});
