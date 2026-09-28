import { getActorContext } from "@/server/core/actor";
import { assertSameOrigin } from "@/server/core/csrf";
import { errorResponse } from "@/server/core/errors";
import * as m11 from "@/server/modules/m11-accounting";

/**
 * Unduh ekspor format konsultan (US-M11-08 KP-3, NFR-23): `GET /akuntansi/pajak/ekspor?template=<kunci>&periode=YYYY-MM`.
 * Template aktif terbaru dipakai (format dapat diubah tanpa rilis). Ekspor menulis log ekspor & log akses, jadi
 * permintaan lintas situs ditolak. Otorisasi `m11.tax.export`/`m11.journal.export` di layanan.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh ekspor." }, { status: 401 });
    const url = new URL(request.url);
    const result = await m11.exportWithTemplate(actor, { templateKey: url.searchParams.get("template") ?? "", period: url.searchParams.get("periode") ?? "" });
    return new Response(new Uint8Array(result.body), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Rows": String(result.rowCount),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
