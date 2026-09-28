/**
 * M7 — kas toko harian (US-M7-09): shift/kas toko memakai kerangka POS M6 (kas awal tetap PAR-57, kas fisik, selisih
 * beralasan, setoran fisik/setor bank; tempo & QRIS tidak masuk kas fisik). Berkas ini menyediakan syarat tutup kas
 * Admin Keuangan (M4, US-M4-06): shift toko hari itu harus sudah ditutup.
 */
import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";

import { outlets, shifts } from "@/db/schema";
import type { BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";

export type OpenStoreShift = { shiftId: string; outletId: string; outletName: string; businessDate: string; openedAt: Date; syncConflict: boolean };

/**
 * Shift toko yang masih TERBUKA dengan tanggal bisnis ≤ `businessDate` — M4 menolak tutup kas selama daftar ini tidak
 * kosong (US-M7-09 KP-3). Termasuk shift konflik perangkat cadangan.
 */
export async function storeShiftsBlockingCashClose(tx: Tx, tenantId: string, businessDate: BusinessDate): Promise<OpenStoreShift[]> {
  const rows = await tx
    .select({ s: shifts, outletName: outlets.name })
    .from(shifts)
    .innerJoin(outlets, eq(outlets.id, shifts.outletId))
    .where(and(eq(shifts.tenantId, tenantId), eq(outlets.kind, "store"), eq(shifts.status, "open"), lte(shifts.businessDate, businessDate)))
    .orderBy(asc(shifts.openedAt));
  return rows.map(({ s, outletName }) => ({ shiftId: s.id, outletId: s.outletId, outletName, businessDate: s.businessDate, openedAt: s.openedAt, syncConflict: s.syncConflict }));
}
