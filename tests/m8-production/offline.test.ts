import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { devices, meterReadings, tankLevelReadings, truckFills, waterBalances } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate, wibToUtc } from "@/lib/time";
import * as params from "@/server/core/params";

import type { M8Today } from "@/client/m8-production/contract";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { productionWorld } from "./helpers";

describe("M8 — bekerja tanpa sinyal di sumber air (US-M8-07)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M8-07 KP-1 meter, pengisian, tandon & investigasi susut dicatat offline sehari penuh; jadwal rit hari ini diunduh saat login", async () => {
    const w = await productionWorld(t.db, { date: "2026-09-14", capacityL: 40_000 });
    const tripA = await w.addTrip();
    const tripB = await w.addTrip();
    // Login PIN pukul 05.00 saat masih ada sinyal: data referensi hari ini diunduh (meter, truk terjadwal + rit disarankan).
    const ref = await w.today(w.at("05:01"));
    expect(ref.source?.id).toBe(w.source.id);
    expect(ref.meters.map((m) => m.id)).toEqual([w.meter.id]);
    const truck = ref.trucks.find((x) => x.id === w.truck.id)!;
    expect(truck).toMatchObject({ planned: true, nextTripId: tripA.id });
    expect(truck.trips.map((x) => x.id)).toEqual([tripA.id, tripB.id]);
    expect(ref.rules.standardVolumeL).toBe((await params.get(t.db, "PAR-15", w.date)).liters);

    // Sepanjang hari tanpa sinyal: semua aksi masuk antrean dengan waktu perangkat hari itu, terkirim esok pagi.
    const sendAt = wibToUtc(addDays(w.date, 1), "07:00");
    const morningId = newId();
    const eveningId = newId();
    const fillA = newId();
    const fillB = newId();
    const tankId = newId();
    const queued: { type: string; payload: unknown; at: string; photo?: string }[] = [
      { type: "m8.meter_reading.create", payload: { readingId: morningId, waterMeterId: w.meter.id, phase: "morning", readingL: 1_000_000 }, at: "06:10", photo: "meter_photo" },
      { type: "m8.truck_fill.create", payload: { fillId: fillA, truckId: w.truck.id, tripId: tripA.id, volumeL: 5_000 }, at: "07:15" },
      { type: "m8.truck_fill.create", payload: { fillId: fillB, truckId: w.truck.id, tripId: tripB.id, volumeL: 5_000 }, at: "10:40", photo: "truck_fill_photo" },
      { type: "m8.tank_level.create", payload: { tankLevelId: tankId, levelPct: 70, notes: "Tandon utama" }, at: "15:00" },
      { type: "m8.meter_reading.create", payload: { readingId: eveningId, waterMeterId: w.meter.id, phase: "evening", readingL: 1_012_000 }, at: "21:30", photo: "meter_photo" },
    ];
    const cmds = [];
    for (const q of queued) {
      const id = newId();
      const deviceTime = w.at(q.at);
      const up = q.photo ? await w.upload(q.photo, { commandId: id, capturedAt: deviceTime, now: sendAt }) : null;
      cmds.push(w.hp.command(w.op, q.type, q.payload, { id, deviceTime, attachmentIds: up ? [up.attachmentId] : [], attachmentHashes: up ? [up.sha256] : [] }));
    }
    const res = await w.hp.push(cmds, { now: sendAt });
    expect(res.results.map((r) => `${r.status}${r.message ? `:${r.message}` : ""}`)).toEqual(Array(cmds.length).fill("applied"));
    expect(res.results.every((r) => r.lateSync)).toBe(true);

    // Data tercatat pada tanggal & waktu perangkat (bukan waktu kirim), ditandai terlambat sinkron.
    const [morning] = await t.db.select().from(meterReadings).where(eq(meterReadings.id, morningId));
    expect(morning).toMatchObject({ businessDate: w.date, phase: "morning", lateSync: true, lateReason: null });
    expect(morning!.readAt.toISOString()).toBe(w.at("06:10").toISOString());
    const fills = await t.db.select().from(truckFills).where(eq(truckFills.waterSourceId, w.source.id));
    expect(fills.map((f) => [f.tripId, f.businessDate, f.status])).toEqual(
      expect.arrayContaining([
        [tripA.id, w.date, "linked"],
        [tripB.id, w.date, "linked"],
      ]),
    );
    expect((await t.db.select().from(tankLevelReadings).where(eq(tankLevelReadings.id, tankId)))[0]).toMatchObject({ businessDate: w.date, levelPct: 70 });
    // Neraca terbentuk otomatis setelah pembacaan malam: 12.000 − 10.000 = 2.000 L (16,7%) → investigasi.
    const bal = await w.balance();
    expect(bal).toMatchObject({ producedL: 12_000, filledTotalL: 10_000, lossL: 2_000, status: "over_threshold" });

    // Investigasi susut juga dapat dikirim offline (dengan foto) dari antrean.
    const inv = await w.send(
      "m8.loss_investigation.submit",
      { waterBalanceId: bal!.id, reason: "washing_disposal", note: "Pencucian tandon pukul 14.00" },
      { at: wibToUtc(addDays(w.date, 1), "06:00"), now: wibToUtc(addDays(w.date, 1), "09:00"), attach: [{ kind: "loss_investigation_photo" }] },
    );
    expect(inv.status).toBe("applied");
    expect((await t.db.select().from(waterBalances).where(eq(waterBalances.id, bal!.id)))[0]!.status).toBe("investigating");
  });

  it("US-M8-07 KP-1 data referensi diperbarui di latar: tanpa perubahan → tidak dikirim ulang (hemat kuota); rit baru dari kantor → ikut terunduh", async () => {
    // Kursor pull = jam server sungguhan → dunia uji memakai tanggal hari ini (WIB).
    const today = toBusinessDate(new Date());
    const w = await productionWorld(t.db, { date: today, loginAt: "00:00" });
    const first = await w.addTrip();
    const op = await w.hp.login(w.operator.userId, { now: new Date() });
    const p1 = await w.hp.pull(op, { keys: "m8.today" }, { now: new Date() });
    const ref1 = p1.data["m8.today"] as M8Today;
    expect(ref1.trucks.find((x) => x.id === w.truck.id)?.trips.map((x) => x.id)).toEqual([first.id]);
    const p2 = await w.hp.pull(op, { keys: "m8.today", since: p1.cursor }, { now: new Date() });
    expect(p2.data["m8.today"]).toBeUndefined();
    const second = await w.addTrip();
    const p3 = await w.hp.pull(op, { keys: "m8.today", since: p2.cursor }, { now: new Date() });
    const ref3 = p3.data["m8.today"] as M8Today;
    expect(ref3.trucks.find((x) => x.id === w.truck.id)?.trips.map((x) => x.id)).toEqual([first.id, second.id]);
  });

  it("US-M8-07 KP-1 ponsel tanpa sumber air / operator di luar lingkup → aplikasi menampilkan alasan, bukan data sumber lain", async () => {
    const w = await productionWorld(t.db);
    const other = await productionWorld(t.db);
    // Ponsel dilepas dari sumber air → tidak ada data; ponsel dipindah ke sumber di luar lingkup operator → tetap tidak ada data.
    await t.db.update(devices).set({ waterSourceId: null }).where(eq(devices.id, w.deviceId));
    const ref = await w.today(w.at("06:00"));
    expect(ref.source).toBeNull();
    expect(ref.blockedReason).toMatch(/belum terdaftar untuk sumber air/);
    expect(ref.meters).toEqual([]);
    await t.db.update(devices).set({ waterSourceId: other.source.id }).where(eq(devices.id, w.deviceId));
    const ref2 = await w.today(w.at("06:05"));
    expect(ref2.source).toBeNull();
    expect(ref2.blockedReason).toMatch(/tidak ditugaskan/);
  });

  it("US-M8-07 KP-2 kirim ulang tidak menggandakan (idempoten per perintah & per ID data); foto mengikuti PAR-38; sesi PIN wajib", async () => {
    const w = await productionWorld(t.db);
    const fillId = newId();
    const payload = { fillId, truckId: w.truck.id, tripId: null, volumeL: 5_000 };
    const cmd = w.hp.command(w.op, "m8.truck_fill.create", payload, { deviceTime: w.at("08:00") });
    const first = await w.hp.push([cmd], { now: w.at("08:01") });
    const again = await w.hp.push([cmd], { now: w.at("08:05") });
    expect(first.results[0]!.status).toBe("applied");
    expect(again.results[0]).toMatchObject({ status: "duplicate", originalStatus: "applied", objectId: fillId });
    // Perintah BARU dengan ID pengisian sama (antrean dipulihkan) → tidak membuat baris kedua.
    const restored = await w.hp.push([w.hp.command(w.op, "m8.truck_fill.create", payload, { deviceTime: w.at("08:00") })], { now: w.at("08:10") });
    expect(["applied", "duplicate"]).toContain(restored.results[0]!.status);
    expect(await t.db.select().from(truckFills).where(eq(truckFills.id, fillId))).toHaveLength(1);

    // Batas ukuran foto aplikasi = PAR-38 (kompresi kamera aplikasi).
    const ref = await w.today();
    expect(ref.rules.maxPhotoKb).toBe((await params.get(t.db, "PAR-38", w.date)).max_kb);

    // Tanpa tanda tangan sesi PIN → tidak diterapkan (klien diminta login PIN saat ada sinyal).
    const unsigned = await w.hp.push([w.hp.command(w.op, "m8.truck_fill.create", { ...payload, fillId: newId() }, { deviceTime: w.at("09:00"), unsigned: true })], { now: w.at("09:01") });
    expect(unsigned.results[0]!.status).not.toBe("applied");
    // Perangkat diblokir → ditolak.
    await t.db.update(devices).set({ status: "blocked" }).where(eq(devices.id, w.deviceId));
    await expect(w.hp.auth({ now: w.at("09:30") })).rejects.toThrow();
  });
});
