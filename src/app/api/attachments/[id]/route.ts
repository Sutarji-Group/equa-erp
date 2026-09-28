import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { INLINE_CONTENT_TYPES, readAttachment } from "@/server/core/storage";

/**
 * Menyajikan lampiran (foto bukti kirim, meter, nota…) setelah pemeriksaan pelaku, tenant & hak baca per objek
 * (`readAttachment`). Penyimpanan Vercel Blob bersifat privat, jadi semua akses lewat route ini. Pelaku dari resolver
 * F3c (cookie web / token perangkat); tanpa sesi → 401. Disajikan dengan `nosniff` + CSP sandbox; hanya gambar yang
 * inline, selain itu sebagai unduhan (XSS tersimpan tidak mungkin walau jenis berkas lolos).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/attachments/[id]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    const { id } = await ctx.params;
    const { row, body } = await readAttachment(actor, id);
    const inline = INLINE_CONTENT_TYPES.includes(row.contentType);
    const filename = row.originalName ?? `${row.id}`;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
