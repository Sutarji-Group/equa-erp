/**
 * Seed demo Aplikasi Pelanggan (P2, Tahap 2) — idempoten (ID deterministik + ON CONFLICT DO NOTHING). Flag
 * `phase2.customer_app` TETAP mati (D-02): data ini hanya membuat layar kantor `/keluhan/*` tidak kosong dan menjadi
 * contoh saat pemilik mengaktifkan aplikasi.
 *
 * Isi (tanggal relatif hari seed; memakai pelanggan & rit demo M2):
 * - Akun tertaut: PLG-0019 (Perumahan Bumi Pasir Hayam) & PLG-0037 (Kolam Renang Tirta Kencana, Tempo) — nomor WA =
 *   nomor pelanggan M1, persetujuan UU PDP tercatat.
 * - Akun menunggu verifikasi Dispatcher (nama tidak cocok dengan pelanggan PLG-0010, 8.7).
 * - Pesanan aplikasi PLG-0037 lusa slot pagi, belum dikonfirmasi & sudah lewat tenggat PAR-75.
 * - Penilaian 4★ untuk rit Selesai demo M2 (t5a, PLG-0019); keluhan keterlambatan (ditanggapi) & keluhan tagihan
 *   (belum ditanggapi, lewat tenggat); notifikasi aplikasi pelanggan.
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji P2 membuat datanya sendiri.
 */
import { eq } from "drizzle-orm";

import { addDays, toBusinessDate } from "../../lib/time";
import type { DbOrTx } from "../client";
import { complaintActions, complaints, customerAccountRequests, customerAccounts, customerAppOrders, customerNotifications, customers, orders, tripRatings, trips } from "../schema";
import { FUEL_COMPONENT_PER_TRIP, TARIFF_ZONE_SEEDS, productId, tariffZoneId } from "./catalog";
import { customerId } from "./customers";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, truckId, userIdByUsername } from "./org";

async function waPhone(tx: DbOrTx, code: string): Promise<string | null> {
  const [c] = await tx.select({ phone: customers.waPhone }).from(customers).where(eq(customers.id, customerId(code))).limit(1);
  return c?.phone ?? null;
}

export async function seedDemoP2Customer(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ accounts: number; complaints: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { accounts: 0, complaints: 0 };
  const today = toBusinessDate(now);
  const yy = today.slice(2, 4);
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  let accounts = 0;
  let complaintCount = 0;

  // --- Akun tertaut ------------------------------------------------------------------------------------------------
  const linked: { code: string; name: string }[] = [
    { code: "PLG-0019", name: "Perumahan Bumi Pasir Hayam" },
    { code: "PLG-0037", name: "Kolam Renang Tirta Kencana" },
  ];
  for (const l of linked) {
    const phone = await waPhone(tx, l.code);
    if (!phone) continue;
    const res = await tx
      .insert(customerAccounts)
      .values({
        id: seedId(`p2:account:${l.code}`),
        tenantId: EQUA_TENANT_ID,
        phone,
        customerId: customerId(l.code),
        status: "linked",
        displayName: l.name,
        verifiedAt: hoursAgo(72),
        linkedAt: hoursAgo(72),
        consentPdpAt: hoursAgo(72),
        consentVersion: "2026-09",
        lastLoginAt: hoursAgo(3),
        createdAt: hoursAgo(72),
        updatedAt: hoursAgo(3),
      })
      .onConflictDoNothing()
      .returning({ id: customerAccounts.id });
    accounts += res.length;
  }

  // --- Akun menunggu verifikasi (8.7) ---------------------------------------------------------------------------------
  const reviewPhone = await waPhone(tx, "PLG-0010");
  if (reviewPhone) {
    const accId = seedId("p2:account:review");
    const res = await tx
      .insert(customerAccounts)
      .values({ id: accId, tenantId: EQUA_TENANT_ID, phone: reviewPhone, status: "pending_review", displayName: "Rudi Hartono", verifiedAt: hoursAgo(5), consentPdpAt: hoursAgo(5), consentVersion: "2026-09", lastLoginAt: hoursAgo(5), createdAt: hoursAgo(5), updatedAt: hoursAgo(5) })
      .onConflictDoNothing()
      .returning({ id: customerAccounts.id });
    if (res.length) {
      accounts++;
      await tx
        .insert(customerAccountRequests)
        .values({ id: seedId("p2:request:review"), tenantId: EQUA_TENANT_ID, customerAccountId: accId, kind: "review", status: "open", reason: "Nama tidak cocok dengan pelanggan yang memakai nomor WA ini (8.7).", detail: "Rudi Hartono", candidateCustomerId: customerId("PLG-0010"), createdAt: hoursAgo(5), updatedAt: hoursAgo(5) })
        .onConflictDoNothing();
    }
  }

  const accountOf = (code: string) => seedId(`p2:account:${code}`);
  const hasAccount = async (code: string) => (await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.id, accountOf(code))).limit(1)).length > 0;

  // --- Pesanan aplikasi menunggu konfirmasi (lewat tenggat) ------------------------------------------------------------
  if (await hasAccount("PLG-0037")) {
    const orderId = seedId("p2:order:PLG-0037");
    const addressId = seedId("address:PLG-0037:utama");
    const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === tariffZoneId("Z1")) ?? TARIFF_ZONE_SEEDS[0];
    const price = zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP;
    const number = `P-${yy}-${String(900_101).padStart(6, "0")}`;
    const date = addDays(today, 2);
    const created = await tx
      .insert(orders)
      .values({
        id: orderId,
        tenantId: EQUA_TENANT_ID,
        number,
        customerId: customerId("PLG-0037"),
        addressId,
        productId: productId("AIR-TRUK"),
        status: "new",
        source: "customer_app",
        slot: "morning",
        tankCount: 1,
        requestedDate: date,
        requestedTime: "06:00",
        paymentMethod: "credit",
        pricePerTrip: price,
        totalAmount: price,
        priceSource: "zone",
        tariffZoneId: tariffZoneId("Z1"),
        notes: "Dari aplikasi pelanggan: isi kolam sebelum buka pukul 08.00",
        createdByCustomerAccountId: accountOf("PLG-0037"),
        createdAt: hoursAgo(3),
      })
      .onConflictDoNothing()
      .returning({ id: orders.id });
    if (created.length) {
      await tx
        .insert(trips)
        .values({ id: seedId("p2:trip:PLG-0037:1"), tenantId: EQUA_TENANT_ID, orderId, number: `${number}/1`, sequenceInOrder: 1, status: "assigned", customerId: customerId("PLG-0037"), addressId, scheduledDate: date, price, paymentMethod: "credit", plannedVolumeL: 5000 })
        .onConflictDoNothing();
      await tx
        .insert(customerAppOrders)
        .values({ id: seedId("p2:app_order:PLG-0037"), tenantId: EQUA_TENANT_ID, orderId, customerAccountId: accountOf("PLG-0037"), customerId: customerId("PLG-0037"), slot: "morning", paymentPreference: "credit", confirmDueAt: hoursAgo(1), createdAt: hoursAgo(3), updatedAt: hoursAgo(3) })
        .onConflictDoNothing();
    }
  }

  // --- Penilaian & keluhan (rit Selesai demo M2 t5a — PLG-0019, truk T5) ------------------------------------------------
  const t5aTrip = seedId("m2:trip:t5a:1");
  const [trip] = await tx.select({ id: trips.id, status: trips.status, driver: trips.driverEmployeeId }).from(trips).where(eq(trips.id, t5aTrip)).limit(1);
  if (trip && (await hasAccount("PLG-0019"))) {
    if (trip.status === "completed") {
      await tx
        .insert(tripRatings)
        .values({ id: seedId("p2:rating:t5a"), tenantId: EQUA_TENANT_ID, tripId: trip.id, customerAccountId: accountOf("PLG-0019"), customerId: customerId("PLG-0019"), truckId: truckId("T5"), driverEmployeeId: trip.driver, rating: 4, comment: "Air jernih, sopir sopan. Datang sedikit terlambat.", createdAt: hoursAgo(1), updatedAt: hoursAgo(1) })
        .onConflictDoNothing();
    }
    const c1 = seedId("p2:complaint:lateness");
    const r1 = await tx
      .insert(complaints)
      .values({ id: c1, tenantId: EQUA_TENANT_ID, customerAccountId: accountOf("PLG-0019"), customerId: customerId("PLG-0019"), orderId: seedId("m2:order:t5a"), tripId: trip.id, kind: "lateness", description: "Truk datang pukul 09.30, padahal janji pukul 07.00. Warga menunggu sejak pagi.", status: "responded", assignedRole: "dispatcher", dueAt: hoursAgo(-20), firstResponseAt: hoursAgo(1), firstResponseBy: userIdByUsername("dispatcher1"), response: "Mohon maaf, truk tertahan antrean pengisian di sumber. Besok kami jadwalkan paling awal.", createdAt: hoursAgo(2), updatedAt: hoursAgo(1) })
      .onConflictDoNothing()
      .returning({ id: complaints.id });
    if (r1.length) {
      complaintCount++;
      await tx
        .insert(complaintActions)
        .values({ id: seedId("p2:complaint_action:lateness"), complaintId: c1, action: "respond", note: "Mohon maaf, truk tertahan antrean pengisian di sumber. Besok kami jadwalkan paling awal.", visibleToCustomer: true, actorUserId: userIdByUsername("dispatcher1"), createdAt: hoursAgo(1) })
        .onConflictDoNothing();
    }
    await tx
      .insert(customerNotifications)
      .values([
        { id: seedId("p2:notif:t5a:completed"), tenantId: EQUA_TENANT_ID, customerAccountId: accountOf("PLG-0019"), customerId: customerId("PLG-0019"), kind: "delivery_completed", title: "Air sudah diterima — pengiriman pagi ini", body: "5.000 L diterima. Struk digital & penilaian tersedia di aplikasi.", link: `/app/struk/${trip.id}`, objectType: "trip", objectId: trip.id, dedupeKey: `demo:trip_completed:${trip.id}`, createdAt: hoursAgo(1.5) },
        { id: seedId("p2:notif:complaint:responded"), tenantId: EQUA_TENANT_ID, customerAccountId: accountOf("PLG-0019"), customerId: customerId("PLG-0019"), kind: "complaint_update", title: "Keluhan Anda sudah ditanggapi", body: "Mohon maaf, truk tertahan antrean pengisian di sumber.", link: `/app/keluhan/${c1}`, objectType: "complaint", objectId: c1, dedupeKey: `demo:complaint_respond:${c1}`, createdAt: hoursAgo(1) },
      ])
      .onConflictDoNothing();
  }
  if (await hasAccount("PLG-0037")) {
    const c2 = seedId("p2:complaint:billing");
    const r2 = await tx
      .insert(complaints)
      .values({ id: c2, tenantId: EQUA_TENANT_ID, customerAccountId: accountOf("PLG-0037"), customerId: customerId("PLG-0037"), kind: "billing", description: "Faktur bulan lalu tercatat 6 tangki, padahal kami hanya menerima 5 tangki.", status: "submitted", assignedRole: "finance_admin", dueAt: hoursAgo(2), createdAt: hoursAgo(30), updatedAt: hoursAgo(30) })
      .onConflictDoNothing()
      .returning({ id: complaints.id });
    complaintCount += r2.length;
  }
  return { accounts, complaints: complaintCount };
}
