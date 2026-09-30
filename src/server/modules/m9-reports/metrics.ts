/**
 * M9 — SATU definisi angka (US-M9-01, US-M9-06 KP-2, US-M9-07): omzet per lini, kas, piutang, rit, galon, pengecualian,
 * dan ukuran KPI. Dipakai H+0 (harian & rentang), laporan bulanan (M11 belum aktif), tren, kinerja, dan KPI — tidak ada
 * rumus kedua di tempat lain.
 *
 * Semua fungsi `tx`-first TANPA otorisasi (pemanggil sudah berizin) dan berlingkup tenant. Sumber:
 * - Omzet L2: rit pelanggan (bukan internal) berstatus Selesai, Σ `trips.price`, tanggal = `completion_business_date`.
 * - Omzet L3/L4: transaksi POS yang DIHITUNG (definisi M6 `COUNTED_SALE`, termasuk baris pembalik pada tanggal koreksi)
 *   lewat `m6.salesAggregates`, dipisah menurut jenis outlet (depot / toko).
 * - Transfer internal (BR-33): rit internal pasokan depot (L2 → L3, harga transfer terkunci di rit) dan transfer
 *   internal barang toko → depot (L4 → L3, `internal_transfers.total_value`) — ditampilkan terpisah, BUKAN omzet luar.
 * - Kas: posisi kas M4 (`buildCashPosition`) — seharusnya vs diterima vs selisih.
 * - Piutang: faktur + rit belum ditagih (definisi M5), dihitung ULANG per tanggal (as-of) dari alokasi, nota kredit &
 *   penghapusan agar riwayat & tren memakai rumus yang sama; KPI-04 = lewat tempo ÷ total.
 * - Rit per truk: rit terbit (tanggal jadwal) — terjadwal / selesai / gagal; internal dipisah (KPI-07).
 * - Galon per depot: baris POS bergalon (M6).
 */
import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import {
  approvalRequests,
  customers,
  dailyProductions,
  deposits,
  discrepancies,
  employees,
  outlets,
  trips,
  trucks,
  users,
  waterBalances,
  waterSources,
} from "@/db/schema";
import type {
  CashFigures,
  DepotGallonFigures,
  DiscrepancyAwaiting,
  ExceptionFigures,
  GallonFigures,
  ReceivableFigures,
  RevenueFigures,
  TripFigures,
  TruckTripFigures,
} from "@/client/m9-reports/types";
import { label } from "@/lib/labels";
import { addDays, businessDateToUtcRange, daysBetween, toBusinessDate, type BusinessDate } from "@/lib/time";

import { systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import * as m4 from "@/server/modules/m4-cash";
import * as m6 from "@/server/modules/m6-pos";
import * as m8 from "@/server/modules/m8-production";
import * as m12 from "@/server/modules/m12-fleet";

// =====================================================================================================================
// Utilitas tanggal
// =====================================================================================================================

/** Semua tanggal bisnis dalam rentang (inklusif). */
export function datesInRange(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function emptyRevenue(): RevenueFigures {
  return {
    L2: { amount: 0, trips: 0 },
    L3: { amount: 0, transactions: 0 },
    L4: { amount: 0, transactions: 0 },
    external: 0,
    internal: { truckToDepot: { amount: 0, trips: 0, liters: 0 }, storeToDepot: { amount: 0, transfers: 0 } },
  };
}

/** Jumlahkan beberapa angka omzet (rentang = Σ harian; definisi sama). */
export function sumRevenue(list: readonly RevenueFigures[]): RevenueFigures {
  const out = emptyRevenue();
  for (const r of list) {
    out.L2.amount += r.L2.amount;
    out.L2.trips += r.L2.trips;
    out.L3.amount += r.L3.amount;
    out.L3.transactions += r.L3.transactions;
    out.L4.amount += r.L4.amount;
    out.L4.transactions += r.L4.transactions;
    out.internal.truckToDepot.amount += r.internal.truckToDepot.amount;
    out.internal.truckToDepot.trips += r.internal.truckToDepot.trips;
    out.internal.truckToDepot.liters += r.internal.truckToDepot.liters;
    out.internal.storeToDepot.amount += r.internal.storeToDepot.amount;
    out.internal.storeToDepot.transfers += r.internal.storeToDepot.transfers;
  }
  out.external = out.L2.amount + out.L3.amount + out.L4.amount;
  return out;
}

// =====================================================================================================================
// Omzet per lini (BR-33)
// =====================================================================================================================

/** Jenis outlet (depot/toko) per outlet tenant — untuk memisah L3/L4. */
export async function outletKinds(tx: Tx, tenantId: string): Promise<Map<string, { kind: string; code: string; name: string }>> {
  const rows = await tx.select({ id: outlets.id, kind: outlets.kind, code: outlets.code, name: outlets.name }).from(outlets).where(eq(outlets.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, { kind: r.kind, code: r.code, name: r.name }]));
}

/** Omzet per lini per tanggal bisnis. Rentang = gabungan harian (satu definisi). */
export async function revenueDaily(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<Map<BusinessDate, RevenueFigures>> {
  const out = new Map<BusinessDate, RevenueFigures>();
  const at = (d: BusinessDate) => {
    let r = out.get(d);
    if (!r) {
      r = emptyRevenue();
      out.set(d, r);
    }
    return r;
  };
  const tripRows = await tx
    .select({
      date: trips.completionBusinessDate,
      isInternal: trips.isInternal,
      count: sql<string>`count(*)`,
      amount: sql<string>`coalesce(sum(${trips.price}), 0)`,
      liters: sql<string>`coalesce(sum(coalesce(${trips.deliveredVolumeL}, ${trips.plannedVolumeL})), 0)`,
    })
    .from(trips)
    .where(and(eq(trips.tenantId, tenantId), eq(trips.status, "completed"), gte(trips.completionBusinessDate, from), lte(trips.completionBusinessDate, to)))
    .groupBy(trips.completionBusinessDate, trips.isInternal);
  for (const r of tripRows) {
    if (!r.date) continue;
    const f = at(r.date);
    if (r.isInternal) {
      f.internal.truckToDepot.amount += num(r.amount);
      f.internal.truckToDepot.trips += num(r.count);
      f.internal.truckToDepot.liters += num(r.liters);
    } else {
      f.L2.amount += num(r.amount);
      f.L2.trips += num(r.count);
    }
  }
  const kinds = await outletKinds(tx, tenantId);
  // Omzet & transaksi saja — galon dihitung `gallonsDaily`.
  const sales = await m6.salesAggregates(tx, tenantId, { from, to, withGallons: false });
  for (const s of sales) {
    const kind = kinds.get(s.outletId)?.kind;
    const f = at(s.businessDate);
    if (kind === "store") {
      f.L4.amount += s.salesTotal;
      f.L4.transactions += s.transactions;
    } else {
      f.L3.amount += s.salesTotal;
      f.L3.transactions += s.transactions;
    }
  }
  const transfers = await tx.execute<{ d: string; n: string; amount: string }>(sql`
    select business_date as d, count(*) filter (where reversal_of_id is null) as n,
      coalesce(sum(case when reversal_of_id is null then total_value else -abs(total_value) end), 0) as amount
    from internal_transfers
    where tenant_id = ${tenantId} and business_date >= ${from} and business_date <= ${to}
    group by business_date`);
  for (const r of transfers.rows) {
    const f = at(String(r.d));
    f.internal.storeToDepot.amount += num(r.amount);
    f.internal.storeToDepot.transfers += num(r.n);
  }
  for (const f of out.values()) f.external = f.L2.amount + f.L3.amount + f.L4.amount;
  return out;
}

/** Omzet per lini untuk rentang (Σ harian). */
export async function revenueForRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<RevenueFigures> {
  return sumRevenue([...(await revenueDaily(tx, tenantId, from, to)).values()]);
}

// =====================================================================================================================
// Rit per truk (KPI-07)
// =====================================================================================================================

export type TripDayRow = TruckTripFigures & { date: BusinessDate };

/** Rit per truk per tanggal jadwal: terjadwal (terbit) / selesai / gagal / berjalan; internal dipisah. */
export async function tripsDaily(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<TripDayRow[]> {
  const scheduledCond = sql`(${trips.publishedAt} is not null and (${trips.withdrawnAt} is null or ${trips.status} in ('departed','arrived','completed','failed')))`;
  const rows = await tx
    .select({
      date: trips.scheduledDate,
      truckId: trips.truckId,
      truckCode: trucks.code,
      scheduled: sql<string>`count(*) filter (where ${scheduledCond})`,
      completed: sql<string>`count(*) filter (where ${trips.status} = 'completed')`,
      failed: sql<string>`count(*) filter (where ${trips.status} = 'failed')`,
      running: sql<string>`count(*) filter (where ${trips.status} in ('departed','arrived'))`,
      internalScheduled: sql<string>`count(*) filter (where ${scheduledCond} and ${trips.isInternal})`,
      internalCompleted: sql<string>`count(*) filter (where ${trips.status} = 'completed' and ${trips.isInternal})`,
    })
    .from(trips)
    .innerJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(trips.tenantId, tenantId), isNotNull(trips.truckId), gte(trips.scheduledDate, from), lte(trips.scheduledDate, to)))
    .groupBy(trips.scheduledDate, trips.truckId, trucks.code);
  return rows
    .map((r) => ({
      date: r.date,
      truckId: r.truckId!,
      truckCode: r.truckCode,
      scheduled: num(r.scheduled),
      completed: num(r.completed),
      failed: num(r.failed),
      running: num(r.running),
      internalScheduled: num(r.internalScheduled),
      internalCompleted: num(r.internalCompleted),
    }))
    .filter((r) => r.scheduled + r.completed + r.failed + r.running > 0);
}

/** Gabungkan baris rit harian menjadi per truk (rentang). */
export function sumTrips(rows: readonly (TruckTripFigures | TripDayRow)[]): TripFigures {
  const byTruck = new Map<string, TruckTripFigures>();
  for (const r of rows) {
    const cur = byTruck.get(r.truckId) ?? {
      truckId: r.truckId,
      truckCode: r.truckCode,
      scheduled: 0,
      completed: 0,
      failed: 0,
      running: 0,
      internalScheduled: 0,
      internalCompleted: 0,
    };
    cur.scheduled += r.scheduled;
    cur.completed += r.completed;
    cur.failed += r.failed;
    cur.running += r.running;
    cur.internalScheduled += r.internalScheduled;
    cur.internalCompleted += r.internalCompleted;
    byTruck.set(r.truckId, cur);
  }
  const list = [...byTruck.values()].sort((a, b) => a.truckCode.localeCompare(b.truckCode, "id"));
  const totals = { scheduled: 0, completed: 0, failed: 0, running: 0, internalScheduled: 0, internalCompleted: 0 };
  for (const t of list) {
    totals.scheduled += t.scheduled;
    totals.completed += t.completed;
    totals.failed += t.failed;
    totals.running += t.running;
    totals.internalScheduled += t.internalScheduled;
    totals.internalCompleted += t.internalCompleted;
  }
  return { byTruck: list, totals };
}

export async function tripsForRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<TripFigures> {
  return sumTrips(await tripsDaily(tx, tenantId, from, to));
}

// =====================================================================================================================
// Galon per depot
// =====================================================================================================================

export type GallonDayRow = DepotGallonFigures & { date: BusinessDate };

export async function gallonsDaily(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<GallonDayRow[]> {
  const kinds = await outletKinds(tx, tenantId);
  const sales = await m6.salesAggregates(tx, tenantId, { from, to });
  return sales
    .filter((s) => kinds.get(s.outletId)?.kind === "depot")
    .map((s) => ({
      date: s.businessDate,
      outletId: s.outletId,
      code: kinds.get(s.outletId)!.code,
      name: kinds.get(s.outletId)!.name,
      gallons: s.gallons,
      liters: s.gallonLiters,
      transactions: s.transactions,
      sales: s.salesTotal,
    }));
}

export function sumGallons(rows: readonly DepotGallonFigures[]): GallonFigures {
  const byDepot = new Map<string, DepotGallonFigures>();
  for (const r of rows) {
    const cur = byDepot.get(r.outletId) ?? { outletId: r.outletId, code: r.code, name: r.name, gallons: 0, liters: 0, transactions: 0, sales: 0 };
    cur.gallons += r.gallons;
    cur.liters += r.liters;
    cur.transactions += r.transactions;
    cur.sales += r.sales;
    byDepot.set(r.outletId, cur);
  }
  const list = [...byDepot.values()].sort((a, b) => a.code.localeCompare(b.code, "id"));
  return { byDepot: list, total: list.reduce((s, d) => s + d.gallons, 0), liters: list.reduce((s, d) => s + d.liters, 0) };
}

export async function gallonsForRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<GallonFigures> {
  return sumGallons(await gallonsDaily(tx, tenantId, from, to));
}

// =====================================================================================================================
// Piutang (definisi M5; KPI-04)
// =====================================================================================================================

/** Sasaran KPI-04 dari aturan piutang M5 (satu sumber target). */
export async function kpi04TargetPercent(tx: Tx, tenantId: string, date: BusinessDate): Promise<number> {
  const rules = await params.get(tx, "m5.receivable_rules", date, { tenantId });
  return Number(rules.kpi04_target_percent);
}

/**
 * Saldo & lewat tempo piutang pada AKHIR tanggal `date` (as-of): faktur terbit ≤ tanggal − alokasi pelunasan/uang muka
 * s.d. akhir hari − nota kredit terbit ≤ tanggal − penghapusan s.d. akhir hari, ditambah rit belum ditagih. Untuk hari
 * ini hasilnya sama dengan sisa faktur M5 saat ini.
 */
export async function receivablesAsOf(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ balance: number; overdue: number; overduePct: number }> {
  const { end } = businessDateToUtcRange(date);
  const res = await tx.execute<{ balance: string; overdue: string }>(sql`
    with a as (
      select invoice_id, sum(amount) as paid from payment_allocations
      where credit_note_id is null and allocated_at < ${end}
      group by invoice_id
    ), c as (
      select invoice_id, sum(amount) as credited from credit_notes
      where status = 'issued' and issue_date <= ${date}
      group by invoice_id
    ), inv as (
      select i.due_date,
        greatest(0, i.amount - coalesce(a.paid, 0) - coalesce(c.credited, 0)
          - case when i.written_off_at is not null and i.written_off_at < ${end} then i.written_off_amount else 0 end) as outstanding
      from invoices i
      left join a on a.invoice_id = i.id
      left join c on c.invoice_id = i.id
      where i.tenant_id = ${tenantId} and i.issue_date <= ${date}
    )
    select coalesce(sum(outstanding), 0) as balance,
      coalesce(sum(outstanding) filter (where due_date < ${date}), 0) as overdue
    from inv`);
  const unbilled = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(u.amount), 0) as total
    from unbilled_charges u
    left join invoices i on i.id = u.invoice_id
    where u.tenant_id = ${tenantId} and u.service_date <= ${date}
      and (u.status = 'unbilled' or (u.invoice_id is not null and i.issue_date > ${date}))`);
  const balance = num(res.rows[0]?.balance) + num(unbilled.rows[0]?.total);
  const overdue = num(res.rows[0]?.overdue);
  return { balance, overdue, overduePct: balance === 0 ? 0 : Math.round((overdue / balance) * 10_000) / 100 };
}

/** Piutang terbentuk & dilunasi PER TANGGAL (faktur non-bulanan & non-saldo awal + rit belum ditagih; alokasi pelunasan). */
export async function receivablesFlowDaily(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<Map<BusinessDate, { formed: number; paid: number }>> {
  const start = businessDateToUtcRange(from).start;
  const end = businessDateToUtcRange(to).end;
  const out = new Map<BusinessDate, { formed: number; paid: number }>();
  const at = (d: string) => {
    let v = out.get(d);
    if (!v) {
      v = { formed: 0, paid: 0 };
      out.set(d, v);
    }
    return v;
  };
  const formed = await tx.execute<{ d: string; total: string }>(sql`
    select issue_date as d, coalesce(sum(amount), 0) as total from invoices
    where tenant_id = ${tenantId} and issue_date >= ${from} and issue_date <= ${to}
      and kind not in ('monthly', 'opening_balance') and is_opening_balance = false
    group by issue_date`);
  for (const r of formed.rows) at(String(r.d)).formed += num(r.total);
  const unbilled = await tx.execute<{ d: string; total: string }>(sql`
    select service_date as d, coalesce(sum(amount), 0) as total from unbilled_charges
    where tenant_id = ${tenantId} and service_date >= ${from} and service_date <= ${to}
    group by service_date`);
  for (const r of unbilled.rows) at(String(r.d)).formed += num(r.total);
  const paid = await tx.execute<{ d: string; total: string }>(sql`
    select to_char(pa.allocated_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD') as d, coalesce(sum(pa.amount), 0) as total
    from payment_allocations pa
    join invoices i on i.id = pa.invoice_id
    where i.tenant_id = ${tenantId} and pa.credit_note_id is null and pa.allocated_at >= ${start} and pa.allocated_at < ${end}
    group by 1`);
  for (const r of paid.rows) at(String(r.d)).paid += num(r.total);
  return out;
}

/** Piutang terbentuk & dilunasi dalam rentang (Σ harian). */
export async function receivablesFlow(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<{ formed: number; paid: number }> {
  let formed = 0;
  let paid = 0;
  for (const v of (await receivablesFlowDaily(tx, tenantId, from, to)).values()) {
    formed += v.formed;
    paid += v.paid;
  }
  return { formed, paid };
}

export async function receivablesForRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate): Promise<ReceivableFigures> {
  const [asOf, flow, targetPct] = await Promise.all([receivablesAsOf(tx, tenantId, to), receivablesFlow(tx, tenantId, from, to), kpi04TargetPercent(tx, tenantId, to)]);
  return { balance: asOf.balance, overdue: asOf.overdue, overduePct: asOf.overduePct, formed: flow.formed, paid: flow.paid, targetPct };
}

// =====================================================================================================================
// Kas (definisi M4)
// =====================================================================================================================

/** Kas seharusnya vs diterima vs selisih satu hari (posisi kas M4). */
export async function cashForDay(tx: Tx, ctx: ActorContext, date: BusinessDate): Promise<CashFigures & { rows: m4.CashSourceRow[] }> {
  const pos = await m4.buildCashPosition(tx, ctx, date);
  const [cd] = await tx.execute<{ closed_at: Date | string | null; last: Date | string | null }>(sql`
    select closed_at, last_deposit_received_at as last from cash_days where tenant_id = ${ctx.tenantId} and business_date = ${date} limit 1`).then((r) => r.rows);
  const closedAt = cd?.closed_at ? new Date(cd.closed_at) : null;
  const last = cd?.last ? new Date(cd.last) : null;
  const office = pos.totals.find((t) => t.line === "office");
  const officeRow = pos.rows.find((r) => r.line === "office");
  return {
    expected: pos.overall.expected,
    received: pos.overall.received,
    discrepancy: pos.overall.discrepancy,
    unmatchedTransfers: pos.overall.unmatchedTransfers,
    byLine: pos.totals.map((t) => ({ line: t.line, label: t.label, expected: t.expected, received: t.received, discrepancy: t.discrepancy, count: t.count })),
    office: {
      system: office ? office.expected : null,
      physical: officeRow?.received ?? null,
      difference: officeRow?.discrepancy ?? null,
    },
    cashDayStatus: pos.cashDayStatus,
    kpi02Minutes: closedAt && last ? Math.max(0, Math.round((closedAt.getTime() - last.getTime()) / 60_000)) : null,
    rows: pos.rows,
  };
}

/** Jumlahkan angka kas beberapa hari (rentang = Σ harian). */
export function sumCash(list: readonly CashFigures[]): CashFigures {
  const lines = new Map<string, CashFigures["byLine"][number]>();
  let expected = 0;
  let received = 0;
  let discrepancy = 0;
  let unmatched = 0;
  for (const c of list) {
    expected += c.expected;
    received += c.received;
    discrepancy += c.discrepancy;
    unmatched = Math.max(unmatched, c.unmatchedTransfers);
    for (const l of c.byLine) {
      const cur = lines.get(l.line) ?? { ...l, expected: 0, received: 0, discrepancy: 0, count: 0 };
      cur.expected += l.expected;
      cur.received += l.received;
      cur.discrepancy += l.discrepancy;
      cur.count = Math.max(cur.count, l.count);
      lines.set(l.line, cur);
    }
  }
  return {
    expected,
    received,
    discrepancy,
    unmatchedTransfers: unmatched,
    byLine: [...lines.values()],
    office: { system: null, physical: null, difference: null },
    cashDayStatus: list.every((c) => c.cashDayStatus === "closed") ? "closed" : "open",
    kpi02Minutes: null,
  };
}

// =====================================================================================================================
// Pengecualian menunggu keputusan
// =====================================================================================================================

/** Batas tindak lanjut selisih (jam) dari aturan kas M4 — dasar KPI-03. */
export async function discrepancyFollowUpHours(tx: Tx, tenantId: string, date: BusinessDate, opts: { cache?: params.ParamCache } = {}): Promise<number> {
  const rules = opts.cache ? await opts.cache.get("m4.cash_rules", date, { tenantId }) : await params.get(tx, "m4.cash_rules", date, { tenantId });
  return Number((rules as { discrepancy_follow_up_hours?: number }).discrepancy_follow_up_hours ?? 24);
}

/** Selisih yang menunggu keputusan pemilik (≥ ambang / pengunci rit) — aksi satu ketuk H+0 & kotak masuk. */
export async function discrepanciesAwaitingOwner(
  tx: Tx,
  tenantId: string,
  now: Date,
  filter: { date?: BusinessDate | null } = {},
  opts: { cache?: params.ParamCache } = {},
): Promise<DiscrepancyAwaiting[]> {
  const hours = await discrepancyFollowUpHours(tx, tenantId, toBusinessDate(now), opts);
  const conds = [
    eq(discrepancies.tenantId, tenantId),
    eq(discrepancies.requiresOwnerDecision, true),
    sql`${discrepancies.decision} is null`,
    inArray(discrepancies.status, ["formed", "explained"]),
  ];
  if (filter.date) conds.push(eq(discrepancies.businessDate, filter.date));
  const rows = await tx
    .select({ d: discrepancies, depositNumber: deposits.number, personName: employees.fullName })
    .from(discrepancies)
    .leftJoin(deposits, eq(deposits.id, discrepancies.depositId))
    .leftJoin(employees, eq(employees.id, discrepancies.employeeId))
    .where(and(...conds))
    .orderBy(asc(discrepancies.createdAt));
  const outletRows = await outletKinds(tx, tenantId);
  return rows.map(({ d, depositNumber, personName }) => ({
    id: d.id,
    amount: d.amount,
    sourceLabel: `${label("discrepancy_source", d.source)}${d.outletId && outletRows.get(d.outletId) ? ` ${outletRows.get(d.outletId)!.code}` : ""}`,
    personName: personName ?? null,
    depositId: d.depositId,
    depositNumber: depositNumber ?? null,
    businessDate: d.businessDate,
    explanation: d.explanation ?? d.reasonNote ?? (d.reason ? label("discrepancy_reason", d.reason) : null),
    approvalId: d.approvalRequestId,
    overdue: now.getTime() - d.createdAt.getTime() > hours * 3_600_000,
    createdAt: d.createdAt.toISOString(),
  }));
}

/**
 * Pengecualian (blok 6 H+0) untuk rentang tanggal (satu hari = rentang satu tanggal): persetujuan & selisih yang
 * MENUNGGU keputusan pemilik saat ini, rit gagal, kejadian GPS (ringkasan H+0 M12 per hari), susut air, utilisasi
 * sumber > PAR-19 (M8), produksi belum lengkap, transfer belum dicocokkan.
 */
export async function exceptionsForRange(
  tx: Tx,
  tenantId: string,
  from: BusinessDate,
  to: BusinessDate,
  now: Date,
  unmatchedTransfers: number,
  opts: { cache?: params.ParamCache } = {},
): Promise<ExceptionFigures> {
  const approvals = await tx
    .select({ deadlineAt: approvalRequests.deadlineAt, overdueAt: approvalRequests.overdueAt, type: approvalRequests.type })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.status, "submitted"), eq(approvalRequests.approverRole, "owner")));
  const approvalsOverdue = approvals.filter((a) => a.overdueAt || (a.deadlineAt && a.deadlineAt <= now)).length;
  const discs = await discrepanciesAwaitingOwner(tx, tenantId, now, {}, { cache: opts.cache });
  const failed = await tx
    .select({ id: trips.id, number: trips.number, truckCode: trucks.code, customerName: customers.name, reason: trips.failReason })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .where(and(eq(trips.tenantId, tenantId), eq(trips.status, "failed"), gte(trips.completionBusinessDate, from), lte(trips.completionBusinessDate, to)))
    .orderBy(asc(trips.number));
  const fleet: ExceptionFigures["fleet"] = { offSchedule: 0, unknownStops: 0, deviationsL2: 0, inconsistent: 0, geofenceFlags: 0, awaitingReview: 0, unexplained: 0, deviceOutages: [] };
  const outages = new Map<string, number>();
  // v1.0.1 (D-14 butir 4, B-90): ringkasan armada versi rentang — kueri tetap per rentang (sebelumnya ±16 kueri per
  // hari, 412 di antaranya pembacaan parameter pada rentang sebulan). Per tanggal identik dengan `fleetDaySummary`.
  for (const f of await m12.fleetRangeSummary(tx, tenantId, from, to, now, { cache: opts.cache })) {
    fleet.offSchedule += f.counts.offSchedule;
    fleet.unknownStops += f.counts.unknownStops;
    fleet.deviationsL2 += f.counts.deviationsL2;
    fleet.inconsistent += f.counts.inconsistent;
    fleet.geofenceFlags += f.counts.geofenceFlags;
    fleet.awaitingReview += f.counts.awaitingReview;
    fleet.unexplained += f.unexplained.length;
    for (const o of f.deviceOutages) outages.set(o.truckCode, (outages.get(o.truckCode) ?? 0) + o.minutes);
  }
  fleet.deviceOutages = [...outages.entries()].map(([truckCode, minutes]) => ({ truckCode, minutes })).sort((a, b) => b.minutes - a.minutes);
  const loss = await tx
    .select({ code: waterSources.code, status: waterBalances.status, lossPct: waterBalances.lossPct, date: waterBalances.businessDate })
    .from(waterBalances)
    .innerJoin(waterSources, eq(waterSources.id, waterBalances.waterSourceId))
    .where(
      and(
        eq(waterBalances.tenantId, tenantId),
        gte(waterBalances.businessDate, from),
        lte(waterBalances.businessDate, to),
        inArray(waterBalances.status, ["over_threshold", "investigating", "negative_anomaly"]),
      ),
    )
    .orderBy(asc(waterBalances.businessDate), asc(waterSources.code));
  const util = (await m8.computeUtilizationDays(tx, tenantId, from, to)).filter((u) => u.high && u.sourceId);
  const incomplete = await tx
    .select({ code: waterSources.code, date: dailyProductions.businessDate })
    .from(dailyProductions)
    .innerJoin(waterSources, eq(waterSources.id, dailyProductions.waterSourceId))
    .where(and(eq(dailyProductions.tenantId, tenantId), gte(dailyProductions.businessDate, from), lte(dailyProductions.businessDate, to), eq(dailyProductions.status, "incomplete")));
  const result: ExceptionFigures = {
    approvalsPending: approvals.filter((a) => a.type !== "cash_discrepancy").length,
    approvalsOverdue,
    discrepancies: discs,
    failedTrips: failed.map((f) => ({ id: f.id, number: f.number, truckCode: f.truckCode ?? null, customerName: f.customerName, reason: f.reason ? label("trip_fail_reason", f.reason) : null })),
    fleet,
    water: {
      lossFlags: loss.map((l) => ({ sourceCode: l.code, status: l.status, lossPct: l.lossPct, date: l.date })),
      utilizationHigh: util.map((u) => ({ sourceCode: u.sourceCode, utilizationPct: u.utilizationPct, date: u.businessDate })),
      productionIncomplete: incomplete.map((p) => ({ sourceCode: p.code, date: p.date })),
    },
    unmatchedTransfers,
    total: 0,
  };
  result.total =
    result.approvalsPending + result.discrepancies.length + result.failedTrips.length + result.fleet.awaitingReview + result.fleet.unexplained + result.water.lossFlags.length;
  return result;
}

// =====================================================================================================================
// Pembantu nama
// =====================================================================================================================

/** Nama karyawan per pengguna. */
export async function userNames(tx: Tx, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: users.id, name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Konteks sistem untuk menghitung angka atas nama tenant (job/handler). */
export function metricsContext(tenantId: string, now: Date): ActorContext {
  return systemContext({ tenantId, now });
}
