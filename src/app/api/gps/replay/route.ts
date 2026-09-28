import { getActorContext } from "@/server/core/actor";
import { errorResponse } from "@/server/core/errors";
import { getReplay } from "@/server/modules/m12-fleet";

/**
 * Putar ulang jejak truk (US-M12-02 KP-5, US-M12-03 KP-3): `?truk=<uuid>&sampai=<ISO>` (bawaan: sekarang; jendela
 * `replay_hours` jam). Hanya peran berizin `m12.position.read` (pemilik & Dispatcher). Posisi disampel untuk animasi —
 * bukan ekspor posisi mentah.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActorContext(request);
    if (!actor) return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu." }, { status: 401 });
    const url = new URL(request.url);
    const replay = await getReplay(actor, { truckId: url.searchParams.get("truk") ?? "", to: url.searchParams.get("sampai") ?? undefined });
    return Response.json(
      { ok: true, replay: { ...replay, from: replay.from.toISOString(), to: replay.to.toISOString() } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
