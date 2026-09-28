/**
 * Setup global Vitest (sekali per `vitest run`, sebelum worker): siapkan snapshot DB uji (skema + hardening, dan
 * skema + hardening + seed) di cache disk agar setiap berkas uji cukup memuat snapshot. Lihat tests/helpers/db.ts.
 */
import { ensureTestDbSnapshots } from "./helpers/db-snapshot";

export default async function setup(): Promise<void> {
  await ensureTestDbSnapshots();
}
