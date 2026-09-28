/**
 * M2 — kru harian & ketersediaan truk (US-M2-10 S, US-M2-11 M; BR-10, BR-36, PTB-10, FR-M3-09).
 *
 * Pengemudi hari itu per truk = penetapan harian aktif (`crew_assignments`, US-M2-11) → jadwal mingguan (`crew_rosters`
 * sopir bertugas) → sopir default truk (US-M1-03) bila tidak libur. Tanpa jadwal mingguan pun papan tetap berfungsi
 * (US-M2-10 KP-4). Penetapan berlaku sampai akhir hari kas, dapat diubah beralasan; baris lama tidak dihapus (ditandai
 * `superseded_at`). Pengemudi yang setorannya hari sebelumnya belum Ditutup ditolak (BR-10).
 */
import "server-only";

import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { crewAssignments, crewRosters, deposits, employees, truckDayStatus, trucks, trips, userRoles, users } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { addDays, formatTanggal, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService, sod } from "@/server/core/rbac";
import { assertTruckCanReceiveTrips } from "@/server/modules/m1-master";

import { rosterEntrySchema, setDriverSchema, truckDaySchema, type RosterEntryInput, type SetDriverInput, type TruckDayInput } from "../schemas";
import { employeeNames, loadTruck, userNames, type TruckRow } from "./common";

type AssignmentRow = typeof crewAssignments.$inferSelect;
type RosterRow = typeof crewRosters.$inferSelect;
type TruckDayRow = typeof truckDayStatus.$inferSelect;

// =====================================================================================================================
// BR-10: setoran hari sebelumnya belum Ditutup
// =====================================================================================================================

export type DepositLock = { depositId: string; number: string; businessDate: string; status: EnumValue<"deposit_status"> };

/**
 * Setoran sopir yang belum Ditutup dari hari-hari sebelum `min(date, hari ini)` (BR-10; baca-saja tabel M4). Kunci
 * rit/penetapan bila ada. Setoran hari berjalan tidak dihitung (normal belum ditutup).
 */
export async function driverDepositLocks(tx: Tx, employeeIds: string[], date: BusinessDate, today: BusinessDate): Promise<Map<string, DepositLock>> {
  const list = [...new Set(employeeIds.filter(Boolean))];
  if (list.length === 0) return new Map();
  const before = date < today ? date : today;
  const accounts = await tx.select({ id: users.id, employeeId: users.employeeId }).from(users).where(inArray(users.employeeId, list));
  const userIds = accounts.map((a) => a.id);
  const rows = await tx
    .select({ id: deposits.id, number: deposits.number, businessDate: deposits.businessDate, status: deposits.status, employeeId: deposits.depositorEmployeeId, userId: deposits.depositorUserId })
    .from(deposits)
    .where(
      and(
        eq(deposits.sourceType, "driver"),
        ne(deposits.status, "closed"),
        lt(deposits.businessDate, before),
        or(inArray(deposits.depositorEmployeeId, list), userIds.length ? inArray(deposits.depositorUserId, userIds) : sql`false`),
      ),
    )
    .orderBy(asc(deposits.businessDate));
  const out = new Map<string, DepositLock>();
  for (const r of rows) {
    const emp = r.employeeId ?? accounts.find((a) => a.id === r.userId)?.employeeId ?? null;
    if (emp && !out.has(emp)) out.set(emp, { depositId: r.id, number: r.number, businessDate: r.businessDate, status: r.status });
  }
  return out;
}

function lockMessage(name: string, lock: DepositLock): string {
  return `${name} belum menutup setoran ${lock.number} tanggal ${formatTanggal(lock.businessDate, { weekday: false })} (status ${label("deposit_status", lock.status)}) — BR-10. Hubungi Admin Keuangan untuk menutup setoran itu dulu.`;
}

// =====================================================================================================================
// Pengemudi hari itu
// =====================================================================================================================

export type DayCrew = {
  truckId: string;
  driverEmployeeId: string | null;
  driverName: string | null;
  /** Asal: penetapan harian / jadwal mingguan / sopir default. */
  driverSource: "assignment" | "roster" | "default" | null;
  /** Jenis penetapan (US-M2-11): sopir default / kernet truk / sopir lain. */
  assignmentSource: EnumValue<"crew_assignment_source"> | null;
  assignmentId: string | null;
  substitute: boolean;
  reason: string | null;
  assignedByName: string | null;
  assignedAt: Date | null;
  helperEmployeeId: string | null;
  helperName: string | null;
  /** BR-10: setoran hari sebelumnya belum Ditutup. */
  lock: DepositLock | null;
  lockMessage: string | null;
};

/** Kru hari itu untuk truk-truk tenant (US-M2-03 KP-1, US-M2-10, US-M2-11 KP-5). */
export async function resolveDayCrews(tx: Tx, tenantId: string, date: BusinessDate, today: BusinessDate, truckIds?: string[]): Promise<Map<string, DayCrew>> {
  const truckRows = await tx
    .select()
    .from(trucks)
    .where(and(eq(trucks.tenantId, tenantId), truckIds?.length ? inArray(trucks.id, truckIds) : sql`true`));
  const assignments = await tx
    .select()
    .from(crewAssignments)
    .where(and(eq(crewAssignments.tenantId, tenantId), eq(crewAssignments.businessDate, date), isNull(crewAssignments.supersededAt)));
  const rosters = await tx.select().from(crewRosters).where(and(eq(crewRosters.tenantId, tenantId), eq(crewRosters.businessDate, date)));
  const offEmployees = new Set(rosters.filter((r) => r.status === "off").map((r) => r.employeeId));
  const assignedElsewhere = new Map(assignments.map((a) => [a.driverEmployeeId, a.truckId]));
  const exited = await exitedEmployees(tx, tenantId, date);
  const out = new Map<string, DayCrew>();
  for (const t of truckRows) {
    const a = assignments.find((x) => x.truckId === t.id) ?? null;
    let driverEmployeeId: string | null = null;
    let driverSource: DayCrew["driverSource"] = null;
    if (a) {
      driverEmployeeId = a.driverEmployeeId;
      driverSource = "assignment";
    } else {
      const r = rosters.find((x) => x.truckId === t.id && x.status === "on_duty" && x.role === "driver" && !assignedElsewhere.has(x.employeeId));
      if (r) {
        driverEmployeeId = r.employeeId;
        driverSource = "roster";
      } else if (
        t.defaultDriverEmployeeId &&
        !offEmployees.has(t.defaultDriverEmployeeId) &&
        !exited.has(t.defaultDriverEmployeeId) &&
        !(assignedElsewhere.has(t.defaultDriverEmployeeId) && assignedElsewhere.get(t.defaultDriverEmployeeId) !== t.id) &&
        !rosters.some((x) => x.employeeId === t.defaultDriverEmployeeId && x.status === "on_duty" && x.truckId && x.truckId !== t.id)
      ) {
        driverEmployeeId = t.defaultDriverEmployeeId;
        driverSource = "default";
      }
    }
    const rosterHelper = rosters.find((x) => x.truckId === t.id && x.status === "on_duty" && x.role === "helper" && x.employeeId !== driverEmployeeId);
    let helperEmployeeId: string | null = rosterHelper?.employeeId ?? null;
    if (!helperEmployeeId && t.defaultHelperEmployeeId && t.defaultHelperEmployeeId !== driverEmployeeId && !offEmployees.has(t.defaultHelperEmployeeId) && !exited.has(t.defaultHelperEmployeeId)) {
      helperEmployeeId = t.defaultHelperEmployeeId;
    }
    out.set(t.id, {
      truckId: t.id,
      driverEmployeeId,
      driverName: null,
      driverSource,
      assignmentSource: a?.source ?? null,
      assignmentId: a?.id ?? null,
      substitute: !!a && a.source !== "default_driver",
      reason: a?.reason ?? null,
      assignedByName: null,
      assignedAt: a?.createdAt ?? null,
      helperEmployeeId,
      helperName: null,
      lock: null,
      lockMessage: null,
    });
  }
  const crews = [...out.values()];
  const names = await employeeNames(tx, crews.flatMap((c) => [c.driverEmployeeId, c.helperEmployeeId]));
  const assigners = await userNames(tx, assignments.map((a) => a.assignedBy));
  const locks = await driverDepositLocks(tx, crews.map((c) => c.driverEmployeeId).filter((x): x is string => !!x), date, today);
  for (const c of crews) {
    c.driverName = c.driverEmployeeId ? (names.get(c.driverEmployeeId) ?? null) : null;
    c.helperName = c.helperEmployeeId ? (names.get(c.helperEmployeeId) ?? null) : null;
    const a = assignments.find((x) => x.id === c.assignmentId);
    c.assignedByName = a?.assignedBy ? (assigners.get(a.assignedBy) ?? null) : null;
    c.lock = c.driverEmployeeId ? (locks.get(c.driverEmployeeId) ?? null) : null;
    c.lockMessage = c.lock ? lockMessage(c.driverName ?? "Pengemudi", c.lock) : null;
  }
  return out;
}

async function exitedEmployees(tx: Tx, tenantId: string, date: BusinessDate): Promise<Set<string>> {
  const rows = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), or(eq(employees.isActive, false), lte(employees.exitDate, date))));
  return new Set(rows.map((r) => r.id));
}

/** Karyawan berperan sopir (akun aktif) — kandidat "sopir lain" (US-M2-11 KP-1). */
async function driverEmployeeIds(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ employeeId: users.employeeId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(users.tenantId, tenantId), eq(userRoles.role, "driver"), eq(userRoles.status, "active"), eq(users.status, "active")));
  return new Set(rows.map((r) => r.employeeId).filter((x): x is string => !!x));
}

async function loadEmployee(tx: Tx, ctx: ActorContext, id: string) {
  const rows = await tx.select().from(employees).where(eq(employees.id, id)).limit(1);
  const e = rows[0];
  if (!e || e.tenantId !== ctx.tenantId) throw new NotFoundError("Karyawan tidak ditemukan.");
  return e;
}

// =====================================================================================================================
// Penetapan pengemudi harian (US-M2-11)
// =====================================================================================================================

export type DriverCandidate = {
  employeeId: string;
  name: string;
  source: EnumValue<"crew_assignment_source">;
  available: boolean;
  note: string | null;
};

/** Kandidat pengemudi truk pada tanggal: sopir default, kernet truk itu, sopir lain yang tidak bertugas (KP-1). */
export async function driverCandidates(ctx: ActorContext, truckId: string, date: BusinessDate, opts: { tx?: Tx } = {}): Promise<DriverCandidate[]> {
  await authorize(ctx, "m2.crew_assignment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const truck = await loadTruck(tx, ctx, truckId);
  const today = ctxBusinessDate(ctx);
  const drivers = await driverEmployeeIds(tx, ctx.tenantId);
  const crews = await resolveDayCrews(tx, ctx.tenantId, date, today);
  const exited = await exitedEmployees(tx, ctx.tenantId, date);
  const rosters = await tx.select().from(crewRosters).where(and(eq(crewRosters.tenantId, ctx.tenantId), eq(crewRosters.businessDate, date)));
  const ids = new Set<string>([...drivers]);
  if (truck.defaultDriverEmployeeId) ids.add(truck.defaultDriverEmployeeId);
  const helperIds = new Set<string>([truck.defaultHelperEmployeeId, ...rosters.filter((r) => r.truckId === truck.id && r.role === "helper" && r.status === "on_duty").map((r) => r.employeeId)].filter((x): x is string => !!x));
  for (const h of helperIds) ids.add(h);
  const names = await employeeNames(tx, [...ids]);
  const locks = await driverDepositLocks(tx, [...ids], date, today);
  const out: DriverCandidate[] = [];
  for (const id of ids) {
    if (exited.has(id)) continue;
    const source: EnumValue<"crew_assignment_source"> = id === truck.defaultDriverEmployeeId ? "default_driver" : helperIds.has(id) ? "helper" : "other_driver";
    let available = true;
    let note: string | null = null;
    const busy = [...crews.values()].find((c) => c.truckId !== truck.id && c.driverEmployeeId === id);
    if (busy) {
      available = false;
      const code = (await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.id, busy.truckId)).limit(1))[0]?.code;
      note = `Bertugas di truk ${code ?? "lain"}`;
    }
    if (rosters.some((r) => r.employeeId === id && r.status === "off")) {
      available = false;
      note = "Libur (jadwal kru)";
    }
    const lock = locks.get(id);
    if (lock) {
      available = false;
      note = `Setoran ${formatTanggal(lock.businessDate, { weekday: false })} belum Ditutup (BR-10)`;
    }
    out.push({ employeeId: id, name: names.get(id) ?? "—", source, available, note });
  }
  const order: Record<string, number> = { default_driver: 0, helper: 1, other_driver: 2 };
  return out.sort((a, b) => order[a.source]! - order[b.source]! || Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}

/**
 * Tetapkan pengemudi truk pada tanggal (US-M2-11): sopir default, kernet truk itu (pengganti — mendapat hak tindakan
 * sopir hanya untuk truk & tanggal itu, KP-2), atau sopir lain yang tidak bertugas. Ubah = beralasan; ditolak bila
 * setoran hari sebelumnya belum Ditutup (KP-4). Rit yang sudah Berangkat tetap atas nama pelaksananya (KP-3).
 */
export async function setDailyDriver(ctx: ActorContext, input: SetDriverInput, opts: { tx?: Tx } = {}): Promise<AssignmentRow> {
  await authorize(ctx, "m2.crew_assignment.update", { tx: opts.tx, objectType: "truck", objectId: input.truckId });
  const data = parseInput(setDriverSchema, input, { truckId: "Truk", date: "Tanggal", employeeId: "Pengemudi", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const today = ctxBusinessDate(ctx);
    if (data.date < today) throw ValidationError.field("date", "Pengemudi hanya dapat ditetapkan untuk hari ini atau sesudahnya.");
    const truck = await loadTruck(tx, ctx, data.truckId);
    await assertTruckCanReceiveTrips(tx, truck.id);
    const employee = await loadEmployee(tx, ctx, data.employeeId);
    if (!employee.isActive || (employee.exitDate && employee.exitDate <= data.date)) {
      throw new DomainError("EMPLOYEE_INACTIVE", `${employee.fullName} tidak aktif pada tanggal itu.`);
    }
    const rosterHelper = await tx
      .select({ id: crewRosters.id })
      .from(crewRosters)
      .where(and(eq(crewRosters.employeeId, employee.id), eq(crewRosters.businessDate, data.date), eq(crewRosters.truckId, truck.id), eq(crewRosters.role, "helper"), eq(crewRosters.status, "on_duty")))
      .limit(1);
    const drivers = await driverEmployeeIds(tx, ctx.tenantId);
    let source: EnumValue<"crew_assignment_source">;
    if (employee.id === truck.defaultDriverEmployeeId) source = "default_driver";
    else if (employee.id === truck.defaultHelperEmployeeId || rosterHelper[0]) source = "helper";
    else if (drivers.has(employee.id)) source = "other_driver";
    else {
      throw new DomainError(
        "NOT_ELIGIBLE_DRIVER",
        `${employee.fullName} bukan sopir default, kernet truk ${truck.code}, atau sopir lain. Pengemudi pengganti hanya dari ketiga kelompok itu (US-M2-11).`,
      );
    }
    const off = await tx
      .select({ id: crewRosters.id })
      .from(crewRosters)
      .where(and(eq(crewRosters.employeeId, employee.id), eq(crewRosters.businessDate, data.date), eq(crewRosters.status, "off")))
      .limit(1);
    if (off[0]) throw new DomainError("EMPLOYEE_OFF", `${employee.fullName} dijadwalkan libur pada tanggal itu. Ubah jadwal kru dulu.`);

    // Sopir lain harus tidak sedang bertugas di truk lain.
    const crews = await resolveDayCrews(tx, ctx.tenantId, data.date, today);
    const busy = [...crews.values()].find((c) => c.truckId !== truck.id && c.driverEmployeeId === employee.id);
    if (busy) {
      const code = (await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.id, busy.truckId)).limit(1))[0]?.code ?? "lain";
      throw new DomainError("DRIVER_BUSY", `${employee.fullName} bertugas di truk ${code} pada tanggal itu. Tetapkan pengemudi lain untuk truk ${code} dulu.`);
    }

    // BR-10 (KP-4).
    const locks = await driverDepositLocks(tx, [employee.id], data.date, today);
    const lock = locks.get(employee.id);
    if (lock) throw new DomainError("DRIVER_LOCKED_BR10", `Tidak dapat ditetapkan: ${lockMessage(employee.fullName, lock)}`);

    const current = await tx
      .select()
      .from(crewAssignments)
      .where(and(eq(crewAssignments.truckId, truck.id), eq(crewAssignments.businessDate, data.date), isNull(crewAssignments.supersededAt)))
      .for("update")
      .limit(1);
    const prev = current[0] ?? null;
    if (prev?.driverEmployeeId === employee.id) throw new ConflictError("SAME_DRIVER", `${employee.fullName} sudah ditetapkan sebagai pengemudi truk ${truck.code}.`);
    const needsReason = !!prev || source !== "default_driver";
    if (needsReason && (!data.reason || data.reason.length < 3)) {
      throw ValidationError.field("reason", prev ? "Alasan mengganti pengemudi wajib diisi (minimal 3 karakter)." : "Alasan penetapan pengemudi pengganti wajib diisi (minimal 3 karakter).");
    }
    if (prev) {
      await tx.update(crewAssignments).set({ supersededAt: ctx.now, supersededBy: ctx.userId, updatedAt: ctx.now }).where(eq(crewAssignments.id, prev.id));
    }
    const [row] = await tx
      .insert(crewAssignments)
      .values({
        tenantId: truck.tenantId,
        truckId: truck.id,
        businessDate: data.date,
        driverEmployeeId: employee.id,
        source,
        reason: data.reason,
        assignedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    // Rit terbit/terjadwal yang belum Berangkat → atas nama pengemudi baru; yang sudah Berangkat tetap (KP-3).
    await tx
      .update(trips)
      .set({ driverEmployeeId: employee.id, updatedAt: ctx.now })
      .where(and(eq(trips.truckId, truck.id), eq(trips.scheduledDate, data.date), eq(trips.status, "assigned"), isNull(trips.withdrawnAt)));
    await auditRecord(tx, {
      ctx,
      objectType: "crew_assignment",
      objectId: row!.id,
      action: prev ? "replace" : "create",
      before: prev ? { driverEmployeeId: prev.driverEmployeeId, source: prev.source } : null,
      after: { truckId: truck.id, truckCode: truck.code, businessDate: data.date, driverEmployeeId: employee.id, driverName: employee.fullName, source },
      reason: data.reason,
      rule: "US-M2-11",
      businessDate: data.date,
    });
    return row!;
  });
}

/** Riwayat penetapan pengemudi per tanggal (KP-5: pelaku, waktu, alasan; termasuk yang diganti). */
export async function listCrewAssignments(ctx: ActorContext, filter: { from: BusinessDate; to: BusinessDate; truckId?: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m2.crew_assignment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ a: crewAssignments, truckCode: trucks.code })
    .from(crewAssignments)
    .innerJoin(trucks, eq(trucks.id, crewAssignments.truckId))
    .where(
      and(
        eq(crewAssignments.tenantId, ctx.tenantId),
        gte(crewAssignments.businessDate, filter.from),
        lte(crewAssignments.businessDate, filter.to),
        filter.truckId ? eq(crewAssignments.truckId, filter.truckId) : sql`true`,
      ),
    )
    .orderBy(asc(crewAssignments.businessDate), asc(trucks.code), asc(crewAssignments.createdAt));
  const names = await employeeNames(tx, rows.map((r) => r.a.driverEmployeeId));
  const users_ = await userNames(tx, rows.flatMap((r) => [r.a.assignedBy, r.a.supersededBy]));
  return rows.map(({ a, truckCode }) => ({
    id: a.id,
    businessDate: a.businessDate,
    truckId: a.truckId,
    truckCode,
    driverEmployeeId: a.driverEmployeeId,
    driverName: names.get(a.driverEmployeeId) ?? "—",
    source: a.source,
    reason: a.reason,
    assignedByName: a.assignedBy ? (users_.get(a.assignedBy) ?? null) : null,
    assignedAt: a.createdAt,
    supersededAt: a.supersededAt,
    supersededByName: a.supersededBy ? (users_.get(a.supersededBy) ?? null) : null,
    active: !a.supersededAt,
  }));
}

// =====================================================================================================================
// Jadwal kru mingguan & status truk per hari (US-M2-10)
// =====================================================================================================================

/** Isi/ubah jadwal kru satu karyawan pada satu tanggal (sopir/kernet di truk X, atau libur). */
export async function setRosterEntry(ctx: ActorContext, input: RosterEntryInput, opts: { tx?: Tx } = {}): Promise<RosterRow> {
  await authorize(ctx, "m2.crew_assignment.update", { tx: opts.tx });
  const data = parseInput(rosterEntrySchema, input, { employeeId: "Karyawan", date: "Tanggal", truckId: "Truk", role: "Peran" });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const today = ctxBusinessDate(ctx);
    if (data.date < today) throw ValidationError.field("date", "Jadwal kru hanya dapat diubah untuk hari ini atau sesudahnya.");
    const employee = await loadEmployee(tx, ctx, data.employeeId);
    if (data.status === "on_duty") {
      if (!data.truckId || !data.role) throw ValidationError.field("truckId", "Pilih truk dan peran (sopir/kernet) untuk karyawan yang bertugas.");
      await loadTruck(tx, ctx, data.truckId);
      if (data.role === "driver") {
        const drivers = await driverEmployeeIds(tx, ctx.tenantId);
        if (!drivers.has(employee.id)) {
          throw new DomainError("NOT_A_DRIVER", `${employee.fullName} bukan sopir. Kernet pengganti ditetapkan lewat "Pengemudi hari ini" (US-M2-11).`);
        }
      }
    } else {
      const live = await tx
        .select({ id: crewAssignments.id })
        .from(crewAssignments)
        .where(and(eq(crewAssignments.driverEmployeeId, employee.id), eq(crewAssignments.businessDate, data.date), isNull(crewAssignments.supersededAt)))
        .limit(1);
      if (live[0]) throw new DomainError("ASSIGNED_DRIVER", `${employee.fullName} sudah ditetapkan sebagai pengemudi pada tanggal itu. Ganti pengemudinya dulu.`);
    }
    const before = (await tx.select().from(crewRosters).where(and(eq(crewRosters.employeeId, employee.id), eq(crewRosters.businessDate, data.date))).limit(1))[0] ?? null;
    const values = {
      status: data.status,
      truckId: data.status === "on_duty" ? data.truckId! : null,
      role: data.status === "on_duty" ? data.role! : null,
      notes: data.notes,
      updatedAt: ctx.now,
    };
    const [row] = await tx
      .insert(crewRosters)
      .values({ tenantId: employee.tenantId, employeeId: employee.id, businessDate: data.date, createdBy: ctx.userId, ...values })
      .onConflictDoUpdate({ target: [crewRosters.employeeId, crewRosters.businessDate], set: values })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "crew_roster",
      objectId: row!.id,
      action: before ? "update" : "create",
      before: before ? { status: before.status, truckId: before.truckId, role: before.role } : null,
      after: { employeeName: employee.fullName, businessDate: data.date, status: row!.status, truckId: row!.truckId, role: row!.role },
      reason: data.notes,
      rule: "US-M2-10",
      businessDate: data.date,
    });
    return row!;
  });
}

/** Status truk per hari (operasi/perbaikan) + kapasitas rit hari itu (US-M2-10 KP-2). */
export async function setTruckDayStatus(ctx: ActorContext, input: TruckDayInput, opts: { tx?: Tx } = {}): Promise<TruckDayRow> {
  await authorize(ctx, "m2.crew_assignment.update", { tx: opts.tx });
  const data = parseInput(truckDaySchema, input, { truckId: "Truk", date: "Tanggal", status: "Status", tripCapacity: "Kapasitas rit", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    sod.assertNotFinanceAdminOnOrders(ctx);
    const today = ctxBusinessDate(ctx);
    if (data.date < today) throw ValidationError.field("date", "Status truk hanya dapat diubah untuk hari ini atau sesudahnya.");
    if (data.status === "maintenance" && (!data.reason || data.reason.length < 3)) throw ValidationError.field("reason", "Alasan truk perbaikan wajib diisi.");
    const truck = await loadTruck(tx, ctx, data.truckId);
    const before = (await tx.select().from(truckDayStatus).where(and(eq(truckDayStatus.truckId, truck.id), eq(truckDayStatus.businessDate, data.date))).limit(1))[0] ?? null;
    const values = { status: data.status, tripCapacity: data.tripCapacity ?? null, reason: data.reason, updatedAt: ctx.now };
    const [row] = await tx
      .insert(truckDayStatus)
      .values({ tenantId: truck.tenantId, truckId: truck.id, businessDate: data.date, createdBy: ctx.userId, ...values })
      .onConflictDoUpdate({ target: [truckDayStatus.truckId, truckDayStatus.businessDate], set: values })
      .returning();
    let flagged = 0;
    if (data.status === "maintenance") {
      const res = await tx
        .update(trips)
        .set({ needsReassignment: true, updatedAt: ctx.now })
        .where(and(eq(trips.truckId, truck.id), eq(trips.scheduledDate, data.date), eq(trips.status, "assigned"), isNull(trips.withdrawnAt)))
        .returning({ id: trips.id });
      flagged = res.length;
      if (flagged) {
        await notify(tx, {
          event: "truck.trips_need_reassignment",
          tenantId: truck.tenantId,
          excludeUserIds: ctx.userId ? [ctx.userId] : [],
          title: `Truk ${truck.code} perbaikan ${formatTanggal(data.date, { weekday: false })}: ${flagged} rit perlu dipindah`,
          body: data.reason ?? undefined,
          objectType: "truck",
          objectId: truck.id,
          link: `/jadwal?tanggal=${data.date}`,
          now: ctx.now,
        });
      }
    }
    await auditRecord(tx, {
      ctx,
      objectType: "truck_day_status",
      objectId: row!.id,
      action: before ? "update" : "create",
      before: before ? { status: before.status, tripCapacity: before.tripCapacity } : null,
      after: { truckCode: truck.code, businessDate: data.date, status: row!.status, tripCapacity: row!.tripCapacity, tripsFlagged: flagged },
      reason: data.reason,
      rule: "US-M2-10 KP-2",
      businessDate: data.date,
    });
    return row!;
  });
}

/** Kapasitas rit truk pada hari itu: 0 bila truk tidak Aktif / Perbaikan hari itu; override hari → per truk → PAR-33. */
export function truckCapacity(truck: TruckRow, day: Pick<TruckDayRow, "status" | "tripCapacity"> | null | undefined, par33: number): number {
  if (!truck.isActive || truck.status !== "active") return 0;
  if (day?.status === "maintenance") return 0;
  return day?.tripCapacity ?? truck.dailyTripCapacity ?? par33;
}

export type WeekRosterCell = {
  date: BusinessDate;
  truckId: string;
  dayStatus: EnumValue<"truck_day_status">;
  tripCapacity: number;
  capacityOverride: number | null;
  dayReason: string | null;
  crew: DayCrew;
  scheduledTrips: number;
};

export type WeekRoster = {
  from: BusinessDate;
  dates: BusinessDate[];
  trucks: { id: string; code: string; plateNumber: string; status: TruckRow["status"]; isActive: boolean }[];
  cells: WeekRosterCell[];
  offByDate: Record<string, { employeeId: string; name: string; notes: string | null }[]>;
  totals: { date: BusinessDate; capacity: number; scheduled: number; customer: number; internal: number }[];
  people: { employeeId: string; name: string; isDriver: boolean }[];
};

/** Jadwal kru mingguan: per truk per hari sopir, kernet, status truk, kapasitas vs terjadwal (US-M2-10 KP-1..KP-3). */
export async function getWeekRoster(ctx: ActorContext, from: BusinessDate, opts: { tx?: Tx; days?: number } = {}): Promise<WeekRoster> {
  await authorize(ctx, "m2.crew_assignment.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const n = opts.days ?? 7;
  const dates = Array.from({ length: n }, (_, i) => addDays(from, i));
  const truckRows = await tx.select().from(trucks).where(eq(trucks.tenantId, ctx.tenantId)).orderBy(asc(trucks.code));
  const days = await tx
    .select()
    .from(truckDayStatus)
    .where(and(eq(truckDayStatus.tenantId, ctx.tenantId), gte(truckDayStatus.businessDate, dates[0]!), lte(truckDayStatus.businessDate, dates[n - 1]!)));
  const tripCounts = await tx
    .select({ truckId: trips.truckId, date: trips.scheduledDate, isInternal: trips.isInternal, n: sql<number>`count(*)::int` })
    .from(trips)
    .where(and(eq(trips.tenantId, ctx.tenantId), gte(trips.scheduledDate, dates[0]!), lte(trips.scheduledDate, dates[n - 1]!), isNull(trips.withdrawnAt), ne(trips.status, "failed"), sql`${trips.truckId} is not null`))
    .groupBy(trips.truckId, trips.scheduledDate, trips.isInternal);
  const rosters = await tx
    .select()
    .from(crewRosters)
    .where(and(eq(crewRosters.tenantId, ctx.tenantId), gte(crewRosters.businessDate, dates[0]!), lte(crewRosters.businessDate, dates[n - 1]!), eq(crewRosters.status, "off")));
  const cells: WeekRosterCell[] = [];
  const totals: WeekRoster["totals"] = [];
  for (const date of dates) {
    const par33 = (await params.get(tx, "PAR-33", date)).trips;
    const crews = await resolveDayCrews(tx, ctx.tenantId, date, today);
    let capacity = 0;
    let customer = 0;
    let internal = 0;
    for (const t of truckRows) {
      const day = days.find((d) => d.truckId === t.id && d.businessDate === date) ?? null;
      const cap = truckCapacity(t, day, par33);
      const counts = tripCounts.filter((c) => c.truckId === t.id && c.date === date);
      const scheduled = counts.reduce((s, c) => s + Number(c.n), 0);
      capacity += cap;
      customer += counts.filter((c) => !c.isInternal).reduce((s, c) => s + Number(c.n), 0);
      internal += counts.filter((c) => c.isInternal).reduce((s, c) => s + Number(c.n), 0);
      cells.push({
        date,
        truckId: t.id,
        dayStatus: day?.status ?? (t.status === "maintenance" ? "maintenance" : "operating"),
        tripCapacity: cap,
        capacityOverride: day?.tripCapacity ?? null,
        dayReason: day?.reason ?? null,
        crew: crews.get(t.id)!,
        scheduledTrips: scheduled,
      });
    }
    totals.push({ date, capacity, scheduled: customer + internal, customer, internal });
  }
  const offNames = await employeeNames(tx, rosters.map((r) => r.employeeId));
  const offByDate: WeekRoster["offByDate"] = {};
  for (const r of rosters) (offByDate[r.businessDate] ??= []).push({ employeeId: r.employeeId, name: offNames.get(r.employeeId) ?? "—", notes: r.notes });
  const drivers = await driverEmployeeIds(tx, ctx.tenantId);
  const crewPeople = await tx
    .select({ id: employees.id, name: employees.fullName, roles: employees.intendedRoles })
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.isActive, true)))
    .orderBy(asc(employees.fullName));
  const people = crewPeople
    .filter((p) => drivers.has(p.id) || (p.roles ?? []).some((r) => r === "driver" || r === "helper"))
    .map((p) => ({ employeeId: p.id, name: p.name, isDriver: drivers.has(p.id) }));
  return {
    from,
    dates,
    trucks: truckRows.map((t) => ({ id: t.id, code: t.code, plateNumber: t.plateNumber, status: t.status, isActive: t.isActive })),
    cells,
    offByDate,
    totals,
    people,
  };
}
