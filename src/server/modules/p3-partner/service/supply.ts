/**
 * P3 — pasokan air mitra & neraca air per mitra (RL-7 US-P3-08; FR-M6-05, FR-M6-07, BRD 9.9, NFR-30).
 *
 * - KP-1: pesanan air mitra = pesanan M2 biasa untuk pelanggan mitra (segmen depot pihak ketiga + penanda mitra depot
 *   EQUA) dengan harga zona Opsi B; P3 hanya menandai tenggat SLA (`orders.sla_due_at`, PAR-76) lewat `order.created`.
 * - KP-2: rit pelanggan mitra Selesai (event `trip.completed` M3) → pasokan "Tiba" di POS outlet mitra
 *   (`water_supply_receipts`, tenant mitra, idempoten per rit). Operator mitra mengonfirmasi lewat perintah POS yang
 *   sama dengan depot EQUA (`m6.water_supply.confirm`, US-M6-05 KP-1–2); selisih kirim–terima → Dispatcher EQUA.
 * - KP-3: neraca air per mitra per bulan = galon terjual × ukuran galon (19 L) vs air diterima dari EQUA, rumus sama
 *   dengan US-M6-05 KP-4 (`waterPeriodBalance` M6) tetapi air tersedia hanya dari truk EQUA; > PAR-79 → pemilik.
 * - KP-4: pesanan air mitra belum Selesai > PAR-76 jam sejak dibuat → Dispatcher & pemilik (job 5 menit).
 * - KP-5: EQUA hanya membaca data yang diperjanjikan (agregat penjualan, pasokan, neraca air) lewat fungsi di bawah —
 *   tidak ada akses ke pengguna, kas/setoran, atau transaksi mentah mitra dari layar EQUA.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";

import { customers, orders, outletWaterLedger, outlets, posSales, trips, waterSupplyReceipts } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { addDays, lastDayOfMonth, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny } from "@/server/core/rbac";
import { salesAggregates, waterPeriodBalance } from "@/server/modules/m6-pos";

import {
  assertOwnerTenant,
  isValidMonth,
  loadPartnerTenant,
  monthKey,
  monthRange,
  notifyOnce,
  ownerTenantId,
  partnerCustomersOf,
  partnerTenants,
  tenantOutlets,
  type OutletRow,
  type TenantRow,
} from "./common";

export type WaterSupplyRow = typeof waterSupplyReceipts.$inferSelect;

// =====================================================================================================================
// KP-1 / KP-4: tenggat SLA pesanan air mitra
// =====================================================================================================================

/** Handler `order.created` (M2): pesanan air pelanggan mitra → `sla_due_at` = dibuat + PAR-76 jam. */
export async function markPartnerOrderSla(tx: Tx, event: DomainEvent<"order.created">): Promise<boolean> {
  const p = event.payload;
  if (p.isInternal) return false;
  const [c] = await tx.select({ isEquaPartner: customers.isEquaPartner }).from(customers).where(eq(customers.id, p.customerId)).limit(1);
  if (!c?.isEquaPartner) return false;
  const [o] = await tx.select({ createdAt: orders.createdAt, slaDueAt: orders.slaDueAt }).from(orders).where(eq(orders.id, p.orderId)).limit(1);
  if (!o || o.slaDueAt) return false;
  const created = o.createdAt ?? event.occurredAt;
  const sla = await params.get(tx, "PAR-76", toBusinessDate(created));
  await tx
    .update(orders)
    .set({ slaDueAt: new Date(created.getTime() + sla.water_delivery_hours * 3_600_000) })
    .where(eq(orders.id, p.orderId));
  return true;
}

export type WaterOrderSlaResult = { checked: number; flagged: string[] };

/**
 * Job SLA (US-P3-08 KP-4, 6.3 "Pesanan air mitra lewat SLA"): pesanan air mitra yang belum Selesai/Dibatalkan
 * > PAR-76 jam sejak dibuat → notifikasi Dispatcher & pemilik (sekali per pesanan).
 */
export async function runWaterOrderSlaCheck(now: Date, db?: Db): Promise<WaterOrderSlaResult> {
  return withTx(
    async (tx) => {
      const today = toBusinessDate(now);
      const sla = await params.get(tx, "PAR-76", today);
      const rows = await tx
        .select({ order: orders, customerName: customers.name })
        .from(orders)
        .innerJoin(customers, eq(customers.id, orders.customerId))
        .where(and(eq(customers.isEquaPartner, true), notInArray(orders.status, ["completed", "cancelled"])))
        .orderBy(asc(orders.createdAt));
      const flagged: string[] = [];
      for (const { order, customerName } of rows) {
        const due = order.slaDueAt ?? new Date(order.createdAt.getTime() + sla.water_delivery_hours * 3_600_000);
        if (due.getTime() >= now.getTime()) continue;
        const lateHours = Math.floor((now.getTime() - order.createdAt.getTime()) / 3_600_000);
        const sent = await notifyOnce(tx, {
          event: "partner.water_order_sla",
          tenantId: order.tenantId,
          title: `Pesanan air mitra ${order.number} lewat SLA ${sla.water_delivery_hours} jam`,
          body: `${customerName}: ${order.tankCount} tangki, dibuat ${lateHours} jam lalu, status ${order.status}. Jadwalkan segera (PAR-76).`,
          objectType: "order",
          objectId: order.id,
          valueText: `${lateHours} jam`,
          link: `/pesanan/${order.id}`,
          groupKey: `partner.water_order_sla:${order.id}`,
          now,
        });
        if (sent) flagged.push(order.id);
      }
      return { checked: rows.length, flagged };
    },
    db ? { db } : {},
  );
}

// =====================================================================================================================
// KP-2: pasokan tiba di POS mitra
// =====================================================================================================================

/**
 * Handler `trip.completed` (M3): rit pelanggan mitra Selesai → pasokan "Tiba" di POS outlet mitra. Idempoten per rit
 * (indeks unik `water_supply_receipts_trip_uq`). Rit internal EQUA ditangani M6 (`recordSupplyArrival`).
 */
export async function recordPartnerSupplyArrival(tx: Tx, event: DomainEvent<"trip.completed">): Promise<WaterSupplyRow | null> {
  const p = event.payload;
  if (p.isInternal) return null;
  const [c] = await tx
    .select({ isEquaPartner: customers.isEquaPartner, partnerTenantId: customers.partnerTenantId, partnerOutletId: customers.partnerOutletId })
    .from(customers)
    .where(eq(customers.id, p.customerId))
    .limit(1);
  if (!c?.isEquaPartner || !c.partnerTenantId || !c.partnerOutletId) return null;
  const [outlet] = await tx.select().from(outlets).where(eq(outlets.id, c.partnerOutletId)).limit(1);
  if (!outlet || outlet.tenantId !== c.partnerTenantId || outlet.kind !== "depot") return null;
  const existing = await tx.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, p.tripId)).limit(1);
  if (existing[0]) return existing[0];
  const completedAt = new Date(p.completedAt);
  const businessDate = p.businessDate ?? event.businessDate ?? toBusinessDate(completedAt);
  const [row] = await tx
    .insert(waterSupplyReceipts)
    .values({
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      source: "equa_truck",
      tripId: p.tripId,
      status: "arrived",
      deliveredVolumeL: p.volumeL,
      businessDate,
      createdAt: completedAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await auditRecord(tx, {
    ctx: systemContext({ tenantId: outlet.tenantId, now: completedAt }),
    objectType: "water_supply_receipt",
    objectId: row.id,
    action: "create",
    after: { status: "arrived", tripId: p.tripId, tripNumber: p.tripNumber ?? null, deliveredVolumeL: p.volumeL, outletId: outlet.id },
    rule: "US-P3-08 KP-2",
    businessDate,
  });
  return row;
}

/**
 * Handler `water_supply.confirmed` (M6, tenant mitra): selisih kirim–terima pasokan mitra → Dispatcher EQUA (M6 hanya
 * memberi tahu dispatcher di tenant mitra, yang tidak ada). US-P3-08 KP-2.
 */
export async function flagPartnerSupplyDifference(tx: Tx, event: DomainEvent<"water_supply.confirmed">): Promise<boolean> {
  const p = event.payload;
  const diff = p.differenceL ?? p.volumeReceivedL - p.volumeSentL;
  if (!p.tripId || diff === 0) return false;
  const [outlet] = await tx.select().from(outlets).where(eq(outlets.id, p.outletId)).limit(1);
  if (!outlet) return false;
  const tenant = await loadPartnerTenant(tx, outlet.tenantId).catch(() => null);
  if (!tenant) return false;
  const [trip] = await tx.select({ number: trips.number, tenantId: trips.tenantId }).from(trips).where(eq(trips.id, p.tripId)).limit(1);
  const equaTenant = trip?.tenantId ?? (await ownerTenantId(tx));
  await notify(tx, {
    event: "water_supply.discrepancy",
    tenantId: equaTenant,
    title: `Selisih pasokan air mitra ${tenant.name} · ${outlet.name}: ${diff > 0 ? "+" : ""}${diff} L`,
    body: `Rit ${trip?.number ?? "-"}: sopir mencatat ${p.volumeSentL} L, operator mitra menerima ${p.volumeReceivedL} L. Alasan: ${p.differenceReason ?? "-"}`,
    objectType: "water_supply_receipt",
    objectId: p.waterSupplyReceiptId,
    valueText: `${diff} L`,
    link: `/kemitraan/pasokan?mitra=${tenant.id}`,
    now: event.occurredAt,
  });
  return true;
}

// =====================================================================================================================
// KP-3: neraca air per mitra per bulan
// =====================================================================================================================

export type PartnerWaterBalanceRow = {
  tenantId: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  month: string;
  openingL: number;
  /** Air diterima dari truk EQUA (dikonfirmasi/diterima otomatis). */
  receivedFromEquaL: number;
  /** Pasokan sumber lain yang dicatat mitra sendiri (US-M6-05 KP-6). */
  otherSourceL: number;
  adjustmentL: number;
  /** Galon terjual × ukuran galon (19 L). */
  soldL: number;
  gallonsSold: number;
  availableL: number;
  excessL: number;
  excessPct: number;
  tolerancePct: number;
  exceeded: boolean;
};

/** Neraca air mitra per outlet per bulan (US-P3-08 KP-3). Tanpa otorisasi (dipanggil layanan terotorisasi/job). */
export async function partnerWaterBalance(tx: Tx, tenantId: string, month: string): Promise<PartnerWaterBalanceRow[]> {
  const { from, to } = monthRange(month);
  const list = (await tenantOutlets(tx, tenantId, { depotOnly: true })).filter((o) => o.isActive || (o.deactivatedAt && toBusinessDate(o.deactivatedAt) >= from));
  if (!list.length) return [];
  const ids = list.map((o) => o.id);
  const sales = await salesAggregates(tx, tenantId, { from, to, outletIds: ids });
  const other = await tx
    .select({ outletId: outletWaterLedger.outletId, total: sql<string>`coalesce(sum(${outletWaterLedger.volumeL}), 0)` })
    .from(outletWaterLedger)
    .innerJoin(waterSupplyReceipts, and(eq(outletWaterLedger.sourceObjectType, "water_supply_receipt"), sql`${outletWaterLedger.sourceObjectId} = ${waterSupplyReceipts.id}`))
    .where(
      and(
        inArray(outletWaterLedger.outletId, ids),
        eq(outletWaterLedger.kind, "supply_in"),
        eq(waterSupplyReceipts.source, "other"),
        gte(outletWaterLedger.businessDate, from),
        lte(outletWaterLedger.businessDate, to),
      ),
    )
    .groupBy(outletWaterLedger.outletId);
  const otherBy = new Map(other.map((r) => [r.outletId, Number(r.total)]));
  const tol = await params.get(tx, "PAR-79", to, { tenantId });
  const out: PartnerWaterBalanceRow[] = [];
  for (const o of list) {
    const bal = await waterPeriodBalance(tx, o.id, from, to);
    const otherL = otherBy.get(o.id) ?? 0;
    // `receivedL` M6 = pasokan masuk + stok awal periode; pisahkan stok awal & sumber lain.
    const openingKind = await tx
      .select({ total: sql<string>`coalesce(sum(${outletWaterLedger.volumeL}), 0)` })
      .from(outletWaterLedger)
      .where(and(eq(outletWaterLedger.outletId, o.id), eq(outletWaterLedger.kind, "opening"), gte(outletWaterLedger.businessDate, from), lte(outletWaterLedger.businessDate, to)));
    const openingInPeriod = Number(openingKind[0]?.total ?? 0);
    const receivedEqua = Math.max(0, bal.receivedL - openingInPeriod - otherL);
    const opening = bal.openingL + openingInPeriod;
    const availableL = Math.max(0, opening) + receivedEqua + Math.max(0, bal.adjustmentL);
    const excessL = Math.max(0, bal.soldL - availableL);
    const excessPct = availableL > 0 ? Math.round((excessL / availableL) * 10_000) / 100 : bal.soldL > 0 ? 100 : 0;
    const gallons = sales.filter((s) => s.outletId === o.id).reduce((s, r) => s + r.gallons, 0);
    out.push({
      tenantId,
      outletId: o.id,
      outletCode: o.code,
      outletName: o.name,
      month,
      openingL: opening,
      receivedFromEquaL: receivedEqua,
      otherSourceL: otherL,
      adjustmentL: bal.adjustmentL,
      soldL: bal.soldL,
      gallonsSold: gallons,
      availableL,
      excessL,
      excessPct,
      tolerancePct: tol.percent,
      exceeded: excessPct > tol.percent,
    });
  }
  return out;
}

/**
 * Job bulanan (tanggal 1): neraca air bulan lalu per mitra; di atas PAR-79 → pemilik (sekali per outlet-bulan).
 * Pemicu sanksi Tahap 3 dicatat modul sanksi bila portal lengkap aktif.
 */
export async function runPartnerWaterBalanceCheck(
  now: Date,
  opts: { db?: Db; month?: string; onExceeded?: (tx: Tx, row: PartnerWaterBalanceRow, tenant: TenantRow) => Promise<void> } = {},
): Promise<{ month: string; checked: number; flagged: string[] }> {
  const today = toBusinessDate(now);
  const month = opts.month ?? monthKey(addDays(`${today.slice(0, 7)}-01`, -1));
  return withTx(
    async (tx) => {
      const equa = await ownerTenantId(tx);
      const flagged: string[] = [];
      let checked = 0;
      for (const tenant of await partnerTenants(tx, { includeInactive: true })) {
        for (const row of await partnerWaterBalance(tx, tenant.id, month)) {
          checked++;
          if (!row.exceeded) continue;
          const sent = await notifyOnce(tx, {
            event: "partner.water_balance_exceeded",
            tenantId: equa,
            title: `Neraca air mitra ${tenant.name} · ${row.outletName} ${month} di luar toleransi`,
            body: `Galon terjual ${row.soldL.toLocaleString("id-ID")} L vs air diterima dari EQUA ${row.receivedFromEquaL.toLocaleString("id-ID")} L (+ stok awal ${row.openingL.toLocaleString("id-ID")} L): kelebihan ${row.excessPct}% > ${row.tolerancePct}% (PAR-79). Kemungkinan sumber lain — periksa pasokan mitra.`,
            objectType: "outlet",
            objectId: row.outletId,
            valueText: `${row.excessPct}%`,
            link: `/kemitraan/pasokan?bulan=${month}&mitra=${tenant.id}`,
            groupKey: `partner.water_balance:${row.outletId}:${month}`,
            now,
          });
          if (sent) {
            flagged.push(row.outletId);
            if (opts.onExceeded) await opts.onExceeded(tx, row, tenant);
          }
        }
      }
      return { month, checked, flagged };
    },
    opts.db ? { db: opts.db } : {},
  );
}

// =====================================================================================================================
// Papan pasokan EQUA (KP-2..KP-5) & riwayat pembelian (US-P3-03 KP-5)
// =====================================================================================================================

export type PartnerSupplyRow = {
  tenant: Pick<TenantRow, "id" | "code" | "name" | "isActive" | "readOnly">;
  outlets: Pick<OutletRow, "id" | "code" | "name">[];
  customers: { id: string; name: string }[];
  orders: { total: number; open: number; late: number; completed: number };
  tripsCompleted: number;
  deliveredL: number;
  receipts: { arrived: number; confirmed: number; discrepancy: number; autoAccepted: number; receivedL: number; differenceL: number };
  sales: { salesTotal: number; gallons: number; transactions: number };
  balance: PartnerWaterBalanceRow[];
  exceeded: boolean;
};

export type PartnerSupplyBoard = { month: string; rows: PartnerSupplyRow[]; lateOrders: LateOrderRow[]; pendingReceipts: PendingReceiptRow[] };
export type LateOrderRow = { orderId: string; number: string; tenantName: string; customerName: string; status: string; createdAt: Date; slaDueAt: Date | null; tankCount: number };
export type PendingReceiptRow = { id: string; tenantName: string; outletName: string; tripNumber: string | null; deliveredVolumeL: number | null; status: string; businessDate: string; receivedVolumeL: number | null; differenceL: number | null; differenceReason: string | null };

/** Papan pasokan & neraca air mitra per bulan (EQUA: pemilik, Admin Keuangan, Dispatcher, pembina). */
export async function supplyBoard(ctx: ActorContext, input: { month?: string | null; tenantId?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<PartnerSupplyBoard> {
  await authorize(ctx, "p3.partner_supply.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const month = isValidMonth(input.month) ? input.month! : monthKey(ctxBusinessDate(ctx));
  const { from, to } = monthRange(month);
  const { start } = { start: new Date(`${from}T00:00:00+07:00`) };
  const end = new Date(`${addDays(to, 1)}T00:00:00+07:00`);
  const sla = await params.get(tx, "PAR-76", ctxBusinessDate(ctx));
  const list = (await partnerTenants(tx, { includeInactive: true })).filter((t) => !input.tenantId || t.id === input.tenantId);
  const rows: PartnerSupplyRow[] = [];
  const lateOrders: LateOrderRow[] = [];
  const pendingReceipts: PendingReceiptRow[] = [];
  for (const tenant of list) {
    const outletRows = await tenantOutlets(tx, tenant.id, { depotOnly: true });
    const cust = await partnerCustomersOf(tx, tenant.id);
    const custIds = cust.map((c) => c.id);
    const ord = custIds.length
      ? await tx
          .select()
          .from(orders)
          .where(and(inArray(orders.customerId, custIds), gte(orders.createdAt, start), sql`${orders.createdAt} < ${end}`))
      : [];
    let late = 0;
    for (const o of ord) {
      const due = o.slaDueAt ?? new Date(o.createdAt.getTime() + sla.water_delivery_hours * 3_600_000);
      const doneAt = o.completedAt ?? (o.status === "cancelled" ? o.cancelledAt : null);
      const isLate = doneAt ? doneAt.getTime() > due.getTime() && o.status !== "cancelled" : ctx.now.getTime() > due.getTime();
      if (isLate) {
        late++;
        lateOrders.push({ orderId: o.id, number: o.number, tenantName: tenant.name, customerName: cust.find((c) => c.id === o.customerId)?.name ?? "-", status: o.status, createdAt: o.createdAt, slaDueAt: due, tankCount: o.tankCount });
      }
    }
    const tripRows = custIds.length
      ? await tx
          .select({ n: sql<string>`count(*)`, l: sql<string>`coalesce(sum(${trips.deliveredVolumeL}), 0)` })
          .from(trips)
          .where(and(inArray(trips.customerId, custIds), eq(trips.status, "completed"), gte(trips.completionBusinessDate, from), lte(trips.completionBusinessDate, to)))
      : [{ n: "0", l: "0" }];
    const receipts = outletRows.length
      ? await tx
          .select()
          .from(waterSupplyReceipts)
          .where(and(eq(waterSupplyReceipts.tenantId, tenant.id), inArray(waterSupplyReceipts.outletId, outletRows.map((o) => o.id)), gte(waterSupplyReceipts.businessDate, from), lte(waterSupplyReceipts.businessDate, to), isNull(waterSupplyReceipts.reversedAt)))
          .orderBy(desc(waterSupplyReceipts.businessDate))
      : [];
    const tripNumbers = new Map<string, string>();
    const tripIds = receipts.map((r) => r.tripId).filter((x): x is string => !!x);
    if (tripIds.length) for (const t of await tx.select({ id: trips.id, number: trips.number }).from(trips).where(inArray(trips.id, tripIds))) tripNumbers.set(t.id, t.number);
    for (const r of receipts) {
      if (r.source !== "equa_truck") continue;
      if (r.status === "arrived" || r.status === "discrepancy") {
        pendingReceipts.push({
          id: r.id,
          tenantName: tenant.name,
          outletName: outletRows.find((o) => o.id === r.outletId)?.name ?? "-",
          tripNumber: r.tripId ? (tripNumbers.get(r.tripId) ?? null) : null,
          deliveredVolumeL: r.deliveredVolumeL,
          status: r.status,
          businessDate: r.businessDate,
          receivedVolumeL: r.receivedVolumeL,
          differenceL: r.differenceL,
          differenceReason: r.differenceReason,
        });
      }
    }
    const equaReceipts = receipts.filter((r) => r.source === "equa_truck");
    const sales = outletRows.length ? await salesAggregates(tx, tenant.id, { from, to, outletIds: outletRows.map((o) => o.id) }) : [];
    const balance = await partnerWaterBalance(tx, tenant.id, month);
    rows.push({
      tenant: { id: tenant.id, code: tenant.code, name: tenant.name, isActive: tenant.isActive, readOnly: tenant.readOnly },
      outlets: outletRows.map((o) => ({ id: o.id, code: o.code, name: o.name })),
      customers: cust.map((c) => ({ id: c.id, name: c.name })),
      orders: { total: ord.length, open: ord.filter((o) => !["completed", "cancelled"].includes(o.status)).length, late, completed: ord.filter((o) => o.status === "completed").length },
      tripsCompleted: Number(tripRows[0]?.n ?? 0),
      deliveredL: Number(tripRows[0]?.l ?? 0),
      receipts: {
        arrived: equaReceipts.filter((r) => r.status === "arrived").length,
        confirmed: equaReceipts.filter((r) => r.status === "confirmed").length,
        discrepancy: equaReceipts.filter((r) => r.status === "discrepancy").length,
        autoAccepted: equaReceipts.filter((r) => r.status === "auto_accepted").length,
        receivedL: equaReceipts.reduce((s, r) => s + (r.receivedVolumeL ?? (r.status === "auto_accepted" ? (r.deliveredVolumeL ?? 0) : 0)), 0),
        differenceL: equaReceipts.reduce((s, r) => s + (r.differenceL ?? 0), 0),
      },
      sales: { salesTotal: sales.reduce((s, r) => s + r.salesTotal, 0), gallons: sales.reduce((s, r) => s + r.gallons, 0), transactions: sales.reduce((s, r) => s + r.transactions, 0) },
      balance,
      exceeded: balance.some((b) => b.exceeded),
    });
  }
  return { month, rows, lateOrders, pendingReceipts };
}

export type PurchaseHistoryRow = { month: string; waterTrips: number; waterL: number; waterAmount: number; sparePartAmount: number; sparePartTransactions: number };

/**
 * Riwayat pembelian air & spare part mitra per bulan (US-P3-03 KP-5; dasar neraca air & evaluasi ekonomi 9.7).
 * Tanpa otorisasi — dipanggil layanan portal (tenant sendiri) & kantor EQUA (terotorisasi).
 */
export async function purchaseHistory(tx: Tx, partnerTenantId: string, input: { from: BusinessDate; to: BusinessDate }): Promise<PurchaseHistoryRow[]> {
  const cust = await partnerCustomersOf(tx, partnerTenantId);
  const ids = cust.map((c) => c.id);
  if (!ids.length) return [];
  const water = await tx
    .select({
      month: sql<string>`substr(${trips.completionBusinessDate}::text, 1, 7)`,
      n: sql<string>`count(*)`,
      l: sql<string>`coalesce(sum(${trips.deliveredVolumeL}), 0)`,
      amount: sql<string>`coalesce(sum(${trips.price}), 0)`,
    })
    .from(trips)
    .where(and(inArray(trips.customerId, ids), eq(trips.status, "completed"), gte(trips.completionBusinessDate, input.from), lte(trips.completionBusinessDate, input.to)))
    .groupBy(sql`1`);
  const spare = await tx
    .select({
      month: sql<string>`substr(${posSales.businessDate}::text, 1, 7)`,
      n: sql<string>`count(*) filter (where ${posSales.isReversal} = false)`,
      amount: sql<string>`coalesce(sum(case when ${posSales.status} in ('valid', 'void_pending') or ${posSales.isReversal} then ${posSales.total} else 0 end), 0)`,
    })
    .from(posSales)
    .where(and(inArray(posSales.customerId, ids), gte(posSales.businessDate, input.from), lte(posSales.businessDate, input.to)))
    .groupBy(sql`1`);
  const months = new Set([...water.map((w) => w.month), ...spare.map((s) => s.month)]);
  return [...months]
    .sort()
    .reverse()
    .map((m) => {
      const w = water.find((x) => x.month === m);
      const s = spare.find((x) => x.month === m);
      return {
        month: m,
        waterTrips: Number(w?.n ?? 0),
        waterL: Number(w?.l ?? 0),
        waterAmount: Number(w?.amount ?? 0),
        sparePartAmount: Number(s?.amount ?? 0),
        sparePartTransactions: Number(s?.n ?? 0),
      };
    });
}

/** Riwayat pembelian untuk layar EQUA (pemilik, Admin Keuangan, Dispatcher, pembina). */
export async function partnerPurchaseHistory(ctx: ActorContext, input: { tenantId: string; months?: number }, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_supply.read", "p3.partner.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  await loadPartnerTenant(tx, input.tenantId);
  const to = ctxBusinessDate(ctx);
  const from = `${monthKey(addDays(to, -31 * (input.months ?? 12)))}-01`;
  return purchaseHistory(tx, input.tenantId, { from, to: lastDayOfMonth(to) });
}

export function describeSupplyValue(amount: number): string {
  return formatRupiah(amount);
}
