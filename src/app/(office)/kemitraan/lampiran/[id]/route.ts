import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { INLINE_CONTENT_TYPES } from "@/server/core/storage";
import * as p3 from "@/server/modules/p3-partner";

/**
 * Lampiran objek Kemitraan untuk pengguna EQUA — termasuk berkas milik tenant mitra yang DIPERJANJIKAN (foto
 * permintaan dukungan, daftar periksa mutu, audit, sertifikat uji air; NFR-30). Diotorisasi per objek di
 * `readPartnerAttachmentForEqua`; selain itu ditolak & tercatat di log akses.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/kemitraan/lampiran/[id]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    const { id } = await ctx.params;
    const { row, body } = await p3.readPartnerAttachmentForEqua(actor, id);
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
