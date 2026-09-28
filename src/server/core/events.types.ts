/**
 * Katalog event domain (docs/ARCHITECTURE.md §8) dengan payload bertipe. Nama event WAJIB sama dengan katalog.
 *
 * BERKAS BERSAMA — modul MENAMBAH event baru dengan menambah entri di `DomainEventMap` + `DOMAIN_EVENT_LABELS`
 * (jangan ubah/rename yang ada). Kolom payload tambahan yang opsional boleh ditambahkan (append) bila perlu.
 *
 * Konvensi payload: ID berupa UUID string; uang = integer rupiah; volume = integer liter; waktu = ISO string (UTC);
 * tanggal bisnis = 'YYYY-MM-DD' (juga tersedia di envelope `DomainEvent.businessDate`). Pusat laba (`profitCenter`)
 * diisi bila modul sumber mengetahuinya (dipakai M11 untuk aturan `from_source`).
 *
 * Payload WAJIB MANDIRI (PTB-47: jurnal retroaktif memutar ulang `domain_events` tanpa membaca ulang objek yang mungkin
 * sudah berubah): sertakan semua nilai yang dibutuhkan pemilihan akun (metode, rekening bank, pusat laba, outlet).
 * Koreksi/pembalik memakai event `*.reversed` / `*.corrected` / `invoice.written_off` / `customer_advance.refunded` /
 * `discrepancy.reopened` di bawah (tinjauan pasca-F3c) — jangan membuat nama sendiri.
 */
import type {
  CreditStatus,
  DepositSourceType,
  EnumValue,
  FleetEventKind,
  InvoiceKind,
  OutletKind,
  PaymentMethod,
  ProfitCenter,
  TripFailReason,
} from "@/lib/labels";

type TripExpenseKind = EnumValue<"trip_expense_kind">;
type OfficeCashKind = EnumValue<"office_cash_kind">;
type ConsumableSource = EnumValue<"consumable_source">;
type TransferSourceKind = EnumValue<"transfer_source_kind">;
type DepositMethod = EnumValue<"deposit_method">;

// --- M2/M3 rit -------------------------------------------------------------------------------------------------------
export interface TripPublishedPayload {
  scheduleId: string;
  truckId: string;
  tripIds: string[];
  /** Nomor revisi jadwal (0 = terbit pertama). */
  revision: number;
}
export interface TripDepartedPayload {
  tripId: string;
  orderId: string;
  truckId: string;
  driverUserId: string | null;
  departedAt: string;
  lat?: number | null;
  lng?: number | null;
}
export interface TripArrivedPayload {
  tripId: string;
  orderId: string;
  truckId: string;
  arrivedAt: string;
  distanceToAddressM?: number | null;
}
export interface TripCompletedPayload {
  tripId: string;
  orderId: string;
  customerId: string;
  truckId: string;
  driverUserId: string | null;
  /** Rit internal pasokan depot (PTB-01): tanpa pembayaran; `destinationOutletId` terisi. */
  isInternal: boolean;
  destinationOutletId?: string | null;
  volumeL: number;
  /** Harga rit dari pesanan (rupiah). */
  price: number;
  paymentMethod: PaymentMethod;
  cashReceived: number;
  transferAmount: number;
  creditAmount: number;
  /** Kurang bayar lapangan (PTB-18) → faktur jatuh tempo H+0. */
  underpaymentAmount: number;
  completedAt: string;
  locationDeviationM?: number | null;
  recordedByOffice: boolean;
  lateSync: boolean;
}
export interface TripFailedPayload {
  tripId: string;
  orderId: string;
  customerId: string;
  truckId: string;
  reason: TripFailReason;
  /** Jumlah rit gagal berturut untuk pelanggan (BR-24). */
  consecutiveFailures: number;
}
export interface TripPaymentRecordedPayload {
  tripPaymentId: string;
  tripId: string;
  customerId: string;
  method: PaymentMethod;
  amount: number;
  driverUserId: string | null;
}
export interface CollectionRecordedPayload {
  customerPaymentId: string;
  customerId: string;
  amount: number;
  /** Kanal pelunasan: sopir, kantor, kasir toko, transfer, pembayaran digital. */
  channel: "driver" | "office" | "store" | "transfer" | "digital";
  method: PaymentMethod;
  allocations: { invoiceId: string; amount: number }[];
  /** Kelebihan bayar menjadi uang muka. */
  advanceAmount: number;
  driverUserId?: string | null;
  outletId?: string | null;
  /** Lini piutang (PRD 7.11.4: L2 truk / L4 toko). */
  profitCenter?: ProfitCenter | null;
  /** Rekening bank penerima (transfer). */
  bankAccountId?: string | null;
  /** Transfer masuk yang dicocokkan (M4). */
  incomingTransferId?: string | null;
}
export interface TripExpenseRecordedPayload {
  tripExpenseId: string;
  tripId?: string | null;
  truckId: string;
  kind: TripExpenseKind;
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
}
export interface ExpenseVerifiedPayload {
  tripExpenseId: string;
  truckId: string;
  kind: TripExpenseKind;
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
  accepted: boolean;
  depositId?: string | null;
}

// --- M4 kas ----------------------------------------------------------------------------------------------------------
export interface DepositSubmittedPayload {
  depositId: string;
  sourceType: DepositSourceType;
  sourceUserId?: string | null;
  truckId?: string | null;
  outletId?: string | null;
  expectedAmount: number;
}
export interface DepositReceivedPayload {
  depositId: string;
  sourceType: DepositSourceType;
  sourceUserId?: string | null;
  truckId?: string | null;
  outletId?: string | null;
  expectedAmount: number;
  receivedAmount: number;
  /** Diterima − seharusnya (negatif = kurang). */
  discrepancyAmount: number;
  receivedBy: string;
  profitCenter?: ProfitCenter | null;
  late: boolean;
  /** Serah fisik / setor bank dengan slip (deposits.method). */
  method?: DepositMethod | null;
  /** Rekening bank (setor bank dengan slip). */
  bankAccountId?: string | null;
  /** Diterima sebagian (setoran tertunda PTB-21). */
  isPartial?: boolean;
}
export interface DepositClosedPayload {
  depositId: string;
  sourceType: DepositSourceType;
  sourceUserId?: string | null;
  closedBy: string;
}
export interface DiscrepancyFormedPayload {
  discrepancyId: string;
  depositId?: string | null;
  sourceType: DepositSourceType | "office_cash" | "stock";
  /** Bertanda (negatif = kurang). */
  amount: number;
  overThreshold: boolean;
  employeeId?: string | null;
  profitCenter?: ProfitCenter | null;
}
export interface DiscrepancyDecidedPayload {
  discrepancyId: string;
  decision: "approved" | "rejected";
  amount: number;
  employeeId?: string | null;
  /** Ganti rugi aktif (flag `cash.restitution_active`) saat keputusan. */
  restitutionActive: boolean;
  profitCenter?: ProfitCenter | null;
}
export interface TransferMatchedPayload {
  incomingTransferId: string;
  amount: number;
  sourceKind: TransferSourceKind;
  bankAccountId?: string | null;
  matchedAt: string;
  /** Objek yang dicocokkan (mis. `trip_payment`, `customer_payment`, `shift`, `bank_deposit`). */
  targetType?: string | null;
  targetId?: string | null;
  customerId?: string | null;
}
export interface TransferNotFoundPayload {
  incomingTransferId: string;
  amount: number;
  sourceKind: TransferSourceKind;
  customerId?: string | null;
}
export interface BankDepositRecordedPayload {
  bankDepositId: string;
  amount: number;
  bankAccountId: string;
  /** Asal uang: kas kantor, setoran outlet, setoran sopir (PTB-23). */
  sourceType: "office" | "outlet" | "driver";
  outletId?: string | null;
}
export interface OfficeCashMovedPayload {
  movementId: string;
  direction: "in" | "out";
  kind: OfficeCashKind;
  amount: number;
}
export interface PettyCashRecordedPayload {
  pettyCashTransactionId: string;
  kind: "topup" | "expense" | "adjustment";
  amount: number;
  category?: string | null;
  profitCenter?: ProfitCenter | null;
  /** Akun beban khusus (bila berbeda dari pemetaan bawaan). */
  accountCode?: string | null;
}
export interface CashDayClosedPayload {
  cashDayId: string;
  closedBy: string;
  late: boolean;
  exceptionCount: number;
}
export interface RestitutionRecordedPayload {
  restitutionId: string;
  employeeId: string;
  amount: number;
  discrepancyId: string;
}
export interface RestitutionSettledPayload {
  restitutionId: string;
  employeeId: string;
  amount: number;
  method: "cash" | "payroll_deduction";
}

// --- M5 piutang ------------------------------------------------------------------------------------------------------
export interface InvoiceIssuedPayload {
  invoiceId: string;
  customerId: string;
  kind: InvoiceKind;
  amount: number;
  dueDate: string;
  tripId?: string | null;
  posSaleId?: string | null;
  /** Lini pendapatan/piutang. */
  profitCenter?: ProfitCenter | null;
  outletId?: string | null;
}
export interface InvoicePaidPayload {
  invoiceId: string;
  customerId: string;
  amount: number;
}
export interface CreditNoteIssuedPayload {
  creditNoteId: string;
  invoiceId?: string | null;
  customerId: string;
  amount: number;
  reason: string;
  /** Lini asal (untuk jurnal pembalik pendapatan). */
  profitCenter?: ProfitCenter | null;
}
export interface PaymentReversedPayload {
  customerPaymentId: string;
  reversalId: string;
  customerId: string;
  amount: number;
  reason: string;
}
export interface CreditStatusChangedPayload {
  customerId: string;
  from: CreditStatus;
  to: CreditStatus;
  reason: string;
  automatic: boolean;
  rule?: string | null;
}

// --- M6/M7 POS & stok ------------------------------------------------------------------------------------------------
export interface ShiftOpenedPayload {
  shiftId: string;
  outletId: string;
  operatorUserId: string | null;
  openingCash: number;
}
export interface ShiftClosedPayload {
  shiftId: string;
  outletId: string;
  operatorUserId: string | null;
  salesTotal: number;
  expectedCash: number;
  countedCash: number;
  cashDiscrepancy: number;
  qrisAmount: number;
  // --- Tambahan opsional M6 (payload mandiri PTB-47; M4 menerima setoran & transfer QRIS, M11 menjurnal) ---
  outletKind?: OutletKind;
  businessDate?: string;
  closedAt?: string;
  /** Kas awal tetap (PAR-57/outlet) & hasil hitung fisik saat buka. */
  openingCash?: number;
  openingCashCounted?: number | null;
  /** Penjualan per cara bayar (transaksi sah + menunggu persetujuan void, PTB-43). */
  salesByMethod?: { cash: number; qris: number; credit: number };
  cashSales?: number;
  qrisCount?: number;
  voidCount?: number;
  voidAmount?: number;
  /** Void menunggu persetujuan pemilik — tetap dihitung sebagai penjualan pada tutup shift (PTB-43). */
  voidPendingCount?: number;
  voidPendingAmount?: number;
  /** Σ setor sebagian (setor bank + slip) selama shift. */
  partialDepositTotal?: number;
  /** Setoran = tunai seharusnya − kas awal tetap − Σ setor sebagian (US-M6-02 KP-5). */
  depositAmount?: number;
  depositId?: string | null;
  /** |selisih kas| ≥ PAR-01 → alur pemilik M4 (US-M6-02 KP-7). */
  cashDiscrepancyOverThreshold?: boolean;
  cashDiscrepancyReason?: string | null;
  salesByProduct?: { productId: string; quantity: number; amount: number; gallonLiters: number }[];
  gallonsSold?: number;
  gallonLitersSold?: number;
  /** Pemakaian bahan seharusnya (resep) vs stok fisik tutup shift (US-M6-02 KP-3, US-M6-04 KP-3). */
  consumableUsage?: { productId: string; expectedUsage: number; systemQty: number; physicalQty: number | null; difference: number | null; reason?: string | null }[];
  consumableUsageValue?: number;
  /** Shift dari perangkat cadangan saat shift lain masih terbuka (7.6.6). */
  syncConflict?: boolean;
}
export interface PosSaleLinePayload {
  productId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}
export interface PosSaleRecordedPayload {
  posSaleId: string;
  outletId: string;
  outletKind: OutletKind;
  shiftId: string;
  method: PaymentMethod;
  total: number;
  discount: number;
  /** HPP rata-rata bergerak (toko). */
  cogs?: number | null;
  customerId?: string | null;
  lines: PosSaleLinePayload[];
  // --- Tambahan opsional M6 ---
  number?: string | null;
  businessDate?: string;
  /** Harga perangkat ≠ harga master berlaku (US-M6-06 KP-4). */
  priceMismatch?: boolean;
  /** Tersinkron setelah shift-nya ditutup (perangkat lain) — ditinjau Admin Keuangan. */
  afterShiftClosed?: boolean;
  qrisReference?: string | null;
}
export interface PosSaleVoidedPayload {
  posSaleId: string;
  outletId: string;
  outletKind: OutletKind;
  shiftId: string;
  method: PaymentMethod;
  total: number;
  cogs?: number | null;
  reason: string;
  // --- Tambahan opsional M6 ---
  businessDate?: string;
  /** Void efektif setelah shift ditutup = transaksi pembalik Admin Keuangan (US-M6-03 KP-2, PTB-43). */
  afterClose?: boolean;
  reversalId?: string | null;
  approvalId?: string | null;
  qrisReference?: string | null;
  lines?: PosSaleLinePayload[];
}
export interface ConsumableUsagePostedPayload {
  shiftId: string;
  outletId: string;
  totalValue: number;
  lines: { productId: string; quantity: number; value: number }[];
}
export interface ConsumableReceivedPayload {
  receiptId: string;
  outletId: string;
  source: ConsumableSource;
  supplierId?: string | null;
  totalValue: number;
}
export interface StockAdjustedPayload {
  stockCountId: string;
  outletId: string;
  outletKind: OutletKind;
  /** Nilai penyesuaian bertanda (negatif = berkurang). */
  totalValue: number;
  lines: { productId: string; quantityDelta: number; value: number }[];
}
export interface InternalTransferSentPayload {
  internalTransferId: string;
  fromOutletId: string;
  toOutletId: string;
  /** Nilai harga mitra (PTB-37). */
  totalValue: number;
  /** HPP toko. */
  totalCost: number;
}
export interface InternalTransferReceivedPayload {
  internalTransferId: string;
  toOutletId: string;
  totalValue: number;
  hasDiscrepancy: boolean;
}
export interface PurchaseReceiptRecordedPayload {
  purchaseReceiptId: string;
  supplierId: string;
  outletId: string;
  total: number;
  paymentMode: "credit" | "cash" | "transfer";
  isOpeningPayable: boolean;
}
export interface SupplierPaymentRecordedPayload {
  supplierPaymentId: string;
  supplierId: string;
  amount: number;
  method: "cash" | "transfer";
}

// --- M8 produksi -----------------------------------------------------------------------------------------------------
export interface WaterSupplyConfirmedPayload {
  waterSupplyReceiptId: string;
  tripId?: string | null;
  outletId: string;
  volumeSentL: number;
  volumeReceivedL: number;
  /** Nilai transfer internal = volume diterima × harga transfer (BR-33, K20). */
  transferValue: number;
  confirmedByOperator: boolean;
  // --- Tambahan opsional M6 ---
  source?: "equa_truck" | "other";
  differenceL?: number;
  differenceReason?: string | null;
  /** Pasokan tanpa konfirmasi operator sampai tutup shift berikutnya (PAR-61). */
  autoAccepted?: boolean;
  shiftId?: string | null;
}
export interface MeterReadingRecordedPayload {
  meterReadingId: string;
  waterSourceId: string;
  meterId: string;
  phase: "morning" | "evening";
  readingL: number;
}
export interface TruckFillRecordedPayload {
  truckFillId: string;
  waterSourceId: string;
  truckId: string;
  tripId?: string | null;
  volumeL: number;
  isSupply: boolean;
}
export interface WaterBalanceComputedPayload {
  waterBalanceId: string;
  waterSourceId: string;
  productionL: number;
  fillsL: number;
  lossL: number;
  lossPct: number;
  overThreshold: boolean;
}

// --- M10/M11/M12/P2/P3 -----------------------------------------------------------------------------------------------
export interface ApprovalDecidedPayload {
  approvalId: string;
  number: string;
  type: string;
  decision: "approved" | "rejected" | "expired";
  objectType: string;
  objectId: string;
  amount?: number | null;
  requesterUserId: string;
  decidedBy?: string | null;
  delegationId?: string | null;
}
export interface FleetEventDetectedPayload {
  fleetEventId: string;
  truckId: string;
  kind: FleetEventKind;
  startedAt: string;
  tripId?: string | null;
}
export interface PeriodClosedPayload {
  periodId: string;
  period: string;
  closedBy: string;
  late: boolean;
}
export interface PeriodLockedPayload {
  periodId: string;
  period: string;
  lockedBy: string;
}
export interface AssetDepreciatedPayload {
  depreciationEntryId: string;
  fixedAssetId: string;
  category: string;
  periodId: string;
  amount: number;
  profitCenter: ProfitCenter;
  outletId?: string | null;
}
export interface PartnerSubscriptionInvoicedPayload {
  invoiceId: string;
  partnerContractId: string;
  partnerTenantId: string;
  amount: number;
  outletCount: number;
}
export interface DigitalPaymentSucceededPayload {
  paymentIntentId: string;
  customerId: string;
  amount: number;
  gatewayFee: number;
  method: string;
  invoiceIds: string[];
}

// --- Koreksi / pembalik (tinjauan pasca-F3c; PRD 7.11.4, 6.7) -------------------------------------------------------
export interface TripCorrectedPayload {
  tripId: string;
  orderId: string;
  customerId: string;
  truckId: string;
  /** Kolom yang dikoreksi Admin Keuangan (m3.trip.correct), nilai lama → baru. */
  changes: Record<string, { from: unknown; to: unknown }>;
  /** Selisih harga (baru − lama) untuk jurnal koreksi pendapatan. */
  priceDelta: number;
  volumeDeltaL: number;
  profitCenter?: ProfitCenter | null;
  reason: string;
}
export interface TripPaymentReversedPayload {
  tripPaymentId: string;
  reversalId: string;
  tripId: string;
  customerId: string;
  method: PaymentMethod;
  amount: number;
  profitCenter?: ProfitCenter | null;
  reason: string;
}
export interface TripExpenseReversedPayload {
  tripExpenseId: string;
  reversalId: string;
  truckId: string;
  kind: TripExpenseKind;
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
  reason: string;
}
export interface BankDepositReversedPayload {
  bankDepositId: string;
  reversalId: string;
  amount: number;
  bankAccountId: string;
  sourceType: "office" | "outlet" | "driver";
  outletId?: string | null;
  reason: string;
}
export interface RestitutionSettlementReversedPayload {
  settlementId: string;
  reversalId: string;
  restitutionId: string;
  employeeId: string;
  amount: number;
  method: "cash" | "payroll_deduction";
  reason: string;
}
export interface ConsumableReceiptReversedPayload {
  receiptId: string;
  reversalId: string;
  outletId: string;
  source: ConsumableSource;
  supplierId?: string | null;
  totalValue: number;
  reason: string;
}
export interface PurchaseReceiptCorrectedPayload {
  purchaseReceiptId: string;
  /** Baris pembalik/pengganti (purchase_receipts.reversal_of_id). */
  correctionId: string;
  supplierId: string;
  outletId: string;
  /** Koreksi nota, retur barang, atau pembalikan penuh (US-M7-02 KP-6). */
  kind: "correction" | "return" | "reversal";
  /** Selisih nilai (negatif = berkurang). */
  amountDelta: number;
  reason: string;
}
export interface InvoiceWrittenOffPayload {
  invoiceId: string;
  customerId: string;
  /** Sisa piutang yang dihapusbukukan. */
  amount: number;
  profitCenter?: ProfitCenter | null;
  approvalId?: string | null;
  reason: string;
}
export interface CustomerAdvanceRefundedPayload {
  customerAdvanceId: string;
  customerId: string;
  amount: number;
  method: PaymentMethod;
  bankAccountId?: string | null;
  approvalId?: string | null;
  reason: string;
}
export interface DiscrepancyReopenedPayload {
  discrepancyId: string;
  previousDecision: "approved" | "rejected";
  amount: number;
  employeeId?: string | null;
  profitCenter?: ProfitCenter | null;
  reason: string;
}

// --- Tambahan modul (M1 → M10): karyawan keluar (BR-37, US-M10-01 KP-5) ------------------------------------------------
/** Tanggal keluar ditetapkan di master karyawan M1; M10 menonaktifkan akun pada hari itu. */
export interface EmployeeExitedPayload {
  employeeId: string;
  /** Tanggal keluar (tanggal bisnis WIB 'YYYY-MM-DD'). */
  exitDate: string;
  tenantId: string;
}

/** Peta tipe event → payload. */
export interface DomainEventMap {
  "trip.published": TripPublishedPayload;
  "trip.departed": TripDepartedPayload;
  "trip.arrived": TripArrivedPayload;
  "trip.completed": TripCompletedPayload;
  "trip.failed": TripFailedPayload;
  "trip.payment_recorded": TripPaymentRecordedPayload;
  "collection.recorded": CollectionRecordedPayload;
  "trip.expense_recorded": TripExpenseRecordedPayload;
  "expense.verified": ExpenseVerifiedPayload;
  "deposit.submitted": DepositSubmittedPayload;
  "deposit.received": DepositReceivedPayload;
  "deposit.closed": DepositClosedPayload;
  "discrepancy.formed": DiscrepancyFormedPayload;
  "discrepancy.decided": DiscrepancyDecidedPayload;
  "transfer.matched": TransferMatchedPayload;
  "transfer.not_found": TransferNotFoundPayload;
  "bank_deposit.recorded": BankDepositRecordedPayload;
  "office_cash.moved": OfficeCashMovedPayload;
  "petty_cash.recorded": PettyCashRecordedPayload;
  "cash_day.closed": CashDayClosedPayload;
  "invoice.issued": InvoiceIssuedPayload;
  "invoice.paid": InvoicePaidPayload;
  "credit_note.issued": CreditNoteIssuedPayload;
  "payment.reversed": PaymentReversedPayload;
  "credit_status.changed": CreditStatusChangedPayload;
  "shift.opened": ShiftOpenedPayload;
  "shift.closed": ShiftClosedPayload;
  "pos_sale.recorded": PosSaleRecordedPayload;
  "pos_sale.voided": PosSaleVoidedPayload;
  "consumable.usage_posted": ConsumableUsagePostedPayload;
  "consumable.received": ConsumableReceivedPayload;
  "stock.adjusted": StockAdjustedPayload;
  "internal_transfer.sent": InternalTransferSentPayload;
  "internal_transfer.received": InternalTransferReceivedPayload;
  "purchase_receipt.recorded": PurchaseReceiptRecordedPayload;
  "supplier_payment.recorded": SupplierPaymentRecordedPayload;
  "water_supply.confirmed": WaterSupplyConfirmedPayload;
  "meter.reading_recorded": MeterReadingRecordedPayload;
  "truck_fill.recorded": TruckFillRecordedPayload;
  "water_balance.computed": WaterBalanceComputedPayload;
  "restitution.recorded": RestitutionRecordedPayload;
  "restitution.settled": RestitutionSettledPayload;
  "approval.decided": ApprovalDecidedPayload;
  "fleet_event.detected": FleetEventDetectedPayload;
  "period.closed": PeriodClosedPayload;
  "period.locked": PeriodLockedPayload;
  "asset.depreciated": AssetDepreciatedPayload;
  "partner.subscription_invoiced": PartnerSubscriptionInvoicedPayload;
  "digital_payment.succeeded": DigitalPaymentSucceededPayload;
  "trip.corrected": TripCorrectedPayload;
  "trip_payment.reversed": TripPaymentReversedPayload;
  "trip_expense.reversed": TripExpenseReversedPayload;
  "bank_deposit.reversed": BankDepositReversedPayload;
  "restitution.settlement_reversed": RestitutionSettlementReversedPayload;
  "consumable.receipt_reversed": ConsumableReceiptReversedPayload;
  "purchase_receipt.corrected": PurchaseReceiptCorrectedPayload;
  "invoice.written_off": InvoiceWrittenOffPayload;
  "customer_advance.refunded": CustomerAdvanceRefundedPayload;
  "discrepancy.reopened": DiscrepancyReopenedPayload;
  "employee.exited": EmployeeExitedPayload;
}

export type DomainEventType = keyof DomainEventMap;

/** Label Indonesia tiap event (juga daftar runtime tipe yang sah). */
export const DOMAIN_EVENT_LABELS: Record<DomainEventType, string> = {
  "trip.published": "Jadwal rit terbit",
  "trip.departed": "Rit berangkat",
  "trip.arrived": "Rit tiba",
  "trip.completed": "Rit selesai",
  "trip.failed": "Rit gagal",
  "trip.payment_recorded": "Pembayaran rit tercatat",
  "collection.recorded": "Pelunasan tercatat",
  "trip.expense_recorded": "Pengeluaran rit tercatat",
  "expense.verified": "Pengeluaran rit diverifikasi",
  "deposit.submitted": "Setoran diajukan",
  "deposit.received": "Setoran diterima",
  "deposit.closed": "Setoran ditutup",
  "discrepancy.formed": "Selisih terbentuk",
  "discrepancy.decided": "Selisih diputuskan",
  "transfer.matched": "Transfer dicocokkan",
  "transfer.not_found": "Transfer tidak ditemukan",
  "bank_deposit.recorded": "Setor ke bank tercatat",
  "office_cash.moved": "Mutasi kas kantor",
  "petty_cash.recorded": "Kas kecil tercatat",
  "cash_day.closed": "Kas harian ditutup",
  "invoice.issued": "Faktur terbit",
  "invoice.paid": "Faktur lunas",
  "credit_note.issued": "Nota kredit terbit",
  "payment.reversed": "Pelunasan dibalik",
  "credit_status.changed": "Status kredit berubah",
  "shift.opened": "Shift dibuka",
  "shift.closed": "Shift ditutup",
  "pos_sale.recorded": "Transaksi POS tercatat",
  "pos_sale.voided": "Transaksi POS di-void",
  "consumable.usage_posted": "Pemakaian bahan diposting",
  "consumable.received": "Bahan habis pakai diterima",
  "stock.adjusted": "Stok disesuaikan",
  "internal_transfer.sent": "Transfer internal dikirim",
  "internal_transfer.received": "Transfer internal diterima",
  "purchase_receipt.recorded": "Nota pembelian tercatat",
  "supplier_payment.recorded": "Pembayaran pemasok tercatat",
  "water_supply.confirmed": "Pasokan air dikonfirmasi",
  "meter.reading_recorded": "Angka meter tercatat",
  "truck_fill.recorded": "Pengisian truk tercatat",
  "water_balance.computed": "Neraca air dihitung",
  "restitution.recorded": "Ganti rugi tercatat",
  "restitution.settled": "Ganti rugi dilunasi",
  "approval.decided": "Persetujuan diputuskan",
  "fleet_event.detected": "Kejadian armada terdeteksi",
  "period.closed": "Periode ditutup",
  "period.locked": "Periode dikunci",
  "asset.depreciated": "Aset disusutkan",
  "partner.subscription_invoiced": "Langganan mitra ditagih",
  "digital_payment.succeeded": "Pembayaran digital berhasil",
  "trip.corrected": "Rit dikoreksi",
  "trip_payment.reversed": "Pembayaran rit dibalik",
  "trip_expense.reversed": "Pengeluaran rit dibalik",
  "bank_deposit.reversed": "Setor ke bank dibalik",
  "restitution.settlement_reversed": "Pelunasan ganti rugi dibalik",
  "consumable.receipt_reversed": "Penerimaan bahan dibalik",
  "purchase_receipt.corrected": "Nota pembelian dikoreksi/diretur",
  "invoice.written_off": "Faktur dihapusbukukan",
  "customer_advance.refunded": "Uang muka dikembalikan",
  "discrepancy.reopened": "Selisih dibuka kembali",
  "employee.exited": "Karyawan keluar",
};

export const DOMAIN_EVENT_TYPES = Object.keys(DOMAIN_EVENT_LABELS) as DomainEventType[];

export function isDomainEventType(value: string): value is DomainEventType {
  return Object.prototype.hasOwnProperty.call(DOMAIN_EVENT_LABELS, value);
}
