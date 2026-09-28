/**
 * M6 — logika pekerjaan terjadwal (dipisah dari registrasi agar dapat diuji langsung).
 */
import "server-only";

import { and, eq, lt, ne } from "drizzle-orm";

import { outlets, shifts } from "@/db/schema";
import { addDays, toBusinessDate } from "@/lib/time";

import { withTx, type Db } from "@/server/core/db";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";

import { isoWeekLabel } from "./common";
import { outletsWithoutStockCount } from "./stock";

/** Opname minggu berjalan belum dilakukan → tandai Admin Keuangan (US-M6-04 KP-4, PAR-32). */
export async function runStockCountCheck(now: Date, db?: Db): Promise<{ flagged: string[] }> {
  const today = toBusinessDate(now);
  const week = isoWeekLabel(today);
  return withTx(
    async (tx) => {
      const flagged: string[] = [];
      const tenants = await tx.selectDistinct({ tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.kind, "depot"));
      for (const { tenantId } of tenants) {
        const rule = await params.get(tx, "PAR-32", today, { tenantId });
        if (rule.depot !== "weekly") continue;
        for (const o of await outletsWithoutStockCount(tx, tenantId, week)) {
          flagged.push(o.id);
          await notify(tx, {
            event: "stock_count.overdue",
            tenantId,
            title: `Opname mingguan ${o.name} belum dilakukan (${week})`,
            body: "Operator belum mengirim opname bahan habis pakai minggu ini (BR-27, PAR-32).",
            objectType: "outlet",
            objectId: o.id,
            link: `/outlet/${o.id}?tab=stok`,
            groupKey: `stock_count.overdue:${o.id}:${week}`,
            now,
          });
        }
      }
      return { flagged };
    },
    db ? { db } : {},
  );
}

/** Setoran shift belum diterima > PAR-27 hari sejak tutup shift → tandai Admin Keuangan (US-M6-02 KP-5). */
export async function runLateDepositCheck(now: Date, db?: Db): Promise<{ flagged: string[] }> {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const flagged: string[] = [];
      const rows = await tx
        .select({ shift: shifts, outletName: outlets.name })
        .from(shifts)
        .innerJoin(outlets, eq(outlets.id, shifts.outletId))
        .where(and(eq(shifts.status, "closed"), ne(shifts.depositStatus, "received"), lt(shifts.businessDate, today)));
      for (const { shift, outletName } of rows) {
        const late = await params.get(tx, "PAR-27", today, { tenantId: shift.tenantId, outletId: shift.outletId });
        const closedDate = shift.closedAt ? toBusinessDate(shift.closedAt) : shift.businessDate;
        if (addDays(closedDate, late.days_gt) >= today) continue;
        flagged.push(shift.id);
        await notify(tx, {
          event: "deposit.depot_late",
          tenantId: shift.tenantId,
          title: `Setoran shift ${outletName} ${shift.businessDate} belum diterima`,
          body: `Lebih dari ${late.days_gt} hari sejak tutup shift (PAR-27). Status: ${shift.depositStatus === "deposited" ? "Disetor" : "Belum disetor"}.`,
          objectType: "shift",
          objectId: shift.id,
          valueAmount: shift.depositAmount,
          link: `/outlet/shift/${shift.id}`,
          groupKey: `deposit.depot_late:${shift.id}:${today}`,
          now,
        });
      }
      return { flagged };
    },
    db ? { db } : {},
  );
}

