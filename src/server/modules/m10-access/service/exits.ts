/**
 * M10 — tanggal keluar karyawan menonaktifkan akun pada hari itu (BR-37, US-M10-01 KP-5).
 *
 * - Event `employee.exited` (dari M1 saat tanggal keluar ditetapkan): bila tanggal keluar ≤ hari ini → nonaktif seketika
 *   dengan pelaku "Sistem" (aturan BR-37); bila di masa depan → ditangani job harian pada harinya.
 * - Job harian `m10.users.exit_date` (00.10 WIB): semua karyawan dengan tanggal keluar ≤ hari ini yang akunnya masih
 *   aktif/menunggu → dinonaktifkan (sesi diputus, perangkat yang dipegang diblokir).
 */
import "server-only";

import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { employees, users } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";
import { systemContext } from "@/server/core/context";
import { withTx, type Db, type Tx } from "@/server/core/db";
import type { EmployeeExitedPayload } from "@/server/core/events.types";

import { deactivateInTx, type DeactivationResult } from "./users";

function exitReason(exitDate: string): string {
  return `Tanggal keluar karyawan ${exitDate} (BR-37)`;
}

/** Tangani `employee.exited` di transaksi pemancar (M1). */
export async function handleEmployeeExited(tx: Tx, payload: EmployeeExitedPayload, now: Date): Promise<DeactivationResult | null> {
  const today = toBusinessDate(now);
  if (!payload.exitDate || payload.exitDate > today) return null;
  const rows = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(eq(users.employeeId, payload.employeeId), eq(users.tenantId, payload.tenantId)))
    .limit(1);
  const user = rows[0];
  if (!user || user.status === "inactive") return null;
  const ctx = systemContext({ tenantId: payload.tenantId, now });
  return deactivateInTx(tx, ctx, user.id, exitReason(payload.exitDate), { rule: "BR-37", exitDate: true });
}

/** Job harian: nonaktifkan akun karyawan yang tanggal keluarnya sudah tiba. */
export async function runExitDateSweep(now: Date = new Date(), db?: Db): Promise<{ deactivated: number; devicesBlocked: number }> {
  const today = toBusinessDate(now);
  return withTx(async (tx) => {
    const due = await tx
      .select({ userId: users.id, tenantId: users.tenantId, exitDate: employees.exitDate })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(and(isNotNull(employees.exitDate), lte(employees.exitDate, today), inArray(users.status, ["active", "pending_approval", "locked"])));
    let devicesBlocked = 0;
    for (const d of due) {
      const ctx = systemContext({ tenantId: d.tenantId, now });
      const r = await deactivateInTx(tx, ctx, d.userId, exitReason(d.exitDate!), { rule: "BR-37", exitDate: true });
      devicesBlocked += r.devicesBlocked.length;
    }
    return { deactivated: due.length, devicesBlocked };
  }, { db });
}
