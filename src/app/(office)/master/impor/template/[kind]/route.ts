import { getActorContext } from "@/server/core/actor";
import { errorResponse, ForbiddenError, NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

/**
 * Unduh template Excel impor data awal (US-M1-06 KP-1): `GET /master/impor/template/<jenis>` (kosong) atau
 * `?contoh=1` (contoh terisi). Hanya pengguna dengan izin impor.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/master/impor/template/[kind]">) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    if (!can(actor, "m1.import.create") && !can(actor, "m1.import.read")) {
      throw new ForbiddenError("Anda tidak berhak mengunduh template impor data awal.", { permission: "m1.import.create" });
    }
    const { kind } = await ctx.params;
    if (!m1.isImportKindM1(kind)) throw new NotFoundError("Jenis template tidak dikenal.");
    const example = new URL(request.url).searchParams.get("contoh") === "1";
    const body = await m1.buildImportTemplate(kind, { withExample: example });
    const filename = `${example ? "contoh" : "template"}-impor-${kind}.xlsx`;
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
