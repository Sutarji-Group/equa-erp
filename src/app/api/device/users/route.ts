import { authenticateDevice, listDeviceUsers } from "@/server/core/auth";
import { apiErrorResponse, okJson } from "@/server/core/auth/http";
import { getDb } from "@/server/core/db";

/** Daftar pengguna yang boleh memakai perangkat ini (layar "Siapa yang memakai ponsel ini?"). Token perangkat wajib. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    const users = await listDeviceUsers(getDb(), auth.device, auth.now);
    return okJson({ ok: true, users, serverTime: auth.now.toISOString() });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
