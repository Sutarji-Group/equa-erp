import { authenticateDevice, publicDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson } from "@/server/core/auth/http";
import { getDb } from "@/server/core/db";
import { compareVersions, minSupportedVersion } from "@/server/core/sync";

/**
 * Status perangkat (kontak ringan): perangkat diblokir → 403; perintah hapus data → 410 `{ wipe: true }`;
 * versi minimal aplikasi (NFR-32). Token perangkat wajib (sesi tidak wajib).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    const minVersion = await minSupportedVersion(auth.now);
    return okJson({
      ok: true,
      serverTime: auth.now.toISOString(),
      device: await publicDevice(getDb(), auth.device),
      sessionValid: !!auth.session,
      minVersion,
      updateRequired: !!auth.appVersion && compareVersions(auth.appVersion, minVersion) < 0,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
