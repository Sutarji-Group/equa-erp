/**
 * Seed demo Kas & Setoran (M4) — idempoten (ID deterministik + ON CONFLICT DO NOTHING); tanggal relatif terhadap hari
 * seed dijalankan agar layar /kas/* tidak kosong. Hanya memakai truk T3/T4/T6 (sopir3, sopir4, sopir6) dan pelanggan
 * yang tidak dipakai demo modul lain; setoran shift D02 (M6) & TK1 (M7) dari demo kemarin dibiarkan "Diajukan"
 * (diterima di skenario E2E/pelatihan). Event domain TIDAK dipancarkan (seed menulis langsung, seperti demo lain).
 *
 * Isi (nomor demo S-/P-/A-YY-9004xx — tidak bertabrakan dengan penomoran otomatis):
 * - H-3: saldo awal kas kantor (cut-over) + hari kas Ditutup.
 * - H-2: setoran sopir3 & sopir4 Ditutup (sopir4 kurang Rp80.000 → selisih DITOLAK pemilik → ganti rugi karyawan,
 *   sebagian dilunasi tunai H-1); setor ke bank Rp1.500.000 (mutasi cocok); pengisian kas kecil; hari kas Ditutup
 *   (KPI-02 tercatat).
 * - H-1 (hari kas masih terbuka): setoran sopir3 DIAJUKAN (2 rit tunai + 1 rit transfer + pengeluaran BBM menunggu
 *   verifikasi), setoran sopir6 Ditutup dengan selisih −Rp55.000 menunggu keputusan pemilik (persetujuan
 *   `cash_discrepancy`), setoran sopir4 Ditutup dengan selisih −Rp5.000 (di bawah ambang, dapat dibuka kembali pemilik),
 *   QRIS shift D02 & TK1 belum dicocokkan, impor mutasi (usulan pasangan QRIS D02 + mutasi tanpa pasangan), pengeluaran
 *   kas kecil + hitung fisik.
 * - Hari ini: pengisian kas kecil Rp750.000 menunggu persetujuan pemilik (`petty_cash`); transfer pelunasan kantor
 *   "Tidak ditemukan" (H-5) — pelunasan transfer PLG-0039 dari demo M5 (`bojong-tf`); piutang sementara M5-nya dibentuk
 *   `seedDemoM5PendingTransfers` sesudah seed ini.
 * - Pelunasan kantor demo M5 (B-39): transfer → transfer masuk `office_payment` (dicocokkan dengan mutasi, kecuali
 *   `bojong-tf` yang "Tidak ditemukan"); tunai pada/sesudah saldo awal kas kantor (H-3) → mutasi kas kantor masuk
 *   "Pelunasan tunai kantor" (yang lebih lama sudah termasuk saldo awal cut-over).
 * - Parameter "ganti rugi aktif" (flag `cash.restitution_active`) diaktifkan untuk tenant EQUA (data demo PP berlaku).
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji dapat memanggilnya dengan `{ force: true }`.
 */
import { and, eq, inArray } from "drizzle-orm";

import { addDays, formatTanggal, toBusinessDate, wibToUtc, type BusinessDate } from "../../lib/time";
import type { DbOrTx } from "../client";
import {
  approvalRequests,
  bankDeposits,
  bankStatementImports,
  bankStatementLines,
  cashDays,
  customerAddresses,
  customerPayments,
  dailySchedules,
  deposits,
  discrepancies,
  featureFlags,
  incomingTransfers,
  officeCashMovements,
  orders,
  pettyCashCounts,
  pettyCashTransactions,
  restitutionSettlements,
  restitutions,
  shifts,
  tripExpenses,
  tripPayments,
  trips,
} from "../schema";
import { FUEL_COMPONENT_PER_TRIP, TARIFF_ZONE_SEEDS, productId, tariffZoneId } from "./catalog";
import { CUSTOMER_SEEDS, customerId } from "./customers";
import { DEMO_M4_NOT_FOUND_TRANSFER_ID, DEMO_M5_PAYMENT_KEYS, demoM5PaymentId } from "./demo-m5-receivables";
import { DEMO_M6_SHIFT_ID } from "./demo-m6-pos";
import { DEMO_M7_SHIFT_ID } from "./demo-m7-store";
import { seedId } from "./ids";
import { EMPLOYEE_SEEDS, EQUA_TENANT_ID, employeeId, outletId, truckId, userIdByUsername } from "./org";

const emp = (username: string) => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === username)!.no);
const yy = (date: BusinessDate) => date.slice(2, 4);
const num = (prefix: string, date: BusinessDate, seq: number) => `${prefix}-${yy(date)}-${String(900_400 + seq).padStart(6, "0")}`;

/** ID deterministik demo M4 (dipakai E2E & panduan). */
export const DEMO_M4 = {
  depositSopir3Yesterday: seedId("m4:demo:deposit:sopir3:-1"),
  depositSopir6Yesterday: seedId("m4:demo:deposit:sopir6:-1"),
  depositSopir4Yesterday: seedId("m4:demo:deposit:sopir4:-1"),
  discrepancySopir6: seedId("m4:demo:discrepancy:sopir6:-1"),
  discrepancySopir4Small: seedId("m4:demo:discrepancy:sopir4:-1"),
  discrepancySopir4Rejected: seedId("m4:demo:discrepancy:sopir4:-2"),
  restitutionSopir4: seedId("m4:demo:restitution:sopir4:-2"),
  bankAccount: seedId("bank_account:operasional"),
} as const;

async function zonePrice(tx: DbOrTx, addressId: string): Promise<{ price: number; zoneId: string }> {
  const addr = await tx.select({ zoneId: customerAddresses.tariffZoneId }).from(customerAddresses).where(eq(customerAddresses.id, addressId)).limit(1);
  const zoneId = addr[0]?.zoneId ?? tariffZoneId("Z1");
  const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === zoneId) ?? TARIFF_ZONE_SEEDS[0];
  return { price: zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP, zoneId };
}

type OfficeMove = { key: string; date: BusinessDate; at: Date; kind: (typeof officeCashMovements.$inferInsert)["kind"]; direction: "in" | "out"; amount: number; sourceObjectType?: string; sourceObjectId?: string; description: string };

export async function seedDemoM4Cash(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ deposits: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { deposits: 0 };
  const today = toBusinessDate(now);
  const d1 = addDays(today, -1);
  const d2 = addDays(today, -2);
  const d3 = addDays(today, -3);
  const d5 = addDays(today, -5);
  const owner = userIdByUsername("pemilik");
  const finance = userIdByUsername("keuangan1");
  const dispatcher = userIdByUsername("dispatcher1");
  const bank = DEMO_M4.bankAccount;
  let depositCount = 0;

  // --- Parameter ganti rugi aktif (6.2b; demo: Peraturan Perusahaan berlaku) ------------------------------------------
  await tx
    .insert(featureFlags)
    .values({
      id: seedId("m4:demo:flag:restitution"),
      key: "cash.restitution_active",
      scopeType: "tenant",
      scopeRefId: EQUA_TENANT_ID,
      enabled: true,
      description: "Ganti rugi karyawan aktif setelah Peraturan Perusahaan berlaku (BR-11, PTB-22).",
      reason: "Data demo: Peraturan Perusahaan tentang ganti rugi kas berlaku.",
      updatedBy: owner,
    })
    .onConflictDoNothing();

  // --- Setoran sopir (H-2 riwayat, H-1) --------------------------------------------------------------------------------
  type DemoDeposit = {
    id: string;
    seq: number;
    date: BusinessDate;
    username: string;
    truck: string;
    status: "submitted" | "closed";
    expectedCash: number;
    expectedNet: number;
    received?: number;
    reason?: "wrong_change" | "damaged_or_counterfeit" | "other";
    note?: string;
    submittedTime: string;
    receivedTime?: string;
  };
  const demoDeposits: DemoDeposit[] = [
    { id: seedId("m4:demo:deposit:sopir3:-2"), seq: 1, date: d2, username: "sopir3", truck: "T3", status: "closed", expectedCash: 650_000, expectedNet: 650_000, received: 650_000, submittedTime: "17:40", receivedTime: "18:05" },
    { id: seedId("m4:demo:deposit:sopir4:-2"), seq: 2, date: d2, username: "sopir4", truck: "T4", status: "closed", expectedCash: 600_000, expectedNet: 600_000, received: 520_000, reason: "other", note: "Uang hilang di jalan, tidak ada bukti", submittedTime: "18:10", receivedTime: "18:40" },
    { id: DEMO_M4.depositSopir6Yesterday, seq: 3, date: d1, username: "sopir6", truck: "T6", status: "closed", expectedCash: 975_000, expectedNet: 975_000, received: 920_000, reason: "damaged_or_counterfeit", note: "Satu lembar Rp50.000 palsu dan Rp5.000 robek", submittedTime: "17:20", receivedTime: "17:45" },
    { id: DEMO_M4.depositSopir4Yesterday, seq: 4, date: d1, username: "sopir4", truck: "T4", status: "closed", expectedCash: 325_000, expectedNet: 325_000, received: 320_000, reason: "wrong_change", note: "Kembalian pelanggan kurang teliti", submittedTime: "16:50", receivedTime: "17:10" },
  ];
  for (const d of demoDeposits) {
    const submittedAt = wibToUtc(d.date, d.submittedTime);
    const receivedAt = d.receivedTime ? wibToUtc(d.date, d.receivedTime) : null;
    const res = await tx
      .insert(deposits)
      .values({
        id: d.id,
        tenantId: EQUA_TENANT_ID,
        number: num("S", d.date, d.seq),
        sourceType: "driver",
        businessDate: d.date,
        status: d.status,
        depositorUserId: userIdByUsername(d.username),
        depositorEmployeeId: emp(d.username),
        truckId: truckId(d.truck),
        method: "physical",
        expectedCash: d.expectedCash,
        expectedNet: d.expectedNet,
        receivedAmount: d.received ?? null,
        discrepancyAmount: d.received !== undefined ? d.received - d.expectedNet : null,
        discrepancyReason: d.reason ?? null,
        discrepancyNote: d.note ?? null,
        summarySnapshot: { demo: true, cashTotal: d.expectedCash },
        receiptSnapshot: receivedAt ? { via: "physical", demo: true } : null,
        submittedAt,
        receivedAt,
        receivedBy: receivedAt ? finance : null,
        closedAt: receivedAt ? new Date(receivedAt.getTime() + 2 * 60_000) : null,
        closedBy: receivedAt ? finance : null,
        deviceTime: submittedAt,
        createdBy: userIdByUsername(d.username),
        createdAt: wibToUtc(d.date, "07:30"),
      })
      .onConflictDoNothing()
      .returning({ id: deposits.id });
    if (res[0]) depositCount++;
  }

  // Selisih: sopir4 H-2 ditolak pemilik → ganti rugi; sopir6 H-1 menunggu pemilik; sopir4 H-1 di bawah ambang (Selesai).
  const rejectedAt = wibToUtc(d1, "08:15");
  await tx
    .insert(discrepancies)
    .values([
      {
        id: DEMO_M4.discrepancySopir4Rejected,
        tenantId: EQUA_TENANT_ID,
        source: "driver",
        depositId: seedId("m4:demo:deposit:sopir4:-2"),
        employeeId: emp("sopir4"),
        userId: userIdByUsername("sopir4"),
        truckId: truckId("T4"),
        businessDate: d2,
        amount: -80_000,
        status: "followed_up",
        reason: "other",
        reasonNote: "Uang hilang di jalan, tidak ada bukti",
        explanation: "Uang hilang di jalan, tidak ada bukti",
        explainedBy: finance,
        explainedAt: wibToUtc(d2, "18:40"),
        requiresOwnerDecision: true,
        decision: "rejected",
        decidedBy: owner,
        decidedAt: rejectedAt,
        decisionReason: "Kelalaian menjaga uang setoran",
        followedUpAt: rejectedAt,
        createdBy: finance,
        createdAt: wibToUtc(d2, "18:40"),
      },
      {
        id: DEMO_M4.discrepancySopir6,
        tenantId: EQUA_TENANT_ID,
        source: "driver",
        depositId: DEMO_M4.depositSopir6Yesterday,
        employeeId: emp("sopir6"),
        userId: userIdByUsername("sopir6"),
        truckId: truckId("T6"),
        businessDate: d1,
        amount: -55_000,
        status: "explained",
        reason: "damaged_or_counterfeit",
        reasonNote: "Satu lembar Rp50.000 palsu dan Rp5.000 robek",
        explanation: "Satu lembar Rp50.000 palsu dan Rp5.000 robek",
        explainedBy: finance,
        explainedAt: wibToUtc(d1, "17:45"),
        requiresOwnerDecision: true,
        createdBy: finance,
        createdAt: wibToUtc(d1, "17:45"),
      },
      {
        id: DEMO_M4.discrepancySopir4Small,
        tenantId: EQUA_TENANT_ID,
        source: "driver",
        depositId: DEMO_M4.depositSopir4Yesterday,
        employeeId: emp("sopir4"),
        userId: userIdByUsername("sopir4"),
        truckId: truckId("T4"),
        businessDate: d1,
        amount: -5_000,
        status: "done",
        reason: "wrong_change",
        reasonNote: "Kembalian pelanggan kurang teliti",
        explanation: "Kembalian pelanggan kurang teliti",
        explainedBy: finance,
        explainedAt: wibToUtc(d1, "17:10"),
        requiresOwnerDecision: false,
        closedBelowThresholdBy: finance,
        closedBelowThresholdAt: wibToUtc(d1, "17:12"),
        doneAt: wibToUtc(d1, "17:12"),
        createdBy: finance,
        createdAt: wibToUtc(d1, "17:10"),
      },
    ])
    .onConflictDoNothing();

  // Persetujuan pemilik yang menunggu: selisih sopir6 (≤ 24 jam) & pengisian kas kecil > PAR-43.
  const approvalAt = wibToUtc(d1, "17:46");
  await tx
    .insert(approvalRequests)
    .values({
      id: seedId("m4:demo:approval:discrepancy:sopir6"),
      tenantId: EQUA_TENANT_ID,
      number: num("A", d1, 1),
      type: "cash_discrepancy",
      status: "submitted",
      requesterUserId: finance,
      requesterRole: "finance_admin",
      approverRole: "owner",
      objectType: "discrepancy",
      objectId: DEMO_M4.discrepancySopir6,
      amount: -55_000,
      reason: "Sopir — T6: selisih −Rp55.000. Alasan: Uang rusak/palsu — satu lembar Rp50.000 palsu dan Rp5.000 robek",
      payload: { link: `/kas/selisih?id=${DEMO_M4.discrepancySopir6}`, source: "driver", businessDate: d1, reason: "damaged_or_counterfeit", depositId: DEMO_M4.depositSopir6Yesterday, demo: true },
      businessDate: d1,
      deadlineAt: new Date(approvalAt.getTime() + 24 * 3_600_000),
      createdAt: approvalAt,
      updatedAt: approvalAt,
    })
    .onConflictDoNothing();
  await tx.update(discrepancies).set({ approvalRequestId: seedId("m4:demo:approval:discrepancy:sopir6") }).where(and(eq(discrepancies.id, DEMO_M4.discrepancySopir6), eq(discrepancies.status, "explained")));

  // Ganti rugi sopir4 (H-2) — sebagian dilunasi tunai H-1.
  await tx
    .insert(restitutions)
    .values({
      id: DEMO_M4.restitutionSopir4,
      tenantId: EQUA_TENANT_ID,
      employeeId: emp("sopir4"),
      discrepancyId: DEMO_M4.discrepancySopir4Rejected,
      businessDate: d2,
      amount: 80_000,
      reason: `Sopir ${formatTanggal(d2, { weekday: false })} (setoran ${num("S", d2, 2)}): Lainnya — ditolak: Kelalaian menjaga uang setoran`,
      status: "partially_settled",
      settledAmount: 30_000,
      createdBy: owner,
      createdAt: rejectedAt,
    })
    .onConflictDoNothing();

  // --- Setoran sopir3 H-1 DIAJUKAN: 2 rit tunai + 1 rit transfer + pengeluaran BBM menunggu verifikasi ------------------
  const truck3 = truckId("T3");
  const driver3 = userIdByUsername("sopir3");
  await tx
    .insert(dailySchedules)
    .values({ id: seedId("m4:demo:schedule:T3:-1"), tenantId: EQUA_TENANT_ID, truckId: truck3, businessDate: d1, status: "published", publishedAt: wibToUtc(d1, "05:30"), publishedBy: dispatcher, createdBy: dispatcher })
    .onConflictDoNothing();
  const demoTrips = [
    { key: "a", seq: 11, customer: "PLG-0022", time: "07:15", method: "cash" as const },
    { key: "b", seq: 12, customer: "PLG-0023", time: "10:30", method: "cash" as const },
    { key: "c", seq: 13, customer: "PLG-0038", time: "13:45", method: "transfer" as const },
  ];
  let cashTotal = 0;
  const cashTrips: { tripId: string; tripNumber: string; customerName: string; amount: number; underpayment: number }[] = [];
  const transfers: { tripNumber: string; customerName: string; amount: number }[] = [];
  const paymentRows: (typeof tripPayments.$inferInsert)[] = [];
  let transferPayment: { id: string; amount: number; customerId: string; tripNumber: string } | null = null;
  for (const t of demoTrips) {
    const custId = customerId(t.customer);
    const addressId = seedId(`address:${t.customer}:utama`);
    const { price, zoneId } = await zonePrice(tx, addressId);
    const orderId = seedId(`m4:demo:order:${t.key}`);
    const number = num("P", d1, t.seq);
    const at = wibToUtc(d1, t.time);
    const doneAt = new Date(at.getTime() + 45 * 60_000);
    await tx
      .insert(orders)
      .values({
        id: orderId,
        tenantId: EQUA_TENANT_ID,
        number,
        customerId: custId,
        addressId,
        productId: productId("AIR-TRUK"),
        status: "completed",
        source: "office",
        tankCount: 1,
        requestedDate: d1,
        requestedTime: t.time,
        paymentMethod: t.method,
        pricePerTrip: price,
        totalAmount: price,
        priceSource: "zone",
        tariffZoneId: zoneId,
        scheduledAt: wibToUtc(addDays(d1, -1), "15:00"),
        completedAt: doneAt,
        firstDepartedAt: at,
        createdBy: dispatcher,
        createdAt: wibToUtc(addDays(d1, -1), "15:00"),
      })
      .onConflictDoNothing();
    const tripId = seedId(`m4:demo:trip:${t.key}`);
    await tx
      .insert(trips)
      .values({
        id: tripId,
        tenantId: EQUA_TENANT_ID,
        orderId,
        number: `${number}/1`,
        sequenceInOrder: 1,
        status: "completed",
        customerId: custId,
        addressId,
        truckId: truck3,
        scheduledDate: d1,
        scheduleId: seedId("m4:demo:schedule:T3:-1"),
        routeOrder: t.seq - 10,
        publishedAt: wibToUtc(d1, "05:30"),
        price,
        paymentMethod: t.method,
        plannedVolumeL: 5000,
        driverEmployeeId: emp("sopir3"),
        driverUserId: driver3,
        actualOrder: t.seq - 10,
        departedAt: at,
        arrivedAt: new Date(at.getTime() + 30 * 60_000),
        completedAt: doneAt,
        completionBusinessDate: d1,
        deliveredVolumeL: 5000,
        recipientName: "Penerima (demo)",
        deviceTime: doneAt,
        syncedAt: new Date(doneAt.getTime() + 60_000),
        createdBy: dispatcher,
        createdAt: wibToUtc(addDays(d1, -1), "15:00"),
      })
      .onConflictDoNothing();
    const paymentId = seedId(`m4:demo:payment:${t.key}`);
    paymentRows.push({
      id: paymentId,
      tenantId: EQUA_TENANT_ID,
      tripId,
      customerId: custId,
      driverUserId: driver3,
      method: t.method,
      expectedAmount: price,
      receivedAmount: price,
      underpaymentAmount: 0,
      depositId: DEMO_M4.depositSopir3Yesterday,
      businessDate: d1,
      deviceTime: doneAt,
      syncedAt: new Date(doneAt.getTime() + 60_000),
      createdBy: driver3,
      createdAt: doneAt,
    });
    if (t.method === "cash") {
      cashTotal += price;
      cashTrips.push({ tripId, tripNumber: `${number}/1`, customerName: t.customer, amount: price, underpayment: 0 });
    } else {
      transfers.push({ tripNumber: `${number}/1`, customerName: t.customer, amount: price });
      transferPayment = { id: paymentId, amount: price, customerId: custId, tripNumber: `${number}/1` };
    }
  }
  const fuel = 50_000;
  const sub3 = await tx
    .insert(deposits)
    .values({
      id: DEMO_M4.depositSopir3Yesterday,
      tenantId: EQUA_TENANT_ID,
      number: num("S", d1, 5),
      sourceType: "driver",
      businessDate: d1,
      status: "submitted",
      depositorUserId: driver3,
      depositorEmployeeId: emp("sopir3"),
      truckId: truck3,
      method: "physical",
      expectedCash: cashTotal,
      expectedNet: cashTotal - fuel,
      summarySnapshot: { demo: true, cashTrips, transfers, credit: [], underpayments: [], collections: [], note: "Setor sore di kantor (data demo)" },
      submittedAt: wibToUtc(d1, "17:55"),
      deviceTime: wibToUtc(d1, "17:55"),
      createdBy: driver3,
      createdAt: wibToUtc(d1, "08:00"),
    })
    .onConflictDoNothing()
    .returning({ id: deposits.id });
  if (sub3[0]) depositCount++;
  await tx.insert(tripPayments).values(paymentRows).onConflictDoNothing();
  await tx
    .insert(tripExpenses)
    .values({
      id: seedId("m4:demo:expense:sopir3:fuel"),
      tenantId: EQUA_TENANT_ID,
      tripId: seedId("m4:demo:trip:b"),
      truckId: truck3,
      driverUserId: driver3,
      businessDate: d1,
      kind: "fuel",
      amount: fuel,
      fundingSource: "cash_on_hand",
      status: "pending_verification",
      depositId: DEMO_M4.depositSopir3Yesterday,
      note: "Solar tambahan rit siang (data demo)",
      deviceTime: wibToUtc(d1, "12:10"),
      createdBy: driver3,
      createdAt: wibToUtc(d1, "12:10"),
    })
    .onConflictDoNothing();

  // --- Transfer masuk ----------------------------------------------------------------------------------------------------
  const transferRows: (typeof incomingTransfers.$inferInsert)[] = [];
  if (transferPayment) {
    transferRows.push({
      id: seedId("m4:demo:transfer:trip_payment"),
      tenantId: EQUA_TENANT_ID,
      sourceKind: "trip_payment",
      sourceObjectType: "trip_payment",
      sourceObjectId: transferPayment.id,
      customerId: transferPayment.customerId,
      amount: transferPayment.amount,
      transferDate: d1,
      businessDate: d1,
      reference: transferPayment.tripNumber,
      sourceUserId: driver3,
      truckId: truck3,
      createdBy: driver3,
      createdAt: wibToUtc(d1, "14:31"),
    });
  }
  const qris = await tx
    .select({ id: shifts.id, outletId: shifts.outletId, qris: shifts.qrisSales, date: shifts.businessDate, operator: shifts.operatorUserId })
    .from(shifts)
    .where(eq(shifts.tenantId, EQUA_TENANT_ID));
  let d02Qris: { amount: number; date: BusinessDate } | null = null;
  for (const s of qris.filter((x) => x.id === DEMO_M6_SHIFT_ID || x.id === DEMO_M7_SHIFT_ID)) {
    if (!s.qris || s.qris <= 0) continue;
    if (s.id === DEMO_M6_SHIFT_ID) d02Qris = { amount: s.qris, date: s.date };
    transferRows.push({
      id: seedId(`m4:demo:transfer:qris:${s.id}`),
      tenantId: EQUA_TENANT_ID,
      sourceKind: "qris_shift",
      sourceObjectType: "shift",
      sourceObjectId: s.id,
      outletId: s.outletId,
      shiftId: s.id,
      amount: s.qris,
      transferDate: s.date,
      businessDate: s.date,
      reference: "QRIS shift (data demo)",
      sourceUserId: s.operator,
      createdAt: wibToUtc(s.date, "21:05"),
    });
  }
  // Pelunasan kantor demo M5 (B-39) — dibaca dari buku piutang bila seed M5 sudah berjalan.
  const m5Payments = await tx
    .select()
    .from(customerPayments)
    .where(and(eq(customerPayments.tenantId, EQUA_TENANT_ID), eq(customerPayments.channel, "office"), inArray(customerPayments.id, DEMO_M5_PAYMENT_KEYS.map(demoM5PaymentId))));
  const bojongId = demoM5PaymentId("bojong-tf");
  const bojong = m5Payments.find((p) => p.id === bojongId);
  transferRows.push({
    id: DEMO_M4_NOT_FOUND_TRANSFER_ID,
    tenantId: EQUA_TENANT_ID,
    sourceKind: "office_payment",
    sourceObjectType: "customer_payment",
    sourceObjectId: bojongId,
    customerId: customerId("PLG-0039"),
    amount: bojong?.amount ?? 350_000,
    transferDate: bojong?.businessDate ?? d5,
    businessDate: bojong?.businessDate ?? d5,
    status: "not_found",
    notFoundAt: wibToUtc(addDays(d5, 3), "06:50"),
    proofAttachmentId: bojong?.proofAttachmentId ?? null,
    reference: "Pelunasan transfer via telepon (data demo)",
    sourceUserId: finance,
    createdBy: finance,
    createdAt: wibToUtc(d5, "10:00"),
  });
  const officeTransferIds = new Map<string, string>([[bojongId, DEMO_M4_NOT_FOUND_TRANSFER_ID]]);
  for (const p of m5Payments.filter((x) => x.method === "transfer" && x.id !== bojongId)) {
    const id = seedId(`m4:demo:transfer:office_payment:${p.id}`);
    const matchedAt = wibToUtc(addDays(p.businessDate, 1), "09:00");
    officeTransferIds.set(p.id, id);
    transferRows.push({
      id,
      tenantId: EQUA_TENANT_ID,
      sourceKind: "office_payment",
      sourceObjectType: "customer_payment",
      sourceObjectId: p.id,
      customerId: p.customerId,
      amount: p.amount,
      transferDate: p.businessDate,
      businessDate: p.businessDate,
      bankAccountId: bank,
      proofAttachmentId: p.proofAttachmentId ?? null,
      status: "matched",
      matchedAt: matchedAt > now ? now : matchedAt,
      matchedBy: finance,
      matchRefDate: p.businessDate,
      matchRefAmount: p.amount,
      matchRefNote: "TRSF E-BANKING CR (mutasi rekening, data demo)",
      reference: p.notes ?? "Pelunasan transfer (data demo)",
      sourceUserId: finance,
      createdBy: finance,
      createdAt: p.createdAt,
    });
  }
  if (transferRows.length) await tx.insert(incomingTransfers).values(transferRows).onConflictDoNothing();
  if (transferPayment) await tx.update(tripPayments).set({ incomingTransferId: seedId("m4:demo:transfer:trip_payment") }).where(eq(tripPayments.id, transferPayment.id));
  for (const [paymentId, transferId] of officeTransferIds) {
    if (m5Payments.some((p) => p.id === paymentId)) await tx.update(customerPayments).set({ incomingTransferId: transferId }).where(eq(customerPayments.id, paymentId));
  }

  // --- Kas kantor, setor bank, kas kecil -------------------------------------------------------------------------------
  const bankDepositId = seedId("m4:demo:bank_deposit:-2");
  await tx
    .insert(bankDeposits)
    .values({ id: bankDepositId, tenantId: EQUA_TENANT_ID, bankAccountId: bank, amount: 1_500_000, businessDate: d2, status: "matched", matchedAt: wibToUtc(d1, "09:00"), matchedBy: finance, notes: "Setor siang ke Bank Demo (data demo)", createdBy: finance, createdAt: wibToUtc(d2, "13:00") })
    .onConflictDoNothing();
  const importId = seedId("m4:demo:statement_import:-1");
  await tx
    .insert(bankStatementImports)
    .values({ id: importId, tenantId: EQUA_TENANT_ID, bankAccountId: bank, originalFilename: "mutasi-demo.csv", periodStart: d2, periodEnd: d1, lineCount: 4, createdBy: finance, createdAt: wibToUtc(d1, "09:00") })
    .onConflictDoNothing();
  const lines: (typeof bankStatementLines.$inferInsert)[] = [
    { id: seedId("m4:demo:line:bank_deposit"), importId, bankAccountId: bank, lineDate: d2, description: "SETORAN TUNAI TELLER", amount: 1_500_000, rowHash: `m4-demo-${d2}-setoran`, status: "matched", matchedBy: finance, matchedAt: wibToUtc(d1, "09:00") },
    { id: seedId("m4:demo:line:giro"), importId, bankAccountId: bank, lineDate: d1, description: "BUNGA JASA GIRO", amount: 1_234, rowHash: `m4-demo-${d1}-giro`, status: "unmatched" },
    { id: seedId("m4:demo:line:admin"), importId, bankAccountId: bank, lineDate: d1, description: "BIAYA ADMINISTRASI", amount: -6_500, rowHash: `m4-demo-${d1}-admin`, status: "unmatched" },
  ];
  if (d02Qris) lines.push({ id: seedId("m4:demo:line:qris_d02"), importId, bankAccountId: bank, lineDate: d02Qris.date, description: "QRIS SETTLEMENT D02", amount: d02Qris.amount, rowHash: `m4-demo-${d02Qris.date}-qris-d02`, status: "unmatched" });
  await tx.insert(bankStatementLines).values(lines).onConflictDoNothing();
  await tx
    .insert(incomingTransfers)
    .values({
      id: seedId("m4:demo:transfer:bank_deposit"),
      tenantId: EQUA_TENANT_ID,
      sourceKind: "bank_deposit_slip",
      sourceObjectType: "bank_deposit",
      sourceObjectId: bankDepositId,
      amount: 1_500_000,
      transferDate: d2,
      businessDate: d2,
      bankAccountId: bank,
      status: "matched",
      matchedAt: wibToUtc(d1, "09:00"),
      matchedBy: finance,
      matchRefDate: d2,
      matchRefAmount: 1_500_000,
      matchRefNote: "SETORAN TUNAI TELLER",
      bankStatementLineId: seedId("m4:demo:line:bank_deposit"),
      notes: "Setor kas kantor ke bank",
      sourceUserId: finance,
      createdBy: finance,
      createdAt: wibToUtc(d2, "13:00"),
    })
    .onConflictDoNothing();

  const pettyTopup = seedId("m4:demo:petty:topup:-2");
  const pettyRows: (typeof pettyCashTransactions.$inferInsert)[] = [
    { id: pettyTopup, tenantId: EQUA_TENANT_ID, businessDate: d2, kind: "topup", amount: 500_000, description: "Isi kas kecil mingguan (data demo)", status: "approved", createdBy: finance, createdAt: wibToUtc(d2, "08:30") },
    { id: seedId("m4:demo:petty:atk:-1"), tenantId: EQUA_TENANT_ID, businessDate: d1, kind: "expense", amount: 45_000, category: "office_supplies", profitCenter: "SHARED", description: "Kertas struk & pulpen kantor (data demo)", status: "approved", createdBy: finance, createdAt: wibToUtc(d1, "10:15") },
    { id: seedId("m4:demo:petty:konsumsi:-1"), tenantId: EQUA_TENANT_ID, businessDate: d1, kind: "expense", amount: 60_000, category: "consumption", profitCenter: "L3", outletId: outletId("D02"), description: "Konsumsi rapat operator depot D02 (data demo)", status: "approved", createdBy: finance, createdAt: wibToUtc(d1, "12:30") },
    { id: seedId("m4:demo:petty:topup:pending"), tenantId: EQUA_TENANT_ID, businessDate: today, kind: "topup", amount: 750_000, description: "Isi kas kecil untuk perbaikan kecil depot (data demo)", status: "pending_approval", approvalRequestId: seedId("m4:demo:approval:petty"), createdBy: finance, createdAt: wibToUtc(today, "08:00") },
  ];
  // Persetujuan pengisian > PAR-43 lebih dulu (FK kas kecil → persetujuan).
  await tx
    .insert(approvalRequests)
    .values({
      id: seedId("m4:demo:approval:petty"),
      tenantId: EQUA_TENANT_ID,
      number: num("A", today, 2),
      type: "petty_cash",
      status: "submitted",
      requesterUserId: finance,
      requesterRole: "finance_admin",
      approverRole: "owner",
      objectType: "petty_cash_transaction",
      objectId: seedId("m4:demo:petty:topup:pending"),
      amount: 750_000,
      reason: "Pengisian kas kecil Rp750.000: Isi kas kecil untuk perbaikan kecil depot (data demo)",
      payload: { link: "/kas/kas-kecil", kind: "topup", demo: true },
      businessDate: today,
      createdAt: wibToUtc(today, "08:00"),
      updatedAt: wibToUtc(today, "08:00"),
    })
    .onConflictDoNothing();
  await tx.insert(pettyCashTransactions).values(pettyRows).onConflictDoNothing();
  await tx
    .insert(pettyCashCounts)
    .values({ id: seedId("m4:demo:petty_count:-1"), tenantId: EQUA_TENANT_ID, countDate: d1, systemBalance: 395_000, physicalAmount: 395_000, difference: 0, createdBy: finance, createdAt: wibToUtc(d1, "16:00") })
    .onConflictDoNothing();

  // Mutasi kas kantor (saldo = Σ masuk − Σ keluar). Setoran sopir2 kemarin (demo M3) ikut masuk kas kantor.
  const sopir2Yesterday = (await tx.select({ id: deposits.id, received: deposits.receivedAmount, receivedAt: deposits.receivedAt }).from(deposits).where(eq(deposits.id, seedId("m3:deposit:sopir2:-1"))).limit(1))[0];
  const moves: OfficeMove[] = [
    { key: "opening", date: d3, at: wibToUtc(d3, "07:00"), kind: "opening_balance", direction: "in", amount: 2_500_000, description: "Saldo awal kas kantor — hitung fisik cut-over (data demo)" },
    { key: "dep:sopir3:-2", date: d2, at: wibToUtc(d2, "18:05"), kind: "deposit_received", direction: "in", amount: 650_000, sourceObjectType: "deposit", sourceObjectId: seedId("m4:demo:deposit:sopir3:-2"), description: `Setoran ${num("S", d2, 1)} (Sopir)` },
    { key: "dep:sopir4:-2", date: d2, at: wibToUtc(d2, "18:40"), kind: "deposit_received", direction: "in", amount: 520_000, sourceObjectType: "deposit", sourceObjectId: seedId("m4:demo:deposit:sopir4:-2"), description: `Setoran ${num("S", d2, 2)} (Sopir)` },
    { key: "bank:-2", date: d2, at: wibToUtc(d2, "13:00"), kind: "bank_deposit", direction: "out", amount: 1_500_000, sourceObjectType: "bank_deposit", sourceObjectId: bankDepositId, description: "Setor ke Bank Demo 0012345678" },
    { key: "petty:-2", date: d2, at: wibToUtc(d2, "08:30"), kind: "petty_cash_topup", direction: "out", amount: 500_000, sourceObjectType: "petty_cash_transaction", sourceObjectId: pettyTopup, description: "Pengisian kas kecil: Isi kas kecil mingguan (data demo)" },
    { key: "dep:sopir6:-1", date: d1, at: wibToUtc(d1, "17:45"), kind: "deposit_received", direction: "in", amount: 920_000, sourceObjectType: "deposit", sourceObjectId: DEMO_M4.depositSopir6Yesterday, description: `Setoran ${num("S", d1, 3)} (Sopir)` },
    { key: "dep:sopir4:-1", date: d1, at: wibToUtc(d1, "17:10"), kind: "deposit_received", direction: "in", amount: 320_000, sourceObjectType: "deposit", sourceObjectId: DEMO_M4.depositSopir4Yesterday, description: `Setoran ${num("S", d1, 4)} (Sopir)` },
  ];
  if (sopir2Yesterday?.received) {
    moves.push({ key: "dep:sopir2:-1", date: d1, at: sopir2Yesterday.receivedAt ?? wibToUtc(d1, "18:00"), kind: "deposit_received", direction: "in", amount: sopir2Yesterday.received, sourceObjectType: "deposit", sourceObjectId: sopir2Yesterday.id, description: "Setoran sopir2 kemarin (demo M3)" });
  }
  // Pelunasan tunai kantor demo M5 pada/sesudah saldo awal kas kantor (H-3) → kas kantor masuk (B-39, US-M4-06).
  for (const p of m5Payments.filter((x) => x.method === "cash" && x.businessDate >= d3 && x.businessDate <= today)) {
    moves.push({ key: `customer_payment:${p.id}`, date: p.businessDate, at: p.createdAt, kind: "customer_payment", direction: "in", amount: p.amount, sourceObjectType: "customer_payment", sourceObjectId: p.id, description: `Pelunasan tunai kantor ${CUSTOMER_SEEDS.find((c) => customerId(c.code) === p.customerId)?.name ?? ""} (data demo M5)`.replace("  ", " ") });
  }
  const settlementId = seedId("m4:demo:restitution_settlement:sopir4");
  moves.push({ key: "restitution:-1", date: d1, at: wibToUtc(d1, "16:30"), kind: "restitution_payment", direction: "in", amount: 30_000, sourceObjectType: "restitution_settlement", sourceObjectId: settlementId, description: "Pelunasan ganti rugi karyawan (setor tunai)" });
  await tx
    .insert(officeCashMovements)
    .values(moves.map((m) => ({ id: seedId(`m4:demo:office_cash:${m.key}`), tenantId: EQUA_TENANT_ID, businessDate: m.date, kind: m.kind, direction: m.direction, amount: m.amount, sourceObjectType: m.sourceObjectType ?? null, sourceObjectId: m.sourceObjectId ?? null, description: m.description, createdBy: finance, createdAt: m.at })))
    .onConflictDoNothing();
  await tx.update(pettyCashTransactions).set({ officeCashMovementId: seedId("m4:demo:office_cash:petty:-2") }).where(eq(pettyCashTransactions.id, pettyTopup));
  await tx
    .insert(restitutionSettlements)
    .values({ id: settlementId, restitutionId: DEMO_M4.restitutionSopir4, amount: 30_000, method: "cash", settledOn: d1, reference: "Setor tunai sopir (data demo)", officeCashMovementId: seedId("m4:demo:office_cash:restitution:-1"), createdBy: finance, createdAt: wibToUtc(d1, "16:30") })
    .onConflictDoNothing();

  // --- Hari kas H-3 & H-2 Ditutup (riwayat KPI-02); H-1 & hari ini terbuka ---------------------------------------------
  const balanceUpTo = (date: BusinessDate) => moves.filter((m) => m.date <= date).reduce((s, m) => s + (m.direction === "in" ? m.amount : -m.amount), 0);
  const closedDays: { date: BusinessDate; lastReceived: Date | null; started: Date; closed: Date }[] = [
    { date: d3, lastReceived: null, started: wibToUtc(d3, "20:30"), closed: wibToUtc(d3, "20:40") },
    { date: d2, lastReceived: wibToUtc(d2, "18:40"), started: wibToUtc(d2, "20:45"), closed: wibToUtc(d2, "20:58") },
  ];
  for (const c of closedDays) {
    const system = balanceUpTo(c.date);
    await tx
      .insert(cashDays)
      .values({
        id: seedId(`m4:demo:cash_day:${c.date}`),
        tenantId: EQUA_TENANT_ID,
        businessDate: c.date,
        status: "closed",
        lastDepositReceivedAt: c.lastReceived,
        closeStartedAt: c.started,
        closedAt: c.closed,
        closedBy: finance,
        closedLate: false,
        officeCashSystem: system,
        officeCashPhysical: system,
        officeCashDifference: 0,
        blockersSnapshot: [],
        createdAt: c.started,
        updatedAt: c.closed,
      })
      .onConflictDoNothing();
  }
  return { deposits: depositCount };
}
