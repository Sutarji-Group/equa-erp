import { authenticateDevice, enrollPin } from "@/server/core/auth";
import { apiErrorResponse, okJson, readJson } from "@/server/core/auth/http";

/**
 * Aktivasi akun lapangan di perangkat: kode sekali pakai dari admin sistem + PIN baru (US-M10-02 KP-3).
 * `POST { code, pin }` → sesi lapangan + verifier PIN offline.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    const body = (await readJson(request)) as { code?: unknown; pin?: unknown };
    const result = await enrollPin(auth, { code: String(body?.code ?? ""), pin: String(body?.pin ?? "") });
    return okJson({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
