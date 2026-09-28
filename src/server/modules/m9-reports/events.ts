/**
 * M9 — handler event domain (Laporan & Dashboard). M9 tidak memiliki transaksi sendiri; event dipakai untuk:
 * - `cash_day.closed` (M4) → terbitkan ringkasan H+0 terkunci + notifikasi pemilik (US-M9-01 KP-2, US-M4-06 KP-5,
 *   NFR-04/KPI-08). Terisolasi savepoint: galat tidak menggagalkan tutup kas; job `m9.h0.publish_pending` menjadi cadangan.
 * - Peristiwa terlambat sinkron/koreksi atas tanggal yang H+0-nya sudah terbit → addendum bertanda (US-M9-01 KP-6).
 * - `period.locked` (M11) → simpan versi Final laporan laba kotor bulanan + notifikasi (US-M9-02 KP-2, US-M9-03 KP-4).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { cashDays } from "@/db/schema";

import { on } from "@/server/core/events";

import { ADDENDUM_EVENT_TYPES, addendumFromEvent } from "./service/addenda";
import { publishDailySummary } from "./service/h0";
import { finalizeMonthlyReportForPeriod } from "./service/monthly";

export function registerEvents(): void {
  on(
    "cash_day.closed",
    async (event, tx) => {
      const p = event.payload;
      const tenantId = event.tenantId;
      if (!tenantId) return;
      const [cd] = await tx.select().from(cashDays).where(eq(cashDays.id, p.cashDayId)).limit(1);
      const date = p.businessDate ?? cd?.businessDate ?? event.businessDate;
      if (!date) return;
      await publishDailySummary(tx, {
        tenantId,
        date,
        now: event.occurredAt,
        cashDayId: p.cashDayId,
        cashClosedAt: p.closedAt ? new Date(p.closedAt) : (cd?.closedAt ?? null),
        cashClosedLate: p.late,
        trigger: "cash_day_closed",
      });
    },
    { name: "m9-reports:publish_h0" },
  );

  for (const type of ADDENDUM_EVENT_TYPES) {
    on(type, async (event, tx) => void (await addendumFromEvent(event, tx)), { name: `m9-reports:addenda:${type}` });
  }

  on(
    "period.locked",
    async (event, tx) => {
      if (!event.tenantId) return;
      await finalizeMonthlyReportForPeriod(tx, { tenantId: event.tenantId, periodId: event.payload.periodId, now: event.occurredAt, notifyOwner: true });
    },
    { name: "m9-reports:monthly_final" },
  );
}
