/**
 * M4 — "Kas hari ini" (US-M4-01; FR-M4-01, BR-08, P-06 langkah 1): satu baris per sumber — setiap sopir/pengemudi yang
 * bertugas, setiap depot, toko, dan kas kantor — dengan seharusnya (dihitung dari data M3/M6/M7 yang sudah
 * tersinkron), status setoran, diterima, selisih, alasan; kolom terpisah transfer belum dicocokkan & QRIS (PTB-04);
 * total per lini & keseluruhan; sorotan: setoran sopir belum Diajukan > PAR-44 setelah rit terakhir Selesai, setoran
 * depot/toko belum diterima > PAR-27 hari sejak tutup shift, kas outlet > PAR-02 (BR-08). Riwayat per tanggal.
 */
import "server-only";

import { and, asc, eq, inArray, lte } from "drizzle-orm";

import { deposits, incomingTransfers, outlets, shifts, trucks, users } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { toBusinessDate, type BusinessDate } from "@/lib/time";

import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { authorize } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";
import * as m3 from "@/server/modules/m3-driver";
import * as m6 from "@/server/modules/m6-pos";

import { cashDayOf, cashRules, outletCashLimit, userNames, type DepositRow } from "./common";
import { depositFigures, lastCompletedTripAt } from "./deposits";
import { officeCashDay } from "./office-cash";

export type CashLine = "driver" | "depot" | "store" | "office";

export type CashFlag = { code: "driver_not_submitted" | "depot_late" | "outlet_cash_over" | "received_late" | "submitted_late"; text: string };

export type CashSourceRow = {
  key: string;
  line: CashLine;
  label: string;
  detail: string | null;
  phone: string | null;
  /** Seharusnya disetor (tunai; setelah pengeluaran rit dari kas). */
  expected: number;
  status: EnumValue<"deposit_status"> | "none" | "shift_open" | "cash_day_open" | "cash_day_closed";
  statusText: string;
  received: number | null;
  discrepancy: number | null;
  reason: string | null;
  unmatchedTransfers: number;
  qris: number;
  flags: CashFlag[];
  depositIds: string[];
  userId?: string | null;
  outletId?: string | null;
};

export type CashLineTotal = { line: CashLine; label: string; expected: number; received: number; discrepancy: number; unmatchedTransfers: number; qris: number; count: number };

export type CashPosition = {
  date: BusinessDate;
  isToday: boolean;
  rows: CashSourceRow[];
  totals: CashLineTotal[];
  overall: Omit<CashLineTotal, "line" | "label">;
  office: Awaited<ReturnType<typeof officeCashDay>>;
  cashDayStatus: "open" | "closed";
  thresholds: { driverSubmitHours: number; depotLateDays: number };
};

const LINE_LABEL: Record<CashLine, string> = { driver: "Sopir (air truk)", depot: "Depot", store: "Toko", office: "Kas kantor" };

function statusText(status: CashSourceRow["status"]): string {
  switch (status) {
    case "none":
      return "Belum ada setoran";
    case "shift_open":
      return "Shift terbuka";
    case "cash_day_open":
      return "Belum ditutup";
    case "cash_day_closed":
      return "Kas ditutup";
    default:
      return label("deposit_status", status);
  }
}

/** Status gabungan beberapa setoran satu sumber: yang paling "belum selesai". */
function combinedStatus(deps: DepositRow[]): EnumValue<"deposit_status"> {
  const order: EnumValue<"deposit_status">[] = ["running", "submitted", "received", "closed"];
  return deps.map((d) => d.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "running";
}

export async function getCashPosition(ctx: ActorContext, filter: { date?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<CashPosition> {
  await authorize(ctx, "m4.cash_position.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return buildCashPosition(tx, ctx, filter.date ?? ctxBusinessDate(ctx));
}

export async function buildCashPosition(tx: Tx, ctx: ActorContext, date: BusinessDate): Promise<CashPosition> {
  const tenantId = ctx.tenantId;
  const today = ctxBusinessDate(ctx);
  const rules = await cashRules(tx, today, tenantId);
  const dayDeposits = await tx.select().from(deposits).where(and(eq(deposits.tenantId, tenantId), eq(deposits.businessDate, date))).orderBy(asc(deposits.number));
  const unmatched = await tx
    .select({ amount: incomingTransfers.amount, sourceUserId: incomingTransfers.sourceUserId, outletId: incomingTransfers.outletId, sourceKind: incomingTransfers.sourceKind })
    .from(incomingTransfers)
    .where(and(eq(incomingTransfers.tenantId, tenantId), eq(incomingTransfers.businessDate, date), inArray(incomingTransfers.status, ["unmatched", "not_found"])));
  const rows: CashSourceRow[] = [];

  // --- Sopir: pengemudi bertugas (penetapan harian/roster/default) + setiap penyetor sopir hari itu ---
  const driverDeps = dayDeposits.filter((d) => d.sourceType === "driver");
  const crews = await m2.resolveDayCrews(tx, tenantId, date, today);
  const activeTrucks = new Map((await tx.select({ id: trucks.id, code: trucks.code, plate: trucks.plateNumber, status: trucks.status }).from(trucks).where(eq(trucks.tenantId, tenantId))).map((t) => [t.id, t]));
  const crewEmployees = [...crews.values()].filter((c) => c.driverEmployeeId && activeTrucks.get(c.truckId)?.status === "active").map((c) => ({ employeeId: c.driverEmployeeId!, truckId: c.truckId }));
  const crewUsers = crewEmployees.length
    ? await tx.select({ id: users.id, employeeId: users.employeeId }).from(users).where(inArray(users.employeeId, crewEmployees.map((c) => c.employeeId)))
    : [];
  const userByEmployee = new Map(crewUsers.map((u) => [u.employeeId, u.id]));
  const driverUsers = new Map<string, { truckId: string | null }>();
  for (const d of driverDeps) if (d.depositorUserId) driverUsers.set(d.depositorUserId, { truckId: d.truckId });
  for (const c of crewEmployees) {
    const uid = userByEmployee.get(c.employeeId);
    if (uid && !driverUsers.has(uid)) driverUsers.set(uid, { truckId: c.truckId });
  }
  const names = await userNames(tx, [...driverUsers.keys()]);
  for (const [userId, info] of driverUsers) {
    const deps = driverDeps.filter((d) => d.depositorUserId === userId);
    const person = names.get(userId);
    const truck = info.truckId ? activeTrucks.get(info.truckId) : undefined;
    let expected = 0;
    let received: number | null = null;
    let discrepancy: number | null = null;
    let reason: string | null = null;
    const flags: CashFlag[] = [];
    for (const d of deps) {
      if (d.status === "received" || d.status === "closed") {
        expected += d.expectedNet;
        received = (received ?? 0) + (d.receivedAmount ?? 0);
        discrepancy = (discrepancy ?? 0) + (d.discrepancyAmount ?? 0);
        if (d.discrepancyReason) reason = label("discrepancy_reason", d.discrepancyReason) + (d.discrepancyNote ? ` — ${d.discrepancyNote}` : "");
        if (d.receivedLate) flags.push({ code: "received_late", text: `Diterima terlambat${d.lateReason ? `: ${d.lateReason}` : ""}` });
      } else {
        const f = await depositFigures(tx, d);
        const claimedCash = f.expenses.filter((e) => e.fundingSource === "cash_on_hand" && e.status !== "rejected").reduce((s, e) => s + e.amount, 0);
        expected += f.expectedCash - claimedCash;
        if (d.submittedLate) flags.push({ code: "submitted_late", text: "Diajukan setelah batas tutup kas" });
      }
    }
    if (!deps.length) {
      const f = await m3.dayFigures(tx, userId, date);
      expected = f.cashOnHand;
    }
    const status: CashSourceRow["status"] = deps.length ? combinedStatus(deps) : "none";
    // US-M4-01 KP-4: belum Diajukan > PAR-44 jam setelah rit terakhir Selesai.
    if (status === "running" || status === "none") {
      const last = await lastCompletedTripAt(tx, userId, date);
      if (last && ctx.now.getTime() - last.getTime() > rules.driverSubmitHours * 3_600_000) {
        flags.push({ code: "driver_not_submitted", text: `Belum setor > ${rules.driverSubmitHours} jam setelah rit terakhir Selesai` });
      }
    }
    const unm = unmatched.filter((t) => t.sourceUserId === userId && (t.sourceKind === "trip_payment" || t.sourceKind === "collection" || t.sourceKind === "bank_deposit_slip"));
    rows.push({
      key: `driver:${userId}`,
      line: "driver",
      label: person?.name ?? "Sopir",
      detail: truck ? `${truck.code} · ${truck.plate}` : null,
      phone: person?.phone ?? null,
      expected,
      status,
      statusText: statusText(status),
      received,
      discrepancy,
      reason,
      unmatchedTransfers: unm.reduce((s, t) => s + t.amount, 0),
      qris: 0,
      flags,
      depositIds: deps.map((d) => d.id),
      userId,
    });
  }

  // --- Depot & toko: satu baris per outlet ---
  const outletRows = await tx
    .select()
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), inArray(outlets.kind, ["depot", "store"]), eq(outlets.isActive, true)))
    .orderBy(asc(outlets.kind), asc(outlets.code));
  const outletIds = outletRows.map((o) => o.id);
  const dayShifts = outletIds.length ? await tx.select().from(shifts).where(and(inArray(shifts.outletId, outletIds), eq(shifts.businessDate, date))) : [];
  const openShifts = outletIds.length ? await tx.select().from(shifts).where(and(inArray(shifts.outletId, outletIds), eq(shifts.status, "open"), lte(shifts.businessDate, date))) : [];
  const olderOpenDeposits = outletIds.length
    ? await tx
        .select({ d: deposits, closedAt: shifts.closedAt })
        .from(deposits)
        .innerJoin(shifts, eq(shifts.id, deposits.shiftId))
        .where(and(inArray(deposits.outletId, outletIds), lte(deposits.businessDate, date), inArray(deposits.status, ["running", "submitted"]), eq(deposits.isPartial, false)))
    : [];
  const operatorNames = await userNames(tx, [...dayShifts, ...openShifts].map((s) => s.operatorUserId));
  // Satu agregat untuk semua shift terbuka (sebelumnya `computeShiftFigures` per shift — N+1, uji beban NFR-05).
  const openTotals = await m6.computeShiftCashTotals(
    tx,
    openShifts.filter((s) => !s.syncConflict),
  );
  for (const o of outletRows) {
    const line: CashLine = o.kind === "store" ? "store" : "depot";
    const deps = dayDeposits.filter((d) => d.outletId === o.id);
    const myShifts = dayShifts.filter((s) => s.outletId === o.id);
    const open = openShifts.filter((s) => s.outletId === o.id && !s.syncConflict);
    let expected = 0;
    let received: number | null = null;
    let discrepancy: number | null = null;
    let reason: string | null = null;
    let qris = 0;
    const flags: CashFlag[] = [];
    for (const d of deps) {
      expected += d.expectedNet;
      if (d.status === "received" || d.status === "closed") {
        received = (received ?? 0) + (d.receivedAmount ?? 0);
        discrepancy = (discrepancy ?? 0) + (d.discrepancyAmount ?? 0);
        if (d.discrepancyReason) reason = label("discrepancy_reason", d.discrepancyReason) + (d.discrepancyNote ? ` — ${d.discrepancyNote}` : "");
      }
    }
    for (const s of myShifts) if (s.status === "closed") qris += s.qrisSales ?? 0;
    for (const s of open) {
      const f = openTotals.get(s.id)!;
      if (s.businessDate === date) {
        expected += f.depositAmount;
        qris += f.qrisSales;
      }
      // BR-08 / PAR-02: kas berjalan di laci melebihi batas outlet.
      const limit = await outletCashLimit(tx, today, tenantId, o.id);
      if (f.expectedDrawer > limit) flags.push({ code: "outlet_cash_over", text: `Kas di laci ${formatRupiah(f.expectedDrawer)} > batas ${formatRupiah(limit)}` });
    }
    // US-M4-01 KP-4 / PAR-27: setoran shift belum diterima > N hari sejak tutup shift.
    const late = olderOpenDeposits.filter((x) => x.d.outletId === o.id && x.closedAt && ctx.now.getTime() - x.closedAt.getTime() > rules.depotLateDays * 86_400_000);
    if (late.length) flags.push({ code: "depot_late", text: `Setoran shift belum diterima > ${rules.depotLateDays} hari sejak tutup shift (${late.map((x) => x.d.number).join(", ")})` });
    const status: CashSourceRow["status"] = open.some((s) => s.businessDate === date) ? "shift_open" : deps.filter((d) => !d.isPartial).length ? combinedStatus(deps.filter((d) => !d.isPartial)) : "none";
    const operator = [...myShifts, ...open].map((s) => operatorNames.get(s.operatorUserId)?.name).find(Boolean) ?? null;
    const unm = unmatched.filter((t) => t.outletId === o.id);
    rows.push({
      key: `outlet:${o.id}`,
      line,
      label: `${o.code} — ${o.name}`,
      detail: operator ? `Operator: ${operator}` : null,
      phone: o.phone,
      expected,
      status,
      statusText: statusText(status),
      received,
      discrepancy,
      reason,
      unmatchedTransfers: unm.reduce((s, t) => s + t.amount, 0),
      qris,
      flags,
      depositIds: deps.map((d) => d.id),
      outletId: o.id,
    });
  }

  // --- Kas kantor (US-M4-01 KP-3) ---
  const office = await officeCashDay(tx, tenantId, date);
  const cashDay = await cashDayOf(tx, tenantId, date);
  const closed = cashDay?.status === "closed";
  rows.push({
    key: "office",
    line: "office",
    label: "Kas kantor",
    detail: `Saldo awal ${formatRupiah(office.opening)} + setoran ${formatRupiah(office.depositsReceived)} − setor bank ${formatRupiah(office.bankDeposits)} − kas kecil ${formatRupiah(office.pettyCashTopups)} − penggantian ${formatRupiah(office.expenseReimbursements)}`,
    phone: null,
    expected: office.closing,
    status: closed ? "cash_day_closed" : "cash_day_open",
    statusText: statusText(closed ? "cash_day_closed" : "cash_day_open"),
    received: closed ? (cashDay?.officeCashPhysical ?? null) : null,
    discrepancy: closed ? (cashDay?.officeCashDifference ?? null) : null,
    reason: cashDay?.officeCashReason ?? null,
    unmatchedTransfers: unmatched.filter((t) => !t.sourceUserId && !t.outletId).reduce((s, t) => s + t.amount, 0),
    qris: 0,
    flags: [],
    depositIds: [],
  });

  const totals: CashLineTotal[] = (["driver", "depot", "store", "office"] as CashLine[]).map((line) => {
    const rs = rows.filter((r) => r.line === line);
    return {
      line,
      label: LINE_LABEL[line],
      expected: rs.reduce((s, r) => s + r.expected, 0),
      received: rs.reduce((s, r) => s + (r.received ?? 0), 0),
      discrepancy: rs.reduce((s, r) => s + (r.discrepancy ?? 0), 0),
      unmatchedTransfers: rs.reduce((s, r) => s + r.unmatchedTransfers, 0),
      qris: rs.reduce((s, r) => s + r.qris, 0),
      count: rs.length,
    };
  });
  const sources = totals.filter((t) => t.line !== "office");
  return {
    date,
    isToday: date === toBusinessDate(ctx.now),
    rows,
    totals,
    overall: {
      expected: sources.reduce((s, t) => s + t.expected, 0),
      received: sources.reduce((s, t) => s + t.received, 0),
      discrepancy: sources.reduce((s, t) => s + t.discrepancy, 0) + (closed ? (cashDay?.officeCashDifference ?? 0) : 0),
      unmatchedTransfers: totals.reduce((s, t) => s + t.unmatchedTransfers, 0),
      qris: totals.reduce((s, t) => s + t.qris, 0),
      count: rows.length,
    },
    office,
    cashDayStatus: closed ? "closed" : "open",
    thresholds: { driverSubmitHours: rules.driverSubmitHours, depotLateDays: rules.depotLateDays },
  };
}
