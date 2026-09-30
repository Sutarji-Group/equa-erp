/**
 * Pembangkit transaksi harian uji beban (NFR-05). Setiap hari ditulis dalam SATU transaksi, sudah dalam keadaan akhir
 * yang konsisten (bulk insert yang menjaga invarian — metodologi & daftar invarian di docs/qa/uji-beban.md §2):
 *
 * - Rit: pesanan → jadwal terbit → rit (Selesai/Gagal; hari jangkar sebagian masih Ditugaskan/Berangkat) → pembayaran
 *   rit (tunai: diterima + kurang bayar = harga; transfer → transfer masuk; tempo → faktur kirim + baris) → setoran sopir
 *   (Ditutup; hari jangkar Berjalan) → mutasi kas kantor. Rit internal → pasokan air depot dikonfirmasi + buku air.
 * - POS: shift (Ditutup; hari jangkar Terbuka) → transaksi + baris (harga master) → pemakaian bahan per resep & buku air
 *   saat tutup (saldo berjalan per outlet×barang) → setoran shift Ditutup + QRIS shift (transfer masuk) — EQUA saja;
 *   outlet mitra tanpa setoran EQUA & tanpa jurnal (tenant mitra bukan tenant pembukuan).
 * - Toko TK1: transaksi barang + kartu stok per baris (HPP rata-rata) + setoran shift toko.
 * - Piutang: faktur tempo dilunasi ±jatuh tempo (80%) lewat pelunasan kantor + alokasi; sisanya menjadi umur piutang.
 * - Event domain (payload sesuai `events.types.ts`) + jurnal otomatis M11 (templat mesin asli, lihat journals.ts),
 *   jejak audit berantai, perintah sinkron (`sync_commands`) untuk setiap aksi lapangan, posisi GPS 1/menit.
 * - Tutup kas harian (hari lampau).
 */
import { and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import {
  cashDays,
  customerPayments,
  dailySchedules,
  deposits,
  documentSequences,
  domainEvents,
  gpsPositions,
  incomingTransfers,
  invoiceLines,
  invoices,
  journalLines,
  journals,
  officeCashMovements,
  orders,
  outletWaterLedger,
  paymentAllocations,
  posSaleLines,
  posSales,
  shifts,
  stockBalances,
  stockLedger,
  syncCommands,
  tripPayments,
  trips,
  tripStatusEvents,
  waterSupplyReceipts,
} from "@/db/schema";
import { productId, TARIFF_ZONE_SEEDS, tariffZoneId, zoneCodeForDistance, FUEL_COMPONENT_PER_TRIP } from "@/db/seed/catalog";
import { nearestSource } from "@/db/seed/customers";
import { haversineMeters } from "@/lib/geo";
import { newId } from "@/lib/ids";
import { addDays, wibToUtc, type BusinessDate } from "@/lib/time";

import { AuditChain, insertMany } from "./bulk";
import { VOLUME, rng, type Rng } from "./config";
import { JournalFactory } from "./journals";
import type { CustomerInfo, LatLng, OutletInfo, TruckInfo, World } from "./masters";

const MIN = 60_000;

type Row<T extends { $inferInsert: unknown }> = T["$inferInsert"];

/** Antrean baris per tabel untuk satu hari (ditulis berurutan sesuai FK). */
class DayBatch {
  deposits: Row<typeof deposits>[] = [];
  schedules: Row<typeof dailySchedules>[] = [];
  orders: Row<typeof orders>[] = [];
  trips: Row<typeof trips>[] = [];
  tripEvents: Row<typeof tripStatusEvents>[] = [];
  transfers: Row<typeof incomingTransfers>[] = [];
  invoices: Row<typeof invoices>[] = [];
  invoiceLines: Row<typeof invoiceLines>[] = [];
  tripPayments: Row<typeof tripPayments>[] = [];
  supplies: Row<typeof waterSupplyReceipts>[] = [];
  water: Row<typeof outletWaterLedger>[] = [];
  shifts: Row<typeof shifts>[] = [];
  sales: Row<typeof posSales>[] = [];
  saleLines: Row<typeof posSaleLines>[] = [];
  stock: Row<typeof stockLedger>[] = [];
  events: Row<typeof domainEvents>[] = [];
  gps: Row<typeof gpsPositions>[] = [];
  commands: Row<typeof syncCommands>[] = [];
  office: Row<typeof officeCashMovements>[] = [];
  cashDays: Row<typeof cashDays>[] = [];
  payments: Row<typeof customerPayments>[] = [];
  allocations: Row<typeof paymentAllocations>[] = [];
  /** shift_id → deposit_id (ditautkan sesudah keduanya tersimpan). */
  shiftDeposit: { shiftId: string; depositId: string }[] = [];
}

type PendingPayment = { invoiceId: string; customerId: string; amount: number; number: string };

export type DayStats = Record<string, number>;

/** Keadaan lintas hari (penghitung nomor, saldo berjalan, jadwal pelunasan). */
export class Generator {
  private orderSeq = new Map<string, number>();
  private invoiceSeq = new Map<string, number>();
  private depositSeq = new Map<string, number>();
  private deviceSeq = new Map<string, number>();
  private stockBal = new Map<string, { qty: number; cost: number }>();
  private waterBal = new Map<string, number>();
  private pendingPayments = new Map<BusinessDate, PendingPayment[]>();
  private officeBalance = 0;
  private prevDayReceived = 0;
  readonly audit = new AuditChain();
  readonly stats: DayStats = {};
  private posSeqRows: { tenantId: string; scope: string; value: number }[] = [];

  constructor(
    private world: World,
    private jf: JournalFactory,
    private seed: number,
    private startDate: BusinessDate,
    private anchorDate: BusinessDate,
    private anchorNow: Date,
  ) {
    for (const o of world.outlets) {
      if (o.kind === "store") {
        for (const code of Object.keys(o.unitCost)) this.stockBal.set(`${o.id}:${code}`, { qty: code === "TK-DISPENSER" ? 400 : code === "TK-TUTUP" || code === "TK-TISU" ? 40_000 : 3_000, cost: o.unitCost[code]! });
      } else {
        this.stockBal.set(`${o.id}:TUTUP`, { qty: 12_000, cost: 600 });
        this.stockBal.set(`${o.id}:TISU`, { qty: 12_000, cost: 300 });
        this.stockBal.set(`${o.id}:GALON-KOSONG`, { qty: 600, cost: 35_000 });
        this.waterBal.set(o.id, 4_000);
      }
    }
  }

  private count(key: string, n = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  private next(map: Map<string, number>, key: string): number {
    const n = (map.get(key) ?? 0) + 1;
    map.set(key, n);
    return n;
  }

  private cutoff(date: BusinessDate): Date {
    return date === this.anchorDate ? this.anchorNow : wibToUtc(addDays(date, 1), "00:00");
  }

  async generateDay(tx: DbOrTx, date: BusinessDate, dayIndex: number): Promise<void> {
    const r = rng(this.seed * 1_000 + dayIndex);
    const b = new DayBatch();
    const isAnchor = date === this.anchorDate;
    const yy = date.slice(2, 4);
    const yymmdd = `${yy}${date.slice(5, 7)}${date.slice(8, 10)}`;

    // Kas kantor: saldo awal di hari pertama; setor bank pagi hari untuk setoran yang diterima kemarin.
    if (dayIndex === 0) {
      this.office(b, date, "opening_balance", "in", 5_000_000, "07:00", "Saldo awal kas kantor (sintetis)");
    } else if (this.prevDayReceived > 0) {
      this.office(b, date, "bank_deposit", "out", this.prevDayReceived, "09:00", "Setor ke bank (sintetis)");
    }
    let receivedToday = 0;

    // --- Rit truk ---------------------------------------------------------------------------------------------------
    const internalTargets = this.world.equaDepots.filter((_, i) => (i + dayIndex) % 2 === 0).slice(0, VOLUME.internalTripsPerDay);
    let internalCursor = 0;
    for (const [ti, truck] of this.world.trucks.entries()) {
      const n = r.int(VOLUME.tripsPerTruck - 1, VOLUME.tripsPerTruck + 1);
      const internalCount = ti < internalTargets.length - this.world.trucks.length ? 2 : ti < internalTargets.length ? 1 : 0;
      const scheduleId = newId();
      b.schedules.push({ id: scheduleId, tenantId: this.world.tenantId, businessDate: date, truckId: truck.id, status: "published", version: 1, publishedAt: wibToUtc(date, "05:30"), publishedBy: this.world.users.dispatcher, createdBy: this.world.users.dispatcher, createdAt: wibToUtc(addDays(date, -1), "16:00") });
      this.audit.add({ tenantId: this.world.tenantId, serverTime: wibToUtc(date, "05:30"), actorUserId: this.world.users.dispatcher, actorRoles: ["dispatcher"], source: "web", objectType: "daily_schedule", objectId: scheduleId, action: "publish", after: { truckId: truck.id, businessDate: date, trips: n }, businessDate: date });
      const dayTrips: TripPlan[] = [];
      for (let k = 0; k < n; k++) {
        const internal = k < internalCount ? internalTargets[internalCursor++] : undefined;
        const customer = internal ? null : this.pickCustomer(r);
        const depart = new Date(wibToUtc(date, "07:00").getTime() + (k * 95 + r.int(0, 10)) * MIN);
        const arrive = new Date(depart.getTime() + r.int(30, 45) * MIN);
        const complete = new Date(arrive.getTime() + r.int(15, 25) * MIN);
        dayTrips.push({ k, internal: internal ?? null, customer, depart, arrive, complete, failed: !internal && !isAnchor && r.chance(0.03) });
      }
      const { cashTotal, depositId } = await this.truckTrips(tx, b, r, date, yy, truck, scheduleId, dayTrips);
      this.gpsDay(b, r, date, truck, dayTrips);
      // Setoran sopir (dibuat saat rit pelanggan pertama Selesai; Ditutup di hari lampau, Berjalan di hari jangkar).
      const done = dayTrips.filter((t) => t.status === "completed" && !t.internal);
      const dep = depositId ? b.deposits.find((d) => d.id === depositId) : undefined;
      if (dep) {
        dep.expectedCash = cashTotal;
        dep.expectedNet = cashTotal;
        if (!isAnchor) {
          const received = wibToUtc(date, "18:00");
          Object.assign(dep, { status: "closed", receivedAmount: cashTotal, discrepancyAmount: 0, submittedAt: wibToUtc(date, "17:30"), receivedAt: received, receivedBy: this.world.users.finance, closedAt: wibToUtc(date, "18:05"), closedBy: this.world.users.finance, summarySnapshot: { tripsCompleted: done.length, cashTotal, synthetic: true } });
          if (cashTotal > 0) this.office(b, date, "deposit_received", "in", cashTotal, "18:00", `Setoran ${dep.number} (Sopir)`, "deposit", dep.id);
          receivedToday += cashTotal;
          await this.depositReceived(tx, b, dep, received, { truckId: truck.id, sourceUserId: truck.driverUserId, employeeId: truck.driverEmployeeId });
          this.auditDeposit(dep, received, ["driver"], truck.driverUserId, "field");
        }
      }
    }

    // --- POS depot EQUA, outlet mitra, toko ----------------------------------------------------------------------------
    for (const o of this.world.outlets) {
      receivedToday += await this.outletDay(tx, b, r, date, yymmdd, o);
    }

    // --- Pelunasan faktur yang jatuh pada hari ini -------------------------------------------------------------------
    for (const p of this.pendingPayments.get(date) ?? []) await this.pay(tx, b, date, p);
    this.pendingPayments.delete(date);

    // --- Tutup kas (hari lampau) -------------------------------------------------------------------------------------
    if (!isAnchor) {
      const closedAt = wibToUtc(date, "21:45");
      const balance = this.officeBalance + b.office.reduce((s, m) => s + (m.direction === "in" ? m.amount! : -m.amount!), 0);
      b.cashDays.push({ tenantId: this.world.tenantId, businessDate: date, status: "closed", lastDepositReceivedAt: wibToUtc(date, "21:00"), closeStartedAt: wibToUtc(date, "21:30"), closedAt, closedBy: this.world.users.finance, officeCashSystem: balance, officeCashPhysical: balance, officeCashDifference: 0 });
      this.audit.add({ tenantId: this.world.tenantId, serverTime: closedAt, actorUserId: this.world.users.finance, actorRoles: ["finance_admin"], source: "web", objectType: "cash_day", objectId: date, action: "close", after: { businessDate: date, officeCashSystem: balance }, businessDate: date });
    }
    this.officeBalance += b.office.reduce((s, m) => s + (m.direction === "in" ? m.amount! : -m.amount!), 0);
    this.prevDayReceived = isAnchor ? 0 : receivedToday;

    await this.flush(tx, b);
  }

  // ===================================================================================================================
  // Rit
  // ===================================================================================================================

  private pickCustomer(r: Rng): CustomerInfo {
    return r.pick(this.world.customers);
  }

  private methodFor(r: Rng, c: CustomerInfo): "cash" | "transfer" | "credit" {
    if ((c.creditStatus === "credit" || c.creditStatus === "credit_migrated") && !c.monthlyBilling) {
      const x = r.next();
      return x < 0.6 ? "credit" : x < 0.85 ? "cash" : "transfer";
    }
    if (c.segment === "household") return r.chance(0.8) ? "cash" : "transfer";
    return r.chance(0.6) ? "cash" : "transfer";
  }

  private async truckTrips(tx: DbOrTx, b: DayBatch, r: Rng, date: BusinessDate, yy: string, truck: TruckInfo, scheduleId: string, plans: TripPlan[]): Promise<{ cashTotal: number; depositId: string | null }> {
    const cut = this.cutoff(date);
    let cashTotal = 0;
    let depositId: string | null = null;
    const ensureDeposit = () => {
      if (depositId) return depositId;
      depositId = newId();
      const n = this.next(this.depositSeq, yy);
      b.deposits.push({ id: depositId, tenantId: this.world.tenantId, number: `S-${yy}-${String(n).padStart(6, "0")}`, sourceType: "driver", businessDate: date, status: "running", depositorUserId: truck.driverUserId, depositorEmployeeId: truck.driverEmployeeId, truckId: truck.id, method: "physical", expectedCash: 0, expectedNet: 0, createdBy: truck.driverUserId, createdAt: plans[0]!.complete });
      return depositId;
    };
    for (const p of plans) {
      const internalOutlet = p.internal;
      const customerId = internalOutlet ? internalOutlet.internalCustomerId! : p.customer!.id;
      const addressId = internalOutlet ? internalOutlet.internalAddressId! : p.customer!.addressId;
      const price = internalOutlet ? zonePrice(internalOutlet.point) : p.customer!.price;
      const method = internalOutlet ? "internal" : this.methodFor(r, p.customer!);
      const orderId = newId();
      const tripId = newId();
      const number = `P-${yy}-${String(this.next(this.orderSeq, yy)).padStart(6, "0")}`;
      const created = wibToUtc(addDays(date, -1), `${String(r.int(8, 15)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}`);
      // Status menurut waktu jangkar.
      const status: TripPlan["status"] = p.failed ? "failed" : p.complete <= cut ? "completed" : p.arrive <= cut ? "arrived" : p.depart <= cut ? "departed" : "assigned";
      p.status = status;
      p.tripId = tripId;
      p.point = internalOutlet ? internalOutlet.point : p.customer!.point;
      const orderStatus = status === "completed" ? "completed" : status === "failed" ? "cancelled" : status === "assigned" ? "scheduled" : "in_delivery";
      b.orders.push({
        id: orderId,
        tenantId: this.world.tenantId,
        number,
        customerId,
        addressId,
        productId: productId(internalOutlet ? "AIR-TRUK-INT" : "AIR-TRUK"),
        status: orderStatus,
        source: "office",
        tankCount: 1,
        requestedDate: date,
        paymentMethod: method,
        pricePerTrip: price,
        totalAmount: price,
        priceSource: internalOutlet ? "internal_transfer" : "zone",
        tariffZoneId: internalOutlet ? tariffZoneId(zoneCodeForDistance(nearestSource(internalOutlet.point).distanceM)) : p.customer!.zoneId,
        isInternal: !!internalOutlet,
        internalOutletId: internalOutlet?.id ?? null,
        scheduledAt: wibToUtc(date, "05:30"),
        firstDepartedAt: status === "assigned" ? null : p.depart,
        completedAt: status === "completed" ? p.complete : null,
        cancelReason: status === "failed" ? "customer_cancelled" : null,
        cancelNote: status === "failed" ? "Pelanggan membatalkan setelah rit gagal (sintetis)" : null,
        cancelledAt: status === "failed" ? new Date(p.arrive.getTime() + 30 * MIN) : null,
        cancelledBy: status === "failed" ? this.world.users.dispatcher : null,
        createdBy: this.world.users.dispatcher,
        createdAt: created,
        updatedAt: created,
      });
      this.audit.add({ tenantId: this.world.tenantId, serverTime: created, actorUserId: this.world.users.dispatcher, actorRoles: ["dispatcher"], source: "web", objectType: "order", objectId: orderId, action: "create", after: { number, customerId, price, paymentMethod: method }, businessDate: addDays(date, -1) });
      const departed = status !== "assigned";
      const arrived = status === "arrived" || status === "completed" || status === "failed";
      const completed = status === "completed";
      b.trips.push({
        id: tripId,
        tenantId: this.world.tenantId,
        orderId,
        number: `${number}/1`,
        sequenceInOrder: 1,
        status,
        customerId,
        addressId,
        isInternal: !!internalOutlet,
        destinationOutletId: internalOutlet?.id ?? null,
        truckId: truck.id,
        scheduledDate: date,
        scheduleId,
        routeOrder: p.k + 1,
        actualOrder: departed ? p.k + 1 : null,
        publishedAt: wibToUtc(date, "05:30"),
        price,
        paymentMethod: method,
        plannedVolumeL: 5_000,
        driverUserId: departed ? truck.driverUserId : null,
        driverEmployeeId: truck.driverEmployeeId,
        helperEmployeeId: truck.helperEmployeeId,
        departedAt: departed ? p.depart : null,
        departedLat: departed ? this.world.sources[p.k % 2]!.point.lat : null,
        departedLng: departed ? this.world.sources[p.k % 2]!.point.lng : null,
        arrivedAt: arrived ? p.arrive : null,
        arrivedLat: arrived ? p.point.lat : null,
        arrivedLng: arrived ? p.point.lng : null,
        completedAt: completed ? p.complete : null,
        completedLat: completed ? p.point.lat : null,
        completedLng: completed ? p.point.lng : null,
        completedAccuracyM: completed ? 8 : null,
        completionDistanceM: completed ? r.int(5, 60) : null,
        completionBusinessDate: completed ? date : null,
        deliveredVolumeL: completed ? 5_000 : null,
        recipientName: completed ? "Penerima (sintetis)" : null,
        signatureSkippedReason: completed ? "Penerima tidak bersedia (sintetis)" : null,
        failedAt: status === "failed" ? new Date(p.arrive.getTime() + 10 * MIN) : null,
        failReason: status === "failed" ? "customer_absent" : null,
        failNote: status === "failed" ? "Pelanggan tidak ada di tempat (sintetis)" : null,
        loadedWaterDisposition: status === "failed" ? "returned_to_source" : null,
        deviceId: departed ? truck.phoneDeviceId : null,
        deviceTime: completed ? p.complete : departed ? p.depart : null,
        syncedAt: completed ? new Date(p.complete.getTime() + 40_000) : departed ? new Date(p.depart.getTime() + 40_000) : null,
        createdBy: this.world.users.dispatcher,
        createdAt: created,
        updatedAt: completed ? p.complete : created,
      });
      // Aksi lapangan: status + perintah sinkron + audit.
      const actions: [string, Date, "departed" | "arrived" | "completed" | "failed"][] = [];
      if (departed) actions.push(["m3.trip.depart", p.depart, "departed"]);
      if (arrived) actions.push(["m3.trip.arrive", p.arrive, "arrived"]);
      if (completed) actions.push(["m3.trip.complete", p.complete, "completed"]);
      if (status === "failed") actions.push(["m3.trip.fail", new Date(p.arrive.getTime() + 10 * MIN), "failed"]);
      for (const [type, at, st] of actions) {
        const cmdId = newId();
        b.commands.push(this.command(cmdId, truck.phoneDeviceId, truck.driverUserId, type, { tripId, lat: p.point.lat, lng: p.point.lng }, at, date, "trip", tripId));
        b.tripEvents.push({ tenantId: this.world.tenantId, tripId, status: st, deviceTime: at, businessDate: date, syncedAt: new Date(at.getTime() + 40_000), lat: p.point.lat, lng: p.point.lng, accuracyM: 8, userId: truck.driverUserId, deviceId: truck.phoneDeviceId, syncCommandId: cmdId, createdAt: new Date(at.getTime() + 40_000) });
        this.audit.add({ tenantId: this.world.tenantId, serverTime: new Date(at.getTime() + 40_000), deviceTime: at, actorUserId: truck.driverUserId, actorEmployeeId: truck.driverEmployeeId, actorRoles: ["driver"], actorDeviceId: truck.phoneDeviceId, source: "field", objectType: "trip", objectId: tripId, action: st === "departed" ? "depart" : st === "arrived" ? "arrive" : st === "completed" ? "complete" : "fail", after: { status: st }, businessDate: date });
      }
      this.count(internalOutlet ? "rit_internal" : "rit_pelanggan");
      if (!completed) continue;

      if (internalOutlet) {
        // Pasokan air depot dikonfirmasi operator + buku air.
        const receiptId = newId();
        const confirmedAt = new Date(p.complete.getTime() + 20 * MIN);
        b.supplies.push({ id: receiptId, tenantId: this.world.tenantId, outletId: internalOutlet.id, source: "equa_truck", tripId, status: "confirmed", deliveredVolumeL: 5_000, receivedVolumeL: 5_000, differenceL: 0, confirmedAt, confirmedBy: internalOutlet.operatorUserId, businessDate: date, deviceId: internalOutlet.deviceId, deviceTime: confirmedAt, createdAt: p.complete });
        const bal = (this.waterBal.get(internalOutlet.id) ?? 0) + 5_000;
        this.waterBal.set(internalOutlet.id, bal);
        b.water.push({ tenantId: this.world.tenantId, outletId: internalOutlet.id, businessDate: date, kind: "supply_in", volumeL: 5_000, balanceAfterL: bal, sourceObjectType: "water_supply_receipt", sourceObjectId: receiptId, occurredAt: confirmedAt });
        this.event(b, "trip.completed", this.world.tenantId, date, p.complete, truck.driverUserId, "field", "trip", tripId, { tripId, orderId, customerId, truckId: truck.id, driverUserId: truck.driverUserId, isInternal: true, destinationOutletId: internalOutlet.id, volumeL: 5_000, price, paymentMethod: "internal", cashReceived: 0, transferAmount: 0, creditAmount: 0, underpaymentAmount: 0, completedAt: p.complete.toISOString(), recordedByOffice: false, lateSync: false, tripNumber: `${number}/1`, orderNumber: number, businessDate: date });
        continue;
      }
      const customer = p.customer!;
      const depId = ensureDeposit();
      const paymentId = newId();
      let transferId: string | null = null;
      let invoiceId: string | null = null;
      if (method === "cash") cashTotal += price;
      if (method === "transfer") {
        transferId = newId();
        const matched = date < this.anchorDate;
        b.transfers.push({ id: transferId, tenantId: this.world.tenantId, sourceKind: "trip_payment", sourceObjectType: "trip_payment", sourceObjectId: paymentId, customerId: customer.id, amount: price, transferDate: date, businessDate: date, reference: `TRF-${number}`, status: matched ? "matched" : "unmatched", matchedAt: matched ? wibToUtc(addDays(date, 1), "10:00") : null, matchedBy: matched ? this.world.users.finance : null, sourceUserId: truck.driverUserId, truckId: truck.id, createdBy: truck.driverUserId, createdAt: p.complete });
      }
      if (method === "credit") {
        invoiceId = newId();
        const invNo = `F-${yy}-${String(this.next(this.invoiceSeq, yy)).padStart(6, "0")}`;
        const due = addDays(date, customer.termDays);
        const payDate = addDays(due, r.int(-5, 6));
        const willPay = payDate < this.anchorDate && r.chance(0.8);
        b.invoices.push({
          id: invoiceId,
          tenantId: this.world.tenantId,
          number: invNo,
          kind: "delivery",
          customerId: customer.id,
          addressId: customer.addressId,
          tripId,
          issueDate: date,
          dueDate: due,
          amount: price,
          paidAmount: willPay ? price : 0,
          outstandingAmount: willPay ? 0 : price,
          status: willPay ? "paid" : "open",
          description: `Rit ${number}/1`,
          paidAt: willPay ? wibToUtc(payDate, "10:00") : null,
          createdAt: p.complete,
          updatedAt: willPay ? wibToUtc(payDate, "10:00") : p.complete,
        });
        b.invoiceLines.push({ invoiceId, lineNo: 1, component: "trip", description: `Rit ${number}/1 — 5.000 L`, tripId, productId: productId("AIR-TRUK"), serviceDate: date, quantity: 1, unitPrice: price, amount: price, volumeL: 5_000 });
        this.audit.add({ tenantId: this.world.tenantId, serverTime: p.complete, actorUserId: null, actorRoles: null, source: "system", objectType: "invoice", objectId: invoiceId, action: "create", after: { number: invNo, amount: price, dueDate: due }, rule: "US-M5-01", businessDate: date });
        this.count("faktur_tempo");
        if (willPay) {
          const list = this.pendingPayments.get(payDate) ?? [];
          list.push({ invoiceId, customerId: customer.id, amount: price, number: invNo });
          this.pendingPayments.set(payDate, list);
        }
      }
      b.tripPayments.push({ id: paymentId, tenantId: this.world.tenantId, tripId, customerId: customer.id, driverUserId: truck.driverUserId, method, expectedAmount: price, receivedAmount: method === "credit" ? 0 : price, underpaymentAmount: 0, incomingTransferId: transferId, invoiceId, depositId: depId, businessDate: date, deviceId: truck.phoneDeviceId, deviceTime: p.complete, syncedAt: new Date(p.complete.getTime() + 40_000), createdBy: truck.driverUserId, createdAt: p.complete });
      const payload = {
        tripId,
        orderId,
        customerId: customer.id,
        truckId: truck.id,
        driverUserId: truck.driverUserId,
        isInternal: false,
        volumeL: 5_000,
        price,
        paymentMethod: method,
        cashReceived: method === "cash" ? price : 0,
        transferAmount: method === "transfer" ? price : 0,
        creditAmount: method === "credit" ? price : 0,
        underpaymentAmount: 0,
        completedAt: p.complete.toISOString(),
        recordedByOffice: false,
        lateSync: false,
        tripNumber: `${number}/1`,
        orderNumber: number,
        addressId,
        profitCenter: "L2" as const,
        businessDate: date,
        expectedAmount: price,
        tripPaymentId: paymentId,
        depositId: depId,
        plannedVolumeL: 5_000,
      };
      const ev = this.event(b, "trip.completed", this.world.tenantId, date, p.complete, truck.driverUserId, "field", "trip", tripId, payload);
      await this.jf.journalFor(tx, { event: ev, variant: `trip:${method}:${truck.id}`, amounts: [price], ref: `${number}/1`, sourceObject: { type: "trip", id: tripId }, date, postedAt: p.complete });
      this.count("pembayaran_rit");
    }
    return { cashTotal, depositId };
  }

  private gpsDay(b: DayBatch, r: Rng, date: BusinessDate, truck: TruckInfo, plans: TripPlan[]): void {
    const cut = this.cutoff(date);
    type Seg = { t0: number; t1: number; from: LatLng; to: LatLng; tripId: string | null };
    const segs: Seg[] = [];
    let at = wibToUtc(date, "06:30").getTime();
    let pos = this.world.pool;
    for (const p of plans) {
      const src = this.world.sources[p.k % 2]!.point;
      const target = p.point ?? src;
      const fillStart = Math.max(at, p.depart.getTime() - 20 * MIN);
      segs.push({ t0: at, t1: fillStart, from: pos, to: src, tripId: null });
      segs.push({ t0: fillStart, t1: p.depart.getTime(), from: src, to: src, tripId: null });
      segs.push({ t0: p.depart.getTime(), t1: p.arrive.getTime(), from: src, to: target, tripId: p.tripId ?? null });
      segs.push({ t0: p.arrive.getTime(), t1: p.complete.getTime(), from: target, to: target, tripId: p.tripId ?? null });
      at = p.complete.getTime();
      pos = target;
    }
    segs.push({ t0: at, t1: at + 45 * MIN, from: pos, to: this.world.pool, tripId: null });
    const end = Math.min(segs[segs.length - 1]!.t1, cut.getTime());
    const step = VOLUME.gpsIntervalSec * 1_000;
    let si = 0;
    let prev: LatLng | null = null;
    for (let t = wibToUtc(date, "06:30").getTime(); t <= end; t += step) {
      while (si < segs.length - 1 && t > segs[si]!.t1) si++;
      const s = segs[si]!;
      const f = s.t1 > s.t0 ? Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) : 1;
      const lat = s.from.lat + (s.to.lat - s.from.lat) * f + (r.next() - 0.5) * 0.00004;
      const lng = s.from.lng + (s.to.lng - s.from.lng) * f + (r.next() - 0.5) * 0.00004;
      const here = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
      const speed = prev ? Math.round((haversineMeters(prev, here) / (step / 1_000)) * 3.6 * 10) / 10 : 0;
      prev = here;
      b.gps.push({ tenantId: this.world.tenantId, truckId: truck.id, deviceId: truck.gpsDeviceId, source: "gps_device", deviceTime: new Date(t), serverTime: new Date(t + 5_000), lat: here.lat, lng: here.lng, speedKmh: speed, heading: r.int(0, 359), accuracyM: 8, ignitionOn: true, powerConnected: true, isValid: true, tripId: s.tripId, vendor: "generic-json" });
    }
  }

  // ===================================================================================================================
  // POS (depot EQUA, outlet mitra, toko)
  // ===================================================================================================================

  private async outletDay(tx: DbOrTx, b: DayBatch, r: Rng, date: BusinessDate, yymmdd: string, o: OutletInfo): Promise<number> {
    const isAnchor = date === this.anchorDate;
    const cut = this.cutoff(date);
    const shiftId = newId();
    const openedAt = wibToUtc(date, "06:30");
    const closedAt = wibToUtc(date, "20:30");
    const isStore = o.kind === "store";
    const mean = isStore ? VOLUME.salesPerStore : o.isPartner ? VOLUME.salesPerPartnerOutlet : VOLUME.salesPerEquaDepot;
    const count = r.around(mean, 0.35);
    const openMs = wibToUtc(date, "06:40").getTime();
    const span = wibToUtc(date, "20:15").getTime() - openMs;
    const times = Array.from({ length: count }, () => openMs + Math.floor(r.next() * span)).sort((a, b2) => a - b2).filter((t) => t <= cut.getTime());
    const openingCash = 200_000;
    const shift: Row<typeof shifts> = { id: shiftId, tenantId: o.tenantId, outletId: o.id, operatorUserId: o.operatorUserId, businessDate: date, status: "open", openedAt, openingCashFixed: openingCash, openingCashCounted: openingCash, deviceId: o.deviceId, deviceTime: openedAt, syncedAt: new Date(openedAt.getTime() + 30_000), createdBy: o.operatorUserId, createdAt: openedAt, updatedAt: openedAt };
    b.shifts.push(shift);
    b.commands.push(this.command(newId(), o.deviceId, o.operatorUserId, "m6.shift.open", { shiftId, outletId: o.id }, openedAt, date, "shift", shiftId, o.tenantId));
    this.event(b, "shift.opened", o.tenantId, date, openedAt, o.operatorUserId, "pos", "shift", shiftId, { shiftId, outletId: o.id, operatorUserId: o.operatorUserId, openingCash, businessDate: date });
    this.audit.add({ tenantId: o.tenantId, serverTime: openedAt, deviceTime: openedAt, actorUserId: o.operatorUserId, actorRoles: [isStore ? "store_cashier" : "depot_operator"], actorDeviceId: o.deviceId, source: "pos", objectType: "shift", objectId: shiftId, action: "open", after: { openingCash }, businessDate: date });

    let cashSales = 0;
    let qrisSales = 0;
    let gallons = 0;
    let liters = 0;
    const usage: Record<string, number> = {};
    for (const [i, t] of times.entries()) {
      const soldAt = new Date(t);
      const saleId = newId();
      const seq = i + 1;
      const dseq = this.next(this.deviceSeq, o.deviceId);
      const lines = isStore ? this.storeLines(r, o) : this.depotLines(r, o);
      const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
      const method = r.chance(isStore ? 0.2 : 0.25) ? "qris" : "cash";
      const number = `${o.code}-${yymmdd}-${String(seq).padStart(4, "0")}`;
      if (method === "cash") cashSales += total;
      else qrisSales += total;
      const cashReceived = method === "cash" ? Math.ceil(total / 5_000) * 5_000 : null;
      b.sales.push({ id: saleId, tenantId: o.tenantId, outletId: o.id, shiftId, number, localNumber: `${o.code}-${yymmdd}-${o.deviceCode}-${String(dseq).padStart(4, "0")}`, deviceSeq: dseq, operatorUserId: o.operatorUserId, priceKind: isStore ? "general" : "standard", businessDate: date, soldAt, subtotal: total, total, paymentMethod: method, cashReceived, changeAmount: cashReceived !== null ? cashReceived - total : null, qrisReference: method === "qris" ? `QR${yymmdd}${o.code}${seq}` : null, status: "valid", deviceId: o.deviceId, deviceTime: soldAt, syncedAt: new Date(t + 20_000), createdBy: o.operatorUserId, createdAt: new Date(t + 20_000), updatedAt: new Date(t + 20_000) });
      let cogs = 0;
      const lineCosts: { productId: string; quantity: number; unitCost: number }[] = [];
      lines.forEach((l, li) => {
        const pid = o.product[l.code]!;
        b.saleLines.push({ posSaleId: saleId, tenantId: o.tenantId, outletId: o.id, businessDate: date, lineNo: li + 1, productId: pid, quantity: l.qty, unitPrice: l.price, lineTotal: l.qty * l.price, unitCost: isStore ? (o.unitCost[l.code] ?? 0) : null, gallonSizeL: l.gallon ? 19 : null, createdAt: new Date(t + 20_000), updatedAt: new Date(t + 20_000) });
        if (l.gallon) {
          gallons += l.qty;
          liters += l.qty * 19;
        }
        for (const m of l.recipe ?? []) usage[m] = (usage[m] ?? 0) + l.qty;
        if (isStore) {
          const key = `${o.id}:${l.code}`;
          const bal = this.stockBal.get(key)!;
          bal.qty -= l.qty;
          const unitCost = bal.cost;
          cogs += unitCost * l.qty;
          lineCosts.push({ productId: pid, quantity: l.qty, unitCost });
          b.stock.push({ tenantId: o.tenantId, outletId: o.id, productId: pid, kind: "sale", quantity: -l.qty, unitCost, totalCost: -unitCost * l.qty, balanceAfter: bal.qty, avgCostAfter: unitCost, businessDate: date, occurredAt: soldAt, sourceObjectType: "pos_sale", sourceObjectId: saleId, createdBy: o.operatorUserId });
        }
      });
      const cmdId = newId();
      b.commands.push(this.command(cmdId, o.deviceId, o.operatorUserId, "m6.pos_sale.create", { id: saleId, shiftId, total, method, lines: lines.length }, soldAt, date, "pos_sale", saleId, o.tenantId));
      this.audit.add({ tenantId: o.tenantId, serverTime: new Date(t + 20_000), deviceTime: soldAt, actorUserId: o.operatorUserId, actorRoles: [isStore ? "store_cashier" : "depot_operator"], actorDeviceId: o.deviceId, source: "pos", objectType: "pos_sale", objectId: saleId, action: "create", after: { number, total, method }, businessDate: date });
      const payload = {
        posSaleId: saleId,
        outletId: o.id,
        outletKind: o.kind,
        shiftId,
        method,
        total,
        discount: 0,
        cogs: isStore ? cogs : null,
        lines: lines.map((l) => ({ productId: o.product[l.code]!, quantity: l.qty, unitPrice: l.price, lineTotal: l.qty * l.price })),
        number,
        businessDate: date,
        priceKind: isStore ? ("general" as const) : ("standard" as const),
        ...(isStore ? { lineCosts } : {}),
      };
      const ev = this.event(b, "pos_sale.recorded", o.tenantId, date, new Date(t + 20_000), o.operatorUserId, "pos", "pos_sale", saleId, payload);
      if (!o.isPartner) {
        await this.jf.journalFor(tx, { event: ev, variant: isStore ? `store:${method}` : `depot:${method}:${o.id}`, amounts: isStore ? [total, cogs] : [total], ref: number, sourceObject: { type: "pos_sale", id: saleId }, date, postedAt: new Date(t + 20_000) });
      }
    }
    this.count(o.isPartner ? "pos_mitra" : isStore ? "pos_toko" : "pos_depot", times.length);
    this.posSeqRows.push({ tenantId: o.tenantId, scope: `${o.code}-${yymmdd}`, value: times.length });

    if (isAnchor) return 0;
    // --- Tutup shift: ringkasan, pemakaian bahan, buku air, setoran & QRIS ------------------------------------------
    const expectedCash = openingCash + cashSales;
    Object.assign(shift, {
      status: "closed",
      closedAt,
      cashSales,
      qrisSales,
      creditSales: 0,
      voidCount: 0,
      voidAmount: 0,
      expectedCash,
      closingCashCounted: expectedCash,
      cashDifference: 0,
      depositAmount: cashSales,
      depositStatus: o.isPartner ? "not_deposited" : "received",
      depositedAt: o.isPartner ? null : new Date(closedAt.getTime() + 5 * MIN),
      summary: { salesTotal: cashSales + qrisSales, saleCount: times.length, gallonsSold: gallons, gallonLitersSold: liters, synthetic: true },
      updatedAt: closedAt,
    });
    b.commands.push(this.command(newId(), o.deviceId, o.operatorUserId, "m6.shift.close", { shiftId, closingCash: expectedCash }, closedAt, date, "shift", shiftId, o.tenantId));
    this.event(b, "shift.closed", o.tenantId, date, closedAt, o.operatorUserId, "pos", "shift", shiftId, { shiftId, outletId: o.id, businessDate: date, cashSales, qrisSales, depositAmount: cashSales });
    this.audit.add({ tenantId: o.tenantId, serverTime: closedAt, deviceTime: closedAt, actorUserId: o.operatorUserId, actorRoles: [isStore ? "store_cashier" : "depot_operator"], actorDeviceId: o.deviceId, source: "pos", objectType: "shift", objectId: shiftId, action: "close", after: { cashSales, qrisSales }, businessDate: date });
    if (!isStore) {
      for (const [code, used] of Object.entries(usage)) {
        const key = `${o.id}:${code}`;
        const bal = this.stockBal.get(key);
        if (!bal || used === 0) continue;
        bal.qty -= used;
        b.stock.push({ tenantId: o.tenantId, outletId: o.id, productId: o.product[code]!, kind: "consumption", quantity: -used, unitCost: bal.cost, totalCost: -used * bal.cost, balanceAfter: bal.qty, avgCostAfter: bal.cost, businessDate: date, occurredAt: closedAt, sourceObjectType: "shift", sourceObjectId: shiftId, note: "Pemakaian seharusnya (resep) — tutup shift", createdBy: o.operatorUserId });
      }
      const wb = (this.waterBal.get(o.id) ?? 0) - liters;
      this.waterBal.set(o.id, wb);
      if (liters > 0) b.water.push({ tenantId: o.tenantId, outletId: o.id, businessDate: date, kind: "sales_out", volumeL: -liters, balanceAfterL: wb, sourceObjectType: "shift", sourceObjectId: shiftId, occurredAt: closedAt });
      if (o.isPartner && date.endsWith("0")) {
        // Pasokan air truk EQUA ke outlet mitra (±3 hari sekali) — dikonfirmasi operator mitra.
        const rid = newId();
        const at = wibToUtc(date, "09:10");
        b.supplies.push({ id: rid, tenantId: o.tenantId, outletId: o.id, source: "equa_truck", status: "confirmed", deliveredVolumeL: 5_000, receivedVolumeL: 5_000, differenceL: 0, confirmedAt: at, confirmedBy: o.operatorUserId, businessDate: date, deviceId: o.deviceId, createdAt: at });
        const nb = (this.waterBal.get(o.id) ?? 0) + 5_000;
        this.waterBal.set(o.id, nb);
        b.water.push({ tenantId: o.tenantId, outletId: o.id, businessDate: date, kind: "supply_in", volumeL: 5_000, balanceAfterL: nb, sourceObjectType: "water_supply_receipt", sourceObjectId: rid, occurredAt: at });
      }
    }
    if (o.isPartner) return 0;
    const yy = date.slice(2, 4);
    const depositId = newId();
    const dNo = `S-${yy}-${String(this.next(this.depositSeq, yy)).padStart(6, "0")}`;
    const submittedAt = new Date(closedAt.getTime() + 5 * MIN);
    const receivedAt = wibToUtc(date, "21:00");
    const dep: Row<typeof deposits> = { id: depositId, tenantId: o.tenantId, number: dNo, sourceType: isStore ? "store_shift" : "depot_shift", businessDate: date, status: "closed", depositorUserId: o.operatorUserId, outletId: o.id, shiftId, method: "physical", expectedCash: cashSales, expectedNet: cashSales, receivedAmount: cashSales, discrepancyAmount: 0, summarySnapshot: { kind: "shift_close", salesTotal: cashSales + qrisSales, cashSales, qrisSales, openingCash, synthetic: true }, submittedAt, receivedAt, receivedBy: this.world.users.finance, closedAt: new Date(receivedAt.getTime() + 5 * MIN), closedBy: this.world.users.finance, deviceId: o.deviceId, deviceTime: submittedAt, createdBy: o.operatorUserId, createdAt: submittedAt, updatedAt: receivedAt };
    b.deposits.push(dep);
    b.shiftDeposit.push({ shiftId, depositId });
    if (cashSales > 0) this.office(b, date, "deposit_received", "in", cashSales, "21:00", `Setoran ${dNo} (${isStore ? "Shift toko" : "Shift depot"})`, "deposit", depositId);
    await this.depositReceived(tx, b, dep, receivedAt, { outletId: o.id, shiftId, sourceUserId: o.operatorUserId });
    this.auditDeposit(dep, receivedAt, [isStore ? "store_cashier" : "depot_operator"], o.operatorUserId, "pos");
    if (qrisSales > 0) {
      b.transfers.push({ tenantId: o.tenantId, sourceKind: "qris_shift", sourceObjectType: "shift", sourceObjectId: shiftId, outletId: o.id, shiftId, amount: qrisSales, transferDate: date, businessDate: date, reference: `QRIS-${o.code}-${yymmdd}`, status: "matched", matchedAt: wibToUtc(addDays(date, 1), "10:30"), matchedBy: this.world.users.finance, createdAt: closedAt });
    }
    return cashSales;
  }

  private depotLines(r: Rng, o: OutletInfo): SaleLine[] {
    const x = r.next();
    if (x < 0.05) return [{ code: "GALON-BARU", qty: 1, price: o.price["GALON-BARU"]!, gallon: true, recipe: ["GALON-KOSONG", "TUTUP"] }];
    const refill: SaleLine = { code: "ISI-ULANG", qty: r.int(1, 3), price: o.price["ISI-ULANG"]!, gallon: true, recipe: ["TUTUP", "TISU"] };
    if (x < 0.15) return [{ code: "CUCI-GALON", qty: refill.qty, price: o.price["CUCI-GALON"]!, gallon: false }, refill];
    return [refill];
  }

  private storeLines(r: Rng, o: OutletInfo): SaleLine[] {
    const codes = Object.keys(o.unitCost);
    const n = r.int(1, 2);
    const out: SaleLine[] = [];
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      const code = r.pick(codes);
      if (used.has(code)) continue;
      used.add(code);
      const qty = code === "TK-TUTUP" || code === "TK-TISU" ? r.int(20, 100) : code === "TK-DISPENSER" ? 1 : r.int(1, 4);
      out.push({ code, qty, price: o.price[code]!, gallon: false });
    }
    return out;
  }

  // ===================================================================================================================
  // Kas, setoran, pelunasan
  // ===================================================================================================================

  private office(b: DayBatch, date: BusinessDate, kind: Row<typeof officeCashMovements>["kind"], direction: "in" | "out", amount: number, time: string, description: string, sourceObjectType?: string, sourceObjectId?: string): void {
    b.office.push({ tenantId: this.world.tenantId, businessDate: date, kind, direction, amount, sourceObjectType: sourceObjectType ?? null, sourceObjectId: sourceObjectId ?? null, description, createdBy: this.world.users.finance, createdAt: wibToUtc(date, time) });
  }

  private async depositReceived(tx: DbOrTx, b: DayBatch, dep: Row<typeof deposits>, at: Date, dims: { truckId?: string; outletId?: string; shiftId?: string; sourceUserId: string; employeeId?: string }): Promise<void> {
    const amount = dep.receivedAmount ?? 0;
    const payload = {
      depositId: dep.id!,
      sourceType: dep.sourceType,
      sourceUserId: dims.sourceUserId,
      truckId: dims.truckId ?? null,
      outletId: dims.outletId ?? null,
      expectedAmount: dep.expectedNet ?? 0,
      receivedAmount: amount,
      discrepancyAmount: 0,
      receivedBy: this.world.users.finance,
      profitCenter: dep.sourceType === "driver" ? ("L2" as const) : dep.sourceType === "store_shift" ? ("L4" as const) : ("L3" as const),
      late: false,
      method: "physical" as const,
      depositNumber: dep.number,
      businessDate: dep.businessDate,
      shiftId: dims.shiftId ?? null,
      employeeId: dims.employeeId ?? null,
      expectedCash: dep.expectedCash ?? 0,
      acceptedExpenses: 0,
      carryOverCash: 0,
    };
    const ev = this.event(b, "deposit.received", this.world.tenantId, dep.businessDate!, at, this.world.users.finance, "web", "deposit", dep.id!, payload);
    if (amount > 0) {
      await this.jf.journalFor(tx, { event: ev, variant: `deposit:${dep.sourceType}:${dims.truckId ?? dims.outletId}`, amounts: [amount], ref: dep.number!, sourceObject: { type: "deposit", id: dep.id! }, date: dep.businessDate!, postedAt: at });
    }
    this.count("setoran_diterima");
  }

  private auditDeposit(dep: Row<typeof deposits>, receivedAt: Date, roles: string[], userId: string, source: "field" | "pos"): void {
    this.audit.add({ tenantId: this.world.tenantId, serverTime: dep.submittedAt ?? receivedAt, actorUserId: userId, actorRoles: roles, source, objectType: "deposit", objectId: dep.id!, action: "submit", after: { expectedCash: dep.expectedCash }, businessDate: dep.businessDate });
    this.audit.add({ tenantId: this.world.tenantId, serverTime: receivedAt, actorUserId: this.world.users.finance, actorRoles: ["finance_admin"], source: "web", objectType: "deposit", objectId: dep.id!, action: "receive", after: { receivedAmount: dep.receivedAmount, discrepancyAmount: 0 }, businessDate: dep.businessDate });
    this.audit.add({ tenantId: this.world.tenantId, serverTime: new Date(receivedAt.getTime() + 5 * MIN), actorUserId: this.world.users.finance, actorRoles: ["finance_admin"], source: "web", objectType: "deposit", objectId: dep.id!, action: "close", businessDate: dep.businessDate });
  }

  private async pay(tx: DbOrTx, b: DayBatch, date: BusinessDate, p: PendingPayment): Promise<void> {
    const paymentId = newId();
    const at = wibToUtc(date, "10:00");
    b.payments.push({ id: paymentId, tenantId: this.world.tenantId, customerId: p.customerId, channel: "office", method: "transfer", amount: p.amount, businessDate: date, advanceAmount: 0, notes: `Transfer pelunasan ${p.number} (sintetis)`, createdBy: this.world.users.finance, createdAt: at });
    b.allocations.push({ invoiceId: p.invoiceId, customerPaymentId: paymentId, amount: p.amount, allocatedAt: at, createdBy: this.world.users.finance, createdAt: at });
    this.audit.add({ tenantId: this.world.tenantId, serverTime: at, actorUserId: this.world.users.finance, actorRoles: ["finance_admin"], source: "web", objectType: "customer_payment", objectId: paymentId, action: "create", after: { amount: p.amount, invoice: p.number }, businessDate: date });
    const ev = this.event(b, "collection.recorded", this.world.tenantId, date, at, this.world.users.finance, "web", "customer_payment", paymentId, {
      customerPaymentId: paymentId,
      customerId: p.customerId,
      amount: p.amount,
      channel: "office",
      method: "transfer",
      allocations: [{ invoiceId: p.invoiceId, amount: p.amount }],
      advanceAmount: 0,
      profitCenter: "L2",
      businessDate: date,
      recordedByOffice: true,
    });
    await this.jf.journalFor(tx, { event: ev, variant: "collection:office:transfer", amounts: [p.amount], ref: null, sourceObject: { type: "customer_payment", id: paymentId }, date, postedAt: at });
    this.count("pelunasan");
  }

  // ===================================================================================================================
  // Event, perintah sinkron, penulisan
  // ===================================================================================================================

  private event(b: DayBatch, type: string, tenantId: string, date: BusinessDate, at: Date, actor: string | null, source: "web" | "field" | "pos" | "system", objectType: string, objectId: string, payload: Record<string, unknown>) {
    const row = { id: newId(), tenantId, type, payload, occurredAt: at, businessDate: date, actorUserId: actor, source, objectType, objectId };
    b.events.push(row);
    return row;
  }

  private command(id: string, deviceId: string, userId: string, type: string, payload: Record<string, unknown>, deviceTime: Date, date: BusinessDate, objectType: string, objectId: string, tenantId = this.world.tenantId): Row<typeof syncCommands> {
    const received = new Date(deviceTime.getTime() + 30_000);
    return { id, tenantId, deviceId, userId, type, payload, deviceTime, businessDate: date, receivedAt: received, processedAt: new Date(received.getTime() + 150), status: "applied", objectType, objectId, clockSkewMs: 0, createdAt: received };
  }

  private async flush(tx: DbOrTx, b: DayBatch): Promise<void> {
    // Event templat jurnal sudah tersimpan saat templat dibuat — jangan disisipkan dua kali.
    const storedIds = this.jf.insertedEventIds;
    const { journals: js, lines } = this.jf.drain();
    const steps: [string, () => Promise<number>][] = [
      ["shifts", () => insertMany(tx, shifts, b.shifts)],
      ["deposits", () => insertMany(tx, deposits, b.deposits)],
      ["daily_schedules", () => insertMany(tx, dailySchedules, b.schedules)],
      ["orders", () => insertMany(tx, orders, b.orders)],
      ["trips", () => insertMany(tx, trips, b.trips)],
      ["sync_commands", () => insertMany(tx, syncCommands, b.commands)],
      ["trip_status_events", () => insertMany(tx, tripStatusEvents, b.tripEvents)],
      ["incoming_transfers", () => insertMany(tx, incomingTransfers, b.transfers)],
      ["invoices", () => insertMany(tx, invoices, b.invoices)],
      ["invoice_lines", () => insertMany(tx, invoiceLines, b.invoiceLines)],
      ["trip_payments", () => insertMany(tx, tripPayments, b.tripPayments)],
      ["water_supply_receipts", () => insertMany(tx, waterSupplyReceipts, b.supplies)],
      ["outlet_water_ledger", () => insertMany(tx, outletWaterLedger, b.water)],
      ["pos_sales", () => insertMany(tx, posSales, b.sales)],
      ["pos_sale_lines", () => insertMany(tx, posSaleLines, b.saleLines)],
      ["stock_ledger", () => insertMany(tx, stockLedger, b.stock)],
      ["domain_events", () => insertMany(tx, domainEvents, b.events.filter((e) => !storedIds.has(e.id!)))],
      ["journals", () => insertMany(tx, journals, js)],
      ["journal_lines", () => insertMany(tx, journalLines, lines)],
      ["gps_positions", () => insertMany(tx, gpsPositions, b.gps)],
      ["office_cash_movements", () => insertMany(tx, officeCashMovements, b.office)],
      ["cash_days", () => insertMany(tx, cashDays, b.cashDays)],
      ["customer_payments", () => insertMany(tx, customerPayments, b.payments)],
      ["payment_allocations", () => insertMany(tx, paymentAllocations, b.allocations)],
    ];
    for (const [name, run] of steps) this.count(`rows:${name}`, await run());
    // Tautan shift → setoran (dua arah; setoran merujuk shift lebih dulu).
    for (const link of b.shiftDeposit) await tx.update(shifts).set({ depositId: link.depositId }).where(eq(shifts.id, link.shiftId));
    await this.audit.flush(tx);
    await this.jf.syncSequences(tx);
  }

  /** Akhir pembangkitan: saldo stok akhir, urutan nomor dokumen (layanan melanjutkan tanpa bentrok). */
  async finish(tx: DbOrTx): Promise<void> {
    for (const [key, bal] of this.stockBal) {
      const [outletId, code] = key.split(":") as [string, string];
      const o = this.world.outlets.find((x) => x.id === outletId)!;
      await tx
        .update(stockBalances)
        .set({ quantity: bal.qty, avgCost: bal.cost, totalValue: bal.qty * bal.cost, lastMovementAt: this.anchorNow })
        .where(and(eq(stockBalances.outletId, outletId), eq(stockBalances.productId, o.product[code]!)));
    }
    const seqRows: { tenantId: string; kind: string; scope: string; value: number }[] = [
      ...[...this.orderSeq].map(([scope, value]) => ({ tenantId: this.world.tenantId, kind: "order", scope, value })),
      ...[...this.invoiceSeq].map(([scope, value]) => ({ tenantId: this.world.tenantId, kind: "invoice", scope, value })),
      ...[...this.depositSeq].map(([scope, value]) => ({ tenantId: this.world.tenantId, kind: "deposit", scope, value })),
      ...this.posSeqRows.map((p) => ({ tenantId: p.tenantId, kind: "pos_sale", scope: p.scope, value: p.value })),
    ];
    for (let i = 0; i < seqRows.length; i += 500) {
      const chunk = seqRows.slice(i, i + 500);
      await tx
        .insert(documentSequences)
        .values(chunk.map((s) => ({ id: newId(), tenantId: s.tenantId, kind: s.kind, scopeKey: s.scope, lastValue: s.value })))
        .onConflictDoUpdate({
          target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
          set: { lastValue: sql`greatest(${documentSequences.lastValue}, excluded.last_value)`, updatedAt: new Date() },
        });
    }
    await this.audit.flush(tx);
  }
}

type SaleLine = { code: string; qty: number; price: number; gallon: boolean; recipe?: string[] };

type TripPlan = {
  k: number;
  internal: OutletInfo | null;
  customer: CustomerInfo | null;
  depart: Date;
  arrive: Date;
  complete: Date;
  failed: boolean;
  status?: "assigned" | "departed" | "arrived" | "completed" | "failed";
  tripId?: string;
  point?: LatLng;
};

function zonePrice(point: LatLng): number {
  const code = zoneCodeForDistance(nearestSource(point).distanceM);
  const zone = TARIFF_ZONE_SEEDS.find((z) => z.code === code) ?? TARIFF_ZONE_SEEDS[0];
  return zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP;
}
