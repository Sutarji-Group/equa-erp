/**
 * Registrasi modul untuk uji: SELALU lewat `ensureBootstrapped()` (sekali per proses, per modul, handler bernama
 * tidak digandakan). JANGAN memanggil `registerEvents()`/`registerSync()`/… modul secara manual.
 *
 * ```ts
 * beforeAll(() => bootstrapForTests());
 * ```
 * Pengganti resolver pelaku (`setActorResolver`) harus dipasang SESUDAH bootstrap — bootstrap memasang resolver bawaan.
 */
import { ensureBootstrapped } from "@/server/core/bootstrap";

export function bootstrapForTests(): void {
  ensureBootstrapped();
}
