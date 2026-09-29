import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { INLINE_CONTENT_TYPES } from "@/server/core/storage";
import * as p3 from "@/server/modules/p3-partner";

/**
 * Lampiran untuk pemilik mitra (portal): foto permintaan dukungan tenant sendiri, bukti mutu outletnya, dan tanda tangan
 * penerima pada rit pelanggan mitranya (US-P3-03 KP-4). Selain itu ditolak & tercatat (US-P3-10 KP-4, NFR-30).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/mitra/lampiran/[id]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk portal mitra terlebih dahulu." }, { status: 401 });
    const { id } = await ctx.params;
    const { row, body } = await p3.readPartnerAttachmentForPortal(actor, id);
    const inline = INLINE_CONTENT_TYPES.includes(row.contentType);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.originalName ?? row.id)}`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
