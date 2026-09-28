import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  customerAddresses,
  customerLegacyPrices,
  customers,
  dataSignoffs,
  employees,
  importBatchRows,
  notifications,
  outlets,
  trucks,
  waterMeters,
  waterSources,
} from "@/db/schema";
import { customerId as seedCustomerId, userIdByUsername } from "@/db/seed";
import { ForbiddenError } from "@/server/core/errors";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, sysadmin, workbook } from "./helpers";

describe("M1 Master Data", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  const CUSTOMER_HEADERS = m1.IMPORT_DEFS.customers.columns.map(
    (c) => c.header,
  );
  type CustRow = Partial<
    Record<
      (typeof m1.IMPORT_DEFS.customers.columns)[number]["key"],
      string | number | null
    >
  >;
  const custRow = (r: CustRow) =>
    m1.IMPORT_DEFS.customers.columns.map(
      (c) => r[c.key as keyof CustRow] ?? null,
    );

  describe("US-M1-06 Mengimpor data awal dan membersihkan duplikat", () => {
    it("US-M1-06 KP-1 template Excel per jenis (pelanggan multi-alamat, harga per pelanggan, armada, kru, karyawan, depot, sumber air) + contoh terisi yang dapat dibaca ulang", async () => {
      expect(m1.IMPORT_KINDS_M1).toEqual([
        "customers",
        "customer_prices",
        "trucks",
        "crew",
        "employees",
        "outlets",
        "water_sources",
      ]);
      for (const kind of m1.IMPORT_KINDS_M1) {
        const empty = await m1.buildImportTemplate(kind);
        await expect(m1.parseImportWorkbook(kind, empty)).rejects.toThrow(
          /kosong/,
        );
        const example = await m1.buildImportTemplate(kind, {
          withExample: true,
        });
        const rows = await m1.parseImportWorkbook(kind, example);
        expect(rows.length, kind).toBe(m1.IMPORT_DEFS[kind].example.length);
      }
      const rows = await m1.parseImportWorkbook(
        "customers",
        await m1.buildImportTemplate("customers", { withExample: true }),
      );
      expect(
        rows.filter((r) => r.data.kode_pelanggan === "PLG-0101"),
      ).toHaveLength(2);
      await expect(
        m1.parseImportWorkbook(
          "customers",
          await workbook(["Nama pelanggan"], [["X"]]),
        ),
      ).rejects.toThrow(/Kolom wajib tidak ditemukan/);
    });

    it("US-M1-06 KP-2 laporan validasi per baris (wajib kosong, format WA, segmen tak dikenal, duplikat + usulan gabung); tidak ada baris masuk sebelum semua diselesaikan/dikecualikan beralasan", async () => {
      const file = await workbook(CUSTOMER_HEADERS, [
        custRow({
          kode_pelanggan: "IMP-001",
          nama: "Hotel Impor Satu",
          segmen: "Hotel",
          nomor_wa: "0812-7000-0001",
          label_alamat: "Utama",
          alamat: "Jl. Impor 1, Cipanas",
          lat: -6.74,
          lng: 107.05,
        }),
        custRow({
          kode_pelanggan: "IMP-002",
          nama: "",
          segmen: "Hotel",
          nomor_wa: "0812-7000-0002",
          label_alamat: "Utama",
          alamat: "Jl. Impor 2, Cipanas",
        }),
        custRow({
          kode_pelanggan: "IMP-003",
          nama: "Toko Salah WA",
          segmen: "Hotel",
          nomor_wa: "12345",
          label_alamat: "Utama",
          alamat: "Jl. Impor 3, Cipanas",
        }),
        custRow({
          kode_pelanggan: "IMP-004",
          nama: "Segmen Aneh",
          segmen: "Pabrik bulan",
          nomor_wa: "0812-7000-0004",
          label_alamat: "Utama",
          alamat: "Jl. Impor 4, Cipanas",
        }),
        // Duplikat pelanggan seed: WA sama dengan PLG-0001 (6281310000001).
        custRow({
          kode_pelanggan: "IMP-005",
          nama: "Depot Tirta Sari (lama)",
          segmen: "Depot pihak ketiga",
          nomor_wa: "0813-1000-0001",
          label_alamat: "Cabang",
          alamat: "Jl. Raya Cibeber No. 99, Cibeber",
        }),
      ]);
      const { batch, rows } = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        filename: "pelanggan.xlsx",
        file,
      });
      expect(batch).toMatchObject({
        status: "has_errors",
        rowCount: 5,
        errorCount: 3,
        duplicateCount: 1,
      });
      const byRow = (n: number) => rows.find((r) => r.rowNumber === n)!;
      expect(byRow(2).status).toBe("valid");
      expect(byRow(3).errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Nama pelanggan wajib diisi/),
        ]),
      );
      expect(byRow(4).errors!.join(" ")).toMatch(/Format nomor WA salah/);
      expect(byRow(5).errors!.join(" ")).toMatch(
        /Segmen "Pabrik bulan" tidak dikenal/,
      );
      expect(byRow(6).status).toBe("duplicate");
      expect(byRow(6).mergeProposal).toMatchObject({
        action: "merge",
        targetCustomerId: seedCustomerId("PLG-0001"),
      });

      await expect(
        m1.commitImport(dispatcher(), batch.id),
      ).rejects.toMatchObject({ code: "IMPORT_HAS_ERRORS" });
      expect(
        (
          await t.db
            .select()
            .from(customers)
            .where(eq(customers.code, "IMP-001"))
        ).length,
      ).toBe(0);

      // Perbaiki baris 3, kecualikan baris 4 & 5 beralasan, gabungkan duplikat ke pelanggan yang ada.
      await m1.updateImportRow(dispatcher(), batch.id, byRow(3).id, {
        nama: "Hotel Impor Dua",
      });
      await expect(
        m1.resolveImportRow(dispatcher(), batch.id, byRow(4).id, {
          decision: "exclude",
        }),
      ).rejects.toThrow(/Alasan pengecualian/);
      await m1.resolveImportRow(dispatcher(), batch.id, byRow(4).id, {
        decision: "exclude",
        reason: "Nomor WA ditanyakan ulang",
      });
      await m1.resolveImportRow(dispatcher(), batch.id, byRow(5).id, {
        decision: "exclude",
        reason: "Bukan pelanggan air",
      });
      const after = await m1.resolveImportRow(
        dispatcher(),
        batch.id,
        byRow(6).id,
        { decision: "merge" },
      );
      expect(after).toMatchObject({
        status: "validated",
        errorCount: 0,
        duplicateCount: 0,
        excludedCount: 2,
      });

      const { summary } = await m1.commitImport(dispatcher(), batch.id);
      expect(summary).toMatchObject({ created: 2, merged: 1, excluded: 2 });
      const merged = await t.db
        .select()
        .from(customerAddresses)
        .where(
          and(
            eq(customerAddresses.customerId, seedCustomerId("PLG-0001")),
            eq(customerAddresses.label, "Cabang"),
          ),
        );
      expect(merged).toHaveLength(1);
      const rowsAfter = await t.db
        .select()
        .from(importBatchRows)
        .where(eq(importBatchRows.batchId, batch.id));
      expect(rowsAfter.filter((r) => r.status === "committed")).toHaveLength(3);
      // Admin Keuangan tidak dapat mengunggah; pelanggan (data harga/batas) butuh izin commit_pricing (Dispatcher).
      await expect(
        m1.uploadImport(finance(), { kind: "customers", mode: "test", file }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("US-M1-06 KP-2 duplikat nama + alamat mirip dapat dinyatakan pelanggan baru dengan alasan", async () => {
      const file = await workbook(CUSTOMER_HEADERS, [
        custRow({
          kode_pelanggan: "IMP-101",
          nama: "Depot Air Tirta Sari",
          segmen: "Depot pihak ketiga",
          nomor_wa: "0812-7100-0101",
          label_alamat: "Utama",
          alamat: "Jl. Raya Cibeber No. 12, Cibeber",
        }),
      ]);
      const { batch, rows } = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        file,
      });
      expect(rows[0]!.status).toBe("duplicate");
      await expect(
        m1.resolveImportRow(dispatcher(), batch.id, rows[0]!.id, {
          decision: "create_new",
        }),
      ).rejects.toThrow(/Alasan/);
      await m1.resolveImportRow(dispatcher(), batch.id, rows[0]!.id, {
        decision: "create_new",
        reason: "Cabang milik pemilik berbeda",
      });
      const res = await m1.commitImport(dispatcher(), batch.id);
      expect(res.summary.created).toBe(1);
    });

    it("US-M1-06 KP-3 mode uji dapat diulang; produksi hanya sekali per jenis dengan penanda data awal (ubah hanya lewat koreksi berjejak)", async () => {
      const file = await workbook(CUSTOMER_HEADERS, [
        custRow({
          kode_pelanggan: "PRD-001",
          nama: "Pabrik Produksi Satu",
          segmen: "Industri",
          nomor_wa: "0812-7200-0001",
          label_alamat: "Utama",
          alamat: "Jl. Produksi 1, Sukaluyu",
          lat: -6.815,
          lng: 107.24,
          status_kredit: "Tempo migrasi",
          batas_kredit: 8_000_000,
          tempo_hari: 21,
        }),
        custRow({
          kode_pelanggan: "PRD-001",
          nama: "Pabrik Produksi Satu",
          segmen: "Industri",
          nomor_wa: "0812-7200-0001",
          label_alamat: "Gudang",
          alamat: "Jl. Produksi 2, Sukaluyu",
          status_kredit: "Tempo migrasi",
          batas_kredit: 8_000_000,
          tempo_hari: 21,
          zona_manual: "Z3",
        }),
        custRow({
          kode_pelanggan: "PRD-002",
          nama: "Rumah Produksi Dua",
          segmen: "Rumah tangga",
          nomor_wa: "0812-7200-0002",
          label_alamat: "Utama",
          alamat: "Kp. Produksi RT 1, Cilaku",
        }),
      ]);
      // Uji berulang: dua kali unggah uji tidak ditolak.
      const t1 = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        file,
      });
      await m1.cancelImport(dispatcher(), t1.batch.id, "Latihan pertama");
      const t2 = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        file,
      });
      await m1.cancelImport(dispatcher(), t2.batch.id, "Latihan kedua");

      const prod = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "production",
        file,
      });
      expect(prod.batch.isInitialData).toBe(true);
      const res = await m1.commitImport(dispatcher(), prod.batch.id);
      const [c] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.code, "PRD-001"));
      expect(c).toMatchObject({
        isInitialData: true,
        importBatchId: prod.batch.id,
        creditStatus: "cash",
      });
      expect(res.summary).toMatchObject({
        created: 2,
        addressesLocked: 1,
        addressesUnlocked: 2,
      });
      await expect(
        m1.uploadImport(dispatcher(), {
          kind: "customers",
          mode: "production",
          file,
        }),
      ).rejects.toMatchObject({ code: "PRODUCTION_IMPORT_DONE" });
      await expect(
        m1.updateCustomer(dispatcher(), c!.id, { notes: "x" }),
      ).rejects.toMatchObject({ code: "INITIAL_DATA_CORRECTION" });
    });

    it("US-M1-06 KP-4 & KP-6 ringkasan per segmen, per zona, Tempo migrasi & batas ditandatangani pemilik; Tempo migrasi berlaku saat ditandatangani (satu-satunya pengecualian BR-01)", async () => {
      const [signoff] = await t.db
        .select()
        .from(dataSignoffs)
        .where(
          and(
            eq(dataSignoffs.group, "customers"),
            eq(dataSignoffs.status, "draft"),
          ),
        );
      expect(signoff).toBeTruthy();
      const summary = (
        signoff!.summary as { kinds: { customers: Record<string, unknown> } }
      ).kinds.customers;
      expect(summary.bySegment).toMatchObject({
        Industri: 1,
        "Rumah tangga": 1,
      });
      expect(
        Object.values(summary.byZone as Record<string, number>).reduce(
          (a, b) => a + b,
          0,
        ),
      ).toBe(3);
      expect(summary.tempoMigrasi).toEqual([
        expect.objectContaining({
          code: "PRD-001",
          creditLimit: 8_000_000,
          paymentTermDays: 21,
        }),
      ]);
      const n = await t.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.event, "initial_data.signoff_pending"),
            eq(notifications.recipientUserId, userIdByUsername("pemilik")),
          ),
        );
      expect(n.length).toBeGreaterThan(0);

      await expect(
        m1.signDataSignoff(dispatcher(), signoff!.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const signed = await m1.signDataSignoff(owner(), signoff!.id, {
        note: "Sesuai daftar pelanggan tempo lama",
      });
      expect(signed).toMatchObject({
        status: "signed",
        signedBy: userIdByUsername("pemilik"),
      });
      const [c] = await t.db
        .select()
        .from(customers)
        .where(eq(customers.code, "PRD-001"));
      expect(c).toMatchObject({
        creditStatus: "credit_migrated",
        creditLimit: 8_000_000,
        paymentTermDays: 21,
      });
      await expect(
        m1.signDataSignoff(owner(), signoff!.id),
      ).rejects.toMatchObject({ code: "SIGNOFF_NOT_DRAFT" });
      const status = await m1.initialDataStatus(owner());
      expect(status.groups.find((g) => g.group === "customers")!.status).toBe(
        "signed",
      );
      expect(status.allSigned).toBe(false);
      // Tempo migrasi untuk rumah tangga ditolak saat validasi (BR-04).
      const bad = await workbook(CUSTOMER_HEADERS, [
        custRow({
          kode_pelanggan: "PRD-009",
          nama: "Rumah Tempo",
          segmen: "Rumah tangga",
          nomor_wa: "0812-7200-0009",
          label_alamat: "Utama",
          alamat: "Kp. X, Cilaku",
          status_kredit: "Tempo migrasi",
          batas_kredit: 1_000_000,
          tempo_hari: 14,
        }),
      ]);
      const b = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        file: bad,
      });
      expect(b.rows[0]!.errors!.join(" ")).toMatch(/BR-04/);
      const tempo = await workbook(CUSTOMER_HEADERS, [
        custRow({
          kode_pelanggan: "PRD-010",
          nama: "Hotel Tempo Biasa",
          segmen: "Hotel",
          nomor_wa: "0812-7200-0010",
          label_alamat: "Utama",
          alamat: "Jl. X, Cipanas",
          status_kredit: "Tempo",
        }),
      ]);
      const b2 = await m1.uploadImport(dispatcher(), {
        kind: "customers",
        mode: "test",
        file: tempo,
      });
      expect(b2.rows[0]!.errors!.join(" ")).toMatch(/Tempo migrasi/);
    });

    it("US-M1-06 KP-5 kemajuan % alamat terkunci (koordinat kosong dilengkapi dari GPS sopir)", async () => {
      const p = await m1.coordinateLockProgress(dispatcher());
      expect(p.total).toBeGreaterThan(0);
      expect(p.unlocked).toBeGreaterThan(0);
      expect(p.percentLocked).toBeCloseTo((p.locked / p.total) * 100, 0);
      expect(p.windowDays).toBe(30);
      // Mengunci satu alamat menaikkan persentase.
      const [unlocked] = await t.db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.coordinateStatus, "unlocked"))
        .limit(1);
      await m1.setAddressCoordinates(dispatcher(), unlocked!.id, {
        lat: -6.83,
        lng: 107.14,
      });
      const p2 = await m1.coordinateLockProgress(dispatcher());
      expect(p2.locked).toBe(p.locked + 1);
    });

    it("US-M1-06 KP-1 impor harga saat ini per pelanggan, armada, karyawan, kru, depot, sumber air", async () => {
      const priceFile = await workbook(
        m1.IMPORT_DEFS.customer_prices.columns.map((c) => c.header),
        [
          ["PRD-001", "Utama", 275_000, "Harga lama"],
          ["PLG-9999", null, 100_000, null],
        ],
      );
      const pb = await m1.uploadImport(dispatcher(), {
        kind: "customer_prices",
        mode: "test",
        file: priceFile,
      });
      expect(pb.rows[1]!.errors!.join(" ")).toMatch(/belum ada di sistem/);
      await m1.resolveImportRow(dispatcher(), pb.batch.id, pb.rows[1]!.id, {
        decision: "exclude",
        reason: "Pelanggan tidak aktif lagi",
      });
      await m1.commitImport(dispatcher(), pb.batch.id);
      const legacy = await t.db
        .select()
        .from(customerLegacyPrices)
        .where(eq(customerLegacyPrices.importBatchId, pb.batch.id));
      expect(legacy[0]).toMatchObject({
        pricePerTrip: 275_000,
        isCurrent: true,
      });

      const empFile = await workbook(
        m1.IMPORT_DEFS.employees.columns.map((c) => c.header),
        [
          [
            "EQ-700",
            "Sopir Impor",
            "Ujang",
            "Sopir",
            "0812-7300-0700",
            "Pool",
            null,
            "Sopir",
            "2026-09-01",
            null,
          ],
          [
            "EQ-701",
            "Kernet Impor",
            "Dede",
            "Kernet",
            null,
            "Pool",
            null,
            "Kernet",
            "2026-09-01",
            null,
          ],
        ],
      );
      const eb = await m1.uploadImport(sysadmin(), {
        kind: "employees",
        mode: "test",
        file: empFile,
      });
      expect(eb.batch.status).toBe("validated");
      await m1.commitImport(sysadmin(), eb.batch.id);
      const [emp] = await t.db
        .select()
        .from(employees)
        .where(eq(employees.employeeNo, "EQ-700"));
      expect(emp!.intendedRoles).toEqual(["driver"]);

      const truckFile = await workbook(
        m1.IMPORT_DEFS.trucks.columns.map((c) => c.header),
        [["T30", "F 8230 IM", 5000, 3, "PL1"]],
      );
      const tb = await m1.uploadImport(dispatcher(), {
        kind: "trucks",
        mode: "test",
        file: truckFile,
      });
      await m1.commitImport(dispatcher(), tb.batch.id);
      const crewFile = await workbook(
        m1.IMPORT_DEFS.crew.columns.map((c) => c.header),
        [["T30", "EQ-700", "EQ-701"]],
      );
      const cb = await m1.uploadImport(dispatcher(), {
        kind: "crew",
        mode: "test",
        file: crewFile,
      });
      expect(cb.batch.status).toBe("validated");
      await m1.commitImport(dispatcher(), cb.batch.id);
      const [truck] = await t.db
        .select()
        .from(trucks)
        .where(eq(trucks.code, "T30"));
      expect(truck!.defaultDriverEmployeeId).toBe(emp!.id);
      // Duplikat armada terhadap data yang ada = kesalahan yang harus dikecualikan.
      const dupTruck = await m1.uploadImport(dispatcher(), {
        kind: "trucks",
        mode: "test",
        file: truckFile,
      });
      expect(dupTruck.rows[0]!.errors!.join(" ")).toMatch(/Duplikat/);

      const outletFile = await workbook(
        m1.IMPORT_DEFS.outlets.columns.map((c) => c.header),
        [
          [
            "D40",
            "Depot Impor",
            "Depot",
            "Jl. Impor Depot",
            -6.83,
            107.15,
            100,
            5000,
            null,
          ],
        ],
      );
      const ob = await m1.uploadImport(sysadmin(), {
        kind: "outlets",
        mode: "test",
        file: outletFile,
      });
      await m1.commitImport(sysadmin(), ob.batch.id);
      const [depot] = await t.db
        .select()
        .from(outlets)
        .where(eq(outlets.code, "D40"));
      expect(
        (
          await t.db
            .select()
            .from(customers)
            .where(eq(customers.internalOutletId, depot!.id))
        ).length,
      ).toBe(1);

      const srcFile = await workbook(
        m1.IMPORT_DEFS.water_sources.columns.map((c) => c.header),
        [
          [
            "SA40",
            "Sumber Impor",
            "Kp. Impor",
            -6.78,
            107.09,
            50000,
            100,
            "MTR-SA40",
            "Liter",
            5_000_000,
          ],
        ],
      );
      const sb = await m1.uploadImport(sysadmin(), {
        kind: "water_sources",
        mode: "test",
        file: srcFile,
      });
      await m1.commitImport(sysadmin(), sb.batch.id);
      const [src] = await t.db
        .select()
        .from(waterSources)
        .where(eq(waterSources.code, "SA40"));
      expect(
        (
          await t.db
            .select()
            .from(waterMeters)
            .where(eq(waterMeters.waterSourceId, src!.id))
        )[0]!.initialReadingL,
      ).toBe(5_000_000);
      // Admin sistem tidak dapat memasukkan data keuangan (pelanggan/harga) — SOD-07.
      const again = await m1.uploadImport(sysadmin(), {
        kind: "customer_prices",
        mode: "test",
        file: priceFile,
      });
      await expect(
        m1.commitImport(sysadmin(), again.batch.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
