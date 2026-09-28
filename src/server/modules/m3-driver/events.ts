/**
 * M3 — handler event domain.
 *
 * - `discrepancy.formed` (M4) → `m3-driver:par83_trip_lock`: bila PAR-83 aktif (PTB-62) dan selisih kurang setoran SOPIR
 *   ≥ ambang, rit sopir itu terkunci sampai pemilik memutuskan (kunci dibaca pull `m3.today` lewat `driverLock`) →
 *   notifikasi 6.3 "Selisih besar mengunci rit" ke pemilik & Dispatcher (putuskan sebelum rit pertama esok hari).
 *   Selisih biasa TIDAK mengunci rit (Bab 5.2; kunci BR-10 hanya penutupan setoran oleh Admin Keuangan).
 *
 * Event yang dipancarkan M3: `trip.departed`, `trip.arrived`, `trip.completed`, `trip.failed`, `trip.payment_recorded`,
 * `collection.recorded`, `trip.expense_recorded`, `deposit.submitted` (payload lengkap — docs/dev/modules/m3-driver.md).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { employees } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { toBusinessDate } from "@/lib/time";

import { EQUA_TENANT_ID } from "@/server/core/context";
import { on } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";

export function registerEvents(): void {
  on(
    "discrepancy.formed",
    async (event, tx) => {
      const p = event.payload;
      if (p.sourceType !== "driver" || p.amount >= 0) return;
      const tenantId = event.tenantId ?? EQUA_TENANT_ID;
      const date = event.businessDate ?? toBusinessDate(event.occurredAt);
      const par83 = await params.get(tx, "PAR-83", date, { tenantId });
      if (!par83.enabled || -p.amount < par83.amount_gte) return;
      const name = p.employeeId ? (await tx.select({ name: employees.fullName }).from(employees).where(eq(employees.id, p.employeeId)).limit(1))[0]?.name : null;
      await notify(tx, {
        event: "discrepancy.trip_lock",
        tenantId,
        title: `Selisih besar mengunci rit ${name ?? "sopir"}: ${formatRupiah(p.amount, { signed: true })}`,
        body: "PAR-83 aktif: rit sopir terkunci sampai pemilik memutuskan selisih ini. Putuskan sebelum rit pertama esok hari (PTB-62).",
        objectType: "discrepancy",
        objectId: p.discrepancyId,
        valueAmount: p.amount,
        link: "/kas/selisih",
        groupKey: `discrepancy.trip_lock:${p.discrepancyId}`,
        now: event.occurredAt,
      });
    },
    { name: "m3-driver:par83_trip_lock" },
  );
}
