/**
 * M4 — pembantu internal layanan kas (tidak diekspor lewat index.ts kecuali disebut): aturan kas dari parameter,
 * pusat laba per sumber, nama karyawan/sumber, mutasi kas kantor (append-only + event), saldo kas kantor, kunci hari kas.
 */
import "server-only";

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { cashDays, deposits, employees, officeCashMovements, outlets, trucks, users } from "@/db/schema";
import type { EnumValue, ProfitCenter } from "@/lib/labels";
import { formatTanggal, parseHourMinute, toBusinessDate, toWibParts, type BusinessDate } from "@/lib/time";

import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import * as params from "@/server/core/params";

export type DepositRow = typeof deposits.$inferSelect;
export type OfficeCashMovementRow = typeof officeCashMovements.$inferSelect;
export type DepositSourceType = EnumValue<"deposit_source_type">;
export type DiscrepancySource = EnumValue<"discrepancy_source">;
export type DiscrepancyReason = EnumValue<"discrepancy_reason">;

// =====================================================================================================================
// Aturan (parameter Lampiran B + m4.cash_rules) — tidak ada angka aturan di kode
// =====================================================================================================================

export type CashRules = {
  /** PAR-01: |selisih| ≥ nilai ini → keputusan pemilik (BR-09). */
  discrepancyThreshold: number;
  /** PAR-06: batas tutup kas (HH:mm WIB). */
  cashCloseTime: string;
  /** PAR-27: setoran depot dianggap terlambat > N hari sejak tutup shift. */
  depotLateDays: number;
  /** PAR-39: transfer tanpa mutasi > N hari → Tidak ditemukan. */
  transferNotFoundDays: number;
  /** PAR-43: kas kecil > nilai ini → persetujuan pemilik. */
  pettyCashApprovalAbove: number;
  /** PAR-44: setoran sopir belum Diajukan > N jam setelah rit terakhir Selesai. */
  driverSubmitHours: number;
  /** PAR-83 (PTB-62): kunci rit karena selisih kurang besar. */
  tripLock: { enabled: boolean; amountGte: number };
  /** PAR-89: setoran tertunda maksimal N hari. */
  pendingDepositMaxDays: number;
  /** PAR-21: koreksi > nilai ini → persetujuan pemilik (BR-38). */
  correctionApprovalAbove: number;
  followUpHours: number;
  reopenDays: number;
  statementMatchDays: number;
  pettyCashCountDays: number;
  zeroDiscrepancyMonths: number;
};

export async function cashRules(tx: Tx, date: BusinessDate, tenantId: string): Promise<CashRules> {
  const scope = { tenantId };
  const [p01, p06, p27, p39, p43, p44, p83, p89, p21, rules] = await Promise.all([
    params.get(tx, "PAR-01", date, scope),
    params.get(tx, "PAR-06", date, scope),
    params.get(tx, "PAR-27", date, scope),
    params.get(tx, "PAR-39", date, scope),
    params.get(tx, "PAR-43", date, scope),
    params.get(tx, "PAR-44", date, scope),
    params.get(tx, "PAR-83", date, scope),
    params.get(tx, "PAR-89", date, scope),
    params.get(tx, "PAR-21", date, scope),
    params.get(tx, "m4.cash_rules", date, scope),
  ]);
  return {
    discrepancyThreshold: p01.amount,
    cashCloseTime: p06.time,
    depotLateDays: p27.days_gt,
    transferNotFoundDays: p39.days_gt,
    pettyCashApprovalAbove: p43.amount_gt,
    driverSubmitHours: p44.hours_gt,
    tripLock: { enabled: p83.enabled, amountGte: p83.amount_gte },
    pendingDepositMaxDays: p89.max_days,
    correctionApprovalAbove: p21.amount_gt,
    followUpHours: rules.discrepancy_follow_up_hours,
    reopenDays: rules.discrepancy_reopen_days,
    statementMatchDays: rules.statement_match_days,
    pettyCashCountDays: rules.petty_cash_count_days,
    zeroDiscrepancyMonths: rules.zero_discrepancy_months,
  };
}

/** PAR-02 per outlet (lingkup outlet → tenant → global). */
export async function outletCashLimit(tx: Tx, date: BusinessDate, tenantId: string, outletId: string): Promise<number> {
  return (await params.get(tx, "PAR-02", date, { tenantId, outletId })).amount;
}

/** Waktu `at` (UTC) jatuh setelah jam `time` WIB pada tanggal bisnis `date`, atau pada hari sesudahnya. */
export function isAfterCutoff(at: Date, date: BusinessDate, time: string): boolean {
  const atDate = toBusinessDate(at);
  if (atDate > date) return true;
  if (atDate < date) return false;
  const p = toWibParts(at);
  return p.hour * 60 + p.minute > parseHourMinute(time as `${number}:${number}`);
}

// =====================================================================================================================
// Pusat laba & label sumber
// =====================================================================================================================

/** Pusat laba sumber setoran/selisih (PRD 7.11.4): sopir L2 (air truk), depot L3, toko L4, kas kantor bersama. */
export function profitCenterFor(source: DepositSourceType | DiscrepancySource): ProfitCenter {
  switch (source) {
    case "driver":
      return "L2";
    case "depot_shift":
      return "L3";
    case "store_shift":
      return "L4";
    default:
      return "SHARED";
  }
}

export const LINE_LABELS: Record<"driver" | "depot" | "store" | "office", string> = {
  driver: "Sopir (air truk)",
  depot: "Depot",
  store: "Toko",
  office: "Kas kantor",
};

/** Nama karyawan per id pengguna. */
export async function userNames(tx: Tx, userIds: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; employeeId: string | null; phone: string | null }>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: users.id, username: users.username, employeeId: users.employeeId, name: employees.fullName, phone: employees.phone })
    .from(users)
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, { name: r.name ?? r.username, employeeId: r.employeeId, phone: r.phone }]));
}

/** Nama karyawan per id karyawan. */
export async function employeeNames(tx: Tx, employeeIds: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; phone: string | null; userId: string | null }>> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: employees.id, name: employees.fullName, phone: employees.phone, userId: users.id })
    .from(employees)
    .leftJoin(users, eq(users.employeeId, employees.id))
    .where(inArray(employees.id, ids));
  return new Map(rows.map((r) => [r.id, { name: r.name, phone: r.phone, userId: r.userId }]));
}

export async function userIdOfEmployee(tx: Tx, employeeId: string | null | undefined): Promise<string | null> {
  if (!employeeId) return null;
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.employeeId, employeeId)).limit(1);
  return rows[0]?.id ?? null;
}

export type SourceInfo = { label: string; detail: string | null; phone: string | null; employeeId: string | null };

/** Label sumber setoran: "Sopir — Nama (T2)", "Depot D02 — Nama operator", "Toko TK1 — Nama kasir". */
export async function depositSourceInfo(tx: Tx, dep: Pick<DepositRow, "sourceType" | "depositorUserId" | "depositorEmployeeId" | "truckId" | "outletId">): Promise<SourceInfo> {
  const names = await userNames(tx, [dep.depositorUserId]);
  const person = dep.depositorUserId ? names.get(dep.depositorUserId) : undefined;
  if (dep.sourceType === "driver") {
    const truck = dep.truckId ? (await tx.select({ code: trucks.code, plate: trucks.plateNumber }).from(trucks).where(eq(trucks.id, dep.truckId)).limit(1))[0] : undefined;
    return { label: `Sopir — ${person?.name ?? "tanpa nama"}`, detail: truck ? `${truck.code} · ${truck.plate}` : null, phone: person?.phone ?? null, employeeId: dep.depositorEmployeeId ?? person?.employeeId ?? null };
  }
  const outlet = dep.outletId ? (await tx.select({ code: outlets.code, name: outlets.name, phone: outlets.phone }).from(outlets).where(eq(outlets.id, dep.outletId)).limit(1))[0] : undefined;
  const kind = dep.sourceType === "store_shift" ? "Toko" : "Depot";
  return {
    label: `${kind} ${outlet?.code ?? ""} — ${outlet?.name ?? ""}`.trim(),
    detail: person ? `Operator: ${person.name}` : null,
    phone: person?.phone ?? outlet?.phone ?? null,
    employeeId: dep.depositorEmployeeId ?? person?.employeeId ?? null,
  };
}

// =====================================================================================================================
// Setoran
// =====================================================================================================================

export async function loadDeposit(tx: Tx, ctx: ActorContext, id: string, opts: { forUpdate?: boolean } = {}): Promise<DepositRow> {
  const q = tx.select().from(deposits).where(eq(deposits.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const dep = rows[0];
  if (!dep || dep.tenantId !== ctx.tenantId) throw new NotFoundError("Setoran tidak ditemukan.");
  return dep;
}

// =====================================================================================================================
// Kas kantor (US-M4-01 KP-3, US-M4-05) — append-only, saldo = Σ masuk − Σ keluar
// =====================================================================================================================

export type OfficeCashInput = {
  tenantId: string;
  businessDate: BusinessDate;
  kind: EnumValue<"office_cash_kind">;
  direction: "in" | "out";
  amount: number;
  sourceObjectType?: string | null;
  sourceObjectId?: string | null;
  description?: string | null;
  reversalOfId?: string | null;
};

/**
 * Catat mutasi kas kantor + event `office_cash.moved` (jurnal M11). Idempoten per (jenis, sumber): mutasi yang sama
 * tidak digandakan (indeks unik `office_cash_movements_source_uq`).
 */
export async function postOfficeCash(tx: Tx, ctx: ActorContext, input: OfficeCashInput): Promise<OfficeCashMovementRow | null> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) return null;
  const [row] = await tx
    .insert(officeCashMovements)
    .values({
      tenantId: input.tenantId,
      businessDate: input.businessDate,
      kind: input.kind,
      direction: input.direction,
      amount: input.amount,
      sourceObjectType: input.sourceObjectType ?? null,
      sourceObjectId: input.sourceObjectId ?? null,
      description: input.description ?? null,
      reversalOfId: input.reversalOfId ?? null,
      createdBy: ctx.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await emit(
    tx,
    "office_cash.moved",
    {
      movementId: row.id,
      direction: input.direction,
      kind: input.kind,
      amount: input.amount,
      businessDate: input.businessDate,
      sourceObjectType: input.sourceObjectType ?? null,
      sourceObjectId: input.sourceObjectId ?? null,
      reversalOfId: input.reversalOfId ?? null,
    },
    { ctx, tenantId: input.tenantId, businessDate: input.businessDate, objectType: "office_cash_movement", objectId: row.id },
  );
  return row;
}

/** Saldo kas kantor sampai akhir tanggal `upTo` (inklusif). */
export async function officeCashBalance(tx: Tx, tenantId: string, upTo: BusinessDate): Promise<number> {
  const [r] = await tx
    .select({ v: sql<string>`coalesce(sum(case when ${officeCashMovements.direction} = 'in' then ${officeCashMovements.amount} else -${officeCashMovements.amount} end), 0)` })
    .from(officeCashMovements)
    .where(and(eq(officeCashMovements.tenantId, tenantId), lte(officeCashMovements.businessDate, upTo)));
  return Number(r?.v ?? 0);
}

/** Mutasi kas kantor sumber tertentu yang belum dibalik. */
export async function officeCashOf(tx: Tx, sourceObjectType: string, sourceObjectId: string): Promise<OfficeCashMovementRow[]> {
  return tx
    .select()
    .from(officeCashMovements)
    .where(and(eq(officeCashMovements.sourceObjectType, sourceObjectType), eq(officeCashMovements.sourceObjectId, sourceObjectId), isNull(officeCashMovements.reversalOfId)));
}

// =====================================================================================================================
// Hari kas (Bab 5.3, US-M4-06 KP-7): hari yang ditutup terkunci
// =====================================================================================================================

export async function cashDayOf(tx: Tx, tenantId: string, date: BusinessDate) {
  return (await tx.select().from(cashDays).where(and(eq(cashDays.tenantId, tenantId), eq(cashDays.businessDate, date))).limit(1))[0] ?? null;
}

/** Tolak pencatatan kas kantor/kas kecil/setor bank pada tanggal yang kasnya sudah ditutup. */
export async function assertCashDayOpen(tx: Tx, tenantId: string, date: BusinessDate, what: string): Promise<void> {
  const day = await cashDayOf(tx, tenantId, date);
  if (day?.status === "closed") {
    throw new DomainError(
      "CASH_DAY_CLOSED",
      `Kas ${formatTanggal(date, { weekday: false })} sudah ditutup — ${what} tidak dapat dicatat pada tanggal itu. Catat pada hari kas yang masih terbuka; koreksi hanya lewat transaksi pembalik.`,
    );
  }
}

/** Tanggal bisnis masukan (bawaan hari ini) tidak boleh di masa depan. */
export function assertNotFuture(date: BusinessDate, today: BusinessDate, what = "Tanggal"): void {
  if (date > today) throw new DomainError("FUTURE_DATE", `${what} tidak boleh setelah hari ini.`);
}
