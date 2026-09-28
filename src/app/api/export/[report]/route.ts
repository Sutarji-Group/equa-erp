import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { exportReport, type ExportFormat } from "@/server/core/export";

/**
 * Unduh laporan: `GET /api/export/<kunci>?format=xlsx|pdf|csv&purpose=…&<filter>=…` (US-M9-03, BR-39).
 * Pelaku dari `getActorContext` — TODO(auth): resolver sesi dipasang F3c; sampai itu route membalas 401.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESERVED = new Set(["format", "purpose"]);

export async function GET(request: Request, ctx: RouteContext<"/api/export/[report]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) {
      return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh laporan." }, { status: 401 });
    }
    const { report } = await ctx.params;
    const url = new URL(request.url);
    const format = (url.searchParams.get("format") ?? "xlsx") as ExportFormat;
    const purpose = url.searchParams.get("purpose");
    const filters: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (!RESERVED.has(k) && v !== "") filters[k] = v;
    }
    const result = await exportReport(actor, decodeURIComponent(report), format, filters, purpose);
    return new Response(new Uint8Array(result.body), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(result.rowCount),
        "X-Export-Sha256": result.sha256,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
