/**
 * M11 — handler event domain: jurnal otomatis untuk SETIAP peristiwa keuangan PRD 7.11.4 + koreksi/pembalik
 * (`JOURNALED_EVENTS`, perlakuan per peristiwa di `service/auto-journals.ts`).
 *
 * - Jurnal dibuat di TRANSAKSI YANG SAMA dengan peristiwa sumbernya (atomik), tepat sebelum COMMIT (`onBeforeCommit`):
 *   seluruh perubahan sumber di transaksi itu sudah lengkap, dan penulis lain di transaksi yang sama (mis. alat uji
 *   atau modul yang memposting sendiri) didahulukan — jurnal tetap satu per event (idempoten).
 * - Diproses di SAVEPOINT: galat jurnal tidak pernah membuat transaksi lapangan tertolak (R04). Galat tak terduga
 *   ditangkap dan dicatat ke DAFTAR TUNGGU (alasan "Lainnya") + notifikasi Admin Keuangan agar tidak ada peristiwa
 *   yang terlewat diam-diam (US-M11-02 KP-3); pemetaan hilang/akun nonaktif juga masuk daftar tunggu.
 */
import "server-only";

import { toBusinessDate } from "@/lib/time";

import { onBeforeCommit, withSavepoint, type Tx } from "@/server/core/db";
import { on, type DomainEvent } from "@/server/core/events";
import { queueJournal } from "@/server/core/ledger";

import { JOURNALED_EVENTS } from "./service/auto-journals";
import { processEvent } from "./service/engine";

/** Proses satu event di savepoint; galat → daftar tunggu (tidak pernah hilang). */
export async function journalEventSafely(tx: Tx, event: DomainEvent): Promise<void> {
  const eventDay = event.businessDate ?? toBusinessDate(event.occurredAt);
  const realToday = toBusinessDate(new Date());
  try {
    await withSavepoint(tx, (sp) => processEvent(sp, event, { today: eventDay > realToday ? eventDay : realToday }));
  } catch (error) {
    if (!event.tenantId) return;
    const message = error instanceof Error ? error.message : String(error);
    await queueJournal(tx, {
      tenantId: event.tenantId,
      eventKey: event.type,
      domainEventId: event.id,
      sourceObject: event.objectType && event.objectId ? { type: event.objectType, id: event.objectId } : null,
      payload: { error: message.slice(0, 500) },
      journalDate: eventDay,
      reason: "other",
      message: `Jurnal otomatis gagal dibuat: ${message}`.slice(0, 500),
      now: event.occurredAt,
    });
  }
}

export function registerEvents(): void {
  for (const type of JOURNALED_EVENTS) {
    on(
      type,
      async (event, tx) => {
        const e = event as unknown as DomainEvent;
        if (!onBeforeCommit(tx, (outer) => journalEventSafely(outer, e))) await journalEventSafely(tx, e);
      },
      { name: `m11-accounting:journal:${type}` },
    );
  }
}
