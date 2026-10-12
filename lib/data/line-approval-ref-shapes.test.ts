/**
 * 木村 10/12: after #228 an unknown ref answers 404 instead of 200. Every ref
 * shape the code can produce must still resolve, so no existing LINE approval
 * channel (e.g. 稲盛 at スペースツリー) breaks:
 *   - DB default: encode(gen_random_bytes(6), 'hex')  (20260827_tenant_notification_channels.sql)
 *   - app / demo create: randomBytes(6).toString("hex") (lib/data/notification-channels.ts)
 * Both are 12 lowercase hex. A ref is looked up by exact equality; the route adds
 * no shape check of its own. Production refs are confirmed by 木村 with
 * supabase/verification/line-approval-refs-in-use-20261012.sql.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  getNotificationChannelByWebhookRef,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { POST } from "@/app/api/webhooks/line/[ref]/route";

const SECRETS = { channelAccessToken: "A".repeat(120), channelSecret: "0123456789abcdef0123456789abcdef" };
afterEach(() => resetDemoNotificationChannels());

async function make(enabled = true) {
  return upsertNotificationChannel({
    orgId: DEMO_ORG.id, provider: "line", label: "LINE 承認", enabled,
    config: { destinationId: "U" + "0".repeat(32) }, secrets: enabled ? SECRETS : {},
  } as never);
}
const post = (ref: string, body = '{"events":[]}', secret = SECRETS.channelSecret) =>
  POST(new Request(`http://x/api/webhooks/line/${ref}`, {
    method: "POST", body, headers: { "x-line-signature": createHmac("sha256", secret).update(body).digest("base64") },
  }), { params: Promise.resolve({ ref }) });

describe("every LINE approval ref shape the code produces still resolves under #228", () => {
  test("the DB default and the app both produce 12 lowercase hex", () => {
    const mig = readFileSync("supabase/migrations/20260827_tenant_notification_channels.sql", "utf8");
    expect(mig).toContain("webhook_ref text not null default encode(gen_random_bytes(6), 'hex')");
    const src = readFileSync("lib/data/notification-channels.ts", "utf8");
    expect(src).toContain('webhookRef: existing?.webhookRef || randomBytes(6).toString("hex")');
    expect(randomBytes(6).toString("hex")).toMatch(/^[0-9a-f]{12}$/);
  });

  test("an app-created channel's ref resolves, and the route answers 200 to LINE 検証 (not 404)", async () => {
    const ch = await make();
    expect(ch.webhookRef).toMatch(/^[0-9a-f]{12}$/);
    expect((await getNotificationChannelByWebhookRef("line", ch.webhookRef))?.id).toBe(ch.id);
    expect((await post(ch.webhookRef)).status).toBe(200);
    expect((await post(ch.webhookRef, '{"events":[]}', "wrong")).status).toBe(401); // resolved, then signature
  });

  test("20 app-created channels (20 random refs) all resolve through the route", async () => {
    for (let i = 0; i < 20; i++) {
      const ch = await upsertNotificationChannel({
        orgId: `org_ref_${i}`, provider: "line", label: `LINE ${i}`, enabled: true,
        config: { destinationId: "U" + "0".repeat(32) }, secrets: SECRETS,
      } as never);
      expect(ch.webhookRef).toMatch(/^[0-9a-f]{12}$/);
      expect(encodeURIComponent(ch.webhookRef)).toBe(ch.webhookRef); // webhookPath keeps it as is
      expect((await post(ch.webhookRef)).status).toBe(200);
    }
  });

  test("only unknown / disabled / credential-less refs answer 404", async () => {
    expect((await post("000000000000")).status).toBe(404);
    const off = await make(false);
    expect((await post(off.webhookRef)).status).toBe(404);
  });
});
