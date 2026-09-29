import { errorResponse } from "@/server/core/errors";
import { isCrossSiteRequest } from "@/server/core/csrf";
import * as p2 from "@/server/modules/p2-customer";
import { getCustomer } from "@/server/modules/p2-customer/web";

import { unauthorized } from "../_util";

/** Simpan langganan Web Push perangkat pelanggan (US-P2-03 KP-4). */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (isCrossSiteRequest(request)) return Response.json({ ok: false, message: "Permintaan ditolak." }, { status: 403 });
    const cctx = await getCustomer();
    if (!cctx) return unauthorized();
    const body = (await request.json().catch(() => null)) as unknown;
    const res = await p2.registerPushSubscription(cctx, body, { userAgent: request.headers.get("user-agent") });
    return Response.json({ ok: true, id: res.id });
  } catch (error) {
    return errorResponse(error);
  }
}
