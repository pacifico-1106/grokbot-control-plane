import { NextResponse } from "next/server";
import { CrossProductEventError } from "@/lib/commerce/cross-product-events";
import { receiveSealithCommerceProjection } from "@/lib/commerce/sealith-projections";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await receiveSealithCommerceProjection({
      rawBody: await request.text(),
      eventIdHeader: request.headers.get("x-sealith-event-id"),
      timestampHeader: request.headers.get("x-sealith-event-timestamp"),
      signatureHeader: request.headers.get("x-sealith-event-signature"),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CrossProductEventError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    console.error("Sealith projection receive failed", error);
    return NextResponse.json({ error: "projection_receive_failed" }, { status: 500 });
  }
}
