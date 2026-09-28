import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { readAttachment } from "@/server/core/storage";

/**
 * Menyajikan lampiran (foto bukti kirim, meter, nota…) setelah pemeriksaan pelaku & tenant. Penyimpanan Vercel Blob
 * bersifat privat, jadi semua akses lewat route ini. Pelaku dari resolver F3c (cookie web / token perangkat); tanpa sesi → 401.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/attachments/[id]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    const { id } = await ctx.params;
    const { row, body } = await readAttachment(actor, id);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "private, max-age=3600",
        ...(row.originalName ? { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.originalName)}` } : {}),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
