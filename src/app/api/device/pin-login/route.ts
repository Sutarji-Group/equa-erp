import { authenticateDevice, pinLogin } from "@/server/core/auth";
import { apiErrorResponse, okJson, readJson } from "@/server/core/auth/http";

/**
 * Login PIN daring (US-M10-02 KP-3). `POST { userId, pin }` → sesi lapangan + verifier PIN offline (PBKDF2, bukan PIN).
 * 5 salah (PAR-36) → terkunci 15 menit + notifikasi admin sistem.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    const body = (await readJson(request)) as { userId?: unknown; pin?: unknown };
    const result = await pinLogin(auth, { userId: String(body?.userId ?? ""), pin: String(body?.pin ?? "") });
    return okJson({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
