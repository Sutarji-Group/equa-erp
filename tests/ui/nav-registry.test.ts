import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  allNavItems,
  buildBreadcrumbs,
  filterNavByPermissions,
  findNavMatch,
  hasPermission,
  isNavItemActive,
  NAV_GROUPS,
  navPermissions,
  PERMISSION_PATTERN,
} from "@/components/shared/nav/registry";

/** Rute web kantor dari docs/ARCHITECTURE.md §9 (kecuali /kemitraan/* yang berupa wildcard). */
const ARCHITECTURE_ROUTES = [
  "/beranda",
  "/master/pelanggan", "/master/produk", "/master/zona", "/master/armada", "/master/depot", "/master/sumber-air", "/master/pool", "/master/karyawan", "/master/impor",
  "/pesanan", "/pesanan/baru", "/pesanan/[id]", "/jadwal", "/jadwal/kru", "/langganan",
  "/sopir-kantor/dicatat-kantor",
  "/kas", "/kas/setoran", "/kas/selisih", "/kas/transfer", "/kas/kantor", "/kas/kas-kecil", "/kas/tutup", "/kas/ganti-rugi",
  "/piutang", "/piutang/faktur", "/piutang/pelunasan", "/piutang/umur", "/piutang/pengingat", "/piutang/faktur-bulanan", "/piutang/saldo-awal",
  "/outlet", "/toko/barang", "/toko/pemasok", "/toko/pembelian", "/toko/opname", "/toko/pesan-ulang", "/toko/utang",
  "/produksi/neraca-air", "/produksi/utilisasi", "/produksi/mutu",
  "/laporan/hari-ini", "/laporan/bulanan", "/laporan/katalog", "/laporan/kinerja", "/laporan/tren", "/laporan/kpi", "/kotak-masuk",
  "/akses/pengguna", "/akses/peran", "/akses/perangkat", "/akses/sinkron", "/akses/tinjauan", "/akses/data-pribadi", "/audit", "/persetujuan", "/notifikasi", "/pengaturan/parameter", "/pengaturan/notifikasi", "/bantuan",
  "/akuntansi/akun", "/akuntansi/pemetaan", "/akuntansi/jurnal", "/akuntansi/buku-besar", "/akuntansi/laporan", "/akuntansi/aset", "/akuntansi/rekonsiliasi", "/akuntansi/periode", "/akuntansi/pajak", "/akuntansi/saldo-awal",
  "/armada/peta", "/armada/riwayat", "/armada/kejadian",
];

describe("Registri navigasi web kantor", () => {
  it("memuat SEMUA rute docs/ARCHITECTURE.md §9 + /kemitraan", () => {
    const hrefs = new Set(allNavItems().map((i) => i.href));
    for (const route of ARCHITECTURE_ROUTES) expect(hrefs, route).toContain(route);
    expect([...hrefs].some((h) => h.startsWith("/kemitraan"))).toBe(true);
  });

  it("id & href unik; label Indonesia tidak kosong; izin berbentuk <modul>.<sumberdaya>.<aksi>", () => {
    const items = allNavItems();
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length);
    for (const item of items) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
      if (item.permission !== null) {
        for (const p of typeof item.permission === "string" ? [item.permission] : item.permission) {
          expect(p, item.href).toMatch(PERMISSION_PATTERN);
        }
      }
    }
  });

  it("docs/nav-permissions.md mencantumkan setiap izin registri", () => {
    const doc = readFileSync(resolve(__dirname, "../../docs/nav-permissions.md"), "utf8");
    for (const p of navPermissions()) expect(doc, p).toContain(p);
  });
});

describe("filterNavByPermissions", () => {
  it("US-M10-01 Dispatcher hanya melihat menu sesuai izinnya (tanpa kas)", () => {
    const groups = filterNavByPermissions(["m2.order.read", "m2.order.create", "m2.schedule.read", "m12.position.read"]);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain("m2.orders");
    expect(ids).toContain("m2.orders.new");
    expect(ids).toContain("m12.map");
    expect(ids).toContain("home"); // izin null = semua pengguna
    expect(ids).not.toContain("m4.cash");
    expect(ids).not.toContain("m2.orders.detail"); // hidden tidak tampil di sidebar
    expect(groups.find((g) => g.id === "m4")).toBeUndefined(); // grup kosong dibuang
  });

  it("tanpa izin → hanya menu umum (Beranda, Notifikasi, Pengaturan notifikasi, Bantuan)", () => {
    const ids = filterNavByPermissions([]).flatMap((g) => g.items.map((i) => i.id));
    expect(ids.sort()).toEqual(["home", "m10.help", "m10.notification_settings", "m10.notifications"].sort());
  });

  it("wildcard: '*' semua, 'm4.*' satu modul, 'm5.invoice.*' satu sumber daya", () => {
    const visibleCount = allNavItems().filter((i) => !i.hidden).length;
    expect(filterNavByPermissions(["*"]).flatMap((g) => g.items)).toHaveLength(visibleCount);
    const m4 = filterNavByPermissions(["m4.*"]).find((g) => g.id === "m4");
    expect(m4?.items).toHaveLength(NAV_GROUPS.find((g) => g.id === "m4")!.items.length);
    expect(hasPermission(["m5.invoice.*"], "m5.invoice.read")).toBe(true);
    expect(hasPermission(["m5.invoice.*"], "m5.aging.read")).toBe(false);
    expect(hasPermission(["m1.*"], "m10.user.read")).toBe(false); // m1.* bukan awalan m10
  });

  it("includeHidden & feature flag", () => {
    const withHidden = filterNavByPermissions(["m2.order.read"], { includeHidden: true }).flatMap((g) => g.items.map((i) => i.id));
    expect(withHidden).toContain("m2.orders.detail");
    const groups = [
      { id: "x", label: "X", module: "p3" as const, items: [{ id: "x.a", href: "/x", label: "X", icon: NAV_GROUPS[0]!.items[0]!.icon, permission: null, flag: "phase3.partner_portal" }] },
    ];
    expect(filterNavByPermissions([], { groups, enabledFlags: [] })).toHaveLength(0);
    expect(filterNavByPermissions([], { groups, enabledFlags: ["phase3.partner_portal"] })).toHaveLength(1);
    expect(filterNavByPermissions([], { groups })).toHaveLength(1); // flag tidak diberikan → diputuskan pemanggil
  });
});

describe("Pencocokan rute & breadcrumb", () => {
  it("findNavMatch: persis, dinamis, dan awalan terpanjang", () => {
    expect(findNavMatch("/kas/setoran")?.item.id).toBe("m4.deposits");
    expect(findNavMatch("/pesanan/0199aa")?.item.id).toBe("m2.orders.detail");
    expect(findNavMatch("/kas/setoran/abc/rincian")?.item.id).toBe("m4.deposits");
    expect(findNavMatch("/pesanan/baru")?.item.id).toBe("m2.orders.new");
    expect(findNavMatch("/tidak-ada")).toBeNull();
  });

  it("item induk aktif untuk halaman rincian tersembunyi", () => {
    const orders = allNavItems().find((i) => i.id === "m2.orders")!;
    expect(isNavItemActive(orders, "/pesanan/0199aa")).toBe(true);
    expect(isNavItemActive(orders, "/pesanan/baru")).toBe(false);
  });

  it("buildBreadcrumbs: Grup › Induk › Halaman (label dapat ditimpa)", () => {
    expect(buildBreadcrumbs("/pesanan/0199aa", { currentLabel: "P-26-000123" })).toEqual([
      { label: "Pesanan & jadwal" },
      { label: "Pesanan", href: "/pesanan" },
      { label: "P-26-000123" },
    ]);
    expect(buildBreadcrumbs("/kas/setoran")).toEqual([
      { label: "Kas & setoran" },
      { label: "Kas hari ini", href: "/kas" },
      { label: "Setoran" },
    ]);
    expect(buildBreadcrumbs("/beranda")).toEqual([{ label: "Beranda" }]);
    expect(buildBreadcrumbs("/tidak-ada")).toEqual([]);
  });
});
