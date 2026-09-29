/**
 * M11 — perlakuan jurnal per peristiwa operasional (PRD 7.11.4, US-M11-02 KP-1). Fungsi murni atas payload event
 * (payload mandiri PTB-47) + pencarian akun buku rekening bank. Keputusan anti-posting-ganda:
 *
 * - Pendapatan diakui pada peristiwa SUMBER (rit Selesai, transaksi POS); `invoice.issued` tidak dijurnal (B-31).
 * - Nota kredit `store_return`/`pos_void` tidak membalik pendapatan lagi (sudah lewat `store_return.recorded` /
 *   `pos_sale.voided`); bagian yang sudah dibayar dipindah ke uang muka. `underpayment_conversion` &
 *   `pending_transfer_resolved` hanya reklasifikasi → tanpa jurnal.
 * - `transfer.matched` dari setor bank dengan slip tidak dijurnal (sumber jurnal kas→bank = setoran/setor bank, B-30).
 * - `office_cash.moved` hanya selisih hitung fisik kas kantor (mutasi lain adalah cermin peristiwa sumbernya, B-30).
 * - `deposit.received` metode slip mendebit akun buku rekening bank (`bankAccountId`), bukan kas kantor (B-30).
 */
import "server-only";

import type { EnumValue, ProfitCenter } from "@/lib/labels";

import type { Tx } from "@/server/core/db";
import type { DomainEvent, DomainEventMap, DomainEventType } from "@/server/core/events";
import * as m5 from "@/server/modules/m5-receivables";

import { TRANSFER_SOURCES_NOT_JOURNALED } from "../constants";
import { outlets } from "@/db/schema";
import { eq } from "drizzle-orm";

import { accountsByCode, bankGlAccountId } from "./common";
import { eventDate, type AutoEntry, type EventJournalSpec } from "./posting";

type Ev<T extends DomainEventType> = DomainEvent<T>;

const SOURCE_PC: Record<string, ProfitCenter> = { driver: "L2", depot_shift: "L3", store_shift: "L4" };

function skip(reason: string): EventJournalSpec {
  return { kind: "skip", reason };
}

function journal(
  eventKey: string,
  date: string,
  description: string,
  entries: AutoEntry[],
  sourceObject: { type: string; id: string } | null,
  ref?: string | null,
): EventJournalSpec {
  return { kind: "journal", eventKey, date, description, entries, sourceObject, ref: ref ?? null };
}

// --- M3 rit ---------------------------------------------------------------------------------------------------------

function tripCompleted(e: Ev<"trip.completed">): EventJournalSpec {
  const p = e.payload;
  if (p.isInternal) return skip("Rit internal pasokan depot dijurnal saat pasokan dikonfirmasi (water_supply.confirmed).");
  const date = eventDate(e, p.businessDate);
  const dims = { truckId: p.truckId || null };
  // B-65 (D-11 butir 4): rit prabayar digital — pendapatan diakui saat Selesai; sisi debit piutang langsung dilunasi
  // uang muka pelanggan oleh M5 (`customer_advance.applied` → Dr 2-1201 / Cr 1-1401), bukan kurang bayar/tempo.
  const prepaid = m5.prepaidAmountOfTrip(p);
  return journal(
    "trip.completed",
    date,
    `Pendapatan air truk rit ${p.tripNumber ?? ""}`.trim(),
    [
      { entryKey: "cash", amount: p.cashReceived, ...dims },
      { entryKey: "transfer", amount: p.transferAmount, ...dims },
      { entryKey: "credit", amount: p.creditAmount + p.underpaymentAmount, ...dims, memo: p.underpaymentAmount > 0 ? `Kurang bayar ${p.underpaymentReason ?? ""}`.trim() : null },
      { entryKey: "credit", amount: prepaid, ...dims, memo: "Rit prabayar digital — dilunasi uang muka pelanggan" },
    ],
    { type: "trip", id: p.tripId },
    p.tripNumber ?? null,
  );
}

function tripCorrected(e: Ev<"trip.corrected">): EventJournalSpec {
  const p = e.payload;
  if (!p.priceDelta) return skip("Koreksi rit tanpa perubahan harga.");
  return journal(
    "trip.corrected",
    eventDate(e),
    `Koreksi harga rit: ${p.reason}`,
    [{ eventKey: "trip.completed", entryKey: "credit", amount: p.priceDelta, truckId: p.truckId || null }],
    { type: "trip", id: p.tripId },
  );
}

function tripPaymentReversed(e: Ev<"trip_payment.reversed">): EventJournalSpec {
  const p = e.payload;
  const method = p.method === "transfer" ? "transfer" : p.method === "cash" ? "cash" : null;
  if (!method) return skip("Pembalik pembayaran tempo tidak menggerakkan kas.");
  // Pembayaran tunai/transfer dibatalkan: kas/transfer berkurang, pelanggan kembali berutang (piutang).
  return journal(
    "trip_payment.reversed",
    eventDate(e),
    `Pembalik pembayaran rit: ${p.reason}`,
    [
      { eventKey: "trip.completed", entryKey: method, amount: -p.amount },
      { eventKey: "trip.completed", entryKey: "credit", amount: p.amount },
    ],
    { type: "trip", id: p.tripId },
  );
}

function collectionRecorded(e: Ev<"collection.recorded">): EventJournalSpec {
  const p = e.payload;
  if (p.method === "internal" || p.reclassifiedFromTripPaymentId) return skip("Reklasifikasi tunai rit (7.5.6) tanpa gerak kas.");
  const cash = p.method === "cash";
  const entryKey = cash ? (p.channel === "driver" ? "cash_driver" : p.channel === "store" ? "cash_store" : "cash_office") : "transfer";
  const debitOutletId = cash && p.channel === "store" ? (p.outletId ?? null) : null;
  return journal(
    "collection.recorded",
    eventDate(e, p.businessDate),
    `Pelunasan piutang (${p.channel})`,
    [
      { entryKey, amount: p.amount, debitOutletId, memo: p.notes ?? null },
      { entryKey: "advance", amount: p.advanceAmount },
    ],
    { type: "customer_payment", id: p.customerPaymentId },
  );
}

function expenseVerified(e: Ev<"expense.verified">): EventJournalSpec {
  const p = e.payload;
  if (!p.accepted) return skip("Pengeluaran rit ditolak — tidak dijurnal (selisih setoran).");
  const kind = p.kind as EnumValue<"trip_expense_kind">;
  const base = kind === "fuel" ? "fuel" : kind === "toll" || kind === "parking" ? "toll_parking" : "other";
  const entryKey = p.fundingSource === "personal" ? (base === "fuel" ? "personal_reimbursed" : `personal_${base}`) : base;
  return journal("expense.verified", eventDate(e), `Pengeluaran rit diverifikasi (${kind})`, [{ entryKey, amount: p.amount, truckId: p.truckId || null }], {
    type: "trip_expense",
    id: p.tripExpenseId,
  });
}

// --- M4 kas ---------------------------------------------------------------------------------------------------------

async function depositReceived(tx: Tx, e: Ev<"deposit.received">): Promise<EventJournalSpec> {
  const p = e.payload;
  const expected = p.expectedAmount;
  const received = p.receivedAmount;
  const diff = p.discrepancyAmount ?? received - expected;
  const shortage = diff < 0 ? -diff : 0;
  const overage = diff > 0 ? diff : 0;
  const pc = p.profitCenter ?? SOURCE_PC[p.sourceType] ?? "SHARED";
  const outletId = p.outletId ?? null;
  const bankGl = p.method === "bank_slip" ? await bankGlAccountId(tx, p.bankAccountId) : null;
  const main = { entryKey: p.sourceType, amount: received - overage, creditOutletId: outletId, truckId: p.truckId ?? null, debitAccountId: bankGl };
  const shortageKey = p.sourceType === "driver" ? "shortage" : `shortage_${p.sourceType}`;
  return journal(
    "deposit.received",
    eventDate(e, p.businessDate),
    `Setoran diterima ${p.depositNumber ?? ""}`.trim(),
    [
      main,
      { entryKey: shortageKey, amount: shortage, profitCenter: pc, creditOutletId: outletId, truckId: p.truckId ?? null, memo: p.discrepancyReason ? `Selisih kurang: ${p.discrepancyReason}` : null },
      { entryKey: "overage", amount: overage, debitAccountId: bankGl },
    ],
    { type: "deposit", id: p.depositId },
    p.depositNumber ?? null,
  );
}

function discrepancyDecided(e: Ev<"discrepancy.decided">): EventJournalSpec {
  const p = e.payload;
  if (p.decision !== "rejected" || !p.restitutionActive || p.amount >= 0 || !p.employeeId) {
    return skip("Selisih disetujui/bukan ganti rugi — beban sudah diakui saat setoran diterima.");
  }
  return journal(
    "discrepancy.decided",
    eventDate(e, p.businessDate),
    "Selisih ditolak — ganti rugi karyawan (piutang karyawan)",
    [{ entryKey: "restitution", amount: -p.amount, profitCenter: p.profitCenter ?? "SHARED", creditOutletId: p.outletId ?? null }],
    { type: "discrepancy", id: p.discrepancyId },
  );
}

function discrepancyReopened(e: Ev<"discrepancy.reopened">): EventJournalSpec {
  const p = e.payload;
  return { kind: "reversal", description: "Selisih dibuka kembali", reason: p.reason, date: eventDate(e), sourceObject: { type: "discrepancy", id: p.discrepancyId }, sourceTypes: ["discrepancy.decided"] };
}

async function transferMatched(tx: Tx, e: Ev<"transfer.matched">): Promise<EventJournalSpec> {
  const p = e.payload;
  if (TRANSFER_SOURCES_NOT_JOURNALED.has(p.sourceKind)) return skip("Setor bank dengan slip: jurnal kas→bank dari setoran/setor bank; pencocokan hanya rekonsiliasi.");
  const bankGl = await bankGlAccountId(tx, p.bankAccountId);
  const date = eventDate(e);
  return journal("transfer.matched", date, `Transfer dicocokkan (${p.sourceKind})`, [{ entryKey: "default", amount: p.amount, debitAccountId: bankGl }], {
    type: "incoming_transfer",
    id: p.incomingTransferId,
  });
}

async function bankDepositRecorded(tx: Tx, e: Ev<"bank_deposit.recorded">): Promise<EventJournalSpec> {
  const p = e.payload;
  const bankGl = await bankGlAccountId(tx, p.bankAccountId);
  let entryKey = p.sourceType === "driver" ? "driver" : "default";
  if (p.sourceType === "outlet") {
    const kind = p.outletId ? (await tx.select({ kind: outlets.kind }).from(outlets).where(eq(outlets.id, p.outletId)).limit(1))[0]?.kind : null;
    entryKey = kind === "store" ? "outlet_store" : "outlet_depot";
  }
  return journal("bank_deposit.recorded", eventDate(e), "Setor ke bank", [{ entryKey, amount: p.amount, debitAccountId: bankGl, creditOutletId: p.outletId ?? null }], {
    type: "bank_deposit",
    id: p.bankDepositId,
  });
}

function officeCashMoved(e: Ev<"office_cash.moved">): EventJournalSpec {
  const p = e.payload;
  if (p.kind !== "adjustment" || p.sourceObjectType !== "discrepancy") return skip("Mutasi kas kantor adalah cermin peristiwa sumbernya (dijurnal di sana).");
  return journal(
    "office_cash.moved",
    eventDate(e, p.businessDate),
    "Selisih hitung fisik kas kantor",
    [{ entryKey: p.direction === "in" ? "adjustment_in" : "adjustment_out", amount: p.amount }],
    { type: "office_cash_movement", id: p.movementId },
  );
}

async function pettyCashRecorded(tx: Tx, e: Ev<"petty_cash.recorded">): Promise<EventJournalSpec> {
  const p = e.payload;
  const date = eventDate(e, p.businessDate);
  const src = { type: p.kind === "adjustment" ? "petty_cash_count" : "petty_cash_transaction", id: p.pettyCashTransactionId };
  if (p.kind === "topup") return journal("petty_cash.recorded", date, "Pengisian kas kecil", [{ entryKey: "topup", amount: p.amount }], src);
  if (p.kind === "adjustment") {
    return journal("petty_cash.recorded", date, p.description ?? "Selisih hitung fisik kas kecil", [{ entryKey: p.amount >= 0 ? "adjustment_over" : "adjustment_short", amount: Math.abs(p.amount) }], src);
  }
  const debitAccountId = p.accountCode ? ((await accountsByCode(tx, e.tenantId!, [p.accountCode])).get(p.accountCode)?.id ?? null) : null;
  return journal(
    "petty_cash.recorded",
    date,
    `Kas kecil: ${p.description ?? p.category ?? "pengeluaran"}`,
    [{ entryKey: "expense", amount: p.amount, profitCenter: p.profitCenter ?? null, debitProfitCenter: p.profitCenter ?? null, debitOutletId: p.outletId ?? null, debitAccountId }],
    src,
  );
}

function restitutionSettled(e: Ev<"restitution.settled">): EventJournalSpec {
  const p = e.payload;
  return journal(
    "restitution.settled",
    eventDate(e, p.settledOn),
    `Pelunasan ganti rugi (${p.method === "cash" ? "tunai" : "potongan gaji"})`,
    [{ entryKey: p.method, amount: p.amount }],
    { type: "restitution_settlement", id: p.settlementId ?? p.restitutionId },
  );
}

// --- M5 piutang -----------------------------------------------------------------------------------------------------

function creditNoteIssued(e: Ev<"credit_note.issued">): EventJournalSpec {
  const p = e.payload;
  const purpose = p.purpose ?? "correction";
  const advance = p.advanceAmount ?? 0;
  const src = { type: "credit_note", id: p.creditNoteId };
  if (purpose === "underpayment_conversion" || purpose === "pending_transfer_resolved") return skip("Nota kredit reklasifikasi piutang — tanpa jurnal.");
  if (purpose === "store_return" || purpose === "pos_void") {
    if (advance <= 0) return skip("Pendapatan sudah dibalik oleh retur/void di sumbernya.");
    return journal("credit_note.issued", eventDate(e), `Nota kredit ${p.number ?? ""}: bagian terbayar menjadi uang muka`.trim(), [{ entryKey: "advance", amount: advance }], src, p.number);
  }
  if (purpose === "opening_adjustment") {
    return journal("credit_note.issued", eventDate(e), `Nota kredit saldo awal ${p.number ?? ""}`.trim(), [{ entryKey: "opening_adjustment", amount: p.amount }], src, p.number);
  }
  const pc = (p.profitCenter ?? "L2") as ProfitCenter;
  const line = pc === "L1" || pc === "SHARED" ? "L2" : pc;
  return journal(
    "credit_note.issued",
    eventDate(e),
    `Nota kredit ${p.number ?? ""}: ${p.reason}`.trim(),
    [
      // Pendapatan dibalik seluruhnya ke piutang; bagian yang melampaui sisa faktur dipindah ke uang muka.
      { entryKey: line, amount: p.amount },
      { entryKey: "advance", amount: advance },
    ],
    src,
    p.number,
  );
}

function paymentReversed(e: Ev<"payment.reversed">): EventJournalSpec {
  const p = e.payload;
  return { kind: "reversal", description: "Pelunasan dibalik", reason: p.reason, date: eventDate(e, p.businessDate), sourceObject: { type: "customer_payment", id: p.customerPaymentId } };
}

async function advanceRefunded(tx: Tx, e: Ev<"customer_advance.refunded">): Promise<EventJournalSpec> {
  const p = e.payload;
  const transfer = p.method === "transfer";
  const bankGl = transfer ? await bankGlAccountId(tx, p.bankAccountId) : null;
  return journal("customer_advance.refunded", eventDate(e), `Pengembalian uang muka: ${p.reason}`, [{ entryKey: transfer ? "transfer" : "cash", amount: p.amount, creditAccountId: bankGl }], {
    type: "customer_advance",
    id: p.customerAdvanceId,
  });
}

// --- M6/M7 POS & stok -----------------------------------------------------------------------------------------------

function posSaleRecorded(e: Ev<"pos_sale.recorded">): EventJournalSpec {
  const p = e.payload;
  const date = eventDate(e, p.businessDate);
  const src = { type: "pos_sale", id: p.posSaleId };
  const ref = p.number ?? null;
  if (p.outletKind === "store") {
    const method = p.method === "credit" ? "store_credit" : p.method === "qris" ? "store_qris" : "store_cash";
    const cashOutlet = method === "store_cash" ? p.outletId : null;
    return journal(
      "pos_sale.recorded",
      date,
      `Penjualan toko ${ref ?? ""}`.trim(),
      [
        { entryKey: method, amount: p.total, outletId: null, debitOutletId: cashOutlet, creditOutletId: p.outletId },
        { entryKey: "store_discount", amount: p.discount ?? 0, outletId: p.outletId },
        { entryKey: "store_cogs", amount: p.cogs ?? 0, outletId: p.outletId },
      ],
      src,
      ref,
    );
  }
  const method = p.method === "qris" ? "depot_qris" : "depot_cash";
  return journal("pos_sale.recorded", date, `Penjualan depot ${ref ?? ""}`.trim(), [{ entryKey: method, amount: p.total, outletId: p.outletId }], src, ref);
}

function posSaleVoided(e: Ev<"pos_sale.voided">): EventJournalSpec {
  const p = e.payload;
  return { kind: "reversal", description: "Void transaksi POS", reason: p.reason, date: eventDate(e, p.businessDate), sourceObject: { type: "pos_sale", id: p.posSaleId }, sourceTypes: ["pos_sale.recorded"] };
}

function storeReturn(e: Ev<"store_return.recorded">): EventJournalSpec {
  const p = e.payload;
  // Retur setelah shift: pendapatan & HPP dibalik; tempo → piutang berkurang, tunai → kas toko, QRIS → transfer belum
  // dicocokkan (pengembalian dana). Nota kredit M5 hanya memindah bagian terbayar ke uang muka.
  const method = p.method === "credit" ? "store_credit" : p.method === "qris" ? "store_qris" : "store_cash";
  return journal(
    "store_return.recorded",
    eventDate(e, p.businessDate),
    `Retur barang toko ${p.posSaleNumber ?? ""}: ${p.reason}`.trim(),
    [
      { eventKey: "pos_sale.recorded", entryKey: method, amount: -p.amount, debitOutletId: p.outletId, creditOutletId: method === "store_cash" ? p.outletId : null },
      { eventKey: "pos_sale.recorded", entryKey: "store_cogs", amount: -p.cogs, outletId: p.outletId },
    ],
    { type: "store_return", id: p.storeReturnId },
    p.posSaleNumber,
  );
}

function consumableUsage(e: Ev<"consumable.usage_posted">): EventJournalSpec {
  const p = e.payload;
  return journal("consumable.usage_posted", eventDate(e), "Pemakaian bahan habis pakai per shift", [{ entryKey: "default", amount: p.totalValue, outletId: p.outletId }], { type: "shift", id: p.shiftId });
}

function consumableReceived(e: Ev<"consumable.received">): EventJournalSpec {
  const p = e.payload;
  if (p.source === "internal_transfer") return skip("Penerimaan transfer internal dijurnal saat transfer dikirim (internal_transfer.sent).");
  return journal("consumable.received", eventDate(e), "Penerimaan bahan habis pakai depot", [{ entryKey: p.source === "supplier" ? "supplier" : "other", amount: p.totalValue, outletId: p.outletId }], {
    type: "consumable_receipt",
    id: p.receiptId,
  });
}

function consumableReceiptReversed(e: Ev<"consumable.receipt_reversed">): EventJournalSpec {
  const p = e.payload;
  return { kind: "reversal", description: "Penerimaan bahan dibalik", reason: p.reason, date: eventDate(e), sourceObject: { type: "consumable_receipt", id: p.receiptId } };
}

function stockAdjusted(e: Ev<"stock.adjusted">): EventJournalSpec {
  const p = e.payload;
  // Nilai bertanda: negatif = stok berkurang → beban selisih stok; positif = bertambah → pembalik sisi.
  return journal(
    "stock.adjusted",
    eventDate(e),
    `Penyesuaian opname ${p.outletKind === "store" ? "toko" : "depot"}`,
    [{ entryKey: p.outletKind === "store" ? "store" : "depot", amount: -p.totalValue, outletId: p.outletId }],
    { type: "stock_count", id: p.stockCountId },
  );
}

function internalTransferSent(e: Ev<"internal_transfer.sent">): EventJournalSpec {
  const p = e.payload;
  return journal(
    "internal_transfer.sent",
    eventDate(e),
    "Transfer internal bahan toko → depot (harga mitra)",
    [
      { entryKey: "revenue", amount: p.totalValue, debitOutletId: p.toOutletId, creditOutletId: p.fromOutletId },
      { entryKey: "cogs", amount: p.totalCost, outletId: p.fromOutletId },
    ],
    { type: "internal_transfer", id: p.internalTransferId },
  );
}

function purchaseReceipt(e: Ev<"purchase_receipt.recorded">): EventJournalSpec {
  const p = e.payload;
  if (p.isOpeningPayable) return skip("Saldo awal utang pemasok masuk jurnal saldo awal (US-M11-09).");
  const entryKey = p.paymentMode === "cash" ? "cash" : "credit";
  return journal("purchase_receipt.recorded", eventDate(e, p.businessDate), `Nota pembelian ${p.number ?? ""}`.trim(), [{ entryKey, amount: p.total, outletId: p.outletId }], { type: "purchase_receipt", id: p.purchaseReceiptId }, p.number ?? null);
}

function purchaseCorrected(e: Ev<"purchase_receipt.corrected">): EventJournalSpec {
  const p = e.payload;
  return journal(
    "purchase_receipt.corrected",
    eventDate(e),
    `Koreksi/retur nota pembelian: ${p.reason}`,
    [{ eventKey: "purchase_receipt.recorded", entryKey: "credit", amount: p.amountDelta, outletId: p.outletId }],
    { type: "purchase_receipt", id: p.correctionId },
  );
}

async function supplierPayment(tx: Tx, e: Ev<"supplier_payment.recorded">): Promise<EventJournalSpec> {
  const p = e.payload;
  const bankGl = p.method === "transfer" ? await bankGlAccountId(tx, p.bankAccountId) : null;
  return journal(
    "supplier_payment.recorded",
    eventDate(e, p.businessDate),
    p.reversalOfId ? `Pembalik pembayaran pemasok: ${p.reason ?? ""}`.trim() : "Pembayaran pemasok",
    [{ entryKey: p.method, amount: p.amount, creditAccountId: bankGl }],
    { type: "supplier_payment", id: p.supplierPaymentId },
  );
}

function waterSupply(e: Ev<"water_supply.confirmed">): EventJournalSpec {
  const p = e.payload;
  if (!p.transferValue) return skip("Pasokan tanpa nilai transfer internal (sumber lain).");
  return journal(
    "water_supply.confirmed",
    eventDate(e),
    `Pasokan air depot ${p.volumeReceivedL.toLocaleString("id-ID")} L (transfer internal L2 → L3)`,
    [{ entryKey: "internal_transfer", amount: p.transferValue, debitOutletId: p.outletId, creditOutletId: null }],
    { type: "water_supply_receipt", id: p.waterSupplyReceiptId },
  );
}

// --- P2/P3 ------------------------------------------------------------------------------------------------------------

function partnerSubscription(e: Ev<"partner.subscription_invoiced">): EventJournalSpec {
  const p = e.payload;
  return journal("partner.subscription_invoiced", eventDate(e), "Tagihan langganan sistem mitra", [{ entryKey: "default", amount: p.amount }], { type: "invoice", id: p.invoiceId });
}

/**
 * Uang muka pelanggan dipakai pada faktur (B-65): reklasifikasi Dr uang muka 2-1201 / Cr piutang 1-1401 (bertanda —
 * negatif = alokasi dibatalkan / kelebihan pelunasan menjadi uang muka). Menyelaraskan buku besar dengan buku bantu M5.
 */
function advanceApplied(e: Ev<"customer_advance.applied">): EventJournalSpec {
  const p = e.payload;
  const text = p.amount >= 0 ? "Uang muka pelanggan dipakai" : "Alokasi dibatalkan → uang muka pelanggan";
  return journal("customer_advance.applied", eventDate(e, p.businessDate), `${text} (${p.invoiceNumber ?? "faktur"})`, [{ entryKey: "default", amount: p.amount }], { type: "invoice", id: p.invoiceId });
}

function digitalPayment(e: Ev<"digital_payment.succeeded">): EventJournalSpec {
  const p = e.payload;
  // Integrasi P2: bila pelunasan M5 (`customerPaymentId`) sudah dibentuk, `collection.recorded` kanal `digital` yang
  // menjurnal pelunasan piutang/uang muka — di sini hanya biaya gerbang (hindari piutang dikredit dua kali).
  const settledViaCollection = !!p.customerPaymentId;
  return journal(
    "digital_payment.succeeded",
    eventDate(e),
    `Pembayaran digital (${p.method})`,
    [
      ...(settledViaCollection ? [] : [{ entryKey: "default", amount: p.amount }]),
      { entryKey: "gateway_fee", amount: p.gatewayFee },
    ],
    { type: "payment_intent", id: p.paymentIntentId },
  );
}

/** Peristiwa yang ditangani M11 (didaftarkan `events.ts`). */
export const JOURNALED_EVENTS = [
  "trip.completed",
  "trip.corrected",
  "trip_payment.reversed",
  "trip_expense.reversed",
  "collection.recorded",
  "expense.verified",
  "deposit.received",
  "discrepancy.decided",
  "discrepancy.reopened",
  "transfer.matched",
  "bank_deposit.recorded",
  "bank_deposit.reversed",
  "office_cash.moved",
  "petty_cash.recorded",
  "restitution.settled",
  "restitution.settlement_reversed",
  "credit_note.issued",
  "payment.reversed",
  "customer_advance.refunded",
  "pos_sale.recorded",
  "pos_sale.voided",
  "store_return.recorded",
  "consumable.usage_posted",
  "consumable.received",
  "consumable.receipt_reversed",
  "stock.adjusted",
  "internal_transfer.sent",
  "purchase_receipt.recorded",
  "purchase_receipt.corrected",
  "supplier_payment.recorded",
  "water_supply.confirmed",
  "partner.subscription_invoiced",
  "digital_payment.succeeded",
  "customer_advance.applied",
] as const satisfies readonly DomainEventType[];

export type JournaledEventType = (typeof JOURNALED_EVENTS)[number];

export function isJournaledEvent(type: string): type is JournaledEventType {
  return (JOURNALED_EVENTS as readonly string[]).includes(type);
}

/** Spesifikasi jurnal untuk satu event. */
export async function specForEvent(tx: Tx, event: DomainEvent): Promise<EventJournalSpec> {
  const e = event as DomainEvent<DomainEventType>;
  const as = <T extends DomainEventType>() => e as unknown as Ev<T>;
  switch (e.type) {
    case "trip.completed":
      return tripCompleted(as<"trip.completed">());
    case "trip.corrected":
      return tripCorrected(as<"trip.corrected">());
    case "trip_payment.reversed":
      return tripPaymentReversed(as<"trip_payment.reversed">());
    case "trip_expense.reversed": {
      const p = (e.payload as DomainEventMap["trip_expense.reversed"]);
      return { kind: "reversal", description: "Pengeluaran rit dibalik", reason: p.reason, date: eventDate(e), sourceObject: { type: "trip_expense", id: p.tripExpenseId } };
    }
    case "collection.recorded":
      return collectionRecorded(as<"collection.recorded">());
    case "expense.verified":
      return expenseVerified(as<"expense.verified">());
    case "deposit.received":
      return depositReceived(tx, as<"deposit.received">());
    case "discrepancy.decided":
      return discrepancyDecided(as<"discrepancy.decided">());
    case "discrepancy.reopened":
      return discrepancyReopened(as<"discrepancy.reopened">());
    case "transfer.matched":
      return transferMatched(tx, as<"transfer.matched">());
    case "bank_deposit.recorded":
      return bankDepositRecorded(tx, as<"bank_deposit.recorded">());
    case "bank_deposit.reversed": {
      const p = e.payload as DomainEventMap["bank_deposit.reversed"];
      return { kind: "reversal", description: "Setor ke bank dibalik", reason: p.reason, date: eventDate(e), sourceObject: { type: "bank_deposit", id: p.bankDepositId } };
    }
    case "office_cash.moved":
      return officeCashMoved(as<"office_cash.moved">());
    case "petty_cash.recorded":
      return pettyCashRecorded(tx, as<"petty_cash.recorded">());
    case "restitution.settled":
      return restitutionSettled(as<"restitution.settled">());
    case "restitution.settlement_reversed": {
      const p = e.payload as DomainEventMap["restitution.settlement_reversed"];
      return { kind: "reversal", description: "Pelunasan ganti rugi dibalik", reason: p.reason, date: eventDate(e), sourceObject: { type: "restitution_settlement", id: p.settlementId } };
    }
    case "credit_note.issued":
      return creditNoteIssued(as<"credit_note.issued">());
    case "payment.reversed":
      return paymentReversed(as<"payment.reversed">());
    case "customer_advance.refunded":
      return advanceRefunded(tx, as<"customer_advance.refunded">());
    case "pos_sale.recorded":
      return posSaleRecorded(as<"pos_sale.recorded">());
    case "pos_sale.voided":
      return posSaleVoided(as<"pos_sale.voided">());
    case "store_return.recorded":
      return storeReturn(as<"store_return.recorded">());
    case "consumable.usage_posted":
      return consumableUsage(as<"consumable.usage_posted">());
    case "consumable.received":
      return consumableReceived(as<"consumable.received">());
    case "consumable.receipt_reversed":
      return consumableReceiptReversed(as<"consumable.receipt_reversed">());
    case "stock.adjusted":
      return stockAdjusted(as<"stock.adjusted">());
    case "internal_transfer.sent":
      return internalTransferSent(as<"internal_transfer.sent">());
    case "purchase_receipt.recorded":
      return purchaseReceipt(as<"purchase_receipt.recorded">());
    case "purchase_receipt.corrected":
      return purchaseCorrected(as<"purchase_receipt.corrected">());
    case "supplier_payment.recorded":
      return supplierPayment(tx, as<"supplier_payment.recorded">());
    case "water_supply.confirmed":
      return waterSupply(as<"water_supply.confirmed">());
    case "partner.subscription_invoiced":
      return partnerSubscription(as<"partner.subscription_invoiced">());
    case "digital_payment.succeeded":
      return digitalPayment(as<"digital_payment.succeeded">());
    case "customer_advance.applied":
      return advanceApplied(as<"customer_advance.applied">());
    default:
      return skip(`Peristiwa ${e.type} tidak menghasilkan jurnal.`);
  }
}
