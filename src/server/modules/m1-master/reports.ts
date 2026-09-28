/**
 * M1 — laporan yang dapat diekspor Excel/PDF (katalog PRD 7.9.4 "Riwayat harga; simulasi zona", US-M9-03, NFR-23)
 * dan setiap daftar master yang disebut PRD M1.
 */
import "server-only";

import { z } from "zod";

import { isBusinessDate } from "@/lib/time";
import { registerReport } from "@/server/core/export";

import { listCustomers, getCustomerDetail } from "./service/customers";
import { listTrucks } from "./service/fleet";
import { getImportBatch } from "./service/import/service";
import { listEmployees, listOutlets, listWaterSources } from "./service/org";
import { priceHistory } from "./service/pricing";
import { listProducts } from "./service/products";
import { listSpecialPriceReviews } from "./service/special-prices";
import { listZoneMoves, simulateZonePricing } from "./service/zone-views";

const uuidOpt = z.uuid().optional();
const dateOpt = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).optional();

export function registerReports(): void {
  registerReport({
    key: "m1.customers",
    title: "Daftar pelanggan & alamat kirim",
    module: "m1",
    permission: "m1.customer.export",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: z.object({ status: z.enum(["active", "inactive", "all"]).optional() }),
    columns: [
      { key: "code", header: "Kode", width: 12 },
      { key: "name", header: "Nama", width: 28 },
      { key: "segment", header: "Segmen", type: "enum", enumName: "customer_segment", width: 16 },
      { key: "waPhone", header: "Nomor WA", pii: "phone", width: 16 },
      { key: "creditStatus", header: "Status kredit", type: "enum", enumName: "credit_status", width: 12 },
      { key: "creditLimit", header: "Batas kredit", type: "rupiah", width: 14 },
      { key: "paymentTermDays", header: "Tempo (hari)", type: "number", width: 10 },
      { key: "isStorePartner", header: "Mitra toko", type: "boolean", width: 10 },
      { key: "label", header: "Label alamat", width: 14 },
      { key: "addressText", header: "Alamat", pii: "address", width: 36 },
      { key: "zoneCode", header: "Zona", width: 8 },
      { key: "zoneAssignment", header: "Pemetaan zona", type: "enum", enumName: "zone_assignment", width: 12 },
      { key: "coordinateStatus", header: "Koordinat", type: "enum", enumName: "coordinate_status", width: 12 },
      { key: "coordinates", header: "Lintang, bujur", pii: "coordinates", width: 22 },
      { key: "isActive", header: "Aktif", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, filters: { status?: "active" | "inactive" | "all" }, { tx }) => {
      const list = await listCustomers(ctx, { status: filters.status ?? "active" }, { tx });
      const rows: Record<string, unknown>[] = [];
      for (const c of list) {
        const detail = await getCustomerDetail(ctx, c.id, { tx });
        for (const a of detail.addresses.filter((x) => x.isActive)) {
          rows.push({
            code: c.code,
            name: c.name,
            segment: c.segment,
            waPhone: detail.customer.waPhone,
            creditStatus: c.creditStatus,
            creditLimit: c.creditLimit,
            paymentTermDays: detail.customer.paymentTermDays,
            isStorePartner: c.isStorePartner,
            label: a.label,
            addressText: a.addressText,
            zoneCode: a.zoneCode,
            zoneAssignment: a.zoneAssignment,
            coordinateStatus: a.coordinateStatus,
            coordinates: a.lat !== null && a.lng !== null ? `${a.lat}, ${a.lng}` : null,
            isActive: c.isActive,
          });
        }
      }
      return { rows, summary: [{ label: "Jumlah pelanggan", value: list.length, type: "number" }] };
    },
  });

  registerReport({
    key: "m1.price_history",
    title: "Riwayat harga (tarif zona, BBM, produk, harga khusus)",
    module: "m1",
    permission: "m1.price.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ productId: uuidOpt, customerId: uuidOpt }),
    columns: [
      { key: "effectiveFrom", header: "Berlaku mulai", type: "date", width: 12 },
      { key: "kindLabel", header: "Jenis", width: 16 },
      { key: "subject", header: "Objek", width: 28 },
      { key: "detail", header: "Keterangan", width: 30 },
      { key: "price", header: "Harga", type: "rupiah", width: 14 },
      { key: "status", header: "Status", type: "enum", enumName: "price_status", width: 14 },
      { key: "ownerDirect", header: "Keputusan langsung pemilik", type: "boolean", width: 12 },
      { key: "reason", header: "Alasan", width: 36 },
      { key: "createdAt", header: "Dicatat", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, filters: { productId?: string; customerId?: string }, { tx }) => ({ rows: await priceHistory(tx, ctx.tenantId, filters) }),
  });

  registerReport({
    key: "m1.zone_simulation",
    title: "Simulasi harga zona vs harga berlaku per pelanggan",
    module: "m1",
    permission: "m1.tariff_zone.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ approvalId: uuidOpt, date: dateOpt }),
    columns: [
      { key: "customerCode", header: "Kode", width: 12 },
      { key: "customerName", header: "Pelanggan", width: 28 },
      { key: "segment", header: "Segmen", type: "enum", enumName: "customer_segment", width: 16 },
      { key: "addressLabel", header: "Alamat", width: 14 },
      { key: "distanceKm", header: "Jarak (km)", type: "number", width: 10, value: (r: Record<string, unknown>) => (typeof r.distanceM === "number" ? Math.round(r.distanceM / 100) / 10 : null) },
      { key: "currentZoneCode", header: "Zona kini", width: 10 },
      { key: "newZoneCode", header: "Zona baru", width: 10 },
      { key: "legacyPrice", header: "Harga saat ini (impor)", type: "rupiah", width: 16 },
      { key: "currentPrice", header: "Harga master kini", type: "rupiah", width: 16 },
      { key: "newPrice", header: "Harga zona baru", type: "rupiah", width: 16 },
      { key: "difference", header: "Selisih", type: "rupiah", width: 14 },
      { key: "differencePct", header: "Selisih %", type: "percent", width: 10 },
      { key: "hasSpecialPrice", header: "Harga khusus", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, filters: { approvalId?: string; date?: string }, { tx }) => {
      const sim = await simulateZonePricing(ctx, filters, { tx });
      const up = sim.rows.filter((r) => (r.difference ?? 0) > 0).length;
      const down = sim.rows.filter((r) => (r.difference ?? 0) < 0).length;
      return {
        rows: sim.rows as unknown as Record<string, unknown>[],
        summary: [
          { label: "Tanggal tabel zona", value: sim.date },
          { label: "Alamat naik harga", value: up, type: "number" },
          { label: "Alamat turun harga", value: down, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m1.zone_moves",
    title: "Alamat yang berpindah zona akibat perubahan batas",
    module: "m1",
    permission: "m1.tariff_zone.read",
    containsPii: false,
    filtersSchema: z.object({ approvalId: uuidOpt, effectiveFrom: dateOpt }),
    columns: [
      { key: "customerCode", header: "Kode", width: 12 },
      { key: "customerName", header: "Pelanggan", width: 28 },
      { key: "label", header: "Alamat", width: 14 },
      { key: "distanceKm", header: "Jarak (km)", type: "number", width: 10, value: (r: Record<string, unknown>) => Math.round(Number(r.distanceM) / 100) / 10 },
      { key: "fromZoneCode", header: "Dari zona", width: 10 },
      { key: "toZoneCode", header: "Ke zona", width: 10 },
      { key: "manual", header: "Zona manual", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, filters: { approvalId?: string; effectiveFrom?: string }, { tx }) => {
      const res = await listZoneMoves(ctx, filters, { tx });
      return { rows: res.moves as unknown as Record<string, unknown>[], summary: [{ label: "Berlaku mulai", value: res.effectiveFrom ?? "—" }] };
    },
  });

  registerReport({
    key: "m1.products",
    title: "Produk & harga berlaku",
    module: "m1",
    permission: "m1.product.read",
    containsPii: false,
    columns: [
      { key: "code", header: "Kode", width: 14 },
      { key: "name", header: "Nama", width: 28 },
      { key: "line", header: "Lini", type: "enum", enumName: "product_line", width: 14 },
      { key: "unit", header: "Satuan", width: 10 },
      { key: "standard", header: "Harga standar", type: "rupiah", width: 14 },
      { key: "general", header: "Harga umum", type: "rupiah", width: 14 },
      { key: "partner", header: "Harga mitra", type: "rupiah", width: 14 },
      { key: "status", header: "Status", type: "enum", enumName: "product_status", width: 14 },
    ],
    fetch: async (ctx, _filters, { tx }) => {
      const list = await listProducts(ctx, { includeInactive: true }, { tx });
      return {
        rows: list.map((p) => ({
          code: p.code,
          name: p.name,
          line: p.line,
          unit: p.unit,
          standard: p.prices.find((x) => x.kind === "standard")?.price ?? null,
          general: p.prices.find((x) => x.kind === "general")?.price ?? null,
          partner: p.prices.find((x) => x.kind === "partner")?.price ?? null,
          status: p.status,
        })),
      };
    },
  });

  registerReport({
    key: "m1.trucks",
    title: "Daftar armada & kru default",
    module: "m1",
    permission: "m1.truck.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "code", header: "Kode", width: 8 },
      { key: "plateNumber", header: "Nomor polisi", width: 14 },
      { key: "capacityL", header: "Kapasitas", type: "liter", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "truck_status", width: 12 },
      { key: "driverName", header: "Sopir default", width: 22 },
      { key: "helperName", header: "Kernet default", width: 22 },
      { key: "gpsDeviceCode", header: "Perangkat GPS", width: 16 },
      { key: "fieldDeviceCode", header: "Ponsel lapangan", width: 16 },
      { key: "effectiveTripCapacity", header: "Kapasitas rit/hari", type: "number", width: 12 },
      { key: "poolName", header: "Pool", width: 20 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listTrucks(ctx, { tx })) as unknown as Record<string, unknown>[] }),
  });

  registerReport({
    key: "m1.outlets",
    title: "Daftar depot & toko",
    module: "m1",
    permission: "m1.outlet.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "code", header: "Kode", width: 8 },
      { key: "name", header: "Nama", width: 26 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "outlet_kind", width: 10 },
      { key: "tenantName", header: "Tenant", width: 12 },
      { key: "address", header: "Alamat", width: 32 },
      { key: "geofenceRadiusM", header: "Geofence (m)", type: "number", width: 10 },
      { key: "storageCapacityL", header: "Kapasitas simpan", type: "liter", width: 14 },
      { key: "operatorName", header: "Operator default", width: 22 },
      { key: "isActive", header: "Aktif", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listOutlets(ctx, { tx })) as unknown as Record<string, unknown>[] }),
  });

  registerReport({
    key: "m1.water_sources",
    title: "Sumber air & meter",
    module: "m1",
    permission: "m1.water_source.read",
    containsPii: false,
    columns: [
      { key: "code", header: "Kode", width: 8 },
      { key: "name", header: "Sumber air", width: 26 },
      { key: "dailyCapacityL", header: "Kapasitas harian", type: "liter", width: 14 },
      { key: "meterCode", header: "Meter", width: 16 },
      { key: "meterUnit", header: "Satuan", type: "enum", enumName: "meter_unit", width: 12 },
      { key: "initialReadingL", header: "Angka awal", type: "number", width: 14 },
      { key: "meterStatus", header: "Status meter", type: "enum", enumName: "meter_status", width: 12 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const list = await listWaterSources(ctx, { tx });
      const rows = list.flatMap((s) =>
        (s.meters.length ? s.meters : [null]).map((m) => ({
          code: s.code,
          name: s.name,
          dailyCapacityL: s.dailyCapacityL,
          meterCode: m?.code ?? null,
          meterUnit: m?.unit ?? null,
          initialReadingL: m?.initialReadingL ?? null,
          meterStatus: m?.status ?? null,
        })),
      );
      return { rows };
    },
  });

  registerReport({
    key: "m1.employees",
    title: "Daftar karyawan",
    module: "m1",
    permission: "m1.employee.read",
    containsPii: true,
    orientation: "landscape",
    columns: [
      { key: "employeeNo", header: "No.", width: 10 },
      { key: "fullName", header: "Nama", width: 26 },
      { key: "position", header: "Jabatan", width: 18 },
      { key: "rolesText", header: "Peran sistem", width: 22 },
      { key: "phone", header: "Telepon", pii: "phone", width: 16 },
      { key: "outletName", header: "Outlet utama", width: 22 },
      { key: "hireDate", header: "Tanggal masuk", type: "date", width: 12 },
      { key: "exitDate", header: "Tanggal keluar", type: "date", width: 12 },
      { key: "isActive", header: "Aktif", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listEmployees(ctx, { tx })) as unknown as Record<string, unknown>[] }),
  });

  registerReport({
    key: "m1.special_price_reviews",
    title: "Tinjauan harga khusus (lewat tanggal tinjauan)",
    module: "m1",
    permission: "m1.special_price.read",
    containsPii: false,
    columns: [
      { key: "customerName", header: "Pelanggan", width: 28 },
      { key: "productName", header: "Produk", width: 20 },
      { key: "price", header: "Harga khusus", type: "rupiah", width: 14 },
      { key: "validFrom", header: "Berlaku mulai", type: "date", width: 12 },
      { key: "reviewDate", header: "Tanggal tinjauan", type: "date", width: 12 },
      { key: "daysOverdue", header: "Lewat (hari)", type: "number", width: 10 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listSpecialPriceReviews(ctx, { tx })) as unknown as Record<string, unknown>[] }),
  });

  registerReport({
    key: "m1.import_validation",
    title: "Laporan validasi impor data awal",
    module: "m1",
    permission: "m1.import.read",
    containsPii: true,
    orientation: "landscape",
    filtersSchema: z.object({ batchId: z.uuid({ error: "Batch impor wajib dipilih." }) }),
    columns: [
      { key: "rowNumber", header: "Baris", type: "number", width: 8 },
      { key: "status", header: "Status", type: "enum", enumName: "import_row_status", width: 12 },
      { key: "errors", header: "Kesalahan", width: 50, value: (r: Record<string, unknown>) => ((r.errors as string[] | null) ?? []).join(" ") },
      { key: "duplicates", header: "Kandidat duplikat / usulan", width: 40, value: (r: Record<string, unknown>) => ((r.duplicateCandidates as { name?: string; code?: string; reason?: string }[] | null) ?? []).map((d) => `${d.code ?? ""} ${d.name ?? ""} (${d.reason ?? ""})`.trim()).join("; ") },
      { key: "exclusionReason", header: "Alasan dikecualikan", width: 30 },
      { key: "data", header: "Isi baris", pii: "identity", width: 60, value: (r: Record<string, unknown>) => JSON.stringify(r.data) },
    ],
    fetch: async (ctx, filters: { batchId: string }, { tx }) => {
      const res = await getImportBatch(ctx, filters.batchId, { tx });
      return {
        rows: res.rows as unknown as Record<string, unknown>[],
        status: res.batch.status,
        summary: [
          { label: "Jenis", value: res.def.title },
          { label: "Baris", value: res.batch.rowCount, type: "number" },
          { label: "Salah", value: res.batch.errorCount, type: "number" },
          { label: "Duplikat", value: res.batch.duplicateCount, type: "number" },
          { label: "Dikecualikan", value: res.batch.excludedCount, type: "number" },
        ],
      };
    },
  });
}
