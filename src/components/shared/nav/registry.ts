/**
 * Registri navigasi web kantor (docs/ARCHITECTURE.md §9) — SATU sumber untuk sidebar, breadcrumb, dan katalog izin
 * yang dibutuhkan menu.
 *
 * BERKAS BERSAMA: hanya boleh DITAMBAH (append). Jangan mengubah/rename `id`, `href`, atau string izin yang ada.
 * Setiap string izin berbentuk `<modul>.<sumberdaya>.<aksi>` (mis. `m2.order.read`) dan tercantum di
 * `docs/nav-permissions.md` agar dimasukkan ke katalog RBAC (`src/server/core/rbac/matrix.ts`).
 *
 * Isomorfik (tanpa "use client"): dapat dipakai Server Component (mis. judul halaman) maupun OfficeShell di klien.
 * Otorisasi SEBENARNYA selalu di lapisan layanan (`authorize(ctx, perm)`); menyembunyikan menu hanya kenyamanan.
 */
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeftRight,
  Bell,
  BellDot,
  BookOpen,
  BookText,
  Boxes,
  Building,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumn,
  CheckCheck,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Coins,
  CreditCard,
  Droplets,
  FilePlus,
  FileSpreadsheet,
  FileText,
  FileUp,
  FlaskConical,
  Gauge,
  HandCoins,
  Handshake,
  Headset,
  House,
  IdCard,
  Inbox,
  Landmark,
  LayoutDashboard,
  Library,
  LifeBuoy,
  Link2,
  Lock,
  Map as MapIcon,
  MapPinned,
  Package,
  PackagePlus,
  PencilLine,
  Percent,
  Receipt,
  ReceiptText,
  RefreshCw,
  Repeat,
  Route,
  Scale,
  ScanEye,
  ScrollText,
  ShieldCheck,
  ShieldUser,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Store,
  Target,
  TrendingUp,
  TriangleAlert,
  Truck,
  Undo2,
  UserCog,
  Users,
  Wallet,
  Warehouse,
} from "lucide-react";

/** Kode modul pemilik rute (Bab 7 PRD; `p3` = kemitraan RL-7/Tahap 3). */
export type NavModule =
  | "core"
  | "m1"
  | "m2"
  | "m3"
  | "m4"
  | "m5"
  | "m6"
  | "m7"
  | "m8"
  | "m9"
  | "m10"
  | "m11"
  | "m12"
  | "p3";

/** Kunci hitungan yang dapat ditampilkan sebagai lencana angka di menu (diisi dari `counts` OfficeShell). */
export type NavBadgeKey = "approvals" | "notifications" | "inbox";

export type NavItem = {
  /** Pengenal stabil (jangan diubah). */
  id: string;
  /** Rute. Segmen dinamis ditulis gaya Next: `/pesanan/[id]`. */
  href: string;
  /** Label Bahasa Indonesia (istilah PRD). */
  label: string;
  icon: LucideIcon;
  /**
   * Izin yang dibutuhkan. `null` = semua pengguna web kantor yang sudah masuk.
   * Array = cukup salah satu (any-of).
   */
  permission: string | readonly string[] | null;
  /** Keterangan singkat (tooltip / halaman katalog). */
  description?: string;
  /** Tidak tampil di sidebar (halaman rincian/aksi), tetapi dipakai breadcrumb & katalog izin. */
  hidden?: boolean;
  /** Lencana angka dari `counts`. */
  badgeKey?: NavBadgeKey;
  /** Feature flag yang harus aktif (docs/DECISIONS.md D-02). */
  flag?: string;
};

export type NavGroup = {
  id: string;
  label: string;
  module: NavModule;
  items: readonly NavItem[];
};

/** Semua grup navigasi web kantor, urut tampil. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "home",
    label: "Beranda",
    module: "core",
    items: [
      {
        id: "home",
        href: "/beranda",
        label: "Beranda",
        icon: House,
        permission: null,
        description: "Ringkasan sesuai peran Anda.",
      },
      {
        id: "m9.inbox",
        href: "/kotak-masuk",
        label: "Kotak masuk",
        icon: Inbox,
        permission: "m9.inbox.read",
        badgeKey: "inbox",
        description: "Pengecualian yang perlu tindakan.",
      },
      {
        id: "m10.approvals",
        href: "/persetujuan",
        label: "Persetujuan",
        icon: CheckCheck,
        permission: "m10.approval.read",
        badgeKey: "approvals",
        description: "Permintaan persetujuan yang diajukan atau menunggu keputusan Anda.",
      },
      {
        id: "m10.notifications",
        href: "/notifikasi",
        label: "Notifikasi",
        icon: Bell,
        permission: null,
        badgeKey: "notifications",
      },
    ],
  },
  {
    id: "m2",
    label: "Pesanan & jadwal",
    module: "m2",
    items: [
      { id: "m2.orders", href: "/pesanan", label: "Pesanan", icon: ClipboardList, permission: "m2.order.read" },
      {
        id: "m2.orders.new",
        href: "/pesanan/baru",
        label: "Pesanan baru",
        icon: FilePlus,
        permission: "m2.order.create",
        description: "Input pesanan < 60 detik.",
      },
      {
        id: "m2.orders.detail",
        href: "/pesanan/[id]",
        label: "Rincian pesanan",
        icon: ClipboardList,
        permission: "m2.order.read",
        hidden: true,
      },
      {
        id: "m2.schedule",
        href: "/jadwal",
        label: "Papan jadwal",
        icon: CalendarDays,
        permission: "m2.schedule.read",
        description: "Papan rit harian per truk.",
      },
      {
        id: "m2.crew",
        href: "/jadwal/kru",
        label: "Jadwal kru",
        icon: CalendarRange,
        permission: "m2.crew_assignment.read",
        description: "Kru harian & pengemudi pengganti.",
      },
      {
        id: "m2.recurring",
        href: "/langganan",
        label: "Pesanan berulang",
        icon: Repeat,
        permission: "m2.recurring_order.read",
      },
      {
        id: "m3.office_entry",
        href: "/sopir-kantor/dicatat-kantor",
        label: "Dicatat kantor",
        icon: PencilLine,
        permission: "m3.office_entry.create",
        description: "Pencatatan darurat atas nama sopir (perangkat rusak/hilang).",
      },
      // --- Tambahan modul M3 (hanya tambah) ---
      {
        id: "m3.incidents",
        href: "/sopir-kantor/kendala",
        label: "Kendala sopir",
        icon: TriangleAlert,
        permission: "m3.trip_incident.read",
        description: "Kendala perjalanan & rit gagal dari aplikasi sopir; konfirmasi truk rusak → Perbaikan.",
      },
      {
        id: "m3.reports",
        href: "/sopir-kantor/laporan",
        label: "Laporan sopir",
        icon: FileSpreadsheet,
        permission: ["m3.office_entry.read", "m3.payment_report.read"],
        description: "Dicatat kantor (KPI-01), pembayaran rit, pelunasan, pengeluaran & setoran sopir.",
      },
    ],
  },
  {
    id: "m4",
    label: "Kas & setoran",
    module: "m4",
    items: [
      { id: "m4.cash", href: "/kas", label: "Kas hari ini", icon: Wallet, permission: "m4.cash_position.read" },
      { id: "m4.deposits", href: "/kas/setoran", label: "Setoran", icon: HandCoins, permission: "m4.deposit.read" },
      { id: "m4.discrepancies", href: "/kas/selisih", label: "Selisih", icon: Scale, permission: "m4.discrepancy.read" },
      {
        id: "m4.transfers",
        href: "/kas/transfer",
        label: "Transfer masuk",
        icon: ArrowLeftRight,
        permission: "m4.incoming_transfer.read",
      },
      {
        id: "m4.office_cash",
        href: "/kas/kantor",
        label: "Kas kantor & setor bank",
        icon: Landmark,
        permission: "m4.office_cash.read",
      },
      { id: "m4.petty_cash", href: "/kas/kas-kecil", label: "Kas kecil", icon: Coins, permission: "m4.petty_cash.read" },
      { id: "m4.cash_day", href: "/kas/tutup", label: "Tutup kas", icon: Lock, permission: "m4.cash_day.read" },
      {
        id: "m4.restitutions",
        href: "/kas/ganti-rugi",
        label: "Ganti rugi",
        icon: Undo2,
        permission: "m4.restitution.read",
      },
    ],
  },
  {
    id: "m5",
    label: "Piutang",
    module: "m5",
    items: [
      { id: "m5.overview", href: "/piutang", label: "Ringkasan piutang", icon: Receipt, permission: "m5.receivable.read" },
      { id: "m5.invoices", href: "/piutang/faktur", label: "Faktur", icon: FileText, permission: "m5.invoice.read" },
      {
        id: "m5.payments",
        href: "/piutang/pelunasan",
        label: "Pelunasan",
        icon: CreditCard,
        permission: "m5.customer_payment.read",
      },
      { id: "m5.aging", href: "/piutang/umur", label: "Umur piutang", icon: Clock, permission: "m5.aging.read" },
      {
        id: "m5.reminders",
        href: "/piutang/pengingat",
        label: "Pengingat jatuh tempo",
        icon: BellDot,
        permission: "m5.reminder.read",
      },
      {
        id: "m5.monthly_invoices",
        href: "/piutang/faktur-bulanan",
        label: "Faktur bulanan",
        icon: CalendarClock,
        permission: "m5.monthly_invoice.read",
      },
      {
        id: "m5.opening_balance",
        href: "/piutang/saldo-awal",
        label: "Saldo awal piutang",
        icon: Archive,
        permission: "m5.opening_balance.read",
      },
    ],
  },
  {
    id: "m6m7",
    label: "Depot & toko",
    module: "m6",
    items: [
      {
        id: "m6.outlets",
        href: "/outlet",
        label: "Pemantauan outlet",
        icon: Store,
        permission: "m6.outlet.read",
        description: "Shift, penjualan, void, dan stok bahan per depot/toko.",
      },
      // --- Tambahan modul M6 (hanya tambah) ---
      {
        id: "m6.outlets.detail",
        href: "/outlet/[id]",
        label: "Rincian outlet",
        icon: Store,
        permission: "m6.outlet.read",
        hidden: true,
      },
      {
        id: "m6.shifts.detail",
        href: "/outlet/shift/[id]",
        label: "Rincian shift",
        icon: Clock,
        permission: "m6.outlet.read",
        hidden: true,
      },
      {
        id: "m6.reports",
        href: "/outlet/laporan",
        label: "Laporan outlet",
        icon: ChartColumn,
        permission: "m6.outlet.read",
        description: "Void per hari, pemakaian bahan vs penjualan, neraca air, riwayat shift — per outlet.",
      },
      {
        id: "m6.tenants",
        href: "/outlet/tenant",
        label: "Tenant & paket POS",
        icon: Handshake,
        permission: "m10.tenant.read",
        description: "Tenant mitra dengan salinan katalog standar EQUA (US-M6-07).",
      },
      { id: "m7.items", href: "/toko/barang", label: "Barang & stok toko", icon: Boxes, permission: "m7.stock.read" },
      { id: "m7.suppliers", href: "/toko/pemasok", label: "Pemasok", icon: Building, permission: "m7.supplier.read" },
      {
        id: "m7.purchases",
        href: "/toko/pembelian",
        label: "Penerimaan barang",
        icon: PackagePlus,
        permission: "m7.purchase_receipt.read",
      },
      { id: "m7.stock_counts", href: "/toko/opname", label: "Opname", icon: ClipboardCheck, permission: "m7.stock_count.read" },
      {
        id: "m7.reorder",
        href: "/toko/pesan-ulang",
        label: "Pesan ulang",
        icon: ShoppingCart,
        permission: "m7.reorder.read",
      },
      {
        id: "m7.payables",
        href: "/toko/utang",
        label: "Utang pemasok",
        icon: ReceiptText,
        permission: "m7.supplier_payable.read",
      },
    ],
  },
  {
    id: "m8",
    label: "Produksi air",
    module: "m8",
    items: [
      {
        id: "m8.water_balance",
        href: "/produksi/neraca-air",
        label: "Neraca air",
        icon: Droplets,
        permission: "m8.water_balance.read",
      },
      {
        id: "m8.utilization",
        href: "/produksi/utilisasi",
        label: "Utilisasi kapasitas",
        icon: Gauge,
        permission: "m8.utilization.read",
      },
      { id: "m8.quality", href: "/produksi/mutu", label: "Mutu air", icon: FlaskConical, permission: "m8.quality_test.read" },
    ],
  },
  {
    id: "m12",
    label: "Armada",
    module: "m12",
    items: [
      { id: "m12.map", href: "/armada/peta", label: "Peta truk", icon: MapIcon, permission: "m12.position.read" },
      {
        id: "m12.history",
        href: "/armada/riwayat",
        label: "Riwayat perjalanan",
        icon: Route,
        permission: "m12.trip_history.read",
      },
      {
        id: "m12.events",
        href: "/armada/kejadian",
        label: "Kejadian armada",
        icon: TriangleAlert,
        permission: "m12.fleet_event.read",
      },
    ],
  },
  {
    id: "m9",
    label: "Laporan",
    module: "m9",
    items: [
      {
        id: "m9.today",
        href: "/laporan/hari-ini",
        label: "Hari ini (H+0)",
        icon: LayoutDashboard,
        permission: "m9.daily_summary.read",
      },
      {
        id: "m9.monthly",
        href: "/laporan/bulanan",
        label: "Laba kotor bulanan",
        icon: ChartColumn,
        permission: "m9.monthly_report.read",
      },
      { id: "m9.catalog", href: "/laporan/katalog", label: "Katalog laporan", icon: Library, permission: "m9.report.read" },
      {
        id: "m9.performance",
        href: "/laporan/kinerja",
        label: "Kinerja sopir & depot",
        icon: Users,
        permission: "m9.performance.read",
      },
      { id: "m9.trend", href: "/laporan/tren", label: "Tren", icon: TrendingUp, permission: "m9.trend.read" },
      { id: "m9.kpi", href: "/laporan/kpi", label: "KPI program", icon: Target, permission: "m9.kpi.read" },
    ],
  },
  {
    id: "m11",
    label: "Akuntansi",
    module: "m11",
    items: [
      { id: "m11.accounts", href: "/akuntansi/akun", label: "Bagan akun", icon: BookText, permission: "m11.account.read" },
      {
        id: "m11.mapping",
        href: "/akuntansi/pemetaan",
        label: "Pemetaan jurnal otomatis",
        icon: Link2,
        permission: "m11.journal_mapping.read",
      },
      { id: "m11.journals", href: "/akuntansi/jurnal", label: "Jurnal", icon: BookOpen, permission: "m11.journal.read" },
      { id: "m11.ledger", href: "/akuntansi/buku-besar", label: "Buku besar", icon: Library, permission: "m11.ledger.read" },
      {
        id: "m11.reports",
        href: "/akuntansi/laporan",
        label: "Laporan keuangan",
        icon: FileSpreadsheet,
        permission: "m11.financial_report.read",
      },
      { id: "m11.assets", href: "/akuntansi/aset", label: "Aset tetap", icon: Building, permission: "m11.fixed_asset.read" },
      {
        id: "m11.reconciliation",
        href: "/akuntansi/rekonsiliasi",
        label: "Rekonsiliasi bank & kas",
        icon: ArrowLeftRight,
        permission: "m11.reconciliation.read",
      },
      { id: "m11.periods", href: "/akuntansi/periode", label: "Periode", icon: CalendarClock, permission: "m11.period.read" },
      { id: "m11.tax", href: "/akuntansi/pajak", label: "Pajak", icon: Percent, permission: "m11.tax.read" },
      {
        id: "m11.opening_balance",
        href: "/akuntansi/saldo-awal",
        label: "Saldo awal",
        icon: Archive,
        permission: "m11.opening_balance.read",
      },
    ],
  },
  {
    id: "m1",
    label: "Data master",
    module: "m1",
    items: [
      { id: "m1.customers", href: "/master/pelanggan", label: "Pelanggan", icon: Users, permission: "m1.customer.read" },
      { id: "m1.products", href: "/master/produk", label: "Produk & harga", icon: Package, permission: "m1.product.read" },
      { id: "m1.zones", href: "/master/zona", label: "Zona tarif", icon: MapPinned, permission: "m1.tariff_zone.read" },
      { id: "m1.trucks", href: "/master/armada", label: "Armada & kru", icon: Truck, permission: "m1.truck.read" },
      { id: "m1.outlets", href: "/master/depot", label: "Depot & toko", icon: Store, permission: "m1.outlet.read" },
      {
        id: "m1.water_sources",
        href: "/master/sumber-air",
        label: "Sumber air",
        icon: Droplets,
        permission: "m1.water_source.read",
      },
      { id: "m1.pools", href: "/master/pool", label: "Pool/garasi", icon: Warehouse, permission: "m1.pool_location.read" },
      { id: "m1.employees", href: "/master/karyawan", label: "Karyawan", icon: IdCard, permission: "m1.employee.read" },
      {
        id: "m1.import",
        href: "/master/impor",
        label: "Impor data awal",
        icon: FileUp,
        permission: "m1.import.create",
        description: "Impor & pembersihan duplikat saat cut-over.",
      },
      {
        id: "m1.signoff",
        href: "/master/tanda-tangan",
        label: "Tanda tangan data awal",
        icon: ClipboardCheck,
        permission: "m1.data_signoff.read",
        description: "Ringkasan data awal per kelompok untuk ditandatangani pemilik (NFR-34).",
      },
    ],
  },
  {
    id: "p3",
    label: "Kemitraan",
    module: "p3",
    items: [
      {
        id: "p3.partners",
        href: "/kemitraan",
        label: "Mitra depot",
        icon: Handshake,
        permission: "p3.partner.read",
        description: "Paket Minimum Mitra Fase 1 (RL-7).",
      },
      {
        id: "p3.supply",
        href: "/kemitraan/pasokan",
        label: "Pasokan & neraca mitra",
        icon: Droplets,
        permission: "p3.partner_supply.read",
      },
      {
        id: "p3.subscriptions",
        href: "/kemitraan/langganan",
        label: "Tagihan langganan",
        icon: ReceiptText,
        permission: "p3.subscription.read",
      },
      {
        id: "p3.support",
        href: "/kemitraan/dukungan",
        label: "Dukungan teknis",
        icon: Headset,
        permission: "p3.support_request.read",
      },
    ],
  },
  {
    id: "m10",
    label: "Akses & pengaturan",
    module: "m10",
    items: [
      { id: "m10.users", href: "/akses/pengguna", label: "Pengguna", icon: UserCog, permission: "m10.user.read" },
      { id: "m10.roles", href: "/akses/peran", label: "Peran & matriks", icon: ShieldCheck, permission: "m10.role.read" },
      { id: "m10.devices", href: "/akses/perangkat", label: "Perangkat", icon: Smartphone, permission: "m10.device.read" },
      {
        id: "m10.sync",
        href: "/akses/sinkron",
        label: "Perangkat & sinkron",
        icon: RefreshCw,
        permission: "m10.sync_health.read",
      },
      {
        id: "m10.access_review",
        href: "/akses/tinjauan",
        label: "Tinjauan hak akses",
        icon: ScanEye,
        permission: "m10.access_review.read",
      },
      {
        id: "m10.personal_data",
        href: "/akses/data-pribadi",
        label: "Data pribadi",
        icon: ShieldUser,
        permission: "m10.personal_data.read",
      },
      { id: "m10.audit", href: "/audit", label: "Jejak audit", icon: ScrollText, permission: "m10.audit_log.read" },
      {
        id: "m10.parameters",
        href: "/pengaturan/parameter",
        label: "Parameter",
        icon: SlidersHorizontal,
        permission: "m10.parameter.read",
      },
      {
        id: "m10.notification_settings",
        href: "/pengaturan/notifikasi",
        label: "Pengaturan notifikasi",
        icon: BellDot,
        permission: null,
      },
      // Hanya peran yang boleh mengirim tiket (akuntan baca-saja & pemilik mitra/portal tidak; tinjauan pasca-F3c).
      { id: "m10.help", href: "/bantuan", label: "Bantuan", icon: LifeBuoy, permission: "m10.support_ticket.create" },
    ],
  },
];

/** Semua item (termasuk yang `hidden`), urut registri. */
export function allNavItems(groups: readonly NavGroup[] = NAV_GROUPS): NavItem[] {
  return groups.flatMap((g) => g.items);
}

/** Semua string izin unik yang dipakai registri (terurut) — sumber `docs/nav-permissions.md`. */
export function navPermissions(groups: readonly NavGroup[] = NAV_GROUPS): string[] {
  const set = new Set<string>();
  for (const item of allNavItems(groups)) {
    if (item.permission === null) continue;
    for (const p of typeof item.permission === "string" ? [item.permission] : item.permission) set.add(p);
  }
  return [...set].sort();
}

/** Pola string izin `<modul>.<sumberdaya>.<aksi>` (huruf kecil, angka, garis bawah). */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Benar bila `granted` memuat izin `required`. Mendukung wildcard pada daftar izin milik pengguna:
 * `*` (semua), `m2.*` (semua izin modul), `m2.order.*` (semua aksi sumber daya).
 */
export function hasPermission(granted: Iterable<string>, required: string): boolean {
  const [mod, res] = required.split(".");
  for (const g of granted) {
    if (g === required || g === "*") return true;
    if (g === `${mod}.*` || g === `${mod}.${res}.*`) return true;
  }
  return false;
}

export type NavFilterOptions = {
  /** Feature flag yang aktif. Bila tidak diberikan, item ber-`flag` tetap tampil (flag diputuskan pemanggil). */
  enabledFlags?: Iterable<string>;
  /** Sertakan item `hidden` (bawaan `false` — untuk sidebar). */
  includeHidden?: boolean;
};

/** Benar bila pengguna dengan `permissions` boleh melihat `item`. */
export function canSeeNavItem(item: NavItem, permissions: readonly string[], options: NavFilterOptions = {}): boolean {
  if (item.hidden && !options.includeHidden) return false;
  if (item.flag && options.enabledFlags !== undefined) {
    const flags = new Set(options.enabledFlags);
    if (!flags.has(item.flag)) return false;
  }
  if (item.permission === null) return true;
  const required = typeof item.permission === "string" ? [item.permission] : item.permission;
  return required.some((p) => hasPermission(permissions, p));
}

/**
 * Saring grup navigasi sesuai izin pengguna. Grup tanpa item yang terlihat dibuang. Item `hidden` dibuang kecuali
 * `includeHidden`. Urutan registri dipertahankan.
 */
export function filterNavByPermissions(
  permissions: readonly string[],
  options: NavFilterOptions & { groups?: readonly NavGroup[] } = {},
): NavGroup[] {
  const groups = options.groups ?? NAV_GROUPS;
  const result: NavGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => canSeeNavItem(item, permissions, options));
    if (items.length > 0) result.push({ ...group, items });
  }
  return result;
}

function hrefToRegExp(href: string): RegExp {
  const pattern = href
    .split("/")
    .map((seg) => (/^\[.+\]$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}$`);
}

/** Benar bila `pathname` cocok persis dengan `href` (segmen dinamis `[x]` cocok dengan satu segmen apa pun). */
export function matchNavHref(href: string, pathname: string): boolean {
  return hrefToRegExp(href).test(normalizePath(pathname));
}

function normalizePath(pathname: string): string {
  const p = pathname.split("?")[0]!.split("#")[0]!;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

export type NavMatch = { group: NavGroup; item: NavItem };

/**
 * Item registri untuk `pathname`: cocok persis dulu, lalu awalan terpanjang (mis. `/kas/setoran/123` → "Setoran").
 * Mengembalikan `null` bila tidak ada.
 */
export function findNavMatch(pathname: string, groups: readonly NavGroup[] = NAV_GROUPS): NavMatch | null {
  const path = normalizePath(pathname);
  let best: (NavMatch & { score: number }) | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (matchNavHref(item.href, path)) return { group, item };
      const prefix = item.href.includes("[") ? null : item.href;
      if (prefix && prefix !== "/" && path.startsWith(`${prefix}/`)) {
        const score = prefix.length;
        if (!best || score > best.score) best = { group, item, score };
      }
    }
  }
  return best ? { group: best.group, item: best.item } : null;
}

/** Item aktif di sidebar untuk `pathname` (item tersembunyi dipetakan ke item induk yang terlihat). */
export function isNavItemActive(item: NavItem, pathname: string, groups: readonly NavGroup[] = NAV_GROUPS): boolean {
  const match = findNavMatch(pathname, groups);
  if (!match) return false;
  if (match.item.id === item.id) return true;
  if (match.item.hidden) {
    const parent = findNavMatch(match.item.href.replace(/\/\[[^/]+\]$/, ""), groups);
    return parent?.item.id === item.id;
  }
  return false;
}

export type BreadcrumbEntry = { label: string; href?: string };

/**
 * Jejak breadcrumb untuk `pathname`: `Grup › Induk › Halaman`. Label halaman rincian dapat ditimpa lewat
 * `currentLabel` (mis. nomor pesanan `P-26-000123`).
 */
export function buildBreadcrumbs(
  pathname: string,
  options: { currentLabel?: string; groups?: readonly NavGroup[] } = {},
): BreadcrumbEntry[] {
  const groups = options.groups ?? NAV_GROUPS;
  const path = normalizePath(pathname);
  const match = findNavMatch(path, groups);
  if (!match) return options.currentLabel ? [{ label: options.currentLabel }] : [];

  const trail: BreadcrumbEntry[] = [];
  if (match.group.id !== "home") trail.push({ label: match.group.label });

  // Induk: item terlihat dengan href awalan terpanjang yang bukan item itu sendiri.
  const parents = allNavItems(groups)
    .filter(
      (it) =>
        !it.hidden &&
        it.id !== match.item.id &&
        !it.href.includes("[") &&
        (match.item.href.startsWith(`${it.href}/`) || (path !== match.item.href && path.startsWith(`${it.href}/`))),
    )
    .sort((a, b) => a.href.length - b.href.length);
  for (const parent of parents) trail.push({ label: parent.label, href: parent.href });

  const exact = matchNavHref(match.item.href, path);
  if (exact) {
    trail.push({ label: options.currentLabel ?? match.item.label });
  } else {
    trail.push({ label: match.item.label, href: match.item.href });
    if (options.currentLabel) trail.push({ label: options.currentLabel });
  }
  return trail;
}
