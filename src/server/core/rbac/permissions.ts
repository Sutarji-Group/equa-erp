/**
 * Katalog izin LENGKAP (US-M10-01 KP-1, US-M10-03, Bab 3.2, Bab 6.2, "Peran & antarmuka" tiap modul, docs/nav-permissions.md).
 *
 * Bentuk kunci: `<modul>.<sumberdaya>.<aksi>` (huruf kecil, snake_case) — sama dengan `PERMISSION_PATTERN` registri nav.
 * Setiap izin punya label Indonesia, jenis, penanda pemisahan tugas, dan daftar peran yang memilikinya (sumber matriks
 * peran × izin di `./matrix.ts`). Penanda dipakai uji invarian US-M10-03 KP-1:
 * - `finance`   — mengubah transaksi keuangan → admin sistem DILARANG;
 * - `daily`     — input transaksi harian → pemilik DILARANG;
 * - `cash`      — mengakses kas/setoran/pembayaran → dispatcher DILARANG;
 * - `orderWrite`— membuat/mengubah pesanan & pengiriman → Admin Keuangan DILARANG;
 * - `pii`       — memuat data pribadi pelanggan/mitra (BR-39).
 * Akuntan hanya `read`/`export`/`attest`. Pemilik mitra hanya `read` (+ mengajukan permintaan dukungan, US-P3-11).
 *
 * BERKAS BERSAMA — modul hanya MENAMBAH entri baru (jangan ubah kunci/peran yang ada tanpa keputusan PM). Setiap izin
 * menu di `src/components/shared/nav/registry.ts` WAJIB ada di sini (uji `tests/core/rbac.test.ts`).
 */
import type { RoleCode } from "@/lib/labels";

export type PermissionKind = "read" | "write" | "approve" | "export" | "admin" | "attest";

export type PermissionDef = {
  key: string;
  label: string;
  module: string;
  kind: PermissionKind;
  roles: readonly RoleCode[];
  finance?: boolean;
  daily?: boolean;
  cash?: boolean;
  orderWrite?: boolean;
  pii?: boolean;
  /** Rujukan PRD. */
  ref?: string;
  /** Jalur pengecualian yang ditetapkan (US-M10-03 KP-3), mis. `office_entry`. */
  exception?: string;
};

type Flags = Omit<PermissionDef, "key" | "label" | "module" | "roles" | "kind"> & { kind?: PermissionKind };

// Singkatan peran (hanya di berkas ini).
const O = "owner" as const;
const FA = "finance_admin" as const;
const D = "dispatcher" as const;
const DR = "driver" as const;
const H = "helper" as const;
const DO = "depot_operator" as const;
const SC = "store_cashier" as const;
const PO = "production_operator" as const;
const SA = "system_admin" as const;
const AC = "accountant" as const;
const PW = "partner_owner" as const;
const RC = "regional_coach" as const;

function inferKind(key: string): PermissionKind {
  const action = key.split(".")[2] ?? "";
  if (action === "read") return "read";
  if (action.startsWith("export")) return "export";
  if (["decide", "approve", "lock", "reopen", "review", "sign", "accept", "set", "mark"].includes(action)) return "approve";
  if (action === "attest" || action === "review_note") return "attest";
  return "write";
}

function p(key: string, label: string, roles: readonly RoleCode[], flags: Flags = {}): PermissionDef {
  const [module] = key.split(".");
  return { key, label, module: module!, roles, ...flags, kind: flags.kind ?? inferKind(key) };
}

export const PERMISSIONS: readonly PermissionDef[] = [
  // ===================================================================================================================
  // M1 — Master data
  // ===================================================================================================================
  p("m1.customer.read", "Melihat pelanggan", [O, FA, D, SC]),
  p("m1.customer.create", "Membuat pelanggan", [D], { ref: "US-M1-01" }),
  p("m1.customer.update", "Mengubah data pelanggan & alamat kirim", [D], { ref: "US-M1-01" }),
  p("m1.customer.deactivate", "Menonaktifkan pelanggan", [D], { ref: "US-M1-01 KP-8" }),
  p("m1.customer.lock_coordinate", "Mengunci koordinat alamat kirim", [D], { ref: "US-M1-01 KP-2" }),
  p("m1.customer.request_credit", "Mengajukan status Tempo", [D], { ref: "US-M1-01 KP-3, 6.2a" }),
  p("m1.customer.request_credit_terms", "Mengajukan perubahan batas/tempo pelanggan", [D], { ref: "BR-04, 6.2a" }),
  p("m1.customer.set_credit_migrated", "Menetapkan status Tempo migrasi (data awal)", [O], {
    kind: "approve",
    ref: "US-M1-06 KP-6, 6.2b",
  }),
  p("m1.customer.export", "Mengekspor data pelanggan", [O, FA], { pii: true, ref: "BR-39" }),
  p("m1.customer_pii.read", "Melihat kontak & alamat lengkap pelanggan", [O, FA, D, DR, H], {
    pii: true,
    ref: "US-M10-06 KP-1",
  }),
  p("m1.special_price.read", "Melihat harga khusus pelanggan", [O, FA, D]),
  p("m1.special_price.request", "Mengajukan harga khusus pelanggan", [D], { ref: "BR-16, 6.2a" }),
  p("m1.special_price.review", "Meninjau harga khusus lewat 6 bulan", [O], { ref: "BR-16" }),
  p("m1.product.read", "Melihat produk", [O, FA, D, SC, DO]),
  p("m1.product.create", "Membuat produk depot / air truk", [FA], { ref: "US-M1-02" }),
  p("m1.product.update", "Mengubah atribut produk", [FA], { ref: "US-M1-02" }),
  p("m1.product.deactivate", "Menonaktifkan produk", [FA, O], { ref: "US-M1-02 KP-6" }),
  p("m1.price.read", "Melihat harga & riwayat harga", [O, FA, D]),
  p("m1.price.request", "Mengajukan perubahan harga master/zona/BBM", [FA], { ref: "BR-15, 6.2a" }),
  p("m1.price.set", "Menetapkan harga langsung (keputusan pemilik)", [O], { ref: "BR-15, 6.2b" }),
  p("m1.tariff_zone.read", "Melihat zona tarif", [O, FA, D]),
  p("m1.tariff_zone.update", "Mengubah tabel zona tarif", [O], { kind: "approve", ref: "US-M1-05" }),
  p("m1.truck.read", "Melihat armada", [O, FA, D, SA]),
  p("m1.truck.create", "Mendaftarkan truk", [D], { ref: "US-M1-03" }),
  p("m1.truck.update", "Mengubah truk, status, kru default", [D], { ref: "US-M1-03" }),
  p("m1.truck.deactivate", "Menonaktifkan truk", [D, O], { ref: "US-M1-03" }),
  p("m1.outlet.read", "Melihat depot & toko", [O, FA, D, SA]),
  p("m1.outlet.create", "Membuat outlet depot/toko", [O, SA], { ref: "US-M1-04, US-M6-07" }),
  p("m1.outlet.update", "Mengubah data outlet", [O], { kind: "approve", ref: "US-M1-04" }),
  p("m1.outlet.deactivate", "Menonaktifkan outlet", [O], { kind: "approve", ref: "US-M1-04 KP-4" }),
  p("m1.water_source.read", "Melihat sumber air & meter", [O, FA, D, SA]),
  p("m1.water_source.create", "Membuat sumber air", [O], { kind: "approve", ref: "US-M1-04" }),
  p("m1.water_source.update", "Mengubah sumber air", [O], { kind: "approve", ref: "US-M1-04" }),
  p("m1.water_meter.update", "Mencatat penggantian/putaran meter", [SA, FA], { ref: "US-M8-01 KP-2" }),
  p("m1.pool_location.read", "Melihat pool/garasi", [O, D, SA]),
  p("m1.pool_location.update", "Menetapkan pool/garasi (persetujuan pemilik)", [O], { kind: "approve", ref: "PTB-34" }),
  p("m1.employee.read", "Melihat karyawan", [O, SA]),
  p("m1.employee.create", "Menambah karyawan", [SA], { ref: "US-M1-04 KP-3" }),
  p("m1.employee.update", "Mengubah karyawan (termasuk tanggal keluar)", [SA], { ref: "US-M1-04 KP-3, BR-37" }),
  p("m1.employee.deactivate", "Menonaktifkan karyawan", [SA], { ref: "BR-37" }),
  p("m1.employee.allow_bank_deposit", "Mengizinkan sopir setor bank dengan slip", [O], { kind: "approve", ref: "PTB-23" }),
  p("m1.recipe.read", "Melihat resep bahan depot", [O, FA, DO]),
  p("m1.recipe.update", "Menetapkan resep bahan depot", [O], { kind: "approve", ref: "US-M6-04 KP-2" }),
  p("m1.wa_template.read", "Melihat template WhatsApp", [O, FA, D]),
  p("m1.wa_template.update", "Mengelola template WhatsApp", [O], { kind: "approve", ref: "US-M2-07 KP-1" }),
  p("m1.import.read", "Melihat hasil impor data awal", [O, D, SA, FA]),
  p("m1.import.create", "Mengimpor data awal", [D, SA], { ref: "US-M1-06" }),
  p("m1.import.commit", "Memasukkan data impor master NON-keuangan yang sudah valid (armada, outlet, karyawan, produk tanpa harga)", [D, SA], { ref: "US-M1-06 KP-2" }),
  p(
    "m1.import.commit_pricing",
    "Memasukkan data impor keuangan: pelanggan + harga saat ini, batas/status Tempo & Tempo migrasi (wajib tanda tangan pemilik NFR-34)",
    [D],
    { finance: true, ref: "US-M1-06 KP-1/KP-6, NFR-34" },
  ),
  p("m1.data_signoff.read", "Melihat tanda tangan data awal", [O, FA, SA, AC]),
  p("m1.data_signoff.sign", "Menandatangani ringkasan data awal", [O], { ref: "NFR-34" }),
  p("m1.data_signoff.attest", "Mengesahkan data awal aset tetap & bagan akun (akuntan)", [AC], { ref: "Bab 11.6" }),

  // ===================================================================================================================
  // M2 — Pesanan & penjadwalan
  // ===================================================================================================================
  p("m2.order.read", "Melihat pesanan", [O, FA, D]),
  p("m2.order.create", "Membuat pesanan", [D], { daily: true, orderWrite: true, ref: "US-M2-01" }),
  p("m2.order.update", "Mengubah pesanan (cara bayar, catatan, harga terbaru)", [D], { daily: true, orderWrite: true }),
  p("m2.order.cancel", "Membatalkan pesanan", [D], { daily: true, orderWrite: true, ref: "US-M2-02 KP-3" }),
  p("m2.order.reschedule", "Menjadwalkan ulang pesanan", [D], { daily: true, orderWrite: true, ref: "US-M2-09" }),
  p("m2.order.reconfirm", "Mencatat konfirmasi ulang pelanggan (BR-24)", [D], { daily: true, orderWrite: true }),
  p("m2.order.request_approval", "Mengajukan persetujuan pesanan tempo/kurang bayar kedua", [D], {
    daily: true,
    orderWrite: true,
    ref: "US-M2-05, PTB-18",
  }),
  p("m2.order.send_wa", "Mengirim konfirmasi pesanan lewat WA", [D], { pii: true, ref: "US-M2-07" }),
  p("m2.order.export", "Mengekspor daftar pesanan", [O, D], { ref: "US-M2-02 KP-4" }),
  p("m2.schedule.read", "Melihat papan jadwal", [O, FA, D]),
  p("m2.schedule.update", "Menugaskan & mengurutkan rit", [D], { daily: true, orderWrite: true, ref: "US-M2-03" }),
  p("m2.schedule.publish", "Menerbitkan jadwal ke aplikasi sopir", [D], { daily: true, orderWrite: true }),
  p("m2.crew_assignment.read", "Melihat jadwal kru", [O, FA, D]),
  p("m2.crew_assignment.update", "Menetapkan pengemudi & jadwal kru harian", [D], {
    daily: true,
    orderWrite: true,
    ref: "US-M2-10, US-M2-11",
  }),
  p("m2.recurring_order.read", "Melihat pesanan berulang", [O, FA, D]),
  p("m2.recurring_order.create", "Membuat pesanan berulang", [D], { daily: true, orderWrite: true, ref: "US-M2-06" }),
  p("m2.recurring_order.update", "Mengubah/menjeda pesanan berulang", [D], { daily: true, orderWrite: true }),
  p("m2.trip.read", "Melihat rit & bukti kirim (kantor)", [O, FA, D]),

  // ===================================================================================================================
  // M3 — Aplikasi sopir (lapangan) & pencatatan darurat kantor
  // ===================================================================================================================
  p("m3.trip.read", "Melihat rit hari ini truk sendiri", [DR, H], { ref: "US-M3-01" }),
  p("m3.trip.depart", "Mencatat Berangkat", [DR], { daily: true, orderWrite: true, ref: "US-M3-02" }),
  p("m3.trip.arrive", "Mencatat Tiba", [DR], { daily: true, orderWrite: true, ref: "US-M3-02" }),
  p("m3.trip.complete", "Menyelesaikan rit dengan bukti kirim", [DR], { daily: true, orderWrite: true, ref: "US-M3-03" }),
  p("m3.trip.fail", "Menandai rit gagal", [DR], { daily: true, orderWrite: true, ref: "US-M3-06" }),
  p("m3.trip_payment.create", "Mencatat pembayaran rit", [DR], { daily: true, cash: true, finance: true, orderWrite: true, ref: "US-M3-04" }),
  p("m3.collection.create", "Menerima pelunasan piutang di lapangan", [DR], { daily: true, cash: true, finance: true, ref: "US-M3-05" }),
  p("m3.field_credit.request", "Mengajukan ubah tunai → tempo (persetujuan Dispatcher)", [DR], { daily: true, ref: "PTB-19" }),
  p("m3.trip_incident.create", "Melaporkan kendala perjalanan", [DR], { daily: true, ref: "US-M3-06 KP-3" }),
  p("m3.trip_expense.create", "Mencatat pengeluaran rit", [DR], { daily: true, cash: true, finance: true, ref: "US-M3-08" }),
  p("m3.travel_explanation.create", "Mengisi keterangan perjalanan (BR-25)", [DR], { daily: true, ref: "US-M3-06 KP-4" }),
  p("m3.deposit.submit", "Mengajukan setoran akhir hari", [DR], { daily: true, cash: true, finance: true, ref: "US-M3-07" }),
  p("m3.cash_on_hand.read", "Melihat kas di tangan sendiri", [DR], { cash: true, ref: "US-M3-07 KP-1" }),
  p("m3.deposit_history.read", "Melihat riwayat setoran & selisih sendiri", [DR], { cash: true, ref: "US-M3-07 KP-6" }),
  p("m3.receipt.send_wa", "Mengirim struk rit lewat WA", [DR], { pii: true, ref: "US-M3-03 KP-7" }),
  p("m3.office_entry.create", "Mencatat transaksi lapangan darurat (\"dicatat kantor\")", [FA], {
    daily: true,
    finance: true,
    cash: true,
    exception: "office_entry",
    ref: "Bab 6.1, US-M3-09 KP-5",
  }),
  p("m3.trip.correct", "Koreksi/pembalik transaksi rit (Admin Keuangan)", [FA], { finance: true, ref: "FR-M3-07, BR-38" }),

  // ===================================================================================================================
  // M4 — Kas & setoran
  // ===================================================================================================================
  p("m4.cash_position.read", "Melihat kas hari ini per sumber", [O, FA], { cash: true, ref: "US-M4-01" }),
  p("m4.cash_position.export", "Mengekspor posisi kas", [O, FA], { cash: true }),
  p("m4.deposit.read", "Melihat setoran", [O, FA], { cash: true }),
  p("m4.deposit.receive", "Menerima setoran & menghitung selisih", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-02" }),
  p("m4.deposit.reopen", "Membuka kembali setoran yang belum diterima", [FA], { daily: true, cash: true, finance: true }),
  p("m4.discrepancy.read", "Melihat selisih", [O, FA], { cash: true }),
  p("m4.discrepancy.explain", "Memberi alasan & menutup selisih di bawah ambang", [FA], {
    daily: true,
    cash: true,
    finance: true,
    ref: "US-M4-02 KP-3/4",
  }),
  p("m4.discrepancy.decide", "Memutuskan selisih ≥ ambang", [O], { cash: true, finance: true, ref: "BR-09, US-M4-03" }),
  p("m4.discrepancy.reopen", "Membuka kembali selisih di bawah ambang (≤ 7 hari)", [O], { cash: true, finance: true, ref: "US-M4-03 KP-5" }),
  p("m4.incoming_transfer.read", "Melihat transfer masuk", [O, FA], { cash: true }),
  p("m4.incoming_transfer.match", "Mencocokkan transfer dengan mutasi", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-04" }),
  p("m4.bank_statement.import", "Mengimpor berkas mutasi bank", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-04 KP-3" }),
  p("m4.office_cash.read", "Melihat kas kantor & setor bank", [O, FA], { cash: true }),
  p("m4.office_cash.count", "Mencatat hitung fisik kas kantor", [FA], { daily: true, cash: true, finance: true }),
  p("m4.bank_deposit.create", "Mencatat setor ke bank", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-05" }),
  p("m4.petty_cash.read", "Melihat kas kecil", [O, FA], { cash: true }),
  p("m4.petty_cash.create", "Mencatat pengisian/pengeluaran kas kecil", [FA], { daily: true, cash: true, finance: true }),
  p("m4.petty_cash.count", "Rekonsiliasi fisik kas kecil", [FA], { daily: true, cash: true, finance: true }),
  p("m4.cash_day.read", "Melihat hari kas", [O, FA], { cash: true }),
  p("m4.cash_day.close", "Menutup kas harian", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-06" }),
  p("m4.cash_close_exception.request", "Mengajukan tutup kas dengan setoran tertunda", [FA], {
    daily: true,
    cash: true,
    finance: true,
    ref: "PTB-21",
  }),
  p("m4.restitution.read", "Melihat ganti rugi karyawan", [O, FA], { cash: true }),
  p("m4.restitution.settle", "Mencatat pelunasan ganti rugi", [FA], { daily: true, cash: true, finance: true, ref: "US-M4-03 KP-3" }),
  p("m4.restitution.export", "Mengekspor rekap ganti rugi", [O, FA], { cash: true }),
  // --- Tambahan modul M4 (hanya tambah) ---
  p("m4.bank_account.update", "Mengelola rekening bank PT (tambah/nonaktifkan)", [FA], { cash: true, finance: true, ref: "US-M4-05 KP-1" }),
  p("m4.bank_deposit.reverse", "Membalik setor ke bank yang keliru (beralasan; > PAR-21 persetujuan pemilik)", [FA], {
    daily: true,
    cash: true,
    finance: true,
    ref: "BR-38, US-M4-05",
  }),

  // ===================================================================================================================
  // M5 — Piutang & penagihan
  // ===================================================================================================================
  p("m5.receivable.read", "Melihat ringkasan piutang", [O, FA], { cash: true }),
  p("m5.credit_exposure.read", "Melihat status kredit & eksposur pelanggan", [O, FA, D], { ref: "US-M5-01 KP-3, US-M2-05" }),
  p("m5.invoice.read", "Melihat faktur", [O, FA, AC]),
  p("m5.invoice.send", "Mengirim faktur lewat WA/e-mail", [FA], { pii: true, ref: "US-M5-01 KP-5" }),
  p("m5.invoice.dispute", "Menandai faktur bersengketa", [FA], { finance: true, ref: "7.5.6" }),
  p("m5.invoice.export", "Mengekspor faktur", [O, FA], { pii: true }),
  p("m5.dispute.decide", "Memutuskan sengketa faktur", [O], { finance: true, ref: "7.5.6" }),
  p("m5.credit_note.create", "Menerbitkan nota kredit", [FA], { finance: true, ref: "BR-38, PTB-46" }),
  p("m5.customer_payment.read", "Melihat pelunasan", [O, FA], { cash: true }),
  p("m5.customer_payment.create", "Mencatat pelunasan kantor", [FA], { daily: true, cash: true, finance: true, ref: "US-M5-02" }),
  p("m5.customer_payment.reverse", "Membalik pelunasan", [FA], { cash: true, finance: true, ref: "US-M5-02 KP-4" }),
  p("m5.customer_payment.reallocate", "Mengalokasikan ulang pelunasan", [FA], { cash: true, finance: true }),
  p("m5.customer_advance.refund_request", "Mengajukan pengembalian uang muka", [FA], { cash: true, finance: true, ref: "US-M5-02 KP-3" }),
  p("m5.aging.read", "Melihat umur piutang & kartu piutang", [O, FA, AC], { ref: "US-M5-04" }),
  p("m5.aging.export", "Mengekspor umur piutang", [O, FA], { pii: true, ref: "US-M5-04 KP-4, BR-39" }),
  p("m5.reminder.read", "Melihat daftar pengingat", [O, FA]),
  p("m5.reminder.send", "Mengirim pengingat jatuh tempo lewat WA", [FA], { pii: true, ref: "US-M5-05" }),
  p("m5.monthly_invoice.read", "Melihat faktur bulanan", [O, FA]),
  p("m5.monthly_invoice.send", "Mengirim faktur bulanan", [FA], { pii: true, ref: "US-M5-06 KP-4" }),
  p("m5.monthly_billing.request", "Mengajukan penanda tagihan bulanan", [FA, D], { ref: "BR-05" }),
  p("m5.credit_hold.release_request", "Mengajukan pembukaan status Ditahan", [FA, D], { ref: "BR-03, 6.2a" }),
  p("m5.credit_hold.defer", "Menunda penahanan otomatis (masa transisi)", [O], { kind: "approve", ref: "PAR-41, 6.2b" }),
  p("m5.opening_balance.read", "Melihat saldo awal piutang", [O, FA, AC]),
  p("m5.opening_balance.create", "Mengisi saldo awal piutang", [FA], { finance: true, ref: "US-M5-07" }),

  // ===================================================================================================================
  // M6 — POS depot
  // ===================================================================================================================
  p("m6.outlet.read", "Melihat penjualan & shift outlet (kantor)", [O, FA]),
  p("m6.pos_sale.create", "Mencatat transaksi POS depot", [DO], { daily: true, cash: true, finance: true, ref: "US-M6-01" }),
  p("m6.pos_sale.void", "Void transaksi POS depot", [DO], { daily: true, cash: true, finance: true, ref: "US-M6-03" }),
  p("m6.pos_sale.correct", "Koreksi/pembalik transaksi POS (Admin Keuangan)", [FA], { finance: true, ref: "BR-38" }),
  p("m6.shift.read", "Melihat shift & riwayat outlet sendiri", [DO], { cash: true }),
  p("m6.shift.open", "Membuka shift depot", [DO], { daily: true, cash: true, finance: true, ref: "US-M6-02" }),
  p("m6.shift.close", "Menutup shift depot", [DO], { daily: true, cash: true, finance: true, ref: "US-M6-02" }),
  p("m6.shift_deposit.create", "Menyetor kas shift / setor bank sebagian", [DO], { daily: true, cash: true, finance: true }),
  p("m6.water_supply.confirm", "Mengonfirmasi pasokan air diterima", [DO], { daily: true, ref: "US-M6-05" }),
  p("m6.consumable_receipt.create", "Mencatat penerimaan bahan habis pakai", [DO], { daily: true, ref: "US-M6-04 KP-5" }),
  p("m6.internal_transfer.receive", "Mengonfirmasi penerimaan transfer internal dari toko", [DO], { daily: true, ref: "US-M7-06" }),
  p("m6.stock_count.create", "Mencatat opname depot", [DO, FA], { daily: true, ref: "US-M6-04 KP-4" }),
  p("m6.stock_adjustment.request", "Mengajukan penyesuaian stok depot", [DO, FA], { daily: true, ref: "BR-27" }),
  p("m6.outlet_settings.update", "Mengatur produk, resep, kas awal & ambang per outlet", [O], { kind: "approve", ref: "US-M6-07 KP-3" }),

  // ===================================================================================================================
  // M7 — Toko & stok
  // ===================================================================================================================
  p("m7.pos_sale.create", "Mencatat penjualan toko", [SC], { daily: true, cash: true, finance: true, ref: "US-M7-01" }),
  p("m7.pos_sale.void", "Void penjualan toko", [SC], { daily: true, cash: true, finance: true }),
  p("m7.pos_sale.correct", "Koreksi/pembalik penjualan toko (Admin Keuangan)", [FA], { finance: true }),
  p("m7.discount.request", "Mengajukan diskon di atas batas", [SC], { daily: true, finance: true, ref: "BR-17" }),
  p("m7.credit_sale.create", "Mencatat penjualan tempo mitra", [SC], { daily: true, finance: true, ref: "US-M7-04" }),
  p("m7.shift.read", "Melihat shift & kas toko sendiri", [SC], { cash: true }),
  p("m7.shift.open", "Membuka shift toko", [SC], { daily: true, cash: true, finance: true, ref: "US-M7-09" }),
  p("m7.shift.close", "Menutup shift toko", [SC], { daily: true, cash: true, finance: true, ref: "US-M7-09" }),
  p("m7.shift_deposit.create", "Menyetor kas toko / setor bank", [SC], { daily: true, cash: true, finance: true }),
  p("m7.stock.read", "Melihat barang toko & kartu stok", [O, FA, SC]),
  p("m7.store_product.propose", "Mengusulkan barang toko baru/perubahan harga toko", [SC], { ref: "US-M7-02 KP-2" }),
  p("m7.supplier.read", "Melihat pemasok", [O, FA, SC]),
  p("m7.supplier.create", "Mengusulkan pemasok baru", [SC], { ref: "7.7.3" }),
  p("m7.supplier.update", "Mengubah data pemasok", [SC, FA]),
  p("m7.purchase_receipt.read", "Melihat nota pembelian", [O, FA, SC]),
  p("m7.purchase_receipt.create", "Mencatat penerimaan barang dari nota", [SC], { daily: true, finance: true, ref: "US-M7-02" }),
  p("m7.purchase_receipt.accept_substitute", "Menerima nota pengganti", [FA], { finance: true, ref: "7.7.6" }),
  p("m7.purchase_receipt.correct", "Koreksi/retur nota pembelian", [FA], { finance: true, ref: "US-M7-02 KP-6" }),
  p("m7.stock_count.read", "Melihat opname toko", [O, FA, SC]),
  p("m7.stock_count.create", "Mencatat opname toko", [SC, FA], { daily: true, ref: "US-M7-05" }),
  p("m7.stock_adjustment.request", "Mengajukan penyesuaian stok toko", [SC, FA], { daily: true, ref: "BR-27" }),
  p("m7.reorder.read", "Melihat daftar pesan ulang", [O, FA, SC]),
  p("m7.reorder.update", "Menandai barang sudah dipesan", [SC], { ref: "US-M7-03 KP-2" }),
  p("m7.reorder.export", "Mengekspor daftar pesan ulang", [SC, FA, O]),
  p("m7.internal_transfer.read", "Melihat transfer internal ke depot", [O, FA, SC]),
  p("m7.internal_transfer.create", "Mengirim transfer internal bahan ke depot", [SC], { daily: true, ref: "US-M7-06" }),
  p("m7.supplier_payable.read", "Melihat utang pemasok", [O, FA, AC], { ref: "US-M7-08" }),
  p("m7.supplier_payment.create", "Mencatat pembayaran pemasok", [FA], { daily: true, cash: true, finance: true, ref: "US-M7-08 KP-2" }),
  p("m7.opening_payable.create", "Mengisi saldo awal utang pemasok", [FA], { finance: true, ref: "US-M11-07 KP-2" }),
  p("m7.product_performance.read", "Melihat barang laris/mati & margin", [O], { ref: "US-M7-07" }),

  // ===================================================================================================================
  // M8 — Produksi & stok air
  // ===================================================================================================================
  p("m8.production.read", "Melihat produksi & pengisian sumber sendiri", [PO, O, FA, D]),
  p("m8.meter_reading.create", "Mencatat angka meter dengan foto", [PO], { daily: true, ref: "US-M8-01" }),
  p("m8.meter_reading.correct", "Koreksi pembacaan meter", [FA], { ref: "US-M8-01 KP-5" }),
  p("m8.meter_reading.verify", "Memverifikasi produksi menyimpang", [FA], { ref: "US-M8-01 KP-4" }),
  p("m8.truck_fill.read", "Melihat pengisian truk vs jadwal", [O, FA, D, PO]),
  p("m8.truck_fill.create", "Mencatat pengisian truk", [PO], { daily: true, ref: "US-M8-02" }),
  p("m8.truck_fill.correct", "Koreksi pengisian truk", [FA], { ref: "US-M8-02 KP-6" }),
  p("m8.tank_level.create", "Mencatat level tandon", [PO], { daily: true, ref: "US-M8-04 KP-3" }),
  p("m8.water_balance.read", "Melihat neraca air & susut", [O, FA]),
  p("m8.water_balance.verify", "Memverifikasi susut negatif", [FA], { ref: "US-M8-04 KP-5" }),
  p("m8.loss_investigation.create", "Mengisi investigasi susut", [PO], { daily: true, ref: "US-M8-04 KP-2" }),
  p("m8.loss_investigation.accept", "Menerima penjelasan susut", [O], { ref: "US-M8-04 KP-2" }),
  p("m8.utilization.read", "Melihat utilisasi kapasitas", [O, FA]),
  p("m8.utilization.export", "Mengekspor data utilisasi harian", [O]),
  p("m8.quality_test.read", "Melihat catatan mutu air", [O, FA, PO, RC]),
  p("m8.quality_test.create", "Mencatat hasil uji mutu", [PO, FA], { ref: "US-M8-06" }),
  p("m8.quality_schedule.update", "Menetapkan jadwal uji mutu", [O], { kind: "approve", ref: "US-M8-06 KP-1" }),

  // ===================================================================================================================
  // M9 — Laporan & dashboard
  // ===================================================================================================================
  p("m9.daily_summary.read", "Melihat ringkasan H+0", [O, FA], { ref: "US-M9-01" }),
  p("m9.daily_summary.review", "Menandai ringkasan H+0 ditinjau", [O]),
  p("m9.monthly_report.read", "Melihat laporan bulanan per lini", [O, FA, AC], { ref: "US-M9-02" }),
  p("m9.report.read", "Melihat katalog laporan", [O, FA, D, AC], { ref: "7.9.4" }),
  p("m9.report.export", "Mengekspor laporan (Excel/PDF)", [O, FA, D, AC], { ref: "US-M9-03" }),
  p("m9.report.export_pii", "Mengekspor laporan berisi data pribadi (dengan tujuan)", [O, FA], { pii: true, ref: "BR-39" }),
  p("m9.performance.read", "Melihat kinerja sopir/truk & depot/operator", [O], { ref: "US-M9-05 KP-4" }),
  p("m9.trend.read", "Melihat tren mingguan/bulanan", [O], { ref: "US-M9-06" }),
  p("m9.kpi.read", "Melihat laporan KPI program", [O], { ref: "US-M9-07" }),
  p("m9.kpi_input.create", "Mengisi KPI manual (KPI-10/KPI-11)", [O, SA], { ref: "US-M9-07 KP-2" }),
  p("m9.inbox.read", "Melihat kotak masuk pengecualian", [O, FA], { ref: "US-M9-04" }),

  // ===================================================================================================================
  // M10 — Pengguna, hak akses, jejak audit, platform
  // ===================================================================================================================
  p("m10.approval.read", "Melihat kotak persetujuan", [O, FA, D, SA]),
  p("m10.approval.decide", "Memutuskan permintaan persetujuan", [O, FA, D], { ref: "US-M10-04" }),
  p("m10.delegation.manage", "Mengatur pendelegasian persetujuan", [O], { kind: "approve", ref: "PTB-32" }),
  p("m10.user.read", "Melihat pengguna", [O, SA]),
  p("m10.user.create", "Membuat akun pengguna (persetujuan pemilik)", [SA], { kind: "admin", ref: "US-M10-01" }),
  p("m10.user.update", "Mengubah akun pengguna", [SA], { kind: "admin" }),
  p("m10.user.deactivate", "Menonaktifkan akun seketika", [SA], { kind: "admin", ref: "US-M10-01 KP-5" }),
  p("m10.user.reset_pin", "Mereset PIN pengguna", [SA], { kind: "admin", ref: "US-M10-02 KP-3" }),
  p("m10.user.reset_password", "Mereset kata sandi pengguna", [SA], { kind: "admin" }),
  p("m10.user.reset_totp", "Mereset 2FA pengguna", [SA], { kind: "admin", ref: "7.10.6" }),
  p("m10.role.read", "Melihat peran & matriks hak akses", [O, SA]),
  p("m10.role.export", "Mengekspor matriks peran × tindakan", [O], { ref: "US-M10-03 KP-4" }),
  p("m10.role.request", "Mengajukan pemberian/perubahan peran", [SA], { kind: "admin", ref: "US-M10-01 KP-4/8" }),
  p("m10.role.revoke", "Mencabut peran seketika", [SA], { kind: "admin", ref: "BR-37" }),
  p("m10.scope.request", "Mengajukan perluasan lingkup", [SA], { kind: "admin", ref: "US-M10-01 KP-8" }),
  p("m10.scope.revoke", "Mengurangi lingkup seketika", [SA], { kind: "admin" }),
  p("m10.device.read", "Melihat perangkat", [O, SA]),
  p("m10.device.register", "Mendaftarkan perangkat", [SA], { kind: "admin", ref: "US-M10-02 KP-1" }),
  p("m10.device.update", "Mengubah perangkat", [SA], { kind: "admin" }),
  p("m10.device.block", "Memblokir perangkat", [SA], { kind: "admin", ref: "US-M10-02 KP-6" }),
  p("m10.device.wipe", "Memerintahkan hapus data jarak jauh", [SA], { kind: "admin", ref: "US-M10-02 KP-6" }),
  p("m10.sync_health.read", "Melihat perangkat & sinkron", [SA, D, FA], { ref: "US-M10-07 KP-1" }),
  p("m10.sync_conflict.read", "Melihat konflik sinkron lapangan", [FA, D, SA], { ref: "Bab 6.4 butir 3" }),
  p("m10.access_review.read", "Melihat tinjauan hak akses", [O, SA]),
  p("m10.access_review.mark", "Menandai tinjauan hak akses kuartalan", [O], { ref: "US-M10-01 KP-6" }),
  p("m10.personal_data.read", "Melihat permintaan data pribadi & retensi", [O, SA]),
  p("m10.anonymization.request", "Mencatat permintaan anonimisasi", [SA], { kind: "admin", ref: "US-M10-06 KP-2" }),
  p("m10.audit_log.read", "Melihat jejak audit", [O, SA, AC], { ref: "US-M10-05" }),
  p("m10.audit_log.export", "Mengekspor jejak audit", [O], { ref: "US-M10-05 KP-6" }),
  p("m10.access_log.read", "Melihat log akses", [O, SA], { ref: "US-M10-05 KP-4" }),
  p("m10.parameter.read", "Melihat parameter", [O, FA, SA, AC]),
  p("m10.parameter.update", "Mengubah parameter Lampiran B", [O], { kind: "approve", ref: "6.2b, US-M10-04 KP-6" }),
  p("m10.feature_flag.read", "Melihat feature flag", [O, SA]),
  p("m10.feature_flag.update", "Mengubah feature flag", [O, SA], { kind: "admin", ref: "PRD 2.1" }),
  p("m10.tenant.read", "Melihat tenant", [O, SA]),
  p("m10.tenant.create", "Membuat tenant (mitra)", [SA], { kind: "admin", ref: "US-M6-07 KP-1" }),
  p("m10.tenant.update", "Mengubah tenant", [SA], { kind: "admin" }),
  p("m10.backup_status.read", "Melihat status cadangan", [O, SA], { ref: "US-M10-06 KP-4" }),
  p("m10.backup_status.create", "Mencatat hasil cadangan/uji pemulihan", [SA], { kind: "admin" }),
  p("m10.incident.read", "Melihat insiden", [O, SA], { ref: "NFR-31" }),
  p("m10.incident.update", "Menanggapi & memulihkan insiden", [SA], { kind: "admin" }),
  p("m10.support_ticket.create", "Melaporkan kendala aplikasi / masukan lapangan", [O, FA, D, DR, H, DO, SC, PO, SA, RC], {
    ref: "US-M10-07 KP-3",
  }),
  p("m10.support_ticket.read", "Melihat laporan kendala & masukan", [SA, O]),
  p("m10.support_ticket.answer", "Menjawab laporan kendala & masukan", [SA], { kind: "admin" }),

  // ===================================================================================================================
  // M11 — Akuntansi & pajak
  // ===================================================================================================================
  p("m11.account.read", "Melihat bagan akun", [O, FA, AC]),
  p("m11.account.create", "Menambah akun", [FA], { finance: true, ref: "US-M11-01" }),
  p("m11.account.update", "Mengubah akun", [FA], { finance: true }),
  p("m11.account.deactivate", "Menonaktifkan akun", [FA], { finance: true }),
  p("m11.journal_mapping.read", "Melihat pemetaan peristiwa → akun", [O, FA, AC]),
  p("m11.journal_mapping.update", "Mengubah pemetaan peristiwa → akun", [FA], { finance: true, ref: "US-M11-01 KP-2" }),
  p("m11.journal.read", "Melihat jurnal", [O, FA, AC]),
  p("m11.journal.create", "Membuat jurnal manual", [FA], { daily: true, finance: true, ref: "US-M11-03" }),
  p("m11.journal.submit", "Mengajukan jurnal manual", [FA], { daily: true, finance: true }),
  p("m11.journal.post", "Memposting jurnal manual", [FA], { finance: true }),
  p("m11.journal.reverse", "Membalik jurnal", [FA], { finance: true, ref: "BR-38" }),
  p("m11.journal.review", "Menandai daftar tinjauan jurnal manual", [O], { ref: "PTB-12" }),
  p("m11.journal.export", "Mengekspor jurnal ke format konsultan", [O, FA, AC], { ref: "NFR-23" }),
  p("m11.journal_queue.read", "Melihat antrean jurnal", [O, FA, AC]),
  p("m11.journal_queue.retry", "Memproses ulang antrean jurnal", [FA], { finance: true, ref: "US-M11-02 KP-3" }),
  p("m11.ledger.read", "Melihat buku besar", [O, FA, AC]),
  p("m11.financial_report.read", "Melihat laporan keuangan", [O, FA, AC]),
  p("m11.financial_report.export", "Mengekspor laporan keuangan", [O, FA, AC]),
  p("m11.fixed_asset.read", "Melihat aset tetap", [O, FA, AC]),
  p("m11.fixed_asset.create", "Menambah aset tetap", [FA], { finance: true, ref: "US-M11-05" }),
  p("m11.fixed_asset.update", "Mengubah aset tetap (umur/nilai dari akuntan)", [FA], { finance: true }),
  p("m11.fixed_asset.dispose", "Melepas/menjual aset tetap", [FA], { finance: true }),
  p("m11.reconciliation.read", "Melihat rekonsiliasi bank & kas", [O, FA, AC]),
  p("m11.reconciliation.create", "Mengerjakan rekonsiliasi bank & kas", [FA], { finance: true, ref: "US-M11-06" }),
  p("m11.period.read", "Melihat periode akuntansi", [O, FA, AC]),
  p("m11.period.close", "Menutup periode", [FA], { finance: true, ref: "US-M11-10" }),
  p("m11.period.lock", "Mengunci periode", [O], { finance: true, ref: "BR-32" }),
  p("m11.period.reopen", "Membuka periode terkunci", [O], { finance: true, ref: "BR-32, 6.2b" }),
  p("m11.period.review_note", "Mencatat tinjauan akuntan pada periode", [AC], { ref: "US-M11-04 KP-5" }),
  p("m11.tax.read", "Melihat pajak & pemantauan PKP", [O, FA, AC]),
  p("m11.tax.update", "Mengatur skema pajak", [FA], { finance: true, ref: "US-M11-08" }),
  p("m11.tax.export", "Mengekspor data pajak", [O, FA, AC]),
  p("m11.export_template.update", "Mengatur template ekspor konsultan", [FA], { ref: "US-M11-08 KP-3" }),
  p("m11.opening_balance.read", "Melihat saldo awal akuntansi", [O, FA, AC]),
  p("m11.opening_balance.create", "Mengisi saldo awal & penyesuaiannya", [FA], { finance: true, ref: "US-M11-09" }),
  p("m11.opening_balance.sign", "Menandatangani saldo awal per kelompok", [O], { finance: true, ref: "NFR-34" }),
  p("m11.opening_balance.attest", "Mengesahkan saldo awal (akuntan)", [AC], { ref: "US-M11-09 KP-2" }),
  p("m11.cost_allocation.run", "Menjalankan alokasi biaya L1 & bersama", [FA], { finance: true, ref: "PTB-39" }),

  // ===================================================================================================================
  // M12 — Armada / GPS
  // ===================================================================================================================
  p("m12.position.read", "Melihat peta posisi truk", [O, D], { ref: "US-M12-02" }),
  p("m12.trip_history.read", "Melihat riwayat perjalanan", [O, D], { ref: "US-M12-03" }),
  p("m12.trip_history.export", "Mengekspor ringkasan perjalanan", [O, D]),
  p("m12.fleet_event.read", "Melihat kejadian armada", [O, D, SA]),
  p("m12.fleet_event.request_explanation", "Meminta keterangan sopir", [O, D], { ref: "US-M12-05" }),
  p("m12.fleet_event.review", "Meninjau kejadian & penyimpangan lokasi", [O], { ref: "US-M12-04 KP-3, US-M12-05 KP-4" }),
  p("m12.phone_tracking.enable", "Mengaktifkan GPS ponsel cadangan per truk", [SA], { kind: "admin", ref: "US-M3-02 KP-5" }),
  p("m12.fuel_estimate.read", "Melihat estimasi biaya BBM per rit", [O, FA], { ref: "US-M12-07" }),

  // ===================================================================================================================
  // P2 — Aplikasi pelanggan (sisi kantor; pelanggan memakai autentikasi terpisah)
  // ===================================================================================================================
  p("p2.customer_account.read", "Melihat akun aplikasi pelanggan", [O, D], { pii: true }),
  p("p2.complaint.read", "Melihat keluhan pelanggan", [O, D, FA]),
  p("p2.complaint.respond", "Menanggapi & menutup keluhan", [D, FA], { ref: "US-P2-06 KP-2" }),
  p("p2.rating.read", "Melihat penilaian layanan", [O, D], { ref: "US-P2-06 KP-1" }),
  p("p2.payment_intent.read", "Melihat pembayaran digital", [O, FA], { cash: true, ref: "US-P2-04 KP-3" }),

  // ===================================================================================================================
  // P3 — Kemitraan (RL-7 Fase 1 & Tahap 3)
  // ===================================================================================================================
  p("p3.partner.read", "Melihat mitra & dashboard kemitraan", [O, FA, RC]),
  p("p3.partner_prospect.create", "Mencatat calon mitra", [RC], { ref: "US-P3-01" }),
  p("p3.partner_prospect.update", "Mengubah calon mitra", [RC]),
  p("p3.partner_survey.create", "Mencatat survei lokasi mitra", [RC], { ref: "US-P3-01 KP-1" }),
  p("p3.partner_contract.read", "Melihat kontrak mitra", [O, FA, RC]),
  p("p3.partner_contract.create", "Menginput kontrak mitra (persetujuan pemilik)", [FA], { finance: true, ref: "US-P3-09 KP-1" }),
  p("p3.onboarding.update", "Mengisi daftar periksa onboarding", [RC], { ref: "US-P3-01 KP-4" }),
  p("p3.partner_supply.read", "Melihat pasokan air & neraca air mitra", [O, FA, D, RC], { ref: "US-P3-08" }),
  p("p3.subscription.read", "Melihat tagihan langganan mitra", [O, FA], { ref: "US-P3-09" }),
  p("p3.quality_checklist.read", "Melihat daftar periksa mutu mitra", [O, RC]),
  p("p3.quality_checklist.create", "Mengisi daftar periksa mutu harian", [DO], { daily: true, ref: "US-P3-05 KP-1" }),
  p("p3.partner_audit.create", "Mencatat audit mutu mitra", [RC], { ref: "US-P3-05 KP-2" }),
  p("p3.partner_score.read", "Melihat skor mitra", [O, RC]),
  p("p3.sanction.propose", "Mengusulkan sanksi mitra", [RC, FA], { ref: "US-P3-07" }),
  p("p3.support_request.read", "Melihat permintaan dukungan mitra", [O, RC, SA, PW], { ref: "US-P3-11" }),
  p("p3.support_request.create", "Mengajukan permintaan dukungan teknis", [PW], { ref: "US-P3-11 KP-1" }),
  p("p3.support_request.respond", "Menanggapi permintaan dukungan mitra", [RC, SA], { ref: "US-P3-11" }),
  p("p3.partner_report.read", "Melihat laporan outlet mitra (portal)", [PW, O, FA, RC], { ref: "US-P3-10" }),

  // ===================================================================================================================
  // Tambahan modul M10 (Pengguna, Hak Akses & Jejak Audit) — hanya tambah
  // ===================================================================================================================
  p("m10.app_version.update", "Mengatur versi minimal aplikasi lapangan/POS", [SA], { kind: "admin", ref: "US-M10-07 KP-4, NFR-32" }),
  p("m10.initial_accounts.sign", "Menyetujui sekaligus daftar akun awal go-live", [O], { kind: "approve", ref: "US-M10-01 KP-8, NFR-34" }),
  p("m10.access_log.export", "Mengekspor log akses", [O], { ref: "US-M10-05 KP-4/KP-6" }),

  // ===================================================================================================================
  // Tambahan modul M6 (Penjualan Depot / kerangka POS) — hanya tambah
  // ===================================================================================================================
  p("m6.shift_conflict.resolve", "Meninjau & menandai selesai konflik shift POS (perangkat cadangan)", [FA], {
    cash: true,
    finance: true,
    ref: "7.6.6, Bab 6.4 butir 3",
  }),

  // ===================================================================================================================
  // Tambahan modul M3 (Aplikasi Sopir) — hanya tambah
  // ===================================================================================================================
  p("m3.trip_incident.read", "Melihat kendala perjalanan & rit gagal sopir", [O, D], { ref: "US-M3-06 KP-3" }),
  p("m3.trip_incident.confirm", "Mengonfirmasi kendala sopir (truk rusak → Perbaikan)", [D], { ref: "US-M3-06 KP-3" }),
  p("m3.office_entry.read", "Melihat laporan pencatatan \"dicatat kantor\" (KPI-01)", [O, FA], { ref: "US-M3-09 KP-5, Bab 6.1" }),
  p("m3.payment_report.read", "Melihat & mengekspor pembayaran, pelunasan, pengeluaran & setoran sopir", [O, FA, AC], {
    cash: true,
    ref: "US-M3-04, US-M3-05, US-M3-07, US-M3-08",
  }),

  // ===================================================================================================================
  // Tambahan modul M7 (Penjualan Toko & Stok) — hanya tambah
  // ===================================================================================================================
  p("m7.report.read", "Melihat laporan toko (diskon, transfer internal, pembelian mitra, riwayat opname)", [O, FA, AC], {
    ref: "US-M7-01 KP-3, US-M7-05 KP-5, US-M7-06 KP-3, US-M7-07 KP-2",
  }),
  p("m7.supplier.deactivate", "Menonaktifkan/mengaktifkan kembali pemasok", [FA], { ref: "7.7.3" }),
  p("m7.supplier_payment.reverse", "Membalik pembayaran pemasok yang keliru (beralasan)", [FA], { finance: true, cash: true, ref: "BR-38, US-M7-08 KP-2" }),

  // ===================================================================================================================
  // Tambahan modul M5 (Piutang & Penagihan) — hanya tambah
  // ===================================================================================================================
  p("m5.credit_hold.release", "Membuka status Ditahan sebelum lunas (keputusan pemilik, beralasan)", [O], {
    kind: "approve",
    ref: "US-M5-03 KP-3, BR-03, 6.2a",
  }),
  p("m5.credit_hold.evaluate", "Menghitung ulang umur piutang & status Ditahan sekarang", [O, FA], { ref: "US-M5-03 KP-1" }),
  p("m5.monthly_invoice.issue", "Menerbitkan faktur bulanan periode lalu (bila job belum berjalan)", [FA], { finance: true, ref: "US-M5-06 KP-2" }),
  p("m5.opening_balance.sign", "Menandatangani total saldo awal piutang", [O], { kind: "approve", ref: "US-M5-07 KP-2, NFR-34" }),
];

const BY_KEY = new Map<string, PermissionDef>(PERMISSIONS.map((perm) => [perm.key, perm]));

export type PermissionKey = string;

/** Definisi izin (undefined bila tidak ada di katalog). */
export function getPermission(key: string): PermissionDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownPermission(key: string): boolean {
  return BY_KEY.has(key);
}

export function permissionLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Semua kunci izin (urutan katalog). */
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((perm) => perm.key);

/** Nama modul untuk tampilan matriks. */
export const MODULE_LABELS: Record<string, string> = {
  m1: "M1 Master data",
  m2: "M2 Pesanan & jadwal",
  m3: "M3 Aplikasi sopir",
  m4: "M4 Kas & setoran",
  m5: "M5 Piutang",
  m6: "M6 POS depot",
  m7: "M7 Toko & stok",
  m8: "M8 Produksi air",
  m9: "M9 Laporan",
  m10: "M10 Akses & audit",
  m11: "M11 Akuntansi",
  m12: "M12 Armada",
  p2: "Aplikasi pelanggan",
  p3: "Kemitraan",
};

/**
 * Izin bersyarat (US-M2-11, PTB-10): kernet mendapat tindakan sopir HANYA pada truk & tanggal ia ditetapkan sebagai
 * pengemudi pengganti. Layanan M3 menghitung syaratnya lalu memanggil
 * `authorize(ctx, "m3.trip.complete", { conditions: { substitute_driver: true } })`.
 */
export const CONDITIONAL_GRANTS: readonly { role: RoleCode; condition: "substitute_driver"; permissions: readonly string[] }[] = [
  {
    role: "helper",
    condition: "substitute_driver",
    permissions: [
      "m3.trip.depart",
      "m3.trip.arrive",
      "m3.trip.complete",
      "m3.trip.fail",
      "m3.trip_payment.create",
      "m3.collection.create",
      "m3.field_credit.request",
      "m3.trip_incident.create",
      "m3.trip_expense.create",
      "m3.travel_explanation.create",
      "m3.deposit.submit",
      "m3.cash_on_hand.read",
      "m3.deposit_history.read",
      "m3.receipt.send_wa",
    ],
  },
];
