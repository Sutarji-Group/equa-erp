/**
 * Seed akuntansi: pusat laba L1–L5 & SHARED, bagan akun template (SAK EMKM, Bahasa Indonesia), pemetaan peristiwa →
 * akun bawaan (PRD 7.11.4; ditinjau akuntan sebelum M11 aktif, K9), pengaturan pajak (non-PKP), rekening bank demo,
 * template ekspor jurnal ke format konsultan.
 */
import type { EnumValue } from "@/lib/labels";

import type { DbOrTx } from "../client";
import { accounts, bankAccounts, eventAccountMappings, exportTemplates, profitCenters, taxSettings } from "../schema";
import { SEED_EFFECTIVE_FROM } from "./constants";
import { seedId } from "./ids";
import { EQUA_TENANT_ID } from "./org";

type Pc = EnumValue<"profit_center">;
type AccountSeed = {
  code: string;
  name: string;
  type: EnumValue<"account_type">;
  normal?: EnumValue<"normal_balance">;
  pc?: Pc;
  parent?: string;
  header?: boolean;
  internal?: boolean;
  cash?: boolean;
};

export const PROFIT_CENTER_SEEDS: { code: Pc; name: string; isCostCenter: boolean }[] = [
  { code: "L1", name: "L1 Produksi air", isCostCenter: true },
  { code: "L2", name: "L2 Air truk", isCostCenter: false },
  { code: "L3", name: "L3 Depot", isCostCenter: false },
  { code: "L4", name: "L4 Toko", isCostCenter: false },
  { code: "L5", name: "L5 Kemitraan", isCostCenter: false },
  { code: "SHARED", name: "Umum/kantor (bersama)", isCostCenter: true },
];

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ASET
  { code: "1-0000", name: "ASET", type: "asset", header: true },
  { code: "1-1000", name: "Aset lancar", type: "asset", header: true, parent: "1-0000" },
  { code: "1-1101", name: "Kas kantor", type: "asset", pc: "SHARED", parent: "1-1000", cash: true },
  { code: "1-1102", name: "Kas di tangan sopir", type: "asset", pc: "L2", parent: "1-1000", cash: true },
  { code: "1-1103", name: "Kas outlet depot", type: "asset", pc: "L3", parent: "1-1000", cash: true },
  { code: "1-1104", name: "Kas outlet toko", type: "asset", pc: "L4", parent: "1-1000", cash: true },
  { code: "1-1105", name: "Kas kecil", type: "asset", pc: "SHARED", parent: "1-1000", cash: true },
  { code: "1-1201", name: "Bank — rekening operasional", type: "asset", pc: "SHARED", parent: "1-1000", cash: true },
  { code: "1-1301", name: "Transfer & QRIS belum dicocokkan", type: "asset", pc: "SHARED", parent: "1-1000" },
  { code: "1-1401", name: "Piutang usaha", type: "asset", pc: "SHARED", parent: "1-1000" },
  { code: "1-1402", name: "Piutang karyawan (ganti rugi)", type: "asset", pc: "SHARED", parent: "1-1000" },
  { code: "1-1501", name: "Persediaan barang toko", type: "asset", pc: "L4", parent: "1-1000" },
  { code: "1-1502", name: "Persediaan bahan habis pakai depot", type: "asset", pc: "L3", parent: "1-1000" },
  { code: "1-1601", name: "Uang muka & biaya dibayar di muka", type: "asset", pc: "SHARED", parent: "1-1000" },
  { code: "1-2000", name: "Aset tetap", type: "asset", header: true, parent: "1-0000" },
  { code: "1-2101", name: "Kendaraan (truk)", type: "asset", pc: "L2", parent: "1-2000" },
  { code: "1-2102", name: "Akumulasi penyusutan kendaraan", type: "asset", normal: "credit", pc: "L2", parent: "1-2000" },
  { code: "1-2201", name: "Instalasi sumber air", type: "asset", pc: "L1", parent: "1-2000" },
  { code: "1-2202", name: "Akumulasi penyusutan instalasi sumber air", type: "asset", normal: "credit", pc: "L1", parent: "1-2000" },
  { code: "1-2301", name: "Peralatan depot", type: "asset", pc: "L3", parent: "1-2000" },
  { code: "1-2302", name: "Akumulasi penyusutan peralatan depot", type: "asset", normal: "credit", pc: "L3", parent: "1-2000" },
  { code: "1-2401", name: "Bangunan", type: "asset", pc: "SHARED", parent: "1-2000" },
  { code: "1-2402", name: "Akumulasi penyusutan bangunan", type: "asset", normal: "credit", pc: "SHARED", parent: "1-2000" },
  { code: "1-2501", name: "Aset tetap lainnya", type: "asset", pc: "SHARED", parent: "1-2000" },
  { code: "1-2502", name: "Akumulasi penyusutan aset tetap lainnya", type: "asset", normal: "credit", pc: "SHARED", parent: "1-2000" },
  // LIABILITAS
  { code: "2-0000", name: "LIABILITAS", type: "liability", header: true },
  { code: "2-1000", name: "Liabilitas jangka pendek", type: "liability", header: true, parent: "2-0000" },
  { code: "2-1101", name: "Utang usaha — pemasok", type: "liability", pc: "L4", parent: "2-1000" },
  { code: "2-1201", name: "Uang muka pelanggan", type: "liability", pc: "SHARED", parent: "2-1000" },
  { code: "2-1301", name: "Utang gaji", type: "liability", pc: "SHARED", parent: "2-1000" },
  { code: "2-1401", name: "Beban masih harus dibayar (akrual)", type: "liability", pc: "SHARED", parent: "2-1000" },
  { code: "2-1501", name: "Utang pajak", type: "liability", pc: "SHARED", parent: "2-1000" },
  // EKUITAS
  { code: "3-0000", name: "EKUITAS", type: "equity", header: true },
  { code: "3-1101", name: "Modal disetor", type: "equity", pc: "SHARED", parent: "3-0000" },
  { code: "3-1201", name: "Saldo laba", type: "equity", pc: "SHARED", parent: "3-0000" },
  { code: "3-1301", name: "Laba (rugi) tahun berjalan", type: "equity", pc: "SHARED", parent: "3-0000" },
  { code: "3-1901", name: "Ekuitas saldo awal (penyeimbang)", type: "equity", pc: "SHARED", parent: "3-0000" },
  // PENDAPATAN
  { code: "4-0000", name: "PENDAPATAN", type: "revenue", header: true },
  { code: "4-1101", name: "Pendapatan air truk", type: "revenue", pc: "L2", parent: "4-0000" },
  { code: "4-1201", name: "Pendapatan depot", type: "revenue", pc: "L3", parent: "4-0000" },
  { code: "4-1301", name: "Pendapatan toko", type: "revenue", pc: "L4", parent: "4-0000" },
  { code: "4-1302", name: "Diskon penjualan toko", type: "revenue", normal: "debit", pc: "L4", parent: "4-0000" },
  { code: "4-1401", name: "Pendapatan langganan sistem mitra", type: "revenue", pc: "L5", parent: "4-0000" },
  { code: "4-1402", name: "Pendapatan royalti mitra", type: "revenue", pc: "L5", parent: "4-0000" },
  { code: "4-1501", name: "Pendapatan transfer internal air (L2 → L3)", type: "revenue", pc: "L2", parent: "4-0000", internal: true },
  { code: "4-1502", name: "Pendapatan transfer internal bahan (L4 → L3)", type: "revenue", pc: "L4", parent: "4-0000", internal: true },
  { code: "4-9101", name: "Pendapatan lain-lain — selisih lebih kas", type: "revenue", pc: "SHARED", parent: "4-0000" },
  { code: "4-9201", name: "Laba pelepasan aset tetap", type: "revenue", pc: "SHARED", parent: "4-0000" },
  // BEBAN POKOK & LANGSUNG
  { code: "5-0000", name: "BEBAN POKOK & BEBAN LANGSUNG", type: "expense", header: true },
  { code: "5-1101", name: "Harga pokok penjualan toko", type: "expense", pc: "L4", parent: "5-0000" },
  { code: "5-1201", name: "Beban air depot — transfer internal", type: "expense", pc: "L3", parent: "5-0000", internal: true },
  { code: "5-1202", name: "Beban bahan habis pakai depot", type: "expense", pc: "L3", parent: "5-0000" },
  { code: "5-1301", name: "Beban BBM truk", type: "expense", pc: "L2", parent: "5-0000" },
  { code: "5-1302", name: "Beban tol & parkir", type: "expense", pc: "L2", parent: "5-0000" },
  { code: "5-1401", name: "Beban produksi air (listrik & operasional sumber)", type: "expense", pc: "L1", parent: "5-0000" },
  { code: "5-1501", name: "Beban alokasi biaya produksi air", type: "expense", pc: "L2", parent: "5-0000" },
  { code: "5-1502", name: "Alokasi biaya produksi air — keluar", type: "expense", normal: "credit", pc: "L1", parent: "5-0000" },
  // BEBAN OPERASIONAL
  { code: "6-0000", name: "BEBAN OPERASIONAL", type: "expense", header: true },
  { code: "6-1101", name: "Beban gaji & upah", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1201", name: "Beban sewa", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1301", name: "Beban listrik & air kantor", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1401", name: "Beban pemeliharaan", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1501", name: "Beban penyusutan", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1601", name: "Beban selisih kas", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1701", name: "Beban selisih stok", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1801", name: "Beban kas kecil & perlengkapan kantor", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-1901", name: "Beban bank & gerbang pembayaran", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-2001", name: "Beban komunikasi, cloud & aplikasi", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-9101", name: "Beban lain-lain", type: "expense", pc: "SHARED", parent: "6-0000" },
  { code: "6-9201", name: "Rugi pelepasan aset tetap", type: "expense", pc: "SHARED", parent: "6-0000" },
  // PAJAK
  { code: "7-0000", name: "PAJAK", type: "expense", header: true },
  { code: "7-1101", name: "Beban PPh final", type: "expense", pc: "SHARED", parent: "7-0000" },
];

export const accountId = (code: string) => seedId(`account:${code}`);

const NORMAL_BY_TYPE: Record<EnumValue<"account_type">, EnumValue<"normal_balance">> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

type MappingSeed = {
  event: string;
  entry: string;
  description: string;
  debit: string;
  credit: string;
  debitPc?: Pc;
  creditPc?: Pc;
  /** fixed | from_outlet | from_source | split_internal */
  rule?: string;
};

/** Pemetaan bawaan peristiwa (katalog event ARCHITECTURE §8) → akun (PRD 7.11.4). */
export const EVENT_MAPPING_SEEDS: MappingSeed[] = [
  { event: "trip.completed", entry: "cash", description: "Rit Selesai tunai: kas di tangan sopir / pendapatan air truk", debit: "1-1102", credit: "4-1101", debitPc: "L2", creditPc: "L2" },
  { event: "trip.completed", entry: "transfer", description: "Rit Selesai transfer: transfer belum dicocokkan / pendapatan air truk", debit: "1-1301", credit: "4-1101", debitPc: "SHARED", creditPc: "L2" },
  { event: "trip.completed", entry: "credit", description: "Rit Selesai tempo / kurang bayar: piutang / pendapatan air truk", debit: "1-1401", credit: "4-1101", debitPc: "SHARED", creditPc: "L2" },
  { event: "water_supply.confirmed", entry: "internal_transfer", description: "Pasokan air depot: beban air depot L3 / pendapatan transfer internal L2 (volume diterima × harga transfer)", debit: "5-1201", credit: "4-1501", debitPc: "L3", creditPc: "L2", rule: "split_internal" },
  { event: "collection.recorded", entry: "cash_driver", description: "Pelunasan tunai lewat sopir", debit: "1-1102", credit: "1-1401", debitPc: "L2", creditPc: "SHARED" },
  { event: "collection.recorded", entry: "cash_office", description: "Pelunasan tunai di kantor", debit: "1-1101", credit: "1-1401", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "collection.recorded", entry: "cash_store", description: "Pelunasan tunai di kasir toko", debit: "1-1104", credit: "1-1401", debitPc: "L4", creditPc: "SHARED" },
  { event: "collection.recorded", entry: "transfer", description: "Pelunasan transfer/pembayaran digital", debit: "1-1301", credit: "1-1401", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "collection.recorded", entry: "advance", description: "Kelebihan bayar menjadi uang muka pelanggan", debit: "1-1401", credit: "2-1201", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "deposit.received", entry: "driver", description: "Setoran sopir diterima: kas kantor / kas di tangan sopir", debit: "1-1101", credit: "1-1102", debitPc: "SHARED", creditPc: "L2" },
  { event: "deposit.received", entry: "depot_shift", description: "Setoran shift depot diterima", debit: "1-1101", credit: "1-1103", debitPc: "SHARED", creditPc: "L3", rule: "from_outlet" },
  { event: "deposit.received", entry: "store_shift", description: "Setoran shift toko diterima", debit: "1-1101", credit: "1-1104", debitPc: "SHARED", creditPc: "L4" },
  { event: "deposit.received", entry: "shortage", description: "Selisih kurang setoran → beban selisih kas (pusat laba sumber)", debit: "6-1601", credit: "1-1102", rule: "from_source" },
  { event: "deposit.received", entry: "overage", description: "Selisih lebih setoran → pendapatan lain-lain", debit: "1-1101", credit: "4-9101", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "discrepancy.decided", entry: "restitution", description: "Selisih ditolak & ganti rugi aktif: piutang karyawan / beban selisih kas", debit: "1-1402", credit: "6-1601", debitPc: "SHARED", rule: "from_source" },
  { event: "expense.verified", entry: "fuel", description: "Pengeluaran BBM rit dari kas di tangan", debit: "5-1301", credit: "1-1102", debitPc: "L2", creditPc: "L2" },
  { event: "expense.verified", entry: "toll_parking", description: "Pengeluaran tol/parkir dari kas di tangan", debit: "5-1302", credit: "1-1102", debitPc: "L2", creditPc: "L2" },
  { event: "expense.verified", entry: "personal_reimbursed", description: "Pengeluaran rit dengan uang pribadi diganti kas kantor", debit: "5-1301", credit: "1-1101", debitPc: "L2", creditPc: "SHARED" },
  { event: "transfer.matched", entry: "default", description: "Transfer dicocokkan dengan mutasi: bank / transfer belum dicocokkan", debit: "1-1201", credit: "1-1301", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "bank_deposit.recorded", entry: "default", description: "Setor kas kantor ke bank", debit: "1-1201", credit: "1-1101", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "petty_cash.recorded", entry: "topup", description: "Pengisian kas kecil dari kas kantor", debit: "1-1105", credit: "1-1101", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "petty_cash.recorded", entry: "expense", description: "Pengeluaran kas kecil (pusat laba pengeluaran)", debit: "6-1801", credit: "1-1105", creditPc: "SHARED" },
  { event: "pos_sale.recorded", entry: "depot_cash", description: "Penjualan POS depot tunai", debit: "1-1103", credit: "4-1201", debitPc: "L3", creditPc: "L3", rule: "from_outlet" },
  { event: "pos_sale.recorded", entry: "depot_qris", description: "Penjualan POS depot QRIS", debit: "1-1301", credit: "4-1201", debitPc: "SHARED", creditPc: "L3", rule: "from_outlet" },
  { event: "pos_sale.recorded", entry: "store_cash", description: "Penjualan toko tunai", debit: "1-1104", credit: "4-1301", debitPc: "L4", creditPc: "L4" },
  { event: "pos_sale.recorded", entry: "store_qris", description: "Penjualan toko QRIS", debit: "1-1301", credit: "4-1301", debitPc: "SHARED", creditPc: "L4" },
  { event: "pos_sale.recorded", entry: "store_credit", description: "Penjualan toko tempo mitra", debit: "1-1401", credit: "4-1301", debitPc: "SHARED", creditPc: "L4" },
  { event: "pos_sale.recorded", entry: "store_discount", description: "Diskon kasir sebagai pengurang pendapatan toko", debit: "4-1302", credit: "4-1301", debitPc: "L4", creditPc: "L4" },
  { event: "pos_sale.recorded", entry: "store_cogs", description: "HPP barang toko (rata-rata bergerak)", debit: "5-1101", credit: "1-1501", debitPc: "L4", creditPc: "L4" },
  { event: "consumable.usage_posted", entry: "default", description: "Pemakaian bahan habis pakai per shift (resep)", debit: "5-1202", credit: "1-1502", debitPc: "L3", creditPc: "L3", rule: "from_outlet" },
  { event: "consumable.received", entry: "supplier", description: "Penerimaan bahan depot dari pemasok lain", debit: "1-1502", credit: "2-1101", debitPc: "L3", creditPc: "L4", rule: "from_outlet" },
  { event: "stock.adjusted", entry: "store", description: "Penyesuaian opname toko → beban selisih stok", debit: "6-1701", credit: "1-1501", debitPc: "L4", creditPc: "L4" },
  { event: "stock.adjusted", entry: "depot", description: "Penyesuaian opname depot → beban selisih stok", debit: "6-1701", credit: "1-1502", debitPc: "L3", creditPc: "L3", rule: "from_outlet" },
  { event: "internal_transfer.sent", entry: "revenue", description: "Transfer internal bahan toko → depot (harga mitra)", debit: "1-1502", credit: "4-1502", debitPc: "L3", creditPc: "L4", rule: "split_internal" },
  { event: "internal_transfer.sent", entry: "cogs", description: "HPP barang toko yang ditransfer ke depot", debit: "5-1101", credit: "1-1501", debitPc: "L4", creditPc: "L4" },
  { event: "purchase_receipt.recorded", entry: "credit", description: "Nota pembelian toko belum dibayar → utang pemasok", debit: "1-1501", credit: "2-1101", debitPc: "L4", creditPc: "L4" },
  { event: "purchase_receipt.recorded", entry: "cash", description: "Nota pembelian toko dibayar tunai", debit: "1-1501", credit: "1-1101", debitPc: "L4", creditPc: "SHARED" },
  { event: "supplier_payment.recorded", entry: "cash", description: "Pembayaran pemasok dari kas kantor", debit: "2-1101", credit: "1-1101", debitPc: "L4", creditPc: "SHARED" },
  { event: "supplier_payment.recorded", entry: "transfer", description: "Pembayaran pemasok lewat transfer", debit: "2-1101", credit: "1-1201", debitPc: "L4", creditPc: "SHARED" },
  { event: "asset.depreciated", entry: "truck", description: "Penyusutan truk", debit: "6-1501", credit: "1-2102", debitPc: "L2", creditPc: "L2" },
  { event: "asset.depreciated", entry: "water_installation", description: "Penyusutan instalasi sumber air", debit: "6-1501", credit: "1-2202", debitPc: "L1", creditPc: "L1" },
  { event: "asset.depreciated", entry: "depot_equipment", description: "Penyusutan peralatan depot", debit: "6-1501", credit: "1-2302", debitPc: "L3", creditPc: "L3", rule: "from_outlet" },
  { event: "asset.depreciated", entry: "building", description: "Penyusutan bangunan", debit: "6-1501", credit: "1-2402", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "asset.depreciated", entry: "other", description: "Penyusutan aset tetap lainnya", debit: "6-1501", credit: "1-2502", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "restitution.settled", entry: "cash", description: "Ganti rugi dilunasi tunai", debit: "1-1101", credit: "1-1402", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "restitution.settled", entry: "payroll_deduction", description: "Ganti rugi dilunasi lewat potongan penggajian", debit: "2-1301", credit: "1-1402", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "partner.subscription_invoiced", entry: "default", description: "Tagihan langganan sistem mitra", debit: "1-1401", credit: "4-1401", debitPc: "SHARED", creditPc: "L5" },
  { event: "digital_payment.succeeded", entry: "default", description: "Pembayaran digital berhasil: transfer belum dicocokkan / piutang", debit: "1-1301", credit: "1-1401", debitPc: "SHARED", creditPc: "SHARED" },
  { event: "digital_payment.succeeded", entry: "gateway_fee", description: "Biaya gerbang pembayaran dibukukan sebagai beban (PTB-50)", debit: "6-1901", credit: "1-1301", debitPc: "SHARED", creditPc: "SHARED" },
];

/**
 * Pusat laba, bagan akun template, pemetaan peristiwa → akun, pengaturan pajak, template ekspor jurnal (idempoten).
 * `demoBankAccount` (bawaan true) menambah rekening "Bank Demo" — seed produksi mematikannya: rekening bank nyata
 * dimasukkan saat cut-over dengan akun buku sendiri per rekening (D-12 butir 4, B-79).
 */
export async function seedAccounting(tx: DbOrTx, options: { demoBankAccount?: boolean } = {}): Promise<void> {
  await tx
    .insert(profitCenters)
    .values(PROFIT_CENTER_SEEDS.map((p) => ({ id: seedId(`profit_center:${p.code}`), tenantId: EQUA_TENANT_ID, ...p })))
    .onConflictDoNothing();

  await tx
    .insert(accounts)
    .values(
      CHART_OF_ACCOUNTS.map((a) => ({
        id: accountId(a.code),
        tenantId: EQUA_TENANT_ID,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normal ?? NORMAL_BY_TYPE[a.type],
        parentId: a.parent ? accountId(a.parent) : null,
        isPostable: !a.header,
        profitCenter: a.pc ?? null,
        isInternalTransfer: a.internal ?? false,
        isCash: a.cash ?? false,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(eventAccountMappings)
    .values(
      EVENT_MAPPING_SEEDS.map((m) => ({
        id: seedId(`event_mapping:${m.event}:${m.entry}:${SEED_EFFECTIVE_FROM}`),
        tenantId: EQUA_TENANT_ID,
        eventKey: m.event,
        entryKey: m.entry,
        description: m.description,
        debitAccountId: accountId(m.debit),
        creditAccountId: accountId(m.credit),
        debitProfitCenter: m.debitPc ?? null,
        creditProfitCenter: m.creditPc ?? null,
        profitCenterRule: m.rule ?? "fixed",
        effectiveFrom: SEED_EFFECTIVE_FROM,
      })),
    )
    .onConflictDoNothing();

  await tx
    .insert(taxSettings)
    .values({
      id: seedId(`tax_setting:${SEED_EFFECTIVE_FROM}`),
      tenantId: EQUA_TENANT_ID,
      scheme: "non_pkp_final",
      isPkp: false,
      effectiveFrom: SEED_EFFECTIVE_FROM,
      notes: "PT non-PKP (BR-29); skema PPh final UMKM menunggu penetapan konsultan pajak (BR-30, PAR-64).",
    })
    .onConflictDoNothing();

  if (options.demoBankAccount !== false) {
    await tx
      .insert(bankAccounts)
      .values({
        id: seedId("bank_account:operasional"),
        tenantId: EQUA_TENANT_ID,
        bankName: "Bank Demo",
        accountNumber: "0012345678",
        accountName: "EQUA",
        branch: "Cianjur",
        isCustomerFacing: true,
        glAccountId: accountId("1-1201"),
      })
      .onConflictDoNothing();
  }

  await tx
    .insert(exportTemplates)
    .values({
      id: seedId("export_template:journals-consultant:1"),
      tenantId: EQUA_TENANT_ID,
      key: "journals-consultant",
      name: "Jurnal umum — format konsultan pajak (contoh)",
      target: "journals",
      format: "xlsx",
      columnMapping: [
        { header: "Tanggal", field: "journalDate" },
        { header: "No. Jurnal", field: "number" },
        { header: "Kode Akun", field: "accountCode" },
        { header: "Nama Akun", field: "accountName" },
        { header: "Pusat Laba", field: "profitCenter" },
        { header: "Keterangan", field: "description" },
        { header: "Debit", field: "debit" },
        { header: "Kredit", field: "credit" },
      ],
    })
    .onConflictDoNothing();
}
