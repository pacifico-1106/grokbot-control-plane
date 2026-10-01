/**
 * Public catalog API endpoint.
 * Returns public catalog items for LP display.
 */

import { NextResponse } from "next/server";
import { getCatalog } from "@/lib/lp/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const catalog = await getCatalog();
    
    const publicItems = catalog.items
      .filter((item) => !item.requiresQuote)
      .map((item) => ({
        sku: item.sku,
        displayName: item.displayName,
        displayNameJa: item.displayNameJa,
        monthlyAmountExTax: item.monthlyAmountExTax,
        setupAmountExTax: item.setupAmountExTax,
        annualDisplayAmountExTax: item.annualDisplayAmountExTax,
      }));

    const customItem = catalog.items.find((item) => item.requiresQuote);

    return NextResponse.json({
      ok: true,
      version: catalog.versionKey,
      purchaseEnabled: catalog.purchaseEnabled,
      items: publicItems,
      customQuote: customItem
        ? {
            sku: customItem.sku,
            displayName: customItem.displayName,
            displayNameJa: customItem.displayNameJa,
            requiresConsultation: true,
          }
        : null,
    });
  } catch (error) {
    console.error("[catalog] Failed to load catalog:", error);
    return NextResponse.json(
      { ok: false, error: "catalog_load_failed" },
      { status: 500 }
    );
  }
}
