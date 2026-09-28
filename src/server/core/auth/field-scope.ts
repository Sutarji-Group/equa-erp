/**
 * Lingkup harian Sopir/Kernet (US-M10-01 KP-3: "Sopir/Kernet → truk hari itu (jadwal kru, M2)"; US-M2-11).
 *
 * - `applyCrewScope(tx, ctx, date)`: bila ada jadwal kru hari itu (`crew_assignments` pengemudi harian atau
 *   `crew_rosters` bertugas di truk) → `scope.truckIds` = truk-truk itu saja; bila dijadwalkan libur → tanpa truk;
 *   bila belum ada jadwal sama sekali → lingkup tetap dari `user_scopes` (cadangan sebelum M2 menerbitkan jadwal).
 * - `isActingDriver(tx, ctx, truckId, date)`: pelaku adalah pengemudi truk itu pada tanggal itu. Kernet hanya
 *   membaca KECUALI ditetapkan Dispatcher sebagai pengemudi pengganti (`crew_assignments.driver_employee_id` = kernet).
 *   Sopir: pengemudi bila ditetapkan, atau bila belum ada penetapan untuk truk itu dan truk ada di lingkupnya.
 * - `substituteDriverConditions` → kondisi untuk `authorize(ctx, "m3.trip.complete", { conditions })`.
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { crewAssignments, crewRosters } from "@/db/schema";

import type { ActorContext } from "../context";
import type { Tx } from "../db";

export type CrewDay = { truckIds: string[]; off: boolean; hasSchedule: boolean };

/** Truk yang dijadwalkan untuk karyawan pada tanggal bisnis (jadwal kru M2). */
export async function crewTrucksForDay(tx: Tx, employeeId: string, businessDate: string): Promise<CrewDay> {
  const assigned = await tx
    .select({ truckId: crewAssignments.truckId })
    .from(crewAssignments)
    .where(
      and(eq(crewAssignments.driverEmployeeId, employeeId), eq(crewAssignments.businessDate, businessDate), isNull(crewAssignments.supersededAt)),
    );
  const rosters = await tx
    .select({ truckId: crewRosters.truckId, status: crewRosters.status })
    .from(crewRosters)
    .where(and(eq(crewRosters.employeeId, employeeId), eq(crewRosters.businessDate, businessDate)));
  const truckIds = new Set<string>(assigned.map((a) => a.truckId));
  for (const r of rosters) if (r.status === "on_duty" && r.truckId) truckIds.add(r.truckId);
  const off = truckIds.size === 0 && rosters.some((r) => r.status !== "on_duty");
  return { truckIds: [...truckIds], off, hasSchedule: assigned.length > 0 || rosters.length > 0 };
}

/** Terapkan lingkup truk harian untuk Sopir/Kernet (peran lain tidak berubah). */
export async function applyCrewScope(tx: Tx, ctx: ActorContext, businessDate: string): Promise<ActorContext> {
  if (!ctx.employeeId || !(ctx.roles.includes("driver") || ctx.roles.includes("helper"))) return ctx;
  const day = await crewTrucksForDay(tx, ctx.employeeId, businessDate);
  if (day.truckIds.length > 0) return { ...ctx, scope: { ...ctx.scope, truckIds: day.truckIds } };
  if (day.off) return { ...ctx, scope: { ...ctx.scope, truckIds: [] } };
  return ctx;
}

/** Pelaku adalah pengemudi truk pada tanggal itu (lihat keterangan berkas). */
export async function isActingDriver(tx: Tx, ctx: ActorContext, truckId: string, businessDate: string): Promise<boolean> {
  if (!ctx.employeeId) return false;
  const rows = await tx
    .select({ driver: crewAssignments.driverEmployeeId })
    .from(crewAssignments)
    .where(and(eq(crewAssignments.truckId, truckId), eq(crewAssignments.businessDate, businessDate), isNull(crewAssignments.supersededAt)))
    .limit(1);
  const assignment = rows[0];
  if (assignment) return assignment.driver === ctx.employeeId;
  return ctx.roles.includes("driver") && ctx.scope.truckIds.includes(truckId);
}

/** Kondisi otorisasi kernet pengganti (US-M2-11) untuk `authorize(..., { conditions })`. */
export async function substituteDriverConditions(
  tx: Tx,
  ctx: ActorContext,
  truckId: string,
  businessDate: string,
): Promise<{ substitute_driver: boolean }> {
  return { substitute_driver: ctx.roles.includes("helper") && (await isActingDriver(tx, ctx, truckId, businessDate)) };
}
