/**
 * Registrasi sekali per proses: job & laporan inti, lalu handler event / persetujuan / sinkron / job / laporan
 * setiap modul (`src/server/modules/register.ts`).
 *
 * Dipanggil otomatis oleh `emit`, `approvals.*`, `runDueJobs`, `exportReport`, dan resolver aktor. Aman dipanggil
 * berkali-kali. Modul TIDAK boleh mendaftarkan handler di top-level berkas (hanya di fungsi `register*`) agar
 * impor melingkar core ↔ modul tetap aman.
 */
import "server-only";

import { registerAllModules } from "@/server/modules/register";

import { registerCoreJobs } from "./core-jobs";
import { registerCoreReports } from "./core-reports";

let bootstrapped = false;
let running = false;

export function ensureBootstrapped(): void {
  if (bootstrapped || running) return;
  running = true;
  try {
    registerCoreJobs();
    registerCoreReports();
    registerAllModules();
    bootstrapped = true;
  } finally {
    running = false;
  }
}

/** Benar bila registrasi sudah berjalan. */
export function isBootstrapped(): boolean {
  return bootstrapped;
}
