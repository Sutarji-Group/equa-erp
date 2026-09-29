import { authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson } from "@/server/core/auth/http";
import { processPull } from "@/server/core/sync";

/**
 * Data referensi offline sesuai lingkup pengguna (`GET ?since=<ISO>&keys=a,b`), status perangkat, versi minimal,
 * parameter offline. Wajib sesi lapangan (klaim `sessionId` token perangkat).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const auth = await authenticateDevice(request, { requireSession: true });
    const url = new URL(request.url);
    return okJson(await processPull(auth, { since: url.searchParams.get("since"), keys: url.searchParams.get("keys") }));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
