/**
 * Seed demo Pesanan & Penjadwalan Rit (M2) — idempoten (ID deterministik + ON CONFLICT DO NOTHING); tanggal relatif
 * terhadap hari seed dijalankan agar papan jadwal & daftar pesanan tidak kosong. TIDAK membuat permintaan persetujuan
 * dan hanya memakai truk T5 & T7 serta pelanggan yang tidak dirujuk uji modul lain.
 *
 * Isi (nomor pesanan demo P-YY-9xxxxx — tidak bertabrakan dengan penomoran otomatis):
 * - Hari ini: 2 rit terbit di T5 (satu sudah Selesai), 1 rit draf di T7 (pengemudi pengganti kernet T7), 2 rit belum
 *   terjadwal (satu "kemungkinan dobel"), 1 pesanan internal pasokan depot D05, 1 pesanan dengan harga khusus/jam tetap.
 * - Kemarin: 1 rit gagal (pelanggan tidak ada) + kejadian + rit pengganti "perlu jadwal ulang" di kolom Belum terjadwal.
 * - 1 pesanan dibatalkan alasan "dobel" (KPI-06), 1 pesanan besok.
 * - Pola langganan aktif (Senin & Kamis) + satu catatan "gagal dibuat" (kredit ditahan).
 * - Kru: T7 hari ini dikemudikan kernet (pengganti, beralasan); T5 besok kapasitas 4 rit; sopir T5 libur lusa.
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif "hari ini" membuat uji modul lain tidak deterministik);
 * uji M2 memanggilnya langsung dengan `now` tetap dan `{ force: true }` (tests/m2-orders/seed.test.ts).
 */
import { and, eq, lte } from "drizzle-orm";

import { addDays, toBusinessDate, wibToUtc } from "../../lib/time";
import type { DbOrTx } from "../client";
import {
  crewAssignments,
  crewRosters,
  customerAddresses,
  customers,
  dailySchedules,
  orders,
  recurringOrderFailures,
  recurringOrders,
  specialPrices,
  tripIncidents,
  trips,
  truckDayStatus,
} from "../schema";
import { FUEL_COMPONENT_PER_TRIP, TARIFF_ZONE_SEEDS, productId, tariffZoneId } from "./catalog";
import { customerId, internalCustomerId } from "./customers";
import { seedId } from "./ids";
import { EMPLOYEE_SEEDS, EQUA_TENANT_ID, employeeId, outletId, truckId, userIdByUsername } from "./org";

const emp = (username: string) => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === username)!.no);

type DemoOrder = {
  key: string;
  seq: number;
  customer: string;
  internalOutlet?: string;
  dayOffset: number;
  tanks: number;
  time?: string | null;
  payment?: "cash" | "transfer" | "credit" | "internal";
  status: "new" | "scheduled" | "in_delivery" | "completed" | "cancelled";
  notes?: string | null;
  duplicateOf?: string;
  recurring?: boolean;
  cancel?: { reason: "duplicate" | "customer_cancelled"; note: string };
  needsReschedule?: boolean;
  trips: {
    truck?: "T5" | "T7";
    route?: number;
    published?: boolean;
    status?: "assigned" | "departed" | "completed" | "failed";
    withdrawn?: boolean;
    dayOffset?: number;
  }[];
};

const DEMO_ORDERS: DemoOrder[] = [
  { key: "t5a", seq: 1, customer: "PLG-0019", dayOffset: 0, tanks: 1, time: "07:00", status: "completed", trips: [{ truck: "T5", route: 1, published: true, status: "completed" }] },
  { key: "t5b", seq: 2, customer: "PLG-0025", dayOffset: 0, tanks: 1, status: "scheduled", payment: "credit", notes: "Masuk lewat gerbang samping pabrik.", trips: [{ truck: "T5", route: 2, published: true }] },
  { key: "t7a", seq: 3, customer: "PLG-0027", dayOffset: 0, tanks: 2, status: "new", notes: "Isi bak penampung belakang.", trips: [{ truck: "T7", route: 1 }, {}] },
  { key: "open1", seq: 4, customer: "PLG-0007", dayOffset: 0, tanks: 1, status: "new", trips: [{}] },
  { key: "open2", seq: 5, customer: "PLG-0007", dayOffset: 0, tanks: 1, status: "new", duplicateOf: "open1", trips: [{}] },
  { key: "int", seq: 6, customer: "INT", internalOutlet: "D05", dayOffset: 0, tanks: 1, payment: "internal", status: "new", notes: "Pasokan rutin depot Mande.", trips: [{}] },
  { key: "fail", seq: 7, customer: "PLG-0010", dayOffset: -1, tanks: 1, status: "new", needsReschedule: true, trips: [{ truck: "T5", route: 1, published: true, status: "failed", dayOffset: -1 }, {}] },
  { key: "cancel", seq: 8, customer: "PLG-0036", dayOffset: 0, tanks: 1, status: "cancelled", cancel: { reason: "duplicate", note: "Dibatalkan saat input: dobel dengan pesanan telepon pagi" }, trips: [] },
  { key: "tomorrow", seq: 9, customer: "PLG-0037", dayOffset: 1, tanks: 1, time: "09:00", payment: "credit", status: "new", trips: [{}] },
  { key: "rec", seq: 10, customer: "PLG-0035", dayOffset: 1, tanks: 1, time: "08:00", status: "new", recurring: true, trips: [{}] },
];

async function unitPrice(tx: DbOrTx, custId: string, addressId: string, date: string): Promise<{ price: number; source: "zone" | "special" | "internal_transfer"; zoneId: string | null; specialId: string | null }> {
  const sp = await tx
    .select({ id: specialPrices.id, price: specialPrices.price })
    .from(specialPrices)
    .where(and(eq(specialPrices.customerId, custId), eq(specialPrices.status, "active"), lte(specialPrices.validFrom, date)))
    .limit(1);
  if (sp[0]) return { price: sp[0].price, source: "special", zoneId: null, specialId: sp[0].id };
  const addr = await tx.select({ zoneId: customerAddresses.tariffZoneId }).from(customerAddresses).where(eq(customerAddresses.id, addressId)).limit(1);
  const zoneId = addr[0]?.zoneId ?? tariffZoneId("Z1");
  const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === zoneId) ?? TARIFF_ZONE_SEEDS[0];
  return { price: zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP, source: "zone", zoneId, specialId: null };
}

export async function seedDemoM2Orders(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ orders: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { orders: 0 };
  const today = toBusinessDate(now);
  const yy = today.slice(2, 4);
  const dispatcher = userIdByUsername("dispatcher1");
  const created = new Date(now.getTime() - 2 * 3_600_000);
  let inserted = 0;

  // Kru: T7 hari ini dikemudikan kernet T7 (pengganti beralasan), T5 besok kapasitas 4, sopir T5 libur lusa.
  await tx
    .insert(crewAssignments)
    .values({ id: seedId("m2:crew:T7:today"), tenantId: EQUA_TENANT_ID, truckId: truckId("T7"), businessDate: today, driverEmployeeId: emp("kernet7"), source: "helper", reason: "Sopir T7 izin keluarga (data demo)", assignedBy: dispatcher })
    .onConflictDoNothing();
  await tx
    .insert(truckDayStatus)
    .values({ id: seedId("m2:truckday:T5:tomorrow"), tenantId: EQUA_TENANT_ID, truckId: truckId("T5"), businessDate: addDays(today, 1), status: "operating", tripCapacity: 4, reason: "Hari ramai (data demo)", createdBy: dispatcher })
    .onConflictDoNothing();
  await tx
    .insert(crewRosters)
    .values({ id: seedId("m2:roster:sopir5:+2"), tenantId: EQUA_TENANT_ID, employeeId: emp("sopir5"), businessDate: addDays(today, 2), status: "off", notes: "Libur bergantian (data demo)", createdBy: dispatcher })
    .onConflictDoNothing();

  // Pola langganan (Senin & Kamis) + satu catatan gagal dibuat.
  const recurringId = seedId("m2:recurring:PLG-0035");
  await tx
    .insert(recurringOrders)
    .values({
      id: recurringId,
      tenantId: EQUA_TENANT_ID,
      customerId: customerId("PLG-0035"),
      addressId: seedId("address:PLG-0035:utama"),
      pattern: "weekly",
      daysOfWeek: [1, 4],
      tankCount: 1,
      requestedTime: "08:00",
      paymentMethod: "cash",
      startDate: addDays(today, -14),
      status: "active",
      notes: "Kolam & tandon hotel (data demo)",
      createdBy: dispatcher,
    })
    .onConflictDoNothing();
  const recurring2 = seedId("m2:recurring:PLG-0028");
  await tx
    .insert(recurringOrders)
    .values({ id: recurring2, tenantId: EQUA_TENANT_ID, customerId: customerId("PLG-0028"), addressId: seedId("address:PLG-0028:utama"), pattern: "interval", intervalDays: 7, tankCount: 2, paymentMethod: "credit", startDate: addDays(today, -7), status: "paused", notes: "Dijeda: pabrik libur (data demo)", createdBy: dispatcher })
    .onConflictDoNothing();
  await tx
    .insert(recurringOrderFailures)
    .values({ id: seedId("m2:recurring_failure:PLG-0028"), recurringOrderId: recurring2, targetDate: today, reason: "credit_on_hold", message: "Status kredit Ditahan: piutang lewat tempo (data demo)." })
    .onConflictDoNothing();

  const orderIds = new Map<string, string>();
  for (const o of DEMO_ORDERS) {
    const id = seedId(`m2:order:${o.key}`);
    orderIds.set(o.key, id);
    const date = addDays(today, o.dayOffset);
    const custId = o.internalOutlet ? internalCustomerId(o.internalOutlet) : customerId(o.customer);
    const addressId = o.internalOutlet ? seedId(`address:internal:${o.internalOutlet}`) : seedId(`address:${o.customer}:utama`);
    const exists = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, custId)).limit(1);
    if (!exists[0]) continue;
    const price = o.internalOutlet
      ? { ...(await unitPrice(tx, custId, addressId, date)), source: "internal_transfer" as const }
      : await unitPrice(tx, custId, addressId, date);
    const number = `P-${yy}-${String(900_000 + o.seq).padStart(6, "0")}`;
    const payment = o.payment ?? "cash";
    const res = await tx
      .insert(orders)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        number,
        customerId: custId,
        addressId,
        productId: productId(o.internalOutlet ? "AIR-TRUK-INT" : "AIR-TRUK"),
        status: o.status,
        source: o.recurring ? "recurring" : "office",
        tankCount: o.tanks,
        requestedDate: date,
        requestedTime: o.time ?? null,
        paymentMethod: payment,
        pricePerTrip: price.price,
        totalAmount: price.price * o.tanks,
        priceSource: price.source,
        tariffZoneId: price.zoneId,
        specialPriceId: price.specialId,
        notes: o.notes ?? null,
        isInternal: !!o.internalOutlet,
        internalOutletId: o.internalOutlet ? outletId(o.internalOutlet) : null,
        recurringOrderId: o.recurring ? recurringId : null,
        possibleDuplicate: !!o.duplicateOf,
        duplicateOfOrderId: o.duplicateOf ? seedId(`m2:order:${o.duplicateOf}`) : null,
        duplicateReason: o.duplicateOf ? "Pelanggan minta dua kali kirim hari ini (data demo)" : null,
        needsReschedule: o.needsReschedule ?? false,
        scheduledAt: o.status === "scheduled" || o.status === "completed" ? created : null,
        completedAt: o.status === "completed" ? now : null,
        firstDepartedAt: o.status === "completed" ? created : null,
        cancelReason: o.cancel?.reason ?? null,
        cancelNote: o.cancel?.note ?? null,
        cancelledAt: o.cancel ? created : null,
        cancelledBy: o.cancel ? dispatcher : null,
        createdBy: o.recurring ? null : dispatcher,
        createdAt: created,
      })
      .onConflictDoNothing()
      .returning({ id: orders.id });
    if (!res[0]) continue;
    inserted++;
    let seq = 0;
    for (const t of o.trips) {
      seq++;
      const tripDate = addDays(today, t.dayOffset ?? o.dayOffset);
      let scheduleId: string | null = null;
      if (t.truck) {
        scheduleId = seedId(`m2:schedule:${t.truck}:${t.dayOffset ?? o.dayOffset}`);
        await tx
          .insert(dailySchedules)
          .values({ id: scheduleId, tenantId: EQUA_TENANT_ID, truckId: truckId(t.truck), businessDate: tripDate, status: t.published ? "published" : "draft", publishedAt: t.published ? created : null, publishedBy: t.published ? dispatcher : null, createdBy: dispatcher })
          .onConflictDoNothing();
        const sch = await tx.select({ id: dailySchedules.id }).from(dailySchedules).where(and(eq(dailySchedules.truckId, truckId(t.truck)), eq(dailySchedules.businessDate, tripDate))).limit(1);
        scheduleId = sch[0]?.id ?? scheduleId;
      }
      const status = t.status ?? "assigned";
      const driver = t.truck === "T7" ? emp("kernet7") : t.truck === "T5" ? emp("sopir5") : null;
      const tripId = seedId(`m2:trip:${o.key}:${seq}`);
      const at = wibToUtc(tripDate, "08:00");
      await tx
        .insert(trips)
        .values({
          id: tripId,
          tenantId: EQUA_TENANT_ID,
          orderId: id,
          number: `${number}/${seq}`,
          sequenceInOrder: seq,
          status,
          customerId: custId,
          addressId,
          isInternal: !!o.internalOutlet,
          destinationOutletId: o.internalOutlet ? outletId(o.internalOutlet) : null,
          truckId: t.truck ? truckId(t.truck) : null,
          scheduledDate: tripDate,
          scheduleId,
          routeOrder: t.route ?? null,
          publishedAt: t.published ? created : null,
          price: price.price,
          paymentMethod: payment,
          plannedVolumeL: 5000,
          driverEmployeeId: driver,
          driverUserId: status !== "assigned" && t.truck === "T5" ? userIdByUsername("sopir5") : null,
          departedAt: status !== "assigned" ? at : null,
          completedAt: status === "completed" ? new Date(at.getTime() + 3_600_000) : null,
          completionBusinessDate: status === "completed" ? tripDate : null,
          deliveredVolumeL: status === "completed" ? 5000 : null,
          recipientName: status === "completed" ? "Pak Satpam (demo)" : null,
          failedAt: status === "failed" ? new Date(at.getTime() + 3_600_000) : null,
          failReason: status === "failed" ? "customer_absent" : null,
          failNote: status === "failed" ? "Rumah terkunci, telepon tidak diangkat (data demo)" : null,
          createdBy: dispatcher,
        })
        .onConflictDoNothing();
      if (status === "failed") {
        await tx
          .insert(tripIncidents)
          .values({ id: seedId(`m2:incident:${o.key}:${seq}`), tenantId: EQUA_TENANT_ID, tripId, truckId: truckId(t.truck!), kind: "trip_failed", description: "Pelanggan tidak ada — rumah terkunci (data demo)", occurredAt: new Date(at.getTime() + 3_600_000), reportedByUserId: userIdByUsername("sopir5"), businessDate: tripDate })
          .onConflictDoNothing();
      }
    }
  }
  return { orders: inserted };
}
