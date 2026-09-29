import { isUuid } from "@/lib/ids";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { customerForRoute } from "@/server/modules/p2-customer/web";

import { fileResponse, unauthorized } from "../../_util";

/** Foto bukti kirim / foto keluhan MILIK pelanggan (US-P2-04 KP-1; data pribadi hanya milik sendiri). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/customer/lampiran/[id]">) {
  try {
    const cctx = await customerForRoute();
    if (!cctx) return unauthorized();
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new NotFoundError("Berkas tidak ditemukan.");
    const file = await p2.readMyAttachment(cctx, id);
    return fileResponse(file.body, file.contentType, file.name, true);
  } catch (error) {
    return errorResponse(error);
  }
}
