import { getActorContext } from "@/server/core/actor";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import { isUuid } from "@/lib/ids";
import * as m5 from "@/server/modules/m5-receivables";

/**
 * Unduh PDF faktur (US-M5-01 KP-5, US-M5-06 KP-2/KP-4): `GET /piutang/faktur/<id>/pdf`. Identitas usaha dari
 * `company.identity`, tanpa PPN & bukan faktur pajak (BR-29). Otorisasi `m5.invoice.read` di layanan.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/piutang/faktur/[id]/pdf">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh faktur." }, { status: 401 });
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new NotFoundError("Faktur tidak ditemukan.");
    const pdf = await m5.renderInvoicePdf(actor, id);
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
