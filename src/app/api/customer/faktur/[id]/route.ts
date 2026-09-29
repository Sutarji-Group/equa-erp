import { isUuid } from "@/lib/ids";
import { errorResponse, NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { customerForRoute } from "@/server/modules/p2-customer/web";

import { fileResponse, unauthorized } from "../../_util";

/** PDF faktur milik pelanggan (termasuk faktur bulanan, US-M5-06) — unduhan tercatat (US-P2-04 KP-2/KP-5). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: RouteContext<"/api/customer/faktur/[id]">) {
  try {
    const cctx = await customerForRoute();
    if (!cctx) return unauthorized();
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new NotFoundError("Tagihan tidak ditemukan.");
    const pdf = await p2.myInvoicePdf(cctx, id);
    return fileResponse(pdf.body, "application/pdf", pdf.filename);
  } catch (error) {
    return errorResponse(error);
  }
}
