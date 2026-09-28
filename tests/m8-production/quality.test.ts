import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { attachments, qualityTests, qualityTestSchedules } from "@/db/schema";
import { employeeId, EMPLOYEE_SEEDS, outletId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { withTx } from "@/server/core/db";
import { exportReport } from "@/server/core/export";
import * as params from "@/server/core/params";
import { put } from "@/server/core/storage";
import {
  completeQualityAction,
  deactivateQualitySchedule,
  qualityOverview,
  recordQualityTest,
  runQualityReminders,
  upsertQualitySchedule,
} from "@/server/modules/m8-production";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, PDF, productionWorld } from "./helpers";

const keuanganEmployee = () => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === "keuangan1")!.no);

describe("M8 — catatan mutu air (US-M8-06)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-06 KP-1 jadwal uji per lokasi (sumber, depot) dengan frekuensi PAR-70; pengingat H-7 ke pemilik & operator", async () => {
    const w = await productionWorld(t.db);
    // PAR-70 belum ditetapkan (tanpa bawaan BRD) → frekuensi wajib diisi.
    await expect(upsertQualitySchedule(owner(), { locationType: "water_source", waterSourceId: w.source.id, nextDueDate: "2026-09-25" })).rejects.toThrow(/Frekuensi uji belum ditetapkan/);
    await expect(upsertQualitySchedule(finance(), { locationType: "water_source", waterSourceId: w.source.id, frequencyDays: 90, nextDueDate: "2026-09-25" })).rejects.toThrow();
    const s1 = await upsertQualitySchedule(owner(), { locationType: "water_source", waterSourceId: w.source.id, frequencyDays: 90, nextDueDate: "2026-09-25", laboratory: "Labkesda Cianjur", parameters: ["E. coli", "TDS", "pH"] });
    expect(s1).toMatchObject({ frequencyDays: 90, nextDueDate: "2026-09-25", isActive: true });
    const s2 = await upsertQualitySchedule(owner(), { locationType: "outlet", outletId: outletId("D04"), frequencyDays: 180, nextDueDate: "2026-12-01" });
    expect(s2.outletId).toBe(outletId("D04"));
    // PAR-70 ditetapkan pemilik → dipakai sebagai bawaan frekuensi.
    await params.set(owner(new Date("2026-09-01T01:00:00Z")), "PAR-70", { frequency_days: 30, configured: true }, "2026-09-01", "Arahan konsultan mutu");
    const s3 = await upsertQualitySchedule(owner(), { locationType: "outlet", outletId: outletId("D05"), nextDueDate: "2026-09-26" });
    expect(s3.frequencyDays).toBe(30);

    const res = await runQualityReminders(new Date("2026-09-18T01:00:00Z")); // H-7 dari 25 Sep
    expect(res.reminded).toBeGreaterThanOrEqual(1);
    const notes = await w.notificationsFor("quality_test.due", s1.id);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("pemilik"))).toBe(true);
    expect(recipients.has(w.operator.userId)).toBe(true);
    // Diulang: tidak menggandakan pengingat; jadwal jauh (Desember) belum diingatkan.
    await runQualityReminders(new Date("2026-09-19T01:00:00Z"));
    expect((await w.notificationsFor("quality_test.due", s1.id)).length).toBe(notes.length);
    expect((await w.notificationsFor("quality_test.due", s2.id)).length).toBe(0);
    // Depot D05 → pemilik & operator depot D05.
    const d05 = await w.notificationsFor("quality_test.due", s3.id);
    expect(d05.map((n) => n.recipientUserId)).toContain(userIdByUsername("depot05"));
    const off = await deactivateQualitySchedule(owner(), { scheduleId: s2.id, reason: "Depot pindah jadwal konsultan" });
    expect(off.isActive).toBe(false);
  });

  it("US-M8-06 KP-2 hasil uji (tanggal, lab, parameter & nilai, lulus/tidak, sertifikat); tidak lulus → tindakan wajib + notifikasi pemilik", async () => {
    const w = await productionWorld(t.db);
    const sched = await upsertQualitySchedule(owner(), { locationType: "water_source", waterSourceId: w.source.id, frequencyDays: 90, nextDueDate: "2026-09-20" });
    const cert = await withTx((tx) => put(tx, finance(), { blob: PDF, contentType: "application/pdf", kind: "quality_certificate", originalName: "sertifikat.pdf" }));
    const base = {
      scheduleId: sched.id,
      locationType: "water_source" as const,
      waterSourceId: w.source.id,
      testDate: "2026-09-20",
      laboratory: "Labkesda Cianjur",
      certificateAttachmentId: cert.id,
    };
    // Tidak lulus tanpa tindakan → ditolak.
    await expect(
      recordQualityTest(finance(), { ...base, results: [{ parameter: "E. coli", value: "3", unit: "CFU/100 mL", limit: "0", passed: false }], passed: false }),
    ).rejects.toThrow(/tindakan, penanggung jawab, dan tenggat/);
    // "Lulus" tetapi ada parameter tidak lulus → ditolak.
    await expect(
      recordQualityTest(finance(), { ...base, results: [{ parameter: "E. coli", value: "3", passed: false }], passed: true }),
    ).rejects.toThrow(/harus "tidak lulus"/);
    const failed = await recordQualityTest(finance(), {
      ...base,
      results: [
        { parameter: "E. coli", value: "3", unit: "CFU/100 mL", limit: "0", passed: false },
        { parameter: "pH", value: "7,1", limit: "6,5–8,5", passed: true },
      ],
      passed: false,
      action: { description: "Klorinasi tandon & uji ulang dalam 7 hari", ownerEmployeeId: keuanganEmployee(), dueDate: "2026-09-27" },
    });
    expect(failed).toMatchObject({ passed: false, actionRequired: expect.stringMatching(/Klorinasi/), actionDueDate: "2026-09-27", certificateAttachmentId: cert.id });
    const [att] = await t.db.select().from(attachments).where(eq(attachments.id, cert.id));
    expect(att).toMatchObject({ objectType: "quality_test", objectId: failed.id });
    const notes = await w.notificationsFor("quality_test.failed", failed.id);
    expect(notes.map((n) => n.recipientUserId)).toContain(userIdByUsername("pemilik"));
    // Jadwal berikutnya = tanggal uji + frekuensi.
    const [s] = await t.db.select().from(qualityTestSchedules).where(eq(qualityTestSchedules.id, sched.id));
    expect(s!.nextDueDate).toBe("2026-12-19");
    // Tindakan ditandai selesai (berjejak).
    await expect(completeQualityAction(dispatcher(), { qualityTestId: failed.id, note: "Sudah diklorinasi" })).rejects.toThrow();
    const done = await completeQualityAction(finance(), { qualityTestId: failed.id, note: "Tandon diklorinasi 22 Sep; uji ulang lulus" });
    expect(done.actionDoneAt).toBeTruthy();
    expect(done.actionDoneBy).toBe(userIdByUsername("keuangan1"));
  });

  it("US-M8-06 KP-2 operator produksi mencatat hasil uji sumbernya dari aplikasi (foto sertifikat wajib, offline)", async () => {
    const w = await productionWorld(t.db);
    const payload = {
      qualityTestId: newId(),
      testDate: w.date,
      laboratory: "Lab Air Sukabumi",
      results: [{ parameter: "TDS", value: "120", unit: "mg/L", limit: "500", passed: true }],
      passed: true,
    };
    const noCert = await w.send("m8.quality_test.create", payload, { at: w.at("14:00") });
    expect(noCert.status).toBe("rejected");
    const ok = await w.send("m8.quality_test.create", { ...payload, qualityTestId: newId() }, { at: w.at("14:05"), attach: [{ kind: "quality_certificate" }] });
    expect(ok.status).toBe("applied");
    const [row] = await t.db.select().from(qualityTests).where(eq(qualityTests.id, ok.objectId!));
    expect(row).toMatchObject({ waterSourceId: w.source.id, locationType: "water_source", passed: true });
  });

  it("US-M8-06 KP-3 riwayat per lokasi untuk audit & prospektus kemitraan + ekspor", async () => {
    const w = await productionWorld(t.db);
    const cert = await withTx((tx) => put(tx, finance(), { blob: PDF, contentType: "application/pdf", kind: "quality_certificate" }));
    const cert2 = await withTx((tx) => put(tx, finance(), { blob: PDF, contentType: "application/pdf", kind: "quality_certificate" }));
    await recordQualityTest(finance(), { locationType: "water_source", waterSourceId: w.source.id, testDate: "2026-06-01", laboratory: "Labkesda", results: [{ parameter: "pH", value: "7", passed: true }], passed: true, certificateAttachmentId: cert.id });
    await recordQualityTest(finance(), { locationType: "water_source", waterSourceId: w.source.id, testDate: "2026-09-01", laboratory: "Labkesda", results: [{ parameter: "pH", value: "7,2", passed: true }], passed: true, certificateAttachmentId: cert2.id });
    const hist = await qualityOverview(owner(), { locationId: w.source.id });
    expect(hist.tests.map((x) => x.testDate)).toEqual(["2026-09-01", "2026-06-01"]);
    expect(hist.tests.every((x) => x.locationName === w.source.name)).toBe(true);
    const exp = await exportReport(owner(), "m8.quality_tests", "xlsx", { locationId: w.source.id });
    expect(exp.rowCount).toBe(2);
  });
});
