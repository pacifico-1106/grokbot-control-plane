import { getSessionContext } from "@/lib/auth/session";
import { getOrgStripeCustomerId } from "@/lib/data/subscriptions";
import { isDemoMode } from "@/lib/mode";
import { getAppUrl, getStripe } from "@/lib/stripe";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

const PORTAL_ROLES = new Set(["owner", "admin"]);

/**
 * Stripe Customer Portal session.
 *
 * Access (fail-closed, production):
 * - logged-in user with an active org membership (resolved server-side from
 *   the Supabase session cookie → org_members; the request body is ignored),
 * - membership role must be owner or admin → otherwise 403,
 * - the Stripe customer is the one stored on the session org.
 * DEMO keeps the stub/preview response.
 */
export async function POST() {
  const stripe = getStripe();
  const appUrl = getAppUrl();
  const sessionCtx = await getSessionContext();
  const demo = isDemoMode();

  if (!demo) {
    if (!sessionCtx.userId || !sessionCtx.orgId) {
      return jsonUtf8(
        {
          ok: false,
          error: "auth_required",
          message: "ポータルを開くにはログインが必要です。",
        },
        { status: 401 }
      );
    }
    const member = sessionCtx.member;
    if (
      !member ||
      member.orgId !== sessionCtx.orgId ||
      !PORTAL_ROLES.has(String(member.role || ""))
    ) {
      return jsonUtf8(
        {
          ok: false,
          error: "admin_required",
          message:
            "契約内容の管理は、組織のオーナーまたは管理者のみ行えます。",
        },
        { status: 403 }
      );
    }
  }

  if (!stripe) {
    return jsonUtf8({
      ok: true,
      stub: true,
      message:
        "Stripe 未設定のためカスタマーポータルはスタブです。STRIPE_SECRET_KEY を設定し、Dashboard で Portal を有効化してください。",
      preview: {
        return_url: `${appUrl}/app/billing`,
      },
    });
  }

  const orgId = sessionCtx.orgId;
  if (!orgId) {
    return jsonUtf8(
      {
        ok: false,
        error: "org_required",
        message: "組織が見つかりません。",
      },
      { status: 400 }
    );
  }

  const customerId = await getOrgStripeCustomerId(orgId);
  if (!customerId) {
    return jsonUtf8(
      {
        ok: false,
        error: "no_stripe_customer",
        message:
          "Stripe 顧客がまだありません。ご契約については担当者にお問い合わせください。",
      },
      { status: 400 }
    );
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/app/billing`,
  });

  return jsonUtf8({ ok: true, url: portal.url });
}
