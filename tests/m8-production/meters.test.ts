import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, dailyProductions, meterAdjustments, meterReadings, waterMeters } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";
import { correctMeterReading, recordMeterReplacement, recordMeterRollover, runReadingCheck, verifyProduction } from "@/server/modules/m8-production";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { finance, JPEG, owner, productionWorld, seedProductionHistory, sysadmin } from "./helpers";

describe("M8 — pembacaan meter & produksi harian (US-M8-01)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-01 KP-1 pagi (awal) + malam (akhir) per meter dengan foto & waktu perangkat → produksi = Σ (akhir − awal) per sumber", async () => {
    const w = await productionWorld(t.db);
    const [m2] = await t.db.insert(waterMeters).values({ waterSourceId: w.source.id, code: `${w.meter.code}-B`, initialReadingL: 500_000, installedAt: "2025-01-01" }).returning();
    expect((await w.reading("morning", 1_000_500)).status).toBe("applied");
    expect((await w.reading("morning", 500_100, { meterId: m2!.id })).status).toBe("applied");
    expect((await w.reading("evening", 1_030_500)).status).toBe("applied");
    const last = await w.reading("evening", 510_100, { meterId: m2!.id });
    expect(last.status).toBe("applied");

    const prod = await w.production();
    expect(prod?.status).toBe("complete");
    expect(prod?.producedL).toBe(30_000 + 10_000);
    const [row] = await t.db.select().from(meterReadings).where(eq(meterReadings.id, last.objectId!));
    expect(row!.photoAttachmentId).toBeTruthy();
    expect(row!.readAt.toISOString()).toBe(w.at("21:30").toISOString());
    expect(row!.deviceId).toBe(w.deviceId);
    // Neraca dihitung otomatis setelah pembacaan malam (US-M8-04 KP-1).
    expect((await w.balance())?.producedL).toBe(40_000);
  });

  it("US-M8-01 KP-1 foto meter wajib (kamera aplikasi) — tanpa foto ditolak", async () => {
    const w = await productionWorld(t.db);
    const res = await w.reading("morning", 1_000_100, { noPhoto: true });
    expect(res.status).toBe("rejected");
    expect(res.message).toMatch(/Foto meter wajib/);
  });

  it("US-M8-01 KP-2 angka lebih kecil dari pembacaan sebelumnya ditolak dengan pesan tindakan", async () => {
    const w = await productionWorld(t.db);
    await w.reading("morning", 1_000_500);
    const res = await w.reading("evening", 1_000_400);
    expect(res.status).toBe("rejected");
    expect(res.message).toMatch(/lebih kecil dari pembacaan sebelumnya/);
    expect(res.message).toMatch(/admin sistem\/Admin Keuangan/);
    // Di bawah angka awal cut-over (belum ada pembacaan) juga ditolak.
    const w2 = await productionWorld(t.db, { initialReadingL: 2_000_000 });
    expect((await w2.reading("morning", 1_999_999)).status).toBe("rejected");
  });

  it("US-M8-01 KP-2 putaran meter dicatat admin sistem/Admin Keuangan beralasan → angka kecil diterima & produksi tetap benar", async () => {
    const w = await productionWorld(t.db, { initialReadingL: 99_990_000 });
    await w.reading("morning", 99_995_000);
    // Hanya admin sistem / Admin Keuangan (m1.water_meter.update) — pemilik ditolak.
    await expect(recordMeterRollover(owner(), { meterId: w.meter.id, rolloverAtL: 100_000_000, reason: "Meter kembali ke nol" })).rejects.toThrow(/tidak diizinkan/);
    await expect(recordMeterRollover(sysadmin(w.at("20:00")), { meterId: w.meter.id, rolloverAtL: 99_000_000, reason: "Meter kembali ke nol" })).rejects.toThrow(/lebih besar dari pembacaan terakhir/);
    const adj = await recordMeterRollover(sysadmin(w.at("20:00")), { meterId: w.meter.id, rolloverAtL: 100_000_000, reason: "Angka meter berputar kembali ke nol (6 digit m³)", businessDate: w.date });
    expect(adj.kind).toBe("rollover");
    const res = await w.reading("evening", 12_000);
    expect(res.status).toBe("applied");
    const prod = await w.production();
    expect(prod?.producedL).toBe(100_000_000 - 99_995_000 + 12_000);
    const [reading] = await t.db.select().from(meterReadings).where(eq(meterReadings.id, res.objectId!));
    expect(reading!.adjustmentKind).toBe("rollover");
    const [applied] = await t.db.select().from(meterAdjustments).where(eq(meterAdjustments.id, adj.id));
    expect(applied!.appliedReadingId).toBe(res.objectId);
    const audit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "meter_adjustment"), eq(auditLogs.objectId, adj.id)));
    expect(audit[0]!.reason).toMatch(/berputar/);
  });

  it("US-M8-01 KP-2 penggantian meter: meter lama ditutup, meter baru angka awal, produksi hari itu diestimasi rata-rata 7 hari & ditandai (7.8.6)", async () => {
    const w = await productionWorld(t.db);
    await seedProductionHistory(t.db, w.source.id, w.date, 35_000);
    await w.reading("morning", 1_000_500);
    const { newMeter } = await recordMeterReplacement(finance(w.at("11:00")), {
      meterId: w.meter.id,
      finalReadingL: 1_010_000,
      newMeterCode: `${w.meter.code}-BARU`,
      newInitialReadingL: 0,
      businessDate: w.date,
      reason: "Meter rusak (jarum macet), diganti unit baru",
    });
    const [old] = await t.db.select().from(waterMeters).where(eq(waterMeters.id, w.meter.id));
    expect(old!.status).toBe("replaced");
    expect(old!.finalReadingL).toBe(1_010_000);
    expect(old!.replacedByMeterId).toBe(newMeter.id);
    const prod = await w.production();
    expect(prod?.status).toBe("estimated");
    expect(prod?.producedL).toBe(35_000);
    // Meter lama tidak menerima pembacaan lagi; meter baru dipakai sesudahnya.
    expect((await w.reading("evening", 1_020_000)).status).toBe("rejected");
    expect((await w.reading("evening", 20_000, { meterId: newMeter.id })).status).toBe("applied");
  });

  it("US-M8-01 KP-3 pembacaan belum ada pada 08.00 → pengingat operator + notifikasi pemilik, produksi Belum lengkap; terlambat wajib alasan", async () => {
    const w = await productionWorld(t.db, { date: "2026-09-22" });
    const res = await runReadingCheck(w.at("08:05"), "morning");
    expect(res.missing.some((m) => m.sourceId === w.source.id)).toBe(true);
    const reminders = await w.notificationsFor("production.reading_reminder", w.source.id);
    expect(reminders.map((n) => n.recipientUserId)).toContain(w.operator.userId);
    const ownerNotes = await w.notificationsFor("production.missing_or_negative", w.source.id);
    expect(ownerNotes.length).toBeGreaterThan(0);
    expect((await w.production())?.status).toBe("incomplete");
    // Job diulang: tidak menggandakan notifikasi.
    await runReadingCheck(w.at("08:30"), "morning");
    expect((await w.notificationsFor("production.reading_reminder", w.source.id)).length).toBe(reminders.length);

    const late = await w.reading("morning", 1_000_500, { at: w.at("09:10") });
    expect(late.status).toBe("rejected");
    expect(late.message).toMatch(/setelah 08\.00 — isi alasan/);
    const ok = await w.reading("morning", 1_000_500, { at: w.at("09:12"), lateReason: "Operator terlambat karena hujan deras" });
    expect(ok.status).toBe("applied");
    await w.reading("evening", 1_040_000, { at: w.at("22:30") });
    const prod = await w.production();
    expect(prod?.status).toBe("complete");
    expect(prod?.incompleteReason).toMatch(/Dilengkapi terlambat/);
  });

  it("US-M8-01 KP-3 cek malam 23.00: malam belum dicatat → neraca hari itu terbentuk sebagai belum lengkap", async () => {
    const w = await productionWorld(t.db, { date: "2026-09-23" });
    await w.reading("morning", 1_000_000);
    await w.fill({ volumeL: 5_000, volumeReason: undefined });
    await runReadingCheck(w.at("23:05"), "evening");
    const bal = await w.balance();
    expect(bal?.isIncomplete).toBe(true);
    expect(bal?.status).toBe("formed");
    expect(bal?.filledTotalL).toBe(5_000);
    expect((await w.notificationsFor("production.reading_reminder", w.source.id)).length).toBeGreaterThan(0);
  });

  it("US-M8-01 KP-4 produksi menyimpang > PAR-68 dari rata-rata 7 hari → ditandai verifikasi; Admin Keuangan memverifikasi", async () => {
    const w = await productionWorld(t.db);
    await seedProductionHistory(t.db, w.source.id, w.date, 30_000);
    await w.reading("morning", 1_000_000);
    await w.reading("evening", 1_045_000); // 45.000 L = +50%
    const prod = await w.production();
    expect(prod?.flaggedForVerification).toBe(true);
    expect(prod?.deviationPct).toBe(50);
    const flagged = await t.db.select().from(meterReadings).where(and(eq(meterReadings.waterSourceId, w.source.id), eq(meterReadings.status, "flagged")));
    expect(flagged).toHaveLength(2);
    expect((await w.notificationsFor("production.deviation", prod!.id)).length).toBeGreaterThan(0);
    await expect(verifyProduction(owner(), { productionId: prod!.id, note: "Foto sudah sesuai" })).rejects.toThrow();
    const after = await verifyProduction(finance(), { productionId: prod!.id, note: "Foto pagi & malam cocok dengan angka; pompa baru dipasang" });
    expect(after.flaggedForVerification).toBe(false);
    expect(after.verifiedBy).toBeTruthy();
    const verified = await t.db.select().from(meterReadings).where(and(eq(meterReadings.waterSourceId, w.source.id), eq(meterReadings.status, "verified")));
    expect(verified).toHaveLength(2);
  });

  it("US-M8-01 KP-4 produksi dalam batas PAR-68 tidak ditandai", async () => {
    const w = await productionWorld(t.db);
    await seedProductionHistory(t.db, w.source.id, w.date, 30_000);
    await w.reading("morning", 1_000_000);
    await w.reading("evening", 1_033_000); // +10%
    expect((await w.production())?.flaggedForVerification).toBe(false);
  });

  it("US-M8-01 KP-5 pembacaan tersinkron tidak dapat diubah operator; koreksi Admin Keuangan beralasan + foto pembanding (baris baru)", async () => {
    const w = await productionWorld(t.db);
    const first = await w.reading("morning", 1_000_500);
    await w.reading("evening", 1_040_500);
    // Operator mencoba mencatat ulang pagi (ID lain) → ditolak SOD-05; ID sama isi beda → ditolak juga.
    const again = await w.reading("morning", 1_000_900);
    expect(again.status).toBe("rejected");
    expect(again.message).toMatch(/terkunci; koreksi hanya oleh Admin Keuangan/);
    const sameId = await w.reading("morning", 1_000_900, { readingId: first.objectId! });
    expect(sameId.status).toBe("rejected");
    // Kirim ulang perintah identik (ID sama, isi sama) → idempoten.
    const dup = await w.reading("morning", 1_000_500, { readingId: first.objectId! });
    expect(dup.status).toBe("applied");
    expect((dup.result as { duplicate?: boolean } | undefined)?.duplicate).toBe(true);

    const photo = await withTx((tx) => put(tx, finance(), { blob: JPEG, contentType: "image/jpeg", kind: "meter_photo" }));
    await expect(correctMeterReading(finance(), { readingId: first.objectId!, readingL: 1_001_500, reason: "Salah baca", photoAttachmentId: photo.id }, {})).resolves.toBeTruthy();
    const rows = await t.db.select().from(meterReadings).where(and(eq(meterReadings.waterMeterId, w.meter.id), eq(meterReadings.phase, "morning")));
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.id === first.objectId)!;
    const fix = rows.find((r) => r.id !== first.objectId)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededById).toBe(fix.id);
    expect(old.readingL).toBe(1_000_500);
    expect(fix.readingL).toBe(1_001_500);
    expect(fix.photoAttachmentId).toBe(photo.id);
    expect(fix.correctionReason).toBe("Salah baca");
    expect((await w.production())?.producedL).toBe(39_000);
    // Koreksi kedua atas baris lama ditolak; pengoreksi bukan pencatat (SOD-01) terjaga.
    await expect(correctMeterReading(finance(), { readingId: first.objectId!, readingL: 1_001_000, reason: "Ulang", photoAttachmentId: photo.id })).rejects.toThrow(/sudah dikoreksi/);
    // Tanpa foto pembanding ditolak.
    await expect(correctMeterReading(finance(), { readingId: fix.id, readingL: 1_001_100, reason: "Tanpa foto" } as never)).rejects.toThrow(/Foto pembanding/);
  });

  it("7.8.6 pembacaan malam terlewat → pembacaan pagi berikutnya menutup hari sebelumnya; produksi ditandai gabungan", async () => {
    const w = await productionWorld(t.db, { date: "2026-09-24" });
    await w.reading("morning", 1_000_000);
    // Tidak ada pembacaan malam; keesokan pagi (login baru di hari berikutnya).
    const next = addDays(w.date, 1);
    const op2 = await w.hp.login(w.operator.userId, { now: w.at("05:00", next) });
    const res = await w.send(
      "m8.meter_reading.create",
      { readingId: newId(), waterMeterId: w.meter.id, phase: "morning", readingL: 1_052_000 },
      { at: w.at("06:30", next), attach: [{ kind: "meter_photo" }], actor: op2 },
    );
    expect(res.status).toBe("applied");
    const prev = await w.production(w.date);
    expect(prev?.status).toBe("combined");
    expect(prev?.producedL).toBe(52_000);
    expect(prev?.incompleteReason).toMatch(/gabungan/i);
    expect((await w.balance(w.date))?.producedL).toBe(52_000);
  });

  it("US-M8-07 KP-2 pembacaan dari perangkat lapangan idempoten per perintah (kirim ulang tidak menggandakan)", async () => {
    const w = await productionWorld(t.db);
    const id = newId();
    const readingId = newId();
    const payload = { readingId, waterMeterId: w.meter.id, phase: "morning", readingL: 1_000_700 };
    const a = await w.send("m8.meter_reading.create", payload, { id, at: w.at("06:40"), attach: [{ kind: "meter_photo" }] });
    const b = await w.hp.push([w.hp.command(w.op, "m8.meter_reading.create", payload, { id, deviceTime: w.at("06:40") })], { now: w.at("06:45") });
    expect(a.status).toBe("applied");
    expect(b.results[0]!.status).toBe("duplicate");
    const rows = await t.db.select().from(meterReadings).where(and(eq(meterReadings.waterMeterId, w.meter.id), isNull(meterReadings.supersededById)));
    expect(rows).toHaveLength(1);
    const prods = await t.db.select().from(dailyProductions).where(eq(dailyProductions.waterSourceId, w.source.id));
    expect(prods.length).toBeLessThanOrEqual(1);
  });
});
