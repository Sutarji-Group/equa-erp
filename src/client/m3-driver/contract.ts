/**
 * M3 — KONTRAK data offline aplikasi sopir (isomorfik, tanpa API peramban): bentuk data referensi pull `m3.today` &
 * `m3.deposits`, payload perintah sinkron `m3.*` / `gps.phone_positions`, dan perhitungan "seharusnya" yang SAMA di
 * perangkat (kas di tangan, ringkasan setor) dan di server (ringkasan terkunci saat Setor). Server hanya mengimpor
 * TIPE dan fungsi murni dari berkas ini.
 *
 * Aturan PRD 7.3: sopir tidak pernah mengetik total/harga/saldo — ia memasukkan uang fisik, volume, dan alasan;
 * angka seharusnya dihitung sistem (Bab 6.1). Harga yang terlihat hanya harga pesanan rit itu (BR-19).
 */
import { haversineMeters, isValidLatLng, type LatLng } from "@/lib/geo";

// =====================================================================================================================
// Perintah sinkron
// =====================================================================================================================

export const M3_COMMANDS = {
  depart: "m3.trip.depart",
  arrive: "m3.trip.arrive",
  complete: "m3.trip.complete",
  fail: "m3.trip.fail",
  fieldCredit: "m3.field_credit.request",
  collection: "m3.collection.create",
  incident: "m3.trip_incident.create",
  explanation: "m3.travel_explanation.create",
  expense: "m3.trip_expense.create",
  depositSubmit: "m3.deposit.submit",
  depositNote: "m3.deposit.note",
  receipt: "m3.receipt.record",
  phonePositions: "gps.phone_positions",
} as const;

export type M3CommandType = (typeof M3_COMMANDS)[keyof typeof M3_COMMANDS];

/** Kunci data referensi (penyedia pull). */
export const M3_REFS = { today: "m3.today", deposits: "m3.deposits" } as const;

// --- Data pull modul lain yang ditampilkan aplikasi sopir (tambahan S5) ----------------------------------------------

/** Pull M5 `m5.customer_credit` (B-33, US-M5-01 KP-3) & P2 `p2.prepaid_trips` (B-65, US-P2-04 KP-4). */
export const M3_EXTERNAL_REFS = { customerCredit: "m5.customer_credit", prepaidTrips: "p2.prepaid_trips" } as const;

/** Cermin `CustomerCreditRef` (src/server/modules/m5-receivables/service/pull.ts). */
export type DriverCustomerCreditRef = {
  customerId: string;
  name: string;
  creditStatus: "cash" | "credit" | "credit_migrated" | "on_hold" | string;
  creditLimit: number;
  /** Saldo piutang = faktur terbuka + belum ditagih. */
  balance: number;
  /** Eksposur (BR-06). */
  exposure: number;
  remaining: number;
  overdue: number;
  onHold: boolean;
};
export type DriverCustomerCreditPull = { date: string; generatedAt: string; customers: DriverCustomerCreditRef[] };

/** Cermin `PrepaidTripPull` (src/server/modules/p2-customer/service/overview.ts). */
export type DriverPrepaidTripsPull = { date: string; trips: { tripId: string; orderId: string; paidAmount: number; paidAt: string | null; reference: string }[] };

/**
 * Status "sudah dibayar di muka" rit (B-65): cara bayar rit `digital` (P2 menandai pesanan & rit saat pembayaran di
 * muka Berhasil) atau tercantum di pull `p2.prepaid_trips`. `paidAmount` null = jumlah belum terunduh (pakai harga).
 */
export function prepaidInfo(trip: Pick<M3TripRef, "id" | "paymentMethod" | "isInternal">, prepaid: DriverPrepaidTripsPull | null | undefined): { paidAmount: number | null; paidAt: string | null } | null {
  if (trip.isInternal) return null;
  const rows = prepaid?.trips.filter((p) => p.tripId === trip.id) ?? [];
  if (!rows.length && trip.paymentMethod !== "digital") return null;
  if (!rows.length) return { paidAmount: null, paidAt: null };
  return { paidAmount: rows.reduce((s, r) => s + r.paidAmount, 0), paidAt: rows.map((r) => r.paidAt).filter((x): x is string => !!x).sort()[0] ?? null };
}

/** Jenis lampiran perangkat (kolom `attachments.kind`). */
export const M3_ATTACHMENT_KINDS = {
  deliveryPhoto: "delivery_photo",
  signature: "signature",
  transferProof: "transfer_proof",
  failPhoto: "trip_fail_photo",
  incidentPhoto: "incident_photo",
  expenseReceipt: "receipt_note",
  depositSlip: "deposit_slip",
  collectionProof: "collection_transfer_proof",
} as const;

export type FieldLocation = { lat: number; lng: number; accuracyM: number | null } | null;

export type DepartPayload = { tripId: string; location: FieldLocation; outOfOrderConfirmed?: boolean };
export type ArrivePayload = { tripId: string; location: FieldLocation; clientDistanceM?: number | null };

export type CompletePaymentPayload =
  | { method: "none" }
  | { method: "cash"; cashReceived: number; underpaymentReasonCode?: string | null; underpaymentReasonText?: string | null }
  | { method: "transfer"; transferAmount: number; underpaymentReasonCode?: string | null; underpaymentReasonText?: string | null }
  | {
      method: "credit";
      /** Wajib bila pesanan bercara-bayar tunai (PTB-19): permintaan `field_payment_to_credit` yang disetujui. */
      creditApprovalId?: string | null;
      /** Tunai yang tetap diterima bila tempo ternyata tidak disetujui (bawaan 0 → seluruhnya kurang bayar). */
      cashReceivedIfRejected?: number;
    }
  /** B-65: rit sudah dibayar di muka lewat aplikasi pelanggan (`paymentMethod: "digital"`) — sopir tidak menagih. */
  | { method: "prepaid" };

export type CompletePayload = {
  tripId: string;
  recipientName: string | null;
  /** Tanda tangan dilewati (kode `signature_skip_reason`). Tanpa ini lampiran `signature` wajib. */
  signatureSkipReason?: string | null;
  deliveredVolumeL: number;
  partialVolumeReason?: string | null;
  partialVolumeNote?: string | null;
  location: FieldLocation;
  /** Jarak lokal (perangkat) ke koordinat alamat; server menghitung ulang (FR-M12-03). */
  clientDistanceM?: number | null;
  locationReason?: string | null;
  locationReasonNote?: string | null;
  payment: CompletePaymentPayload;
};

export type FailPayload = {
  tripId: string;
  reason: "customer_absent" | "customer_refused" | "location_inaccessible" | "truck_broken" | "other";
  note?: string | null;
  loadedWaterDisposition: "carried_to_next" | "returned_to_source" | "unloaded_at_depot";
  location: FieldLocation;
};

export type FieldCreditPayload = { tripId: string; reason: string };

export type CollectionPayload = {
  /** ID pelunasan (UUID dibuat perangkat) = `customer_payments.id`. */
  paymentId: string;
  customerId: string;
  tripId: string;
  method: "cash" | "transfer";
  amount: number;
  /** Faktur terpilih (bawaan: yang tertua); alokasi dari yang tertua. */
  invoiceIds: string[];
};

export type IncidentPayload = {
  incidentId: string;
  tripId?: string | null;
  kind: "truck_broken" | "road_blocked" | "accident" | "other";
  description: string;
  location: FieldLocation;
};

export type ExplanationPayload = { fleetEventId: string; explanation: string };

export type ExpensePayload = {
  expenseId: string;
  tripId?: string | null;
  kind: "fuel" | "toll" | "parking" | "other";
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
  note?: string | null;
};

export type DepositManifest = {
  completedTripIds: string[];
  failedTripIds: string[];
  collectionIds: string[];
  expenseIds: string[];
};

export type DepositSubmitPayload = {
  method: "physical" | "bank_slip";
  note?: string | null;
  /** Daftar yang dicatat perangkat ini untuk pengguna & hari itu (US-M3-09 KP-3 "menunggu sinkron"). */
  manifest: DepositManifest;
  /** Angka yang tampil di perangkat saat menekan Setor (server menghitung ulang; selisih dicatat). */
  deviceExpectedNet?: number | null;
};

export type DepositNotePayload = { depositId: string; note: string };

export type ReceiptPayload = {
  kind: "trip_receipt" | "payment_receipt";
  tripId?: string | null;
  customerPaymentId?: string | null;
  action: "opened" | "skipped";
  reasonCode?: string | null;
  reasonText?: string | null;
  toPhone?: string | null;
  renderedText?: string | null;
};

export type PhonePosition = {
  deviceTime: string;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  speedKmh?: number | null;
  heading?: number | null;
  tripId?: string | null;
};
export type PhonePositionsPayload = { truckId: string; positions: PhonePosition[] };

// =====================================================================================================================
// Data referensi `m3.today`
// =====================================================================================================================

export type M3TripStatus = "assigned" | "departed" | "arrived" | "completed" | "failed";

export type M3PaymentRef = {
  id: string | null;
  tripId: string;
  tripNumber: string;
  customerId: string;
  customerName: string;
  /** `digital` = dibayar di muka lewat aplikasi pelanggan (B-65), tidak menambah kas di tangan. */
  method: "cash" | "transfer" | "credit" | "digital";
  expectedAmount: number;
  receivedAmount: number;
  underpaymentAmount: number;
  originalMethod: string | null;
  recordedAt: string;
  /** Tersimpan di ponsel, belum terkirim. */
  local?: boolean;
};

export type M3TripRef = {
  id: string;
  number: string;
  orderId: string;
  orderNumber: string;
  truckId: string;
  truckCode: string;
  routeOrder: number | null;
  actualOrder: number | null;
  status: M3TripStatus;
  customerId: string;
  customerName: string;
  contactName: string | null;
  customerPhone: string | null;
  addressLabel: string;
  addressText: string;
  /** Alamat singkat untuk daftar (baris pertama alamat). */
  addressShort: string;
  lat: number | null;
  lng: number | null;
  /** US-M3-03 KP-4: koordinat Dikunci → pembandingan jarak; Belum dikunci → lokasi Selesai diusulkan. */
  coordinateLocked: boolean;
  requestedTime: string | null;
  customerNotes: string | null;
  addressNotes: string | null;
  orderNotes: string | null;
  hasSpecialNotes: boolean;
  /** Harga pesanan — SATU-SATUNYA harga yang terlihat sopir (BR-19). */
  price: number;
  paymentMethod: string;
  plannedVolumeL: number;
  isInternal: boolean;
  destinationOutletId: string | null;
  destinationOutletName: string | null;
  /** PTB-18: pesanan bertanda "tagih kurang bayar". */
  collectUnderpayment: boolean;
  creditHold: boolean;
  driverUserId: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failReason: string | null;
  arrivalDistanceM: number | null;
  deliveredVolumeL: number | null;
  recipientName: string | null;
  noLocation: boolean;
  receiptStatus: "none" | "sent" | "skipped";
  /** Pembaruan jadwal setelah terbit (US-M3-01 KP-4): waktu & ringkasan perubahan. */
  update: { at: string; summary: string[] } | null;
  /** Permintaan tunai → tempo (PTB-19) terakhir untuk rit ini. */
  creditRequest: { approvalId: string | null; number: string | null; status: "queued" | "submitted" | "approved" | "rejected" | "expired" | "cancelled"; decisionReason: string | null } | null;
  syncConflict: boolean;
  local?: boolean;
};

export type M3InvoiceRef = {
  id: string;
  number: string;
  kind: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  /** Sisa efektif (sudah dikurangi pelunasan lewat sopir yang tercatat, M5 menerapkan ke faktur). */
  outstanding: number;
  /** PTB-18: faktur kurang bayar tampil paling atas dengan penanda "tagih kurang bayar". */
  isUnderpayment: boolean;
};

export type M3CollectionRef = {
  id: string;
  customerId: string;
  customerName: string;
  tripId: string | null;
  method: "cash" | "transfer";
  amount: number;
  allocations: { invoiceId: string; invoiceNumber: string | null; amount: number }[];
  advanceAmount: number;
  recordedAt: string;
  local?: boolean;
};

export type M3ExpenseRef = {
  id: string;
  tripId: string | null;
  kind: string;
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
  status: string;
  recordedAt: string;
  local?: boolean;
};

export type M3DepositRef = {
  id: string | null;
  number: string | null;
  status: "running" | "submitted" | "received" | "closed";
  businessDate: string;
  submittedAt: string | null;
  submittedLate: boolean;
  method: "physical" | "bank_slip";
  expectedCash: number;
  expectedNet: number;
  reopenReason: string | null;
  local?: boolean;
};

export type M3ExplanationTask = {
  fleetEventId: string;
  kind: string;
  kindLabel: string;
  truckCode: string | null;
  startedAt: string;
  endedAt: string | null;
  businessDate: string;
  distanceM: number | null;
  durationS: number | null;
  lat: number | null;
  lng: number | null;
};

export type M3Lock = {
  kind: "br10" | "par83";
  message: string;
  depositNumber: string | null;
  depositDate: string | null;
};

export type M3Settings = {
  /** PAR-15 volume standar rit (L). */
  standardVolumeL: number;
  /** PAR-16 jarak Selesai: alasan wajib > m / tinjauan pemilik > m. */
  reasonRequiredGtM: number;
  ownerReviewGtM: number;
  /** PAR-38 ukuran foto (KB). */
  maxPhotoKb: number;
  maxDeliveryPhotos: number;
  /** PAR-06 batas tutup kas (HH:mm WIB) — pengingat setor. */
  cashCloseTime: string;
  gpsIntervalS: number;
  fieldCreditWaitMinutes: number;
};

export type M3Today = {
  date: string;
  /** Waktu server saat data dibuat — "data sinkron terakhir" untuk faktur terbuka (US-M3-05 KP-1). */
  generatedAt: string;
  user: { id: string; name: string; employeeId: string | null };
  truck: { id: string; code: string; plateNumber: string | null } | null;
  /** Pelaksana: sopir / kernet pengganti (tombol tindakan) / baca saja (US-M3-01 KP-6). */
  actingRole: "driver" | "substitute" | "readonly";
  readOnlyReason: string | null;
  lock: M3Lock | null;
  trips: M3TripRef[];
  /** Rit yang ditarik kantor setelah terbit (penanda "diperbarui"). */
  withdrawn: { tripId: string; number: string; customerName: string; at: string }[];
  invoicesByCustomer: Record<string, M3InvoiceRef[]>;
  payments: M3PaymentRef[];
  collections: M3CollectionRef[];
  expenses: M3ExpenseRef[];
  deposit: M3DepositRef | null;
  allowBankDeposit: boolean;
  explanationTasks: M3ExplanationTask[];
  gpsTracking: { enabled: boolean; truckId: string | null; intervalS: number };
  receiptTemplates: { trip_receipt: string | null; payment_receipt: string | null };
  company: { name: string; phone: string | null };
  bankAccounts: { id: string; bankName: string; accountNumber: string; accountName: string }[];
  financeContacts: { name: string; phone: string | null }[];
  /** Pemberitahuan untuk pengguna ini (pengingat setor PAR-06, setoran dibuka kembali, keputusan persetujuan) — 24 jam. */
  notices: { id: string; event: string; title: string; body: string | null; createdAt: string }[];
  settings: M3Settings;
};

/** Riwayat setoran & selisih sopir sendiri (pull `m3.deposits`, US-M3-07 KP-4/KP-6). */
export type M3DepositHistoryRow = {
  id: string;
  number: string;
  businessDate: string;
  status: "running" | "submitted" | "received" | "closed";
  method: string;
  expectedCash: number;
  expectedNet: number;
  receivedAmount: number | null;
  discrepancyAmount: number | null;
  discrepancyReason: string | null;
  discrepancyNote: string | null;
  depositorNote: string | null;
  submittedAt: string | null;
  submittedLate: boolean;
  receivedAt: string | null;
  closedAt: string | null;
  discrepancies: { id: string; amount: number; status: string; reason: string | null; explanation: string | null; decisionReason: string | null }[];
  local?: boolean;
};
export type M3DepositHistory = { days: number; rows: M3DepositHistoryRow[] };

// =====================================================================================================================
// Perhitungan murni (perangkat & server)
// =====================================================================================================================

export type DayFigures = {
  completedTrips: number;
  failedTrips: number;
  activeTrips: number;
  cashTrips: { tripId: string; tripNumber: string; customerName: string; amount: number; underpayment: number }[];
  tripCash: number;
  collectionsCash: number;
  collectionsTransfer: number;
  transfers: number;
  credit: number;
  underpayments: number;
  expensesFromCash: number;
  expensesPersonal: number;
  /** Tunai rit + pelunasan tunai. */
  expectedCash: number;
  /** Kas di tangan = tunai rit + pelunasan tunai − pengeluaran dari kas (US-M3-07 KP-1, PTB-20). */
  cashOnHand: number;
};

/**
 * Angka hari itu untuk satu pelaksana (US-M3-07 KP-1/KP-2). `trips` = rit yang dikerjakan pengguna ini
 * (Selesai/Gagal/aktif), `payments/collections/expenses` = catatan pengguna ini pada tanggal itu.
 */
export function computeDayFigures(input: {
  trips: readonly Pick<M3TripRef, "status">[];
  payments: readonly Pick<M3PaymentRef, "tripId" | "tripNumber" | "customerName" | "method" | "receivedAmount" | "underpaymentAmount" | "expectedAmount">[];
  collections: readonly Pick<M3CollectionRef, "method" | "amount">[];
  expenses: readonly Pick<M3ExpenseRef, "fundingSource" | "amount" | "status">[];
}): DayFigures {
  const f: DayFigures = {
    completedTrips: 0,
    failedTrips: 0,
    activeTrips: 0,
    cashTrips: [],
    tripCash: 0,
    collectionsCash: 0,
    collectionsTransfer: 0,
    transfers: 0,
    credit: 0,
    underpayments: 0,
    expensesFromCash: 0,
    expensesPersonal: 0,
    expectedCash: 0,
    cashOnHand: 0,
  };
  for (const t of input.trips) {
    if (t.status === "completed") f.completedTrips++;
    else if (t.status === "failed") f.failedTrips++;
    else if (t.status === "departed" || t.status === "arrived") f.activeTrips++;
  }
  for (const p of input.payments) {
    f.underpayments += p.underpaymentAmount;
    if (p.method === "cash") {
      f.tripCash += p.receivedAmount;
      f.cashTrips.push({ tripId: p.tripId, tripNumber: p.tripNumber, customerName: p.customerName, amount: p.receivedAmount, underpayment: p.underpaymentAmount });
    } else if (p.method === "transfer") f.transfers += p.receivedAmount;
    else if (p.method === "credit") f.credit += p.expectedAmount;
  }
  for (const c of input.collections) {
    if (c.method === "cash") f.collectionsCash += c.amount;
    else f.collectionsTransfer += c.amount;
  }
  for (const e of input.expenses) {
    if (e.status === "rejected") continue;
    if (e.fundingSource === "cash_on_hand") f.expensesFromCash += e.amount;
    else f.expensesPersonal += e.amount;
  }
  f.expectedCash = f.tripCash + f.collectionsCash;
  f.cashOnHand = f.expectedCash - f.expensesFromCash;
  return f;
}

/** Urutan tampil daftar rit (US-M3-01 KP-1): rit aktif & berikutnya di atas (urut rencana), Selesai/Gagal turun. */
export function sortTripsForDriver<T extends Pick<M3TripRef, "status" | "routeOrder" | "number">>(trips: readonly T[]): T[] {
  const rank = (s: M3TripStatus) => (s === "departed" || s === "arrived" ? 0 : s === "assigned" ? 1 : 2);
  return [...trips].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    const o = (a.routeOrder ?? 9999) - (b.routeOrder ?? 9999);
    return o !== 0 ? o : a.number.localeCompare(b.number);
  });
}

/** Rit yang ditonjolkan: rit yang sedang berjalan, bila tidak ada rit Ditugaskan pertama menurut urutan rencana. */
export function nextTrip<T extends Pick<M3TripRef, "status" | "routeOrder" | "number">>(trips: readonly T[]): T | null {
  const sorted = sortTripsForDriver(trips);
  return sorted.find((t) => t.status === "departed" || t.status === "arrived") ?? sorted.find((t) => t.status === "assigned") ?? null;
}

/** Rit aktif (Berangkat/Tiba) truk — hanya satu per truk (US-M3-02 KP-1). */
export function activeTrip<T extends Pick<M3TripRef, "status">>(trips: readonly T[]): T | null {
  return trips.find((t) => t.status === "departed" || t.status === "arrived") ?? null;
}

/** Benar bila rit dimulai di luar urutan rencana (ada rit Ditugaskan lain dengan urutan lebih awal) — US-M3-02 KP-2. */
export function isOutOfOrder<T extends Pick<M3TripRef, "id" | "status" | "routeOrder">>(trips: readonly T[], tripId: string): boolean {
  const trip = trips.find((t) => t.id === tripId);
  if (!trip || trip.routeOrder === null) return false;
  return trips.some((t) => t.id !== tripId && t.status === "assigned" && t.routeOrder !== null && t.routeOrder < trip.routeOrder!);
}

/** Jarak (m, dibulatkan) posisi ke koordinat alamat; null bila salah satunya tidak ada (dihitung lokal, tanpa sinyal). */
export function distanceToAddressM(position: Partial<LatLng> | null | undefined, address: { lat: number | null; lng: number | null }): number | null {
  if (!position || !isValidLatLng(position)) return null;
  if (address.lat === null || address.lng === null) return null;
  const target = { lat: address.lat, lng: address.lng };
  if (!isValidLatLng(target)) return null;
  return Math.round(haversineMeters(position, target));
}

/** BR-23 / PAR-16: `none` (≤ ambang alasan), `reason` (> 200 m alasan wajib), `review` (> 1 km alasan + tinjauan pemilik). */
export function locationRule(distanceM: number | null, rules: Pick<M3Settings, "reasonRequiredGtM" | "ownerReviewGtM">): "none" | "reason" | "review" {
  if (distanceM === null) return "none";
  if (distanceM > rules.ownerReviewGtM) return "review";
  if (distanceM > rules.reasonRequiredGtM) return "reason";
  return "none";
}

/** Faktur terbuka pelanggan urut tampil: kurang bayar paling atas, lalu tertua (US-M3-05 KP-1). */
export function sortInvoicesForCollection<T extends Pick<M3InvoiceRef, "isUnderpayment" | "issueDate" | "number">>(invoices: readonly T[]): T[] {
  return [...invoices].sort((a, b) => {
    if (a.isUnderpayment !== b.isUnderpayment) return a.isUnderpayment ? -1 : 1;
    const d = a.issueDate.localeCompare(b.issueDate);
    return d !== 0 ? d : a.number.localeCompare(b.number);
  });
}

/** Alokasi pelunasan ke faktur TERPILIH dari yang tertua (US-M3-05 KP-2). Sisa di atas total sisa → `excess`. */
export function allocateOldestFirst<T extends Pick<M3InvoiceRef, "id" | "issueDate" | "number" | "outstanding">>(
  invoices: readonly T[],
  amount: number,
): { allocations: { invoiceId: string; amount: number }[]; excess: number } {
  let left = Math.max(0, Math.round(amount));
  const allocations: { invoiceId: string; amount: number }[] = [];
  const ordered = [...invoices].sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  for (const inv of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, inv.outstanding));
    if (take > 0) {
      allocations.push({ invoiceId: inv.id, amount: take });
      left -= take;
    }
  }
  return { allocations, excess: left };
}

/** Isi template `{{variabel}}` (sama dengan `renderTemplate` server) — penanda tanpa nilai menjadi kosong. */
export function renderTemplateText(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template
    .replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => {
      const v = vars[key];
      return v === null || v === undefined ? "" : String(v);
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Nomor WA → format internasional tanpa "+" (62…); null bila tidak sah. */
export function normalizePhoneForWa(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^0-9]/g, "");
  if (d.startsWith("0")) d = `62${d.slice(1)}`;
  else if (d.startsWith("8")) d = `62${d}`;
  return /^62\d{8,13}$/.test(d) ? d : null;
}

/** Tautan wa.me berisi teks struk (PTB-29 versi tautan). */
export function waLink(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/** Tautan navigasi ke aplikasi peta ponsel (US-M3-01 KP-3): koordinat bila ada, selain itu teks alamat. */
export function navigationUrl(trip: Pick<M3TripRef, "lat" | "lng" | "addressText">, platform: "android" | "other" = "android"): string {
  if (trip.lat !== null && trip.lng !== null) {
    return platform === "android"
      ? `geo:${trip.lat},${trip.lng}?q=${trip.lat},${trip.lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${trip.lat},${trip.lng}`;
  }
  const q = encodeURIComponent(trip.addressText);
  return platform === "android" ? `geo:0,0?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/** Baris pertama alamat (maks. 60 karakter) untuk daftar rit. */
export function shortAddress(text: string): string {
  const first = text.split(/\n|,\s*(?=Kec\.|Kel\.|Desa|Kab\.|Kota)/)[0]!.trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}
