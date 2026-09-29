import { isUuid } from "@/lib/ids";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { customerForRoute } from "@/server/modules/p2-customer/web";

import { unauthorized } from "../../_util";

/** Posisi truk pesanan pelanggan (penyegaran peta; hanya saat Berangkat menuju alamatnya — PTB-54). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/customer/lacak/[orderId]">) {
  try {
    const cctx = await customerForRoute();
    if (!cctx) return unauthorized();
    const { orderId } = await ctx.params;
    if (!isUuid(orderId)) throw new NotFoundError("Pesanan tidak ditemukan.");
    return Response.json(await p2.getTracking(cctx, orderId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
