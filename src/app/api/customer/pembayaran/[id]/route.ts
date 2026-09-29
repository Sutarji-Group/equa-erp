import { isUuid } from "@/lib/ids";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { customerForRoute } from "@/server/modules/p2-customer/web";

import { unauthorized } from "../../_util";

/** Status kode bayar milik pelanggan (penyegaran halaman bayar, US-P2-04 KP-3). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/customer/pembayaran/[id]">) {
  try {
    const cctx = await customerForRoute();
    if (!cctx) return unauthorized();
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new NotFoundError("Pembayaran tidak ditemukan.");
    const v = await p2.getMyPaymentIntent(cctx, id);
    return Response.json({ status: v.status, statusLabel: v.statusLabel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
