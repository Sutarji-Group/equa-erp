/**
 * Registri jenis persetujuan (PRD Bab 6.2a; US-M10-04 KP-1). Kode = `approval_requests.type` (label di
 * `LABELS.approval_type`). Tahap 1: penyetuju pemilik, kecuali `field_payment_to_credit` → Dispatcher (PTB-19) dan
 * `store_product`/`supplier` → Admin Keuangan (US-M7-02 KP-2, 7.7.3).
 *
 * Tenggat & perilaku lewat tenggat (PTB-32, US-M10-04 KP-4):
 * - `expire`             → status Lewat tenggat + handler `onExpired` modul (mis. pesanan tetap tunai / geser H+1,
 *                          void/diskon dianggap ditolak di akhir shift, harga lama tetap berlaku).
 * - `escalate`           → tetap terbuka, diberi penanda `overdue_at`, naik ke puncak kotak masuk, pengingat ke
 *                          penyetuju (mis. selisih dihitung KPI-03; jurnal manual memblokir tutup buku).
 * - `none`               → tanpa tenggat.
 *
 * Ambang tiap jenis diambil dari parameter (kolom `thresholdParam`) oleh MODUL sebelum memanggil `submit` — registri
 * mencatatnya untuk dokumentasi & tampilan.
 *
 * BERKAS BERSAMA — tambah jenis baru (append) + label di `src/lib/labels.ts` (`approval_type`).
 */
import type { ApprovalType, RoleCode } from "@/lib/labels";

import type { ParamKey } from "../params-registry";

export type DeadlineRule =
  | { kind: "none" }
  /** Jam sejak diajukan (mis. ≤ 24 jam). */
  | { kind: "hours"; hours: number }
  /** Hari kalender sejak diajukan. */
  | { kind: "days"; days: number }
  /** Hari kerja sejak diajukan (lewati Sabtu/Minggu), berakhir 23.59 WIB. */
  | { kind: "business_days"; days: number }
  /** Tanggal ke-N bulan berikutnya dari parameter (mis. PAR-23 tutup buku ≤ tanggal 10), berakhir 23.59 WIB. */
  | { kind: "param_day_of_next_month"; param: ParamKey; field: string }
  /** Tenggat ditentukan modul saat mengajukan (sebelum jadwal terbit, akhir shift, tanggal berlaku, tutup kas…). */
  | { kind: "explicit"; description: string };

export type ExpireBehavior = "expire" | "escalate" | "none";

export type ApprovalTypeDef = {
  type: ApprovalType;
  label: string;
  /** Peran yang boleh mengajukan. */
  requesterRoles: readonly RoleCode[];
  /** Peran penyetuju (6.2a). */
  approverRole: RoleCode;
  /** Parameter ambang/syarat (Lampiran B). */
  thresholdParam?: ParamKey;
  thresholdNote: string;
  deadline: DeadlineRule;
  onExpire: ExpireBehavior;
  /** Kolom "Bila lewat tenggat" Bab 6.2a. */
  expireNote: string;
  /** Notifikasi ke penyetuju saat diajukan: kritis untuk hal uang besar. */
  severity: "critical" | "high" | "normal";
  /** Jenis objek utama yang dirujuk. */
  objectType: string;
  ref: string;
  /**
   * Peran lain yang DIBERI TAHU (bukan memutuskan) saat diajukan, dengan kode notifikasi katalog — mis. void POS:
   * "Pemilik (Admin Keuangan menerima notifikasi)" (6.2a).
   */
  notifyAlso?: { roles: readonly RoleCode[]; event: string };
};

const T = (def: ApprovalTypeDef): ApprovalTypeDef => def;

export const APPROVAL_TYPES: readonly ApprovalTypeDef[] = [
  T({
    type: "cash_discrepancy",
    label: "Selisih setoran",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-01",
    thresholdNote: "≥ Rp 50.000 per sopir/outlet per hari; di bawahnya ditutup Admin Keuangan dengan alasan",
    deadline: { kind: "hours", hours: 24 },
    onExpire: "escalate",
    expireNote: "Tetap terbuka, naik ke puncak kotak masuk, dihitung KPI-03",
    severity: "critical",
    objectType: "discrepancy",
    ref: "BR-09, FR-M4-03",
  }),
  T({
    type: "credit_order",
    label: "Pesanan tempo di luar kontrol kredit",
    requesterRoles: ["dispatcher", "store_cashier"],
    approverRole: "owner",
    thresholdNote: "Status Ditahan atau eksposur melampaui batas (BR-06)",
    deadline: { kind: "explicit", description: "Sebelum jadwal terbit" },
    onExpire: "expire",
    expireNote: "Pesanan tetap tunai atau digeser ke H+1 dengan pemberitahuan ke pelanggan",
    severity: "high",
    objectType: "order",
    ref: "FR-M2-05, US-M7-04 KP-1",
  }),
  T({
    type: "credit_grant",
    label: "Pemberian status Tempo",
    requesterRoles: ["dispatcher"],
    approverRole: "owner",
    thresholdParam: "PAR-11",
    thresholdNote: "Hanya bila PAR-11 dan PAR-82 terpenuhi; rumah tangga tidak dapat Tempo (BR-04)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Status tetap Tunai",
    severity: "normal",
    objectType: "customer",
    ref: "BR-01, BR-04",
  }),
  T({
    type: "credit_terms_change",
    label: "Ubah batas/tempo pelanggan",
    requesterRoles: ["dispatcher"],
    approverRole: "owner",
    thresholdParam: "PAR-10",
    thresholdNote: "Batas bawaan dari segmen; perubahan per pelanggan hanya oleh pemilik",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Batas/tempo lama berlaku",
    severity: "normal",
    objectType: "customer",
    ref: "BR-02, BR-04",
  }),
  T({
    type: "credit_hold_release",
    label: "Pembukaan status Ditahan",
    requesterRoles: ["dispatcher", "finance_admin"],
    approverRole: "owner",
    thresholdNote: "Alasan tercatat; berlaku sampai keterlambatan berikutnya",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Tetap Ditahan",
    severity: "normal",
    objectType: "customer",
    ref: "BR-03, FR-M5-06",
  }),
  T({
    type: "price_change",
    label: "Perubahan harga master/zona/BBM",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdNote: "Tanggal berlaku wajib",
    deadline: { kind: "explicit", description: "Sebelum tanggal berlaku" },
    onExpire: "expire",
    expireNote: "Harga lama tetap berlaku",
    severity: "normal",
    objectType: "price",
    ref: "BR-15, BR-19",
  }),
  T({
    type: "special_price",
    label: "Harga khusus pelanggan",
    requesterRoles: ["dispatcher"],
    approverRole: "owner",
    thresholdParam: "PAR-24",
    thresholdNote: "Alasan + tanggal berlaku; tinjauan 6 bulan",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Harga master berlaku",
    severity: "normal",
    objectType: "special_price",
    ref: "BR-16",
  }),
  T({
    type: "store_discount",
    label: "Diskon kasir toko",
    requesterRoles: ["store_cashier"],
    approverRole: "owner",
    thresholdParam: "PAR-14",
    thresholdNote: "> 5%",
    deadline: { kind: "explicit", description: "Saat transaksi (sampai akhir shift)" },
    onExpire: "expire",
    expireNote: "Dianggap ditolak di akhir shift",
    severity: "high",
    objectType: "pos_sale",
    ref: "BR-17",
  }),
  T({
    type: "pos_void",
    label: "Void POS",
    requesterRoles: ["depot_operator", "store_cashier"],
    approverRole: "owner",
    thresholdParam: "PAR-04",
    thresholdNote: "Void > Rp 100.000; > 3 void/hari/outlet → notifikasi Admin Keuangan (PAR-03)",
    deadline: { kind: "explicit", description: "Saat transaksi (sampai akhir shift)" },
    onExpire: "expire",
    expireNote: "Dianggap ditolak di akhir shift; transaksi tetap dihitung",
    severity: "high",
    objectType: "pos_sale",
    ref: "BR-13",
    notifyAlso: { roles: ["finance_admin"], event: "pos.void_requested" },
  }),
  T({
    type: "stock_adjustment",
    label: "Penyesuaian stok",
    requesterRoles: ["store_cashier", "depot_operator", "finance_admin"],
    approverRole: "owner",
    thresholdNote: "Semua penyesuaian opname",
    deadline: { kind: "days", days: 3 },
    onExpire: "escalate",
    expireNote: "Saldo tidak berubah; tetap di daftar",
    severity: "normal",
    objectType: "stock_count",
    ref: "BR-27, FR-M7-04",
  }),
  T({
    type: "manual_journal",
    label: "Jurnal manual",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-20",
    thresholdNote: "> Rp 5 juta persetujuan sebelum posting; ≤ Rp 5 juta terposting + tinjauan wajib pemilik (PTB-12)",
    deadline: { kind: "explicit", description: "Sebelum tutup buku" },
    onExpire: "escalate",
    expireNote: "Tidak terposting; periode tidak dapat ditutup",
    severity: "normal",
    objectType: "journal",
    ref: "BR-35, FR-M11-03",
  }),
  T({
    type: "correction",
    label: "Koreksi/transaksi pembalik",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-21",
    thresholdNote: "> Rp 500.000",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Koreksi tidak berlaku",
    severity: "normal",
    objectType: "correction",
    ref: "BR-38",
  }),
  T({
    type: "petty_cash",
    label: "Kas kecil",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-43",
    thresholdNote: "Pengisian/pengeluaran > Rp 500.000",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Tidak berlaku",
    severity: "normal",
    objectType: "petty_cash_transaction",
    ref: "US-M4-05",
  }),
  T({
    type: "cash_close_exception",
    label: "Tutup kas dengan setoran tertunda",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-89",
    thresholdNote: "Per kejadian untuk sumber berhalangan, maks. 1 hari; rit sopir tetap terkunci (PTB-21)",
    deadline: { kind: "explicit", description: "Sebelum tutup kas" },
    onExpire: "expire",
    expireNote: "Kas tidak dapat ditutup",
    severity: "high",
    objectType: "cash_day",
    ref: "FR-M4-06, CR-06",
  }),
  T({
    type: "second_underpayment_order",
    label: "Pesanan saat kurang bayar kedua",
    requesterRoles: ["dispatcher"],
    approverRole: "owner",
    thresholdNote: "Kurang bayar kedua saat yang pertama belum lunas (PTB-18)",
    deadline: { kind: "explicit", description: "Sebelum jadwal terbit" },
    onExpire: "expire",
    expireNote: "Pesanan tidak dapat dijadwalkan",
    severity: "high",
    objectType: "order",
    ref: "PTB-18",
  }),
  T({
    type: "field_payment_to_credit",
    label: "Ubah tunai menjadi tempo di lapangan",
    requesterRoles: ["driver", "helper"],
    approverRole: "dispatcher",
    thresholdNote: "Hanya saat daring; pelanggan Tempo dan dalam batas (PTB-19)",
    deadline: { kind: "explicit", description: "Saat di lokasi" },
    onExpire: "expire",
    expireNote: "Dicatat sebagai kurang bayar (US-M3-04 KP-2)",
    severity: "high",
    objectType: "trip",
    ref: "FR-M2-05, PTB-19",
  }),
  T({
    type: "period_lock",
    label: "Tutup buku dan kunci periode",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-23",
    thresholdNote: "Rekonsiliasi nol selisih; daftar tinjauan jurnal manual ≤ Rp 5 juta ditandai",
    deadline: { kind: "param_day_of_next_month", param: "PAR-23", field: "day_of_next_month" },
    onExpire: "escalate",
    expireNote: "Ditandai terlambat",
    severity: "normal",
    objectType: "accounting_period",
    ref: "BR-32",
  }),
  T({
    type: "account_create",
    label: "Akun pengguna baru",
    requesterRoles: ["system_admin"],
    approverRole: "owner",
    thresholdNote: "Semua; pencabutan akses tidak memerlukan persetujuan (BR-37)",
    deadline: { kind: "business_days", days: 2 },
    onExpire: "escalate",
    expireNote: "Akun tidak aktif",
    severity: "normal",
    objectType: "user",
    ref: "BRD 10.2, FR-M10-01",
  }),
  T({
    type: "role_grant",
    label: "Pemberian/perubahan peran",
    requesterRoles: ["system_admin"],
    approverRole: "owner",
    thresholdNote: "Semua; kombinasi terlarang PTB-31 tidak dapat diajukan",
    deadline: { kind: "business_days", days: 2 },
    onExpire: "escalate",
    expireNote: "Peran tidak aktif",
    severity: "normal",
    objectType: "user",
    ref: "BRD 10.2, FR-M10-01",
  }),
  T({
    type: "scope_extension",
    label: "Perluasan lingkup",
    requesterRoles: ["system_admin"],
    approverRole: "owner",
    thresholdNote: "Semua; pengurangan lingkup berlaku seketika",
    deadline: { kind: "business_days", days: 2 },
    onExpire: "escalate",
    expireNote: "Lingkup tidak aktif",
    severity: "normal",
    objectType: "user",
    ref: "US-M10-01 KP-8",
  }),
  T({
    type: "multi_role",
    label: "Satu orang lebih dari satu peran",
    requesterRoles: ["system_admin"],
    approverRole: "owner",
    thresholdNote: "Alasan + masa berlaku; kombinasi terlarang PTB-31 tidak dapat diajukan",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Tidak aktif",
    severity: "normal",
    objectType: "user",
    ref: "FR-M10-01, US-M10-01 KP-4",
  }),
  T({
    type: "monthly_billing",
    label: "Penanda tagihan bulanan",
    requesterRoles: ["finance_admin", "dispatcher"],
    approverRole: "owner",
    thresholdNote: "Hanya dengan perjanjian tertulis terlampir (BR-05)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Pelanggan tetap ditagih per rit",
    severity: "normal",
    objectType: "customer",
    ref: "BR-05, US-M5-06 KP-1",
  }),
  T({
    type: "store_product",
    label: "Barang toko baru/perubahan harga toko",
    requesterRoles: ["store_cashier"],
    approverRole: "finance_admin",
    thresholdNote: "Barang baru & perubahan harga jual toko (BRD 10.2)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Barang/harga belum berlaku",
    severity: "normal",
    objectType: "product",
    ref: "US-M7-02 KP-2",
  }),
  T({
    type: "supplier",
    label: "Pemasok baru",
    requesterRoles: ["store_cashier"],
    approverRole: "finance_admin",
    thresholdNote: "Pemasok diusulkan kasir, disetujui Admin Keuangan",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Pemasok belum aktif",
    severity: "normal",
    objectType: "supplier",
    ref: "7.7.3",
  }),
  T({
    type: "customer_refund",
    label: "Pengembalian uang muka",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdNote: "Kelebihan bayar yang dikembalikan ke pelanggan",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Uang muka tetap dialokasikan ke faktur berikutnya",
    severity: "normal",
    objectType: "customer_advance",
    ref: "US-M5-02 KP-3",
  }),
  T({
    type: "anonymization",
    label: "Anonimisasi data pribadi",
    requesterRoles: ["system_admin"],
    approverRole: "owner",
    thresholdNote: "Ditunda bila piutang terbuka (PTB-36)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Data tidak dianonimkan",
    severity: "normal",
    objectType: "anonymization_request",
    ref: "US-M10-06 KP-2",
  }),
  T({
    type: "opening_balance_adjustment",
    label: "Penyesuaian saldo awal",
    requesterRoles: ["finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-62",
    thresholdNote: "Paling lama 3 bulan setelah cut-over; dengan catatan akuntan (PTB-44)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Saldo awal tidak berubah",
    severity: "normal",
    objectType: "opening_balance_batch",
    ref: "US-M11-09 KP-3",
  }),
  T({
    type: "partner_prospect",
    label: "Persetujuan calon mitra",
    requesterRoles: ["regional_coach"],
    approverRole: "owner",
    thresholdParam: "PAR-81",
    thresholdNote: "Mitra maksimal Fase 1 (PAR-81); radius eksklusif (PAR-35)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Prospek belum disetujui",
    severity: "normal",
    objectType: "partner_prospect",
    ref: "US-P3-01 KP-3",
  }),
  T({
    type: "partner_contract",
    label: "Kontrak mitra",
    requesterRoles: ["finance_admin", "regional_coach"],
    approverRole: "owner",
    thresholdParam: "PAR-35",
    thresholdNote: "Parameter kontrak (langganan, royalti, diskon, radius) disetujui pemilik",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Kontrak belum aktif",
    severity: "normal",
    objectType: "partner_contract",
    ref: "US-P3-09 KP-1, US-P3-01 KP-3",
  }),
  T({
    type: "partner_sanction",
    label: "Sanksi mitra",
    requesterRoles: ["regional_coach", "finance_admin"],
    approverRole: "owner",
    thresholdNote: "Sanksi bertingkat, setiap tahap diputuskan pemilik (PTB-59)",
    deadline: { kind: "none" },
    onExpire: "none",
    expireNote: "Sanksi tidak berlaku",
    severity: "normal",
    objectType: "partner_sanction",
    ref: "US-P3-07",
  }),
  // --- Tambahan modul M9 (hanya tambah) ---
  T({
    type: "paper_withdrawal_early",
    label: "Tarik nota kertas lebih awal (periode paralel)",
    requesterRoles: ["system_admin", "finance_admin"],
    approverRole: "owner",
    thresholdParam: "PAR-84",
    thresholdNote: "Sebelum hari ke-14 periode paralel; syarat PAR-84 (5 hari operasi terakhir 100% tercatat di sumber, 0 selisih tak terjelaskan)",
    deadline: { kind: "explicit", description: "Sebelum hari ke-14 periode paralel unit (batas NFR-35)" },
    onExpire: "expire",
    expireNote: "Nota kertas ditarik pada hari ke-14 sesuai batas NFR-35",
    severity: "normal",
    objectType: "unit_paper_withdrawal",
    ref: "NFR-35, 11.5 butir 2, US-M9-07 KP-2",
  }),
  // --- Tambahan modul M7 (hanya tambah) ---
  T({
    type: "store_credit_sale",
    label: "Penjualan tempo toko di luar kontrol kredit",
    requesterRoles: ["store_cashier"],
    approverRole: "owner",
    thresholdNote: "Mitra toko berstatus Tunai/Ditahan atau eksposur lintas lini > batas kredit (BR-04, BR-06; US-M2-05 KP-3 berlaku sama)",
    deadline: { kind: "explicit", description: "Saat transaksi (sampai akhir shift)" },
    onExpire: "expire",
    expireNote: "Dianggap ditolak di akhir shift; transaksi tidak berlaku",
    severity: "high",
    objectType: "pos_sale",
    ref: "US-M7-04 KP-1",
  }),
];

const BY_TYPE = new Map<string, ApprovalTypeDef>(APPROVAL_TYPES.map((def) => [def.type, def]));

export function getApprovalType(type: string): ApprovalTypeDef | undefined {
  return BY_TYPE.get(type);
}

export function isApprovalType(type: string): type is ApprovalType {
  return BY_TYPE.has(type);
}

/** Peran penyetuju yang dikenal (untuk izin kotak persetujuan). */
export const APPROVER_ROLES: readonly RoleCode[] = Array.from(new Set(APPROVAL_TYPES.map((d) => d.approverRole)));
