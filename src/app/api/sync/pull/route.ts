import { readPullCursors } from "@/lib/pull-delta";
import { authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson } from "@/server/core/auth/http";
import { processPull } from "@/server/core/sync";

/**
 * Data referensi offline sesuai lingkup pengguna (`GET ?since=<ISO>&keys=a,b`), status perangkat, versi minimal,
 * parameter offline. Wajib sesi lapangan (klaim `sessionId` token perangkat). Pull bersyarat v1.0.1 (D-14 butir 3):
 * `?v=2&c.<kunci>=<kursor>` → penyedia tak berubah tanpa isi, koleksi tumbuh sebagai delta (`src/lib/pull-delta.ts`).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const auth = await authenticateDevice(request, { requireSession: true });
    const url = new URL(request.url);
    return okJson(
      await processPull(auth, { since: url.searchParams.get("since"), keys: url.searchParams.get("keys"), cursors: readPullCursors(url.searchParams) }),
    );
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
