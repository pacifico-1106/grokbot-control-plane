import { CrossProductEventError } from "@/lib/commerce/cross-product-events";
import { receiveSealithCommerceProjection } from "@/lib/commerce/sealith-projections";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await receiveSealithCommerceProjection({
      rawBody: await request.text(),
      eventIdHeader: request.headers.get("x-sealith-event-id"),
      timestampHeader: request.headers.get("x-sealith-event-timestamp"),
      signatureHeader: request.headers.get("x-sealith-event-signature"),
    });
    return jsonUtf8(result);
  } catch (error) {
    if (error instanceof CrossProductEventError) {
      return jsonUtf8({ error: error.code }, { status: error.status });
    }
    console.error("Sealith projection receive failed", error);
    return jsonUtf8({ error: "projection_receive_failed" }, { status: 500 });
  }
}
