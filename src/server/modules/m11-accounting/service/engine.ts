/**
 * M11 — jalankan perlakuan jurnal untuk satu event (dipakai handler event, coba ulang antrean, dan pembangkitan
 * retroaktif PTB-47). Satu pintu agar ketiga jalur menghasilkan jurnal yang identik & idempoten.
 */
import "server-only";

import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";

import { specForEvent } from "./auto-journals";
import { executeSpec, type AutoResult, type ProcessOptions } from "./posting";

export async function processEvent(tx: Tx, event: DomainEvent, opts: ProcessOptions = {}): Promise<AutoResult> {
  const spec = await specForEvent(tx, event);
  return executeSpec(tx, event, spec, opts);
}
