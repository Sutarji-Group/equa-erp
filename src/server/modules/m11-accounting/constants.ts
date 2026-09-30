/**
 * M11 — konstanta modul (isomorfik; tanpa angka aturan — ambang tetap dari parameter).
 *
 * - `REQUIRED_MAPPINGS`: SETIAP pasangan (peristiwa, entri) yang dipakai handler jurnal otomatis (PRD 7.11.4). M11 hanya
 *   dapat diaktifkan bila semuanya terpetakan (US-M11-01 KP-2); pemetaan hilang saat berjalan → daftar tunggu.
 * - `SKIPPED_EVENTS`: peristiwa yang sengaja TIDAK dijurnal beserta alasannya (cermin/informasi — hindari posting ganda).
 * - Template jurnal manual berulang (gaji, sewa, listrik, BBM, pemeliharaan, biaya bank; US-M11-03 KP-1).
 */
import type { EnumValue, ProfitCenter } from "@/lib/labels";

export type RequiredMapping = { event: string; entry: string; label: string; ref: string };

const m = (event: string, entry: string, label: string, ref: string): RequiredMapping => ({ event, entry, label, ref });

/** Pemetaan wajib (PRD 7.11.4 + koreksi/pembalik + jurnal internal M11). */
export const REQUIRED_MAPPINGS: readonly RequiredMapping[] = [
  // M3 rit (L2)
  m("trip.completed", "cash", "Rit Selesai tunai", "FR-M11-02, PTB-24"),
  m("trip.completed", "transfer", "Rit Selesai transfer", "FR-M11-02"),
  m("trip.completed", "credit", "Rit Selesai tempo / kurang bayar", "PTB-18"),
  // Rit internal pasokan depot (L2 → L3)
  m("water_supply.confirmed", "internal_transfer", "Pasokan air depot (transfer internal L2 → L3)", "BR-33, K20"),
  // Pelunasan
  m("collection.recorded", "cash_driver", "Pelunasan tunai lewat sopir", "FR-M5-03"),
  m("collection.recorded", "cash_office", "Pelunasan tunai di kantor", "FR-M5-03"),
  m("collection.recorded", "cash_store", "Pelunasan tunai di kasir toko", "FR-M5-03"),
  m("collection.recorded", "transfer", "Pelunasan transfer/digital", "FR-M5-03"),
  m("collection.recorded", "advance", "Kelebihan bayar → uang muka", "FR-M5-03"),
  // Setoran
  m("deposit.received", "driver", "Setoran sopir diterima", "BR-09"),
  m("deposit.received", "depot_shift", "Setoran shift depot diterima", "BR-09"),
  m("deposit.received", "store_shift", "Setoran shift toko diterima", "BR-09"),
  m("deposit.received", "shortage", "Selisih kurang setoran sopir", "BR-11"),
  m("deposit.received", "shortage_depot_shift", "Selisih kurang setoran depot", "BR-11"),
  m("deposit.received", "shortage_store_shift", "Selisih kurang setoran toko", "BR-11"),
  m("deposit.received", "overage", "Selisih lebih setoran", "BR-12"),
  m("discrepancy.decided", "restitution", "Selisih ditolak & ganti rugi aktif → piutang karyawan", "PTB-22"),
  // Pengeluaran rit
  m("expense.verified", "fuel", "BBM rit dari kas di tangan", "PTB-20"),
  m("expense.verified", "toll_parking", "Tol/parkir dari kas di tangan", "PTB-20"),
  m("expense.verified", "other", "Pengeluaran rit lain dari kas di tangan", "PTB-20"),
  m("expense.verified", "personal_reimbursed", "BBM uang pribadi diganti kas kantor", "PTB-20"),
  m("expense.verified", "personal_toll_parking", "Tol/parkir uang pribadi diganti kas kantor", "PTB-20"),
  m("expense.verified", "personal_other", "Pengeluaran lain uang pribadi diganti kas kantor", "PTB-20"),
  // Transfer, bank, kas kantor, kas kecil
  m("transfer.matched", "default", "Transfer dicocokkan → bank", "US-M4-04"),
  m("bank_deposit.recorded", "default", "Setor kas kantor ke bank", "US-M4-05"),
  m("bank_deposit.recorded", "outlet_depot", "Setor kas outlet depot ke bank", "US-M4-05"),
  m("bank_deposit.recorded", "outlet_store", "Setor kas outlet toko ke bank", "US-M4-05"),
  m("bank_deposit.recorded", "driver", "Setor kas sopir ke bank", "PTB-23"),
  m("office_cash.moved", "adjustment_in", "Selisih lebih hitung fisik kas kantor", "US-M4-06"),
  m("office_cash.moved", "adjustment_out", "Selisih kurang hitung fisik kas kantor", "US-M4-06"),
  m("petty_cash.recorded", "topup", "Pengisian kas kecil", "US-M4-05"),
  m("petty_cash.recorded", "expense", "Pengeluaran kas kecil", "US-M4-05"),
  m("petty_cash.recorded", "adjustment_over", "Selisih lebih hitung fisik kas kecil", "US-M4-05"),
  m("petty_cash.recorded", "adjustment_short", "Selisih kurang hitung fisik kas kecil", "US-M4-05"),
  m("restitution.settled", "cash", "Ganti rugi dilunasi tunai", "PTB-22"),
  m("restitution.settled", "payroll_deduction", "Ganti rugi dilunasi potongan gaji", "PTB-22"),
  // POS depot & toko
  m("pos_sale.recorded", "depot_cash", "Penjualan POS depot tunai", "FR-M6-01"),
  m("pos_sale.recorded", "depot_qris", "Penjualan POS depot QRIS", "FR-M6-01"),
  m("pos_sale.recorded", "store_cash", "Penjualan toko tunai", "FR-M7-01"),
  m("pos_sale.recorded", "store_qris", "Penjualan toko QRIS", "FR-M7-01"),
  m("pos_sale.recorded", "store_credit", "Penjualan toko tempo", "FR-M7-03"),
  m("pos_sale.recorded", "store_discount", "Diskon toko (pengurang pendapatan)", "PTB-38"),
  m("pos_sale.recorded", "store_cogs", "HPP toko (rata-rata bergerak)", "FR-M7-01"),
  m("consumable.usage_posted", "default", "Pemakaian bahan per shift", "FR-M6-04"),
  m("consumable.received", "supplier", "Penerimaan bahan depot dari pemasok", "FR-M6-04"),
  m("consumable.received", "other", "Penerimaan bahan depot sumber lain", "FR-M6-04"),
  m("stock.adjusted", "store", "Penyesuaian opname toko", "FR-M7-06"),
  m("stock.adjusted", "depot", "Penyesuaian opname depot", "BR-27"),
  m("internal_transfer.sent", "revenue", "Transfer internal bahan toko → depot (L4 → L3)", "PTB-37"),
  m("internal_transfer.sent", "cogs", "HPP barang toko yang ditransfer", "PTB-37"),
  // Pembelian & pemasok
  m("purchase_receipt.recorded", "credit", "Nota pembelian → utang pemasok", "FR-M7-02"),
  m("purchase_receipt.recorded", "cash", "Nota pembelian dibayar tunai", "FR-M7-02"),
  m("supplier_payment.recorded", "cash", "Pembayaran pemasok dari kas kantor", "FR-M7-06"),
  m("supplier_payment.recorded", "transfer", "Pembayaran pemasok lewat transfer", "FR-M7-06"),
  // Piutang (nota kredit & uang muka)
  m("credit_note.issued", "L2", "Nota kredit air truk (pembalik pendapatan)", "BR-38"),
  m("credit_note.issued", "L3", "Nota kredit depot (pembalik pendapatan)", "BR-38"),
  m("credit_note.issued", "L4", "Nota kredit toko (pembalik pendapatan)", "BR-38"),
  m("credit_note.issued", "L5", "Nota kredit kemitraan (pembalik pendapatan)", "BR-38"),
  m("credit_note.issued", "advance", "Bagian nota kredit menjadi uang muka", "BR-38"),
  m("credit_note.issued", "opening_adjustment", "Nota kredit saldo awal piutang", "PTB-44"),
  m("customer_advance.refunded", "cash", "Pengembalian uang muka tunai", "7.5.6"),
  m("customer_advance.refunded", "transfer", "Pengembalian uang muka transfer", "7.5.6"),
  // Penyusutan (M11)
  m("asset.depreciated", "truck", "Penyusutan truk", "BR-34"),
  m("asset.depreciated", "water_installation", "Penyusutan instalasi sumber air", "BR-34"),
  m("asset.depreciated", "depot_equipment", "Penyusutan peralatan depot", "BR-34"),
  m("asset.depreciated", "building", "Penyusutan bangunan", "BR-34"),
  m("asset.depreciated", "other", "Penyusutan aset lainnya", "BR-34"),
  // Kemitraan & pembayaran digital (Tahap 2/3 — tetap wajib terpetakan)
  m("partner.subscription_invoiced", "default", "Tagihan langganan sistem mitra", "RL-7"),
  m("digital_payment.succeeded", "default", "Pembayaran digital berhasil", "PTB-50"),
  m("digital_payment.succeeded", "gateway_fee", "Biaya gerbang pembayaran", "PTB-50"),
  m("customer_advance.applied", "default", "Uang muka pelanggan dipakai pada faktur (piutang ↔ uang muka)", "US-M5-02 KP-3, B-65"),
  // Jurnal internal M11 (alokasi, pelepasan aset, saldo awal)
  m("m11.allocation", "l1_allocation", "Alokasi biaya L1 → L2/L3 (debit: beban alokasi, kredit: alokasi keluar)", "PTB-39, PAR-65"),
  m("m11.allocation", "shared_costs", "Alokasi biaya bersama (debit: beban alokasi, kredit: alokasi keluar)", "US-M11-01 KP-5"),
  m("m11.asset_disposal", "gain_loss", "Pelepasan aset (debit: akun rugi, kredit: akun laba)", "US-M11-05 KP-4"),
  m("m11.opening_balance", "equity_balancing", "Ekuitas penyeimbang saldo awal (akun debit & kredit sama)", "US-M11-09 KP-2"),
];

/** Peristiwa keuangan yang sengaja tidak dijurnal (dokumentasi & layar pemetaan). */
export const SKIPPED_EVENTS: readonly { event: string; reason: string }[] = [
  { event: "trip.payment_recorded", reason: "Pembayaran rit sudah dijurnal pada rit Selesai (trip.completed)." },
  { event: "trip.expense_recorded", reason: "Menunggu verifikasi M4; dijurnal saat expense.verified." },
  { event: "invoice.issued", reason: "Pendapatan diakui pada peristiwa sumber (rit Selesai / penjualan POS); faktur hanya menagih (hindari posting ganda, B-31)." },
  { event: "invoice.written_off", reason: "Dijurnal oleh jurnal manual penghapusan piutang M11 (PTB-28)." },
  { event: "transfer.not_found", reason: "Tetap di akun transfer belum dicocokkan; tampil sebagai item rekonsiliasi (piutang sementara M5)." },
  { event: "restitution.recorded", reason: "Dijurnal pada discrepancy.decided (ditolak & ganti rugi aktif)." },
  { event: "internal_transfer.received", reason: "Transfer internal dijurnal saat dikirim (internal_transfer.sent)." },
  { event: "shift.closed", reason: "Penjualan dijurnal per transaksi; selisih kas dijurnal saat setoran diterima." },
  { event: "office_cash.moved", reason: "Hanya selisih hitung fisik (kind adjustment dari selisih) yang dijurnal; mutasi lain cermin peristiwa sumber." },
  { event: "truck_fill.recorded", reason: "Air tidak dipersediakan (PTB-39); volume dipakai dasar alokasi L1." },
  { event: "water_balance.computed", reason: "Informasi neraca air (tanpa nilai)." },
  { event: "fleet_event.detected", reason: "Informasi armada (BBM per rit tidak dijurnal, FR-M12-07)." },
];

/** Kunci pemetaan akun bank pada `transfer.matched` yang TIDAK dijurnal (sumber jurnal kas→bank = setoran/setor bank). */
export const TRANSFER_SOURCES_NOT_JOURNALED = new Set(["bank_deposit_slip"]);

/** Pusat laba pemakai bawaan per kategori aset (US-M11-05 KP-1). */
export const ASSET_CATEGORY_PROFIT_CENTER: Record<EnumValue<"asset_category">, ProfitCenter> = {
  truck: "L2",
  water_installation: "L1",
  depot_equipment: "L3",
  building: "SHARED",
  other: "SHARED",
};

/** Akun aset per kategori (kode bagan akun template; dapat diganti per aset). */
export const ASSET_CATEGORY_ACCOUNT: Record<EnumValue<"asset_category">, string> = {
  truck: "1-2101",
  water_installation: "1-2201",
  depot_equipment: "1-2301",
  building: "1-2401",
  other: "1-2501",
};

/** Template jurnal manual berulang (US-M11-03 KP-1): akun beban bawaan (debit) & sumber dana (kredit). */
export const MANUAL_TEMPLATES: Record<
  EnumValue<"recurring_journal_template">,
  { label: string; debitAccountCode: string; creditAccountCode: string; profitCenter: ProfitCenter; hint: string }
> = {
  salary: {
    label: "Gaji total bulanan",
    debitAccountCode: "6-1101",
    creditAccountCode: "1-1201",
    profitCenter: "SHARED",
    hint: "Total rekap penggajian di luar sistem. Potongan ganti rugi dicatat di kredit Utang gaji (2-1301); pelunasannya di Kas & Setoran > Ganti rugi (potongan penggajian).",
  },
  rent: { label: "Sewa (termasuk aset sewa K15)", debitAccountCode: "6-1201", creditAccountCode: "1-1201", profitCenter: "SHARED", hint: "Aset milik pribadi yang disewakan ke PT dicatat sebagai sewa, bukan aset tetap (K15)." },
  electricity: { label: "Listrik & air", debitAccountCode: "6-1301", creditAccountCode: "1-1201", profitCenter: "SHARED", hint: "Listrik sumber air → pusat laba L1; kantor → bersama." },
  fuel: { label: "BBM (di luar rit)", debitAccountCode: "5-1301", creditAccountCode: "1-1101", profitCenter: "L2", hint: "BBM yang tidak tercatat lewat pengeluaran rit." },
  maintenance: { label: "Pemeliharaan", debitAccountCode: "6-1401", creditAccountCode: "1-1101", profitCenter: "SHARED", hint: "Pemeliharaan truk (L2), depot (L3 per outlet), instalasi (L1)." },
  bank_fee: { label: "Biaya/bunga bank", debitAccountCode: "6-1901", creditAccountCode: "1-1201", profitCenter: "SHARED", hint: "Item penyesuai rekonsiliasi bank (biaya administrasi, bunga)." },
  other: { label: "Lainnya", debitAccountCode: "6-9101", creditAccountCode: "1-1101", profitCenter: "SHARED", hint: "Jurnal manual lain dengan lampiran bukti." },
};

/** Tautan layar transaksi sumber per jenis objek (ketertelusuran jurnal → sumber, US-M11-02 KP-5). */
export const SOURCE_OBJECT_LABELS: Record<string, string> = {
  trip: "Rit",
  deposit: "Setoran",
  customer_payment: "Pelunasan",
  invoice: "Faktur",
  credit_note: "Nota kredit",
  customer_advance: "Uang muka",
  pos_sale: "Transaksi POS",
  store_return: "Retur toko",
  shift: "Shift",
  consumable_receipt: "Penerimaan bahan",
  stock_count: "Opname",
  internal_transfer: "Transfer internal",
  purchase_receipt: "Nota pembelian",
  supplier_payment: "Pembayaran pemasok",
  water_supply_receipt: "Pasokan air depot",
  incoming_transfer: "Transfer masuk",
  bank_deposit: "Setor ke bank",
  office_cash_movement: "Mutasi kas kantor",
  petty_cash_transaction: "Kas kecil",
  petty_cash_count: "Hitung fisik kas kecil",
  discrepancy: "Selisih",
  trip_expense: "Pengeluaran rit",
  restitution_settlement: "Pelunasan ganti rugi",
  fixed_asset: "Aset tetap",
  accounting_period: "Periode",
  opening_balance_batch: "Saldo awal",
  cost_allocation_run: "Alokasi biaya",
  journal: "Jurnal",
  depreciation: "Penyusutan",
};

/** Sumber jurnal (source_type) → modul untuk rekonsiliasi harian & filter. */
export const SOURCE_MODULE: Record<string, string> = {
  "trip.completed": "M3",
  "trip.corrected": "M3",
  "trip_payment.reversed": "M3",
  "trip_expense.reversed": "M3",
  "collection.recorded": "M3/M5",
  "deposit.received": "M4",
  "discrepancy.decided": "M4",
  "discrepancy.reopened": "M4",
  "expense.verified": "M4",
  "transfer.matched": "M4",
  "bank_deposit.recorded": "M4",
  "bank_deposit.reversed": "M4",
  "office_cash.moved": "M4",
  "petty_cash.recorded": "M4",
  "restitution.settled": "M4",
  "restitution.settlement_reversed": "M4",
  "credit_note.issued": "M5",
  "payment.reversed": "M5",
  "customer_advance.refunded": "M5",
  "pos_sale.recorded": "M6/M7",
  "pos_sale.voided": "M6/M7",
  "consumable.usage_posted": "M6",
  "consumable.received": "M6",
  "consumable.receipt_reversed": "M6",
  "water_supply.confirmed": "M6/M8",
  "stock.adjusted": "M6/M7",
  "internal_transfer.sent": "M7",
  "store_return.recorded": "M7",
  "purchase_receipt.recorded": "M7",
  "purchase_receipt.corrected": "M7",
  "supplier_payment.recorded": "M7",
  "asset.depreciated": "M11",
  "partner.subscription_invoiced": "P3",
  "digital_payment.succeeded": "P2",
  "customer_advance.applied": "M5",
};

/** Sumber jurnal transfer internal (dieliminasi pada konsolidasi, BR-33, US-M11-01 KP-4). */
export const INTERNAL_TRANSFER_SOURCES = new Set(["water_supply.confirmed", "internal_transfer.sent"]);

export const PROFIT_CENTERS: readonly ProfitCenter[] = ["L1", "L2", "L3", "L4", "L5", "SHARED"];
export const LINE_PROFIT_CENTERS: readonly ProfitCenter[] = ["L2", "L3", "L4", "L5"];

/**
 * Pesan "pemetaan hilang" dengan nama peristiwa yang dipahami pengguna (label `REQUIRED_MAPPINGS`) + tindakannya —
 * kunci teknis (`trip.completed/credit`) hanya disimpan di payload (aturan #1).
 */
export function mappingMissingMessage(eventKey: string, entryKey: string): string {
  const req = REQUIRED_MAPPINGS.find((r) => r.event === eventKey && r.entry === entryKey);
  const what = req ? `"${req.label}"` : "peristiwa ini";
  return `Pemetaan akun untuk ${what} belum ada. Lengkapi di Akuntansi > Pemetaan jurnal otomatis, lalu coba ulang.`;
}
