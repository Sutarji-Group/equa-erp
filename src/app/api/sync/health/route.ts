import { authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson, readJson } from "@/server/core/auth/http";
import { recordHealth } from "@/server/core/sync";

/** Laporan kesehatan perangkat (antrean, versi, baterai, sinkron terakhir, kejadian offline) — US-M10-07 KP-1. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    return okJson(await recordHealth(auth, await readJson(request)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
