import { errorResponse } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { customerForRoute } from "@/server/modules/p2-customer/web";

import { fileResponse, unauthorized } from "../_util";

/** Ekspor riwayat pesanan (PDF) milik pelanggan — tercatat (US-P2-04 KP-5). */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cctx = await customerForRoute();
    if (!cctx) return unauthorized();
    const pdf = await p2.myHistoryPdf(cctx);
    return fileResponse(pdf.body, "application/pdf", pdf.filename);
  } catch (error) {
    return errorResponse(error);
  }
}
