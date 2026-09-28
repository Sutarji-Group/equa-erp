import { getActorContext } from "@/server/core/actor";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import { isUuid } from "@/lib/ids";
import * as m5 from "@/server/modules/m5-receivables";

/**
 * Unduh bukti pelunasan PDF untuk pelanggan (US-M5-02 KP-5): `GET /piutang/pelunasan/<id>/bukti`. Otorisasi
 * `m5.customer_payment.read` di layanan.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/piutang/pelunasan/[id]/bukti">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh bukti pelunasan." }, { status: 401 });
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new NotFoundError("Pelunasan tidak ditemukan.");
    const pdf = await m5.renderPaymentReceiptPdf(actor, id);
    return new Response(new Uint8Array(pdf.body), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
