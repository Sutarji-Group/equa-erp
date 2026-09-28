import * as ExcelJSNs from "exceljs";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as exportRoute } from "@/app/api/export/[report]/route";
import { accessLogs, exportLogs } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { setActorResolver } from "@/server/core/actor";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { exportReport, redactAddress, registerReport, unregisterReport } from "@/server/core/export";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const ExcelJS = ((ExcelJSNs as unknown as { default?: typeof ExcelJSNs }).default ?? ExcelJSNs) as typeof ExcelJSNs;

type Row = { name: string; phone: string; address: string; balance: number; lastOrder: string; status: string };

const ROWS: Row[] = [
  { name: "Hotel Puncak Indah", phone: "6281234567890", address: "Jl. Raya Puncak No. 5, Cipanas", balance: 1_250_000, lastOrder: "2026-09-20", status: "credit" },
  { name: "Depot Sumber Jaya", phone: "6281298765432", address: "Kp. Babakan RT 02, Cilaku", balance: 300_000, lastOrder: "2026-09-25", status: "on_hold" },
];

registerReport({
  key: "uji.customers",
  title: "Daftar pelanggan uji",
  module: "m1",
  permission: "m1.customer.read",
  containsPii: true,
  filtersSchema: z.object({ segment: z.string().optional() }),
  columns: [
    { key: "name", header: "Pelanggan", width: 28 },
    { key: "phone", header: "Nomor WA", pii: "phone" },
    { key: "address", header: "Alamat", pii: "address", width: 36 },
    { key: "status", header: "Status kredit", type: "enum", enumName: "credit_status" },
    { key: "lastOrder", header: "Pesanan terakhir", type: "date" },
    { key: "balance", header: "Saldo piutang", type: "rupiah", total: true },
  ],
  fetch: async () => ({ rows: ROWS, summary: [{ label: "Jumlah pelanggan", value: ROWS.length }] }),
});

async function readWorkbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("Ekspor laporan (US-M9-03, BR-39)", () => {
  const t = useTestDb({ seed: true });
  afterAll(() => {
    unregisterReport("uji.customers");
    setActorResolver(null);
  });

  it("US-M9-03 KP-2 BR-39 laporan ber-data pribadi: pemilik wajib mengisi tujuan", async () => {
    await expect(exportReport(seededContext("pemilik"), "uji.customers", "xlsx", {})).rejects.toBeInstanceOf(ValidationError);
    await expect(exportReport(seededContext("pemilik"), "uji.customers", "xlsx", {}, "abc")).rejects.toThrow(/Tujuan ekspor/);
  });

  it("US-M9-03 KP-1/KP-2 pemilik + tujuan → Excel lengkap (Data + Ringkasan) dan tercatat di export_logs & log akses", async () => {
    const res = await exportReport(seededContext("pemilik"), "uji.customers", "xlsx", { segment: "hotel" }, "Kirim ke akuntan untuk konfirmasi saldo");
    expect(res.containsPersonalData).toBe(true);
    expect(res.piiStripped).toBe(false);
    expect(res.filename).toMatch(/^daftar-pelanggan-uji-\d{8}-\d{4}\.xlsx$/);
    const wb = await readWorkbook(res.body);
    const data = wb.getWorksheet("Data")!;
    expect(data.getRow(1).values).toEqual([undefined, "Pelanggan", "Nomor WA", "Alamat", "Status kredit", "Pesanan terakhir", "Saldo piutang"]);
    expect(data.getRow(1).font?.bold).toBe(true);
    expect(data.getCell(2, 2).value).toBe("6281234567890");
    expect(data.getCell(2, 4).value).toBe("Tempo");
    expect(data.getCell(2, 6).value).toBe(1_250_000);
    expect(data.getCell(2, 6).numFmt).toContain('"Rp"');
    const sum = wb.getWorksheet("Ringkasan")!;
    const texts = sum.getColumn(1).values.filter(Boolean).map(String);
    expect(texts).toEqual(expect.arrayContaining(["EQUA", "Laporan", "Dicetak", "Dibuat oleh", "Filter", "Total Saldo piutang"]));

    const log = await t.db.select().from(exportLogs).where(eq(exportLogs.id, res.exportLogId));
    expect(log[0]).toMatchObject({ reportKey: "uji.customers", format: "xlsx", containsPersonalData: true, rowCount: 2 });
    expect(log[0]!.purpose).toMatch(/akuntan/);
    const access = await t.db
      .select()
      .from(accessLogs)
      .where(and(eq(accessLogs.userId, userIdByUsername("pemilik")), eq(accessLogs.event, "export")));
    expect(access.length).toBeGreaterThanOrEqual(1);
  });

  it("US-M9-03 KP-2 peran lain menerima versi tanpa nomor WA & alamat lengkap", async () => {
    const res = await exportReport(seededContext("dispatcher1"), "uji.customers", "xlsx", {});
    expect(res.piiStripped).toBe(true);
    expect(res.containsPersonalData).toBe(false);
    const data = (await readWorkbook(res.body)).getWorksheet("Data")!;
    const headers = data.getRow(1).values as unknown[];
    expect(headers).not.toContain("Nomor WA");
    expect(headers).toContain("Alamat (wilayah)");
    expect(data.getCell(2, 2).value).toBe("Cipanas");
    expect(redactAddress("Jl. Mawar 1")).toBe("(alamat disembunyikan)");
  });

  it("izin laporan ditegakkan (sopir tidak boleh mengekspor data pelanggan)", async () => {
    await expect(exportReport(seededContext("sopir1"), "uji.customers", "pdf", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M9-03 KP-1 PDF siap cetak dan CSV", async () => {
    const pdf = await exportReport(seededContext("keuangan1"), "uji.customers", "pdf", {}, "Tagihan ke pelanggan tempo");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.contentType).toBe("application/pdf");
    const csv = await exportReport(seededContext("keuangan1"), "uji.customers", "csv", {}, "Tagihan ke pelanggan tempo");
    const text = csv.body.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("Pelanggan,Nomor WA,Alamat,Status kredit,Pesanan terakhir,Saldo piutang");
    expect(text).toContain("Ditahan");
  }, 30_000);

  it("US-M10-03 KP-4 matriks peran × tindakan diekspor pemilik", async () => {
    const res = await exportReport(seededContext("pemilik"), "core.rbac_matrix", "xlsx", {});
    const data = (await readWorkbook(res.body)).getWorksheet("Data")!;
    expect(data.rowCount).toBeGreaterThan(100);
    await expect(exportReport(seededContext("dispatcher1"), "core.rbac_matrix", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("route /api/export: 401 tanpa sesi; unduhan berkas dengan resolver pelaku (TODO auth F3c)", async () => {
    const ctx = { params: Promise.resolve({ report: "core.rbac_matrix" }) };
    const unauth = await exportRoute(new Request("http://x/api/export/core.rbac_matrix?format=xlsx"), ctx);
    expect(unauth.status).toBe(401);
    setActorResolver(async () => seededContext("pemilik"));
    const ok = await exportRoute(new Request("http://x/api/export/core.rbac_matrix?format=csv"), ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(/attachment; filename="matriks-peran-tindakan-/);
    const bad = await exportRoute(
      new Request("http://x/api/export/uji.customers?format=xlsx"),
      { params: Promise.resolve({ report: "uji.customers" }) },
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/Tujuan ekspor/);
  });
});
