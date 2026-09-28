import { activateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson, readJson } from "@/server/core/auth/http";
import { requestIp } from "@/server/core/auth/device-auth";

/**
 * Aktivasi perangkat lapangan/POS dengan kode 8 karakter dari admin sistem (US-M10-02 KP-1).
 * `POST { code, appVersion? }` → `{ ok, deviceId, deviceSecret (sekali), device, serverTime }`.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await readJson(request)) as { code?: unknown; appVersion?: unknown };
    const result = await activateDevice(String(body?.code ?? ""), {
      ip: requestIp(request.headers),
      userAgent: request.headers.get("user-agent"),
      appVersion: typeof body?.appVersion === "string" ? body.appVersion.slice(0, 40) : null,
    });
    return okJson({ ok: true, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
