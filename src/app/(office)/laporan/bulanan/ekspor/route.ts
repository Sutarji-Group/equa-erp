import { getActorContext } from "@/server/core/actor";
import { assertSameOrigin } from "@/server/core/csrf";
import { errorResponse } from "@/server/core/errors";
import * as m9 from "@/server/modules/m9-reports";

/**
 * Unduh laporan laba kotor bulanan (US-M9-02, US-M9-03 KP-4): `GET /laporan/bulanan/ekspor?bulan=YYYY-MM&format=xlsx|pdf`.
 * Periode Dikunci (Final) → berkas pertama disimpan dan disajikan ulang IDENTIK; Sementara → dirender ulang. Setiap
 * unduhan tercatat di log ekspor & log akses; permintaan lintas situs ditolak (CSRF).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh laporan." }, { status: 401 });
    const url = new URL(request.url);
    const result = await m9.exportMonthlyReport(actor, { month: url.searchParams.get("bulan") ?? "", format: url.searchParams.get("format") ?? "xlsx" });
    return new Response(new Uint8Array(result.body), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
        "X-Export-Sha256": result.sha256,
        "X-Report-Final": result.final ? "1" : "0",
        "X-Export-Reused": result.reused ? "1" : "0",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
