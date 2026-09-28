/**
 * Seed demo Aplikasi Sopir (M3) — idempoten (ID deterministik + ON CONFLICT DO NOTHING); tanggal relatif terhadap hari
 * seed dijalankan agar aplikasi sopir truk T2 (Ujang Suryana, `sopir2`; kernet `kernet2`) tidak kosong. Hanya memakai
 * truk T2 & pelanggan yang tidak dipakai demo M2 (T5/T7). Tidak membuat permintaan persetujuan.
 *
 * Isi (nomor pesanan demo P-YY-9002xx, setoran S-YY-9002xx — tidak bertabrakan dengan penomoran otomatis):
 * - Kemarin: 2 rit T2 Selesai tunai + setoran sopir kemarin Ditutup tanpa selisih (riwayat setoran; BR-10 tidak
 *   mengunci sopir hari ini).
 * - Hari ini (jadwal T2 terbit): rit 1 Selesai tunai (setoran hari ini Berjalan), rit 2 & 3 Ditugaskan (tunai),
 *   rit 4 Ditugaskan tempo. Satu kendala "Jalan ditutup" menunggu konfirmasi Dispatcher.
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji M3 memanggilnya langsung dengan `{ force: true }`.
 */
import { eq } from "drizzle-orm";

import { addDays, toBusinessDate, wibToUtc } from "../../lib/time";
import type { DbOrTx } from "../client";
import { customerAddresses, customers, dailySchedules, deposits, orders, tripIncidents, tripPayments, trips } from "../schema";
import { FUEL_COMPONENT_PER_TRIP, TARIFF_ZONE_SEEDS, productId, tariffZoneId } from "./catalog";
import { customerId } from "./customers";
import { seedId } from "./ids";
import { EMPLOYEE_SEEDS, EQUA_TENANT_ID, employeeId, truckId, userIdByUsername } from "./org";

const emp = (username: string) => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === username)!.no);

type DemoTrip = {
  key: string;
  seq: number;
  customer: string;
  dayOffset: 0 | -1;
  route: number;
  status: "assigned" | "completed";
  payment: "cash" | "credit";
  time: string;
  notes?: string;
};

const DEMO_TRIPS: DemoTrip[] = [
  { key: "y1", seq: 201, customer: "PLG-0008", dayOffset: -1, route: 1, status: "completed", payment: "cash", time: "07:30" },
  { key: "y2", seq: 202, customer: "PLG-0011", dayOffset: -1, route: 2, status: "completed", payment: "cash", time: "10:00" },
  { key: "t1", seq: 203, customer: "PLG-0006", dayOffset: 0, route: 1, status: "completed", payment: "cash", time: "07:00" },
  { key: "t2", seq: 204, customer: "PLG-0020", dayOffset: 0, route: 2, status: "assigned", payment: "cash", time: "09:00", notes: "Tandon umum blok A, hubungi satpam di pos depan." },
  { key: "t3", seq: 205, customer: "PLG-0014", dayOffset: 0, route: 3, status: "assigned", payment: "cash", time: "11:00" },
  { key: "t4", seq: 206, customer: "PLG-0037", dayOffset: 0, route: 4, status: "assigned", payment: "credit", time: "13:00", notes: "Isi kolam anak — tagihan tempo." },
];

async function zonePrice(tx: DbOrTx, addressId: string): Promise<{ price: number; zoneId: string }> {
  const addr = await tx.select({ zoneId: customerAddresses.tariffZoneId }).from(customerAddresses).where(eq(customerAddresses.id, addressId)).limit(1);
  const zoneId = addr[0]?.zoneId ?? tariffZoneId("Z1");
  const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === zoneId) ?? TARIFF_ZONE_SEEDS[0];
  return { price: zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP, zoneId };
}

export async function seedDemoM3Driver(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ trips: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { trips: 0 };
  const today = toBusinessDate(now);
  const yesterday = addDays(today, -1);
  const yy = today.slice(2, 4);
  const dispatcher = userIdByUsername("dispatcher1");
  const finance = userIdByUsername("keuangan1");
  const driverUser = userIdByUsername("sopir2");
  const driverEmp = emp("sopir2");
  const truck = truckId("T2");
  let inserted = 0;

  // Jadwal T2 kemarin & hari ini (terbit).
  for (const offset of [-1, 0] as const) {
    const date = addDays(today, offset);
    const publishedAt = wibToUtc(date, "05:30");
    await tx
      .insert(dailySchedules)
      .values({ id: seedId(`m3:schedule:T2:${offset}`), tenantId: EQUA_TENANT_ID, truckId: truck, businessDate: date, status: "published", publishedAt, publishedBy: dispatcher, createdBy: dispatcher })
      .onConflictDoNothing();
  }

  // Setoran sopir: kemarin Ditutup (riwayat), hari ini Berjalan (tunai rit 1).
  const depYesterday = seedId("m3:deposit:sopir2:-1");
  const depToday = seedId("m3:deposit:sopir2:0");
  const paidYesterday: number[] = [];
  let paidToday = 0;

  for (const t of DEMO_TRIPS) {
    const exists = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId(t.customer))).limit(1);
    if (!exists[0]) continue;
    const { price } = await zonePrice(tx, seedId(`address:${t.customer}:utama`));
    if (t.status === "completed") {
      if (t.dayOffset === -1) paidYesterday.push(price);
      else paidToday += price;
    }
  }

  const yesterdayTotal = paidYesterday.reduce((a, b) => a + b, 0);
  const submittedY = wibToUtc(yesterday, "16:10");
  await tx
    .insert(deposits)
    .values({
      id: depYesterday,
      tenantId: EQUA_TENANT_ID,
      number: `S-${yy}-${String(900_201).padStart(6, "0")}`,
      sourceType: "driver",
      businessDate: yesterday,
      status: "closed",
      depositorUserId: driverUser,
      depositorEmployeeId: driverEmp,
      truckId: truck,
      method: "physical",
      expectedCash: yesterdayTotal,
      expectedNet: yesterdayTotal,
      receivedAmount: yesterdayTotal,
      discrepancyAmount: 0,
      summarySnapshot: { tripsCompleted: paidYesterday.length, tripsFailed: 0, cashTotal: yesterdayTotal, demo: true },
      submittedAt: submittedY,
      receivedAt: new Date(submittedY.getTime() + 20 * 60_000),
      receivedBy: finance,
      closedAt: new Date(submittedY.getTime() + 25 * 60_000),
      closedBy: finance,
      deviceTime: submittedY,
      syncedAt: submittedY,
      createdBy: driverUser,
      createdAt: wibToUtc(yesterday, "08:30"),
    })
    .onConflictDoNothing();
  await tx
    .insert(deposits)
    .values({
      id: depToday,
      tenantId: EQUA_TENANT_ID,
      number: `S-${yy}-${String(900_202).padStart(6, "0")}`,
      sourceType: "driver",
      businessDate: today,
      status: "running",
      depositorUserId: driverUser,
      depositorEmployeeId: driverEmp,
      truckId: truck,
      method: "physical",
      expectedCash: paidToday,
      expectedNet: paidToday,
      createdBy: driverUser,
      createdAt: wibToUtc(today, "08:10"),
    })
    .onConflictDoNothing();

  for (const t of DEMO_TRIPS) {
    const date = addDays(today, t.dayOffset);
    const custId = customerId(t.customer);
    const addressId = seedId(`address:${t.customer}:utama`);
    const exists = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, custId)).limit(1);
    if (!exists[0]) continue;
    const { price, zoneId } = await zonePrice(tx, addressId);
    const orderId = seedId(`m3:order:${t.key}`);
    const number = `P-${yy}-${String(900_000 + t.seq).padStart(6, "0")}`;
    const created = wibToUtc(addDays(date, -1), "15:00");
    const at = wibToUtc(date, t.time);
    const completed = t.status === "completed";
    const res = await tx
      .insert(orders)
      .values({
        id: orderId,
        tenantId: EQUA_TENANT_ID,
        number,
        customerId: custId,
        addressId,
        productId: productId("AIR-TRUK"),
        status: completed ? "completed" : "scheduled",
        source: "office",
        tankCount: 1,
        requestedDate: date,
        requestedTime: t.time,
        paymentMethod: t.payment,
        pricePerTrip: price,
        totalAmount: price,
        priceSource: "zone",
        tariffZoneId: zoneId,
        notes: t.notes ?? null,
        scheduledAt: created,
        completedAt: completed ? new Date(at.getTime() + 50 * 60_000) : null,
        firstDepartedAt: completed ? at : null,
        createdBy: dispatcher,
        createdAt: created,
      })
      .onConflictDoNothing()
      .returning({ id: orders.id });
    if (!res[0]) continue;
    const tripId = seedId(`m3:trip:${t.key}`);
    const doneAt = new Date(at.getTime() + 50 * 60_000);
    await tx
      .insert(trips)
      .values({
        id: tripId,
        tenantId: EQUA_TENANT_ID,
        orderId,
        number: `${number}/1`,
        sequenceInOrder: 1,
        status: t.status,
        customerId: custId,
        addressId,
        truckId: truck,
        scheduledDate: date,
        scheduleId: seedId(`m3:schedule:T2:${t.dayOffset}`),
        routeOrder: t.route,
        publishedAt: wibToUtc(date, "05:30"),
        price,
        paymentMethod: t.payment,
        plannedVolumeL: 5000,
        driverEmployeeId: driverEmp,
        driverUserId: completed ? driverUser : null,
        actualOrder: completed ? t.route : null,
        departedAt: completed ? at : null,
        arrivedAt: completed ? new Date(at.getTime() + 35 * 60_000) : null,
        completedAt: completed ? doneAt : null,
        completionBusinessDate: completed ? date : null,
        deliveredVolumeL: completed ? 5000 : null,
        recipientName: completed ? "Pemilik rumah (demo)" : null,
        deviceTime: completed ? doneAt : null,
        syncedAt: completed ? new Date(doneAt.getTime() + 60_000) : null,
        createdBy: dispatcher,
        createdAt: created,
      })
      .onConflictDoNothing();
    inserted++;
    if (completed) {
      await tx
        .insert(tripPayments)
        .values({
          id: seedId(`m3:payment:${t.key}`),
          tenantId: EQUA_TENANT_ID,
          tripId,
          customerId: custId,
          driverUserId: driverUser,
          method: "cash",
          expectedAmount: price,
          receivedAmount: price,
          underpaymentAmount: 0,
          depositId: t.dayOffset === -1 ? depYesterday : depToday,
          businessDate: date,
          deviceTime: doneAt,
          syncedAt: new Date(doneAt.getTime() + 60_000),
          createdBy: driverUser,
          createdAt: doneAt,
        })
        .onConflictDoNothing();
    }
  }

  // Kendala hari ini menunggu konfirmasi Dispatcher (US-M3-06 KP-3).
  const incidentAt = wibToUtc(today, "08:20");
  const incidentTrip = await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, seedId("m3:trip:t2"))).limit(1);
  if (!incidentTrip[0]) return { trips: inserted };
  await tx
    .insert(tripIncidents)
    .values({
      id: seedId("m3:incident:T2:road"),
      tenantId: EQUA_TENANT_ID,
      tripId: seedId("m3:trip:t2"),
      truckId: truck,
      kind: "road_blocked",
      description: "Jalan Raya Cianjur–Sukabumi ditutup perbaikan jembatan, lewat jalur alternatif (data demo)",
      occurredAt: incidentAt,
      lat: -6.8201,
      lng: 107.1498,
      reportedByUserId: driverUser,
      businessDate: today,
      deviceTime: incidentAt,
      syncedAt: new Date(incidentAt.getTime() + 30_000),
    })
    .onConflictDoNothing();
  return { trips: inserted };
}
