import { authenticateDevice } from "@/server/core/auth";
import { apiErrorResponse, okJson } from "@/server/core/auth/http";
import { ValidationError } from "@/server/core/errors";
import { processUpload } from "@/server/core/sync";

/** Unggah lampiran antrean offline (multipart; idempoten per `attachmentId`; maks. 5 MB). */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const auth = await authenticateDevice(request);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ValidationError("Kiriman berkas tidak terbaca. Coba kirim ulang.");
    }
    return okJson(await processUpload(auth, form));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
