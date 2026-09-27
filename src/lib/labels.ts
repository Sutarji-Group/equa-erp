/**
 * Label Bahasa Indonesia untuk enum & kode peran (docs/ARCHITECTURE.md §4).
 * Kode = bahasa Inggris; UI = istilah PRD. Berkas BERSAMA: hanya boleh DITAMBAH (append), jangan ubah/rename entri.
 *
 * Pakai: `label("order_status", order.status)` → `"Menunggu persetujuan"`.
 * Nilai enum untuk `pgEnum`/Zod: `enumValues("order_status")` → `["new", "awaiting_approval", …]`.
 */

export const LABELS = {
  /** Kode peran (`RoleCode`). */
  role: {
    owner: "Pemilik",
    finance_admin: "Admin Keuangan",
    dispatcher: "Dispatcher",
    driver: "Sopir",
    helper: "Kernet",
    depot_operator: "Operator depot",
    store_cashier: "Kasir toko",
    production_operator: "Operator produksi",
    system_admin: "Admin sistem",
    accountant: "Akuntan",
    partner_owner: "Pemilik mitra",
    regional_coach: "Pembina wilayah",
  },
  /** Status pesanan. */
  order_status: {
    new: "Baru",
    awaiting_approval: "Menunggu persetujuan",
    scheduled: "Terjadwal",
    in_delivery: "Dalam pengiriman",
    completed: "Selesai",
    cancelled: "Dibatalkan",
  },
  /** Status rit. */
  trip_status: {
    assigned: "Ditugaskan",
    departed: "Berangkat",
    arrived: "Tiba",
    completed: "Selesai",
    failed: "Gagal",
  },
  /** Status setoran (sopir/depot/toko). */
  deposit_status: {
    running: "Berjalan",
    submitted: "Diajukan",
    received: "Diterima",
    closed: "Ditutup",
  },
  /** Sumber setoran. */
  deposit_source_type: {
    driver: "Sopir",
    depot_shift: "Shift depot",
    store_shift: "Shift toko",
  },
  /** Status selisih. */
  discrepancy_status: {
    formed: "Terbentuk",
    explained: "Dijelaskan",
    approved: "Disetujui",
    rejected: "Ditolak",
    followed_up: "Ditindaklanjuti",
    done: "Selesai",
  },
  /** Status shift depot/toko. */
  shift_status: {
    open: "Terbuka",
    closed: "Ditutup",
  },
  /** Status setoran shift. */
  shift_deposit_status: {
    not_deposited: "Belum disetor",
    deposited: "Disetor",
    received: "Diterima",
  },
  /** Status faktur. */
  invoice_status: {
    open: "Terbuka",
    partial: "Sebagian dibayar",
    paid: "Lunas",
  },
  /** Jenis faktur (F2 boleh menambah jenis lain). */
  invoice_kind: {
    underpayment: "Kurang bayar",
  },
  /** Status periode akuntansi. */
  period_status: {
    open: "Terbuka",
    closed: "Ditutup",
    locked: "Dikunci",
    reopened: "Dibuka kembali",
  },
  /** Status permintaan persetujuan. */
  approval_status: {
    submitted: "Diajukan",
    approved: "Disetujui",
    rejected: "Ditolak",
    expired: "Lewat tenggat",
    cancelled: "Dibatalkan",
  },
  /** Status perangkat lapangan/POS. */
  device_status: {
    registered: "Terdaftar",
    active: "Aktif",
    blocked: "Diblokir",
    wipe_pending: "Menunggu hapus data",
    wiped: "Data terhapus",
  },
  /** Status transfer masuk. */
  incoming_transfer_status: {
    unmatched: "Belum dicocokkan",
    matched: "Cocok",
    not_found: "Tidak ditemukan",
  },
  /** Status notifikasi. */
  notification_status: {
    new: "Baru",
    read: "Dibaca",
    actioned: "Ditindaklanjuti",
    done: "Selesai",
  },
  /** Status kredit pelanggan. */
  credit_status: {
    cash: "Tunai",
    credit: "Tempo",
    credit_migrated: "Tempo migrasi",
    on_hold: "Ditahan",
  },
  /** Jenis outlet. */
  outlet_kind: {
    depot: "Depot",
    store: "Toko",
  },
  /** Pusat laba (PRD M11: L1 produksi air, L2 air truk, L3 depot, L4 toko, L5 kemitraan; umum = pusat biaya bersama). */
  profit_center: {
    L1: "L1 Produksi air",
    L2: "L2 Air truk",
    L3: "L3 Depot",
    L4: "L4 Toko",
    L5: "L5 Kemitraan",
    SHARED: "Umum/kantor (bersama)",
  },
  /** Sumber aksi (`ActorContext.source`). */
  actor_source: {
    web: "Web kantor",
    field: "Aplikasi lapangan",
    pos: "POS",
    system: "Sistem",
    customer_app: "Aplikasi pelanggan",
    partner_portal: "Portal mitra",
  },
} as const satisfies Record<string, Record<string, string>>;

export type EnumName = keyof typeof LABELS;
export type EnumValue<E extends EnumName> = keyof (typeof LABELS)[E] & string;

export type RoleCode = EnumValue<"role">;
export type OrderStatus = EnumValue<"order_status">;
export type TripStatus = EnumValue<"trip_status">;
export type DepositStatus = EnumValue<"deposit_status">;
export type DepositSourceType = EnumValue<"deposit_source_type">;
export type DiscrepancyStatus = EnumValue<"discrepancy_status">;
export type ShiftStatus = EnumValue<"shift_status">;
export type ShiftDepositStatus = EnumValue<"shift_deposit_status">;
export type InvoiceStatus = EnumValue<"invoice_status">;
export type PeriodStatus = EnumValue<"period_status">;
export type ApprovalStatus = EnumValue<"approval_status">;
export type DeviceStatus = EnumValue<"device_status">;
export type IncomingTransferStatus = EnumValue<"incoming_transfer_status">;
export type NotificationStatus = EnumValue<"notification_status">;
export type CreditStatus = EnumValue<"credit_status">;
export type OutletKind = EnumValue<"outlet_kind">;
export type ProfitCenter = EnumValue<"profit_center">;
export type ActorSource = EnumValue<"actor_source">;

/** Label Indonesia untuk nilai enum. Nilai tak dikenal dikembalikan apa adanya; kosong → `"—"`. */
export function label<E extends EnumName>(enumName: E, value: EnumValue<E> | (string & {}) | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const map = LABELS[enumName] as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value]! : value;
}

/** Nilai enum (urutan sesuai deklarasi) sebagai tuple non-kosong — cocok untuk `pgEnum` & `z.enum`. */
export function enumValues<E extends EnumName>(enumName: E): [EnumValue<E>, ...EnumValue<E>[]] {
  return Object.keys(LABELS[enumName]) as [EnumValue<E>, ...EnumValue<E>[]];
}

/** Pilihan `{ value, label }` untuk komponen Select. */
export function enumOptions<E extends EnumName>(enumName: E): { value: EnumValue<E>; label: string }[] {
  return enumValues(enumName).map((value) => ({ value, label: label(enumName, value) }));
}

/** Benar bila `value` adalah nilai sah untuk enum tersebut. */
export function isEnumValue<E extends EnumName>(enumName: E, value: unknown): value is EnumValue<E> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LABELS[enumName], value);
}

/** Semua kode peran. */
export const ROLE_CODES = enumValues("role");
