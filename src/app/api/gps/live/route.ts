import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { getFleetSnapshot } from "@/server/modules/m12-fleet";

/**
 * Snapshot peta armada untuk pembaruan berkala komponen peta (US-M12-02 KP-1: pembaruan ≤ 1 menit, PAR-26).
 * Hanya peran berizin `m12.position.read` (pemilik & Dispatcher) — peran lain ditolak 403 (KP-4). `?tanggal=YYYY-MM-DD`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    const date = new URL(request.url).searchParams.get("tanggal") ?? undefined;
    const snapshot = await getFleetSnapshot(actor, { date });
    return Response.json({ ok: true, snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
