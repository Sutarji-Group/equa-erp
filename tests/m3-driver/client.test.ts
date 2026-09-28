/**
 * Uji murni sisi ponsel M3 (tanpa DB/IndexedDB): urutan daftar rit, navigasi, aturan lokasi, alokasi pelunasan,
 * angka kas di tangan, dan reducer optimistis antrean (tampilan tetap benar tanpa sinyal).
 */
import { describe, expect, it } from "vitest";

import {
  activeTrip,
  allocateOldestFirst,
  computeDayFigures,
  distanceToAddressM,
  isOutOfOrder,
  locationRule,
  M3_COMMANDS,
  navigationUrl,
  nextTrip,
  normalizePhoneForWa,
  renderTemplateText,
  shortAddress,
  sortInvoicesForCollection,
  sortTripsForDriver,
  waLink,
  type M3InvoiceRef,
  type M3Today,
  type M3TripRef,
} from "@/client/m3-driver/contract";
import { applyDepositNote, applyM3Command, paymentFromComplete } from "@/client/m3-driver/optimistic";

const RULES = { reasonRequiredGtM: 200, ownerReviewGtM: 1000 };

let n = 0;
function trip(over: Partial<M3TripRef> = {}): M3TripRef {
  n++;
  return {
    id: `trip-${n}`,
    number: `P-26-00000${n}/1`,
    orderId: `order-${n}`,
    orderNumber: `P-26-00000${n}`,
    truckId: "truck-1",
    truckCode: "T1",
    routeOrder: n,
    actualOrder: null,
    status: "assigned",
    customerId: `cust-${n}`,
    customerName: `Pelanggan ${n}`,
    contactName: "Pak RT",
    customerPhone: "0812-3456-7890",
    addressLabel: "Utama",
    addressText: "Jl. Raya Cianjur No. 1, Kec. Cianjur",
    addressShort: "Jl. Raya Cianjur No. 1",
    lat: -6.82,
    lng: 107.14,
    coordinateLocked: true,
    requestedTime: null,
    customerNotes: null,
    addressNotes: null,
    orderNotes: null,
    hasSpecialNotes: false,
    price: 250_000,
    paymentMethod: "cash",
    plannedVolumeL: 5000,
    isInternal: false,
    destinationOutletId: null,
    destinationOutletName: null,
    collectUnderpayment: false,
    creditHold: false,
    driverUserId: null,
    departedAt: null,
    arrivedAt: null,
    completedAt: null,
    failedAt: null,
    failReason: null,
    arrivalDistanceM: null,
    deliveredVolumeL: null,
    recipientName: null,
    noLocation: false,
    receiptStatus: "none",
    update: null,
    creditRequest: null,
    syncConflict: false,
    ...over,
  };
}

function today(trips: M3TripRef[], over: Partial<M3Today> = {}): M3Today {
  return {
    date: "2026-10-05",
    generatedAt: "2026-10-05T01:00:00.000Z",
    user: { id: "user-1", name: "Sopir Uji", employeeId: "emp-1" },
    truck: { id: "truck-1", code: "T1", plateNumber: "F 1234 AB" },
    actingRole: "driver",
    readOnlyReason: null,
    lock: null,
    trips,
    withdrawn: [],
    invoicesByCustomer: {},
    payments: [],
    collections: [],
    expenses: [],
    deposit: null,
    allowBankDeposit: false,
    explanationTasks: [],
    gpsTracking: { enabled: false, truckId: null, intervalS: 60 },
    receiptTemplates: { trip_receipt: null, payment_receipt: null },
    company: { name: "EQUA", phone: null },
    bankAccounts: [],
    financeContacts: [],
    notices: [],
    settings: { standardVolumeL: 5000, reasonRequiredGtM: 200, ownerReviewGtM: 1000, maxPhotoKb: 300, maxDeliveryPhotos: 3, cashCloseTime: "17:00", gpsIntervalS: 60, fieldCreditWaitMinutes: 10 },
    ...over,
  };
}

const ITEM = { id: "cmd-1", userId: "user-1", deviceTime: "2026-10-05T02:00:00.000Z", businessDate: "2026-10-05" };

function invoice(over: Partial<M3InvoiceRef>): M3InvoiceRef {
  return { id: "inv", number: "F-26-000001", kind: "delivery", customerId: "cust-1", issueDate: "2026-09-01", dueDate: "2026-09-15", outstanding: 100_000, isUnderpayment: false, ...over };
}

describe("M3 klien — daftar rit & navigasi", () => {
  it("US-M3-01 KP-1 rit aktif & berikutnya di atas menurut urutan rencana; Selesai/Gagal turun ke bawah; rit berikutnya ditonjolkan", () => {
    const done = trip({ routeOrder: 1, status: "completed" });
    const failed = trip({ routeOrder: 2, status: "failed" });
    const a3 = trip({ routeOrder: 3 });
    const a4 = trip({ routeOrder: 4 });
    const sorted = sortTripsForDriver([a4, done, failed, a3]);
    expect(sorted.map((t) => t.id)).toEqual([a3.id, a4.id, done.id, failed.id]);
    expect(nextTrip([a4, done, a3])?.id).toBe(a3.id);
    const running = trip({ routeOrder: 5, status: "departed" });
    expect(sortTripsForDriver([a3, running])[0]!.id).toBe(running.id);
    expect(nextTrip([a3, running])?.id).toBe(running.id);
    expect(activeTrip([a3, running])?.id).toBe(running.id);
    expect(nextTrip([done, failed])).toBeNull();
    expect(shortAddress("Kp. Sayang RT 02/05, Kec. Cianjur, Kab. Cianjur")).toBe("Kp. Sayang RT 02/05");
    expect(shortAddress("x".repeat(80))).toHaveLength(58);
  });

  it("US-M3-01 KP-3 tombol navigasi: koordinat bila ada; bila belum ada koordinat memakai teks alamat", () => {
    expect(navigationUrl(trip({ lat: -6.8, lng: 107.1 }))).toBe("geo:-6.8,107.1?q=-6.8,107.1");
    expect(navigationUrl(trip({ lat: -6.8, lng: 107.1 }), "other")).toContain("destination=-6.8,107.1");
    const noPoint = trip({ lat: null, lng: null, addressText: "Kp. Pasir Kuda, Cugenang" });
    expect(navigationUrl(noPoint)).toBe(`geo:0,0?q=${encodeURIComponent("Kp. Pasir Kuda, Cugenang")}`);
    expect(navigationUrl(noPoint, "other")).toContain("query=Kp.%20Pasir%20Kuda");
  });

  it("US-M3-02 KP-2 memulai rit di luar urutan rencana dikenali (rit Ditugaskan lain berurutan lebih awal)", () => {
    const first = trip({ routeOrder: 1 });
    const second = trip({ routeOrder: 2 });
    expect(isOutOfOrder([first, second], second.id)).toBe(true);
    expect(isOutOfOrder([first, second], first.id)).toBe(false);
    expect(isOutOfOrder([{ ...first, status: "completed" }, second], second.id)).toBe(false);
  });

  it("US-M3-03 KP-3 jarak Selesai dihitung lokal; > 200 m alasan wajib; > 1 km tinjauan pemilik; tanpa posisi = tanpa aturan", () => {
    const address = { lat: -6.82, lng: 107.14 };
    expect(distanceToAddressM({ lat: -6.82, lng: 107.14 }, address)).toBe(0);
    const d300 = distanceToAddressM({ lat: -6.82 + 300 / 111_320, lng: 107.14 }, address)!;
    expect(d300).toBeGreaterThan(290);
    expect(d300).toBeLessThan(310);
    expect(locationRule(d300, RULES)).toBe("reason");
    expect(locationRule(1500, RULES)).toBe("review");
    expect(locationRule(150, RULES)).toBe("none");
    expect(distanceToAddressM(null, address)).toBeNull();
    expect(distanceToAddressM({ lat: -6.82, lng: 107.14 }, { lat: null, lng: null })).toBeNull();
    expect(locationRule(null, RULES)).toBe("none");
  });
});

describe("M3 klien — pelunasan, struk, kas di tangan", () => {
  it("US-M3-05 KP-1 KP-2 faktur kurang bayar paling atas lalu tertua; pelunasan dialokasikan ke faktur terpilih dari yang tertua, lebih → uang muka", () => {
    const old = invoice({ id: "a", number: "F-1", issueDate: "2026-08-01", outstanding: 100_000 });
    const mid = invoice({ id: "b", number: "F-2", issueDate: "2026-09-01", outstanding: 150_000 });
    const under = invoice({ id: "c", number: "F-3", issueDate: "2026-10-01", outstanding: 50_000, isUnderpayment: true });
    expect(sortInvoicesForCollection([mid, old, under]).map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(allocateOldestFirst([mid, old], 180_000)).toEqual({ allocations: [{ invoiceId: "a", amount: 100_000 }, { invoiceId: "b", amount: 80_000 }], excess: 0 });
    expect(allocateOldestFirst([old], 130_000)).toEqual({ allocations: [{ invoiceId: "a", amount: 100_000 }], excess: 30_000 });
  });

  it("US-M3-03 KP-7 struk WA: template diisi, nomor 08xx dinormalkan ke 62xx; nomor tidak sah → tanpa tautan", () => {
    const text = renderTemplateText("Terima kasih {{nama}}.\n\n\n\nRit {{rit}} {{kosong}}", { nama: "Bu Neneng", rit: "P-26-000001/1", kosong: null });
    expect(text).toBe("Terima kasih Bu Neneng.\n\nRit P-26-000001/1");
    expect(normalizePhoneForWa("0812-3456-7890")).toBe("6281234567890");
    expect(normalizePhoneForWa("+62 812 3456 7890")).toBe("6281234567890");
    expect(normalizePhoneForWa("12345")).toBeNull();
    expect(waLink("6281234567890", "a b")).toBe("https://wa.me/6281234567890?text=a%20b");
  });

  it("US-M3-07 KP-1 kas di tangan = tunai rit + pelunasan tunai − pengeluaran dari kas; transfer & tempo tidak menambah kas", () => {
    const f = computeDayFigures({
      trips: [{ status: "completed" }, { status: "completed" }, { status: "completed" }, { status: "failed" }, { status: "departed" }],
      payments: [
        { tripId: "t1", tripNumber: "R1", customerName: "A", method: "cash", expectedAmount: 250_000, receivedAmount: 200_000, underpaymentAmount: 50_000 },
        { tripId: "t2", tripNumber: "R2", customerName: "B", method: "transfer", expectedAmount: 250_000, receivedAmount: 250_000, underpaymentAmount: 0 },
        { tripId: "t3", tripNumber: "R3", customerName: "C", method: "credit", expectedAmount: 300_000, receivedAmount: 0, underpaymentAmount: 0 },
      ],
      collections: [
        { method: "cash", amount: 100_000 },
        { method: "transfer", amount: 75_000 },
      ],
      expenses: [
        { fundingSource: "cash_on_hand", amount: 40_000, status: "pending_verification" },
        { fundingSource: "personal", amount: 10_000, status: "pending_verification" },
        { fundingSource: "cash_on_hand", amount: 99_000, status: "rejected" },
      ],
    });
    expect(f).toMatchObject({ completedTrips: 3, failedTrips: 1, activeTrips: 1, tripCash: 200_000, transfers: 250_000, credit: 300_000, underpayments: 50_000, collectionsCash: 100_000, collectionsTransfer: 75_000, expensesFromCash: 40_000, expensesPersonal: 10_000, expectedCash: 300_000, cashOnHand: 260_000 });
    expect(f.cashTrips).toEqual([{ tripId: "t1", tripNumber: "R1", customerName: "A", amount: 200_000, underpayment: 50_000 }]);
  });
});

describe("M3 klien — antrean optimistis (tanpa sinyal)", () => {
  it("US-M3-09 KP-1 KP-2 Berangkat → Tiba → Selesai tunai tampil langsung dari antrean; kas di tangan ikut bertambah", () => {
    const t = trip({ price: 300_000 });
    let data = today([t]);
    data = applyM3Command(data, M3_COMMANDS.depart, { tripId: t.id, location: null }, ITEM);
    expect(data.trips[0]).toMatchObject({ status: "departed", noLocation: true, driverUserId: "user-1", local: true });
    data = applyM3Command(data, M3_COMMANDS.arrive, { tripId: t.id, location: { lat: -6.82, lng: 107.14, accuracyM: 10 } }, ITEM);
    expect(data.trips[0]!.status).toBe("arrived");
    data = applyM3Command(
      data,
      M3_COMMANDS.complete,
      { tripId: t.id, recipientName: "Pak RT", signatureSkipReason: null, deliveredVolumeL: 5000, partialVolumeReason: null, partialVolumeNote: null, location: null, clientDistanceM: null, locationReason: null, locationReasonNote: null, payment: { method: "cash", cashReceived: 250_000, underpaymentReasonCode: "customer_short", underpaymentReasonText: null } },
      ITEM,
    );
    expect(data.trips[0]).toMatchObject({ status: "completed", recipientName: "Pak RT", deliveredVolumeL: 5000 });
    expect(data.payments).toHaveLength(1);
    expect(data.payments[0]).toMatchObject({ method: "cash", receivedAmount: 250_000, underpaymentAmount: 50_000, local: true });
    expect(computeDayFigures(data).cashOnHand).toBe(250_000);
    // Perintah ganda (antrean dikirim ulang) tidak menggandakan pembayaran.
    const again = applyM3Command(data, M3_COMMANDS.complete, { tripId: t.id, payment: { method: "cash", cashReceived: 1 } }, ITEM);
    expect(again.payments).toHaveLength(1);
  });

  it("US-M3-04 KP-3 tempo: pesanan tempo → piutang tanpa uang; tunai → tempo belum disetujui → tunai yang tetap diterima + kurang bayar", () => {
    const credit = trip({ paymentMethod: "credit", price: 400_000 });
    expect(paymentFromComplete(credit, { payment: { method: "credit", creditApprovalId: null, cashReceivedIfRejected: 0 } } as never, ITEM.deviceTime)).toMatchObject({ method: "credit", receivedAmount: 0, underpaymentAmount: 0 });
    const cash = trip({ paymentMethod: "cash", price: 400_000 });
    expect(paymentFromComplete(cash, { payment: { method: "credit", creditApprovalId: null, cashReceivedIfRejected: 100_000 } } as never, ITEM.deviceTime)).toMatchObject({ method: "cash", receivedAmount: 100_000, underpaymentAmount: 300_000 });
    const approved = trip({ paymentMethod: "cash", price: 400_000, creditRequest: { approvalId: "ap-1", number: "A-26-000001", status: "approved", decisionReason: null } });
    expect(paymentFromComplete(approved, { payment: { method: "credit", creditApprovalId: "ap-1", cashReceivedIfRejected: 0 } } as never, ITEM.deviceTime)).toMatchObject({ method: "credit", originalMethod: "cash" });
    const internal = trip({ isInternal: true });
    expect(paymentFromComplete(internal, { payment: { method: "none" } } as never, ITEM.deviceTime)).toBeNull();
  });

  it("US-M3-06 KP-1 rit gagal dari antrean; US-M3-05 KP-2 pelunasan mengurangi sisa faktur; US-M3-08 KP-1 pengeluaran menunggu verifikasi", () => {
    const t = trip({ status: "arrived", customerId: "cust-1" });
    let data = today([t], { invoicesByCustomer: { "cust-1": [invoice({ id: "a", issueDate: "2026-08-01", outstanding: 100_000 }), invoice({ id: "b", number: "F-2", issueDate: "2026-09-01", outstanding: 100_000 })] } });
    data = applyM3Command(data, M3_COMMANDS.fail, { tripId: t.id, reason: "customer_absent" }, ITEM);
    expect(data.trips[0]).toMatchObject({ status: "failed", failReason: "customer_absent" });
    data = applyM3Command(data, M3_COMMANDS.collection, { paymentId: "pay-1", customerId: "cust-1", tripId: t.id, invoiceIds: ["a", "b"], method: "cash", amount: 150_000 }, ITEM);
    expect(data.invoicesByCustomer["cust-1"]).toEqual([expect.objectContaining({ id: "b", outstanding: 50_000 })]);
    expect(data.collections[0]).toMatchObject({ amount: 150_000, advanceAmount: 0 });
    const dup = applyM3Command(data, M3_COMMANDS.collection, { paymentId: "pay-1", customerId: "cust-1", invoiceIds: ["b"], method: "cash", amount: 1 }, ITEM);
    expect(dup.collections).toHaveLength(1);
    data = applyM3Command(data, M3_COMMANDS.expense, { expenseId: "exp-1", tripId: null, kind: "fuel", amount: 50_000, fundingSource: "cash_on_hand" }, ITEM);
    expect(data.expenses[0]).toMatchObject({ status: "pending_verification", amount: 50_000 });
    expect(computeDayFigures(data).cashOnHand).toBe(100_000);
  });

  it("US-M3-07 KP-2 Setor dari antrean mengubah status setoran menjadi Diajukan; keterangan sopir atas selisih tampil di riwayat", () => {
    let data = today([], { deposit: { id: "dep-1", number: "S-26-000001", status: "running", businessDate: "2026-10-05", submittedAt: null, submittedLate: false, method: "physical", expectedCash: 500_000, expectedNet: 500_000, reopenReason: null } });
    data = applyM3Command(data, M3_COMMANDS.depositSubmit, { method: "physical", deviceExpectedNet: 450_000 }, ITEM);
    expect(data.deposit).toMatchObject({ status: "submitted", expectedNet: 450_000, local: true });
    const unchanged = applyM3Command(data, M3_COMMANDS.depositSubmit, { method: "physical" }, ITEM);
    expect(unchanged.deposit!.expectedNet).toBe(450_000);
    const history = applyDepositNote(
      { days: 30, rows: [{ id: "dep-0", number: "S-1", businessDate: "2026-10-04", status: "closed", method: "physical", expectedCash: 0, expectedNet: 0, receivedAmount: 0, discrepancyAmount: -5_000, discrepancyReason: null, discrepancyNote: null, depositorNote: null, submittedAt: null, submittedLate: false, receivedAt: null, closedAt: null, discrepancies: [] }] },
      { depositId: "dep-0", note: "Uang kembalian kurang" },
    );
    expect(history.rows[0]).toMatchObject({ depositorNote: "Uang kembalian kurang", local: true });
  });

  it("US-M3-03 KP-7 status struk dari antrean; US-M3-06 KP-4 keterangan perjalanan terisi hilang dari daftar tugas; perintah tak dikenal diabaikan", () => {
    const t = trip({ status: "completed" });
    let data = today([t], { explanationTasks: [{ fleetEventId: "fe-1", kind: "off_route", kindLabel: "Keluar rute", truckCode: "T1", startedAt: ITEM.deviceTime, endedAt: null, businessDate: "2026-10-05", distanceM: null, durationS: null, lat: null, lng: null }] });
    data = applyM3Command(data, M3_COMMANDS.receipt, { kind: "trip_receipt", tripId: t.id, action: "skipped", skipReason: "no_whatsapp" }, ITEM);
    expect(data.trips[0]!.receiptStatus).toBe("skipped");
    data = applyM3Command(data, M3_COMMANDS.explanation, { fleetEventId: "fe-1", explanation: "Jalan ditutup" }, ITEM);
    expect(data.explanationTasks).toHaveLength(0);
    expect(applyM3Command(data, "m3.tidak_ada", {}, ITEM)).toBe(data);
  });
});
