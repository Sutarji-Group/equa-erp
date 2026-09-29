import { authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson, readJson } from "@/server/core/auth/http";
import { processPush } from "@/server/core/sync";

/**
 * Kirim antrean outbox lapangan (docs/ARCHITECTURE.md §7): `POST { commands: [...≤50], sentAt, health? }` →
 * hasil per perintah (`applied` | `duplicate` | `rejected` | `conflict` | `retry`). Idempoten per ID perintah.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    return okJson(await processPush(auth, await readJson(request)));
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
