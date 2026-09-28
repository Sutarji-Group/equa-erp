import { and, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, devices, fleetEvents, incidents, notifications, phoneTrackingFlags } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { deviceOutageReport, fleetDaySummary, getGpsDeviceHealth, listGpsDevices, runDeviceHealthCheck, setPhoneTracking } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { dwell, feed, fix, gpsTruck, POOL, SA1, wib, type GpsTruck } from "./helpers";

const DAY = "2026-09-24";
const LATER = "2026-09-26";

type Db = ReturnType<typeof useTestDb>["db"];

async function outages(db: Db, truckId: string) {
  return db.select().from(fleetEvents).where(and(eq(fleetEvents.truckId, truckId), eq(fleetEvents.deviceId, (await deviceOf(db, truckId)).id))).orderBy(fleetEvents.startedAt);
}

async function deviceOf(db: Db, truckId: string) {
  const [row] = await db.select().from(devices).where(eq(devices.truckId, truckId));
  return row!;
}

async function recipientsOf(db: Db, event: string, objectId: string) {
  const rows = await db.select().from(notifications).where(and(eq(notifications.event, event), eq(notifications.objectId, objectId)));
  return new Set(rows.map((r) => r.recipientUserId));
}

describe("M12 — peringatan perangkat GPS mati atau dicabut (US-M12-08)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  let dead: GpsTruck;
  let unplugged: GpsTruck;

  it("US-M12-08 KP-1 tanpa posisi > PAR-25 (15 menit) pada jam layanan, atau daya terputus → Mati/Dicabut; peringatan tim IT & Dispatcher; kejadian per truk; truk Perbaikan tidak dipantau", async () => {
    dead = await gpsTruck(t.db);
    await feed(t.db, dwell(dead.deviceCode, POOL, wib(DAY, "08:30"), 30));
    const fresh = await gpsTruck(t.db);
    await feed(t.db, dwell(fresh.deviceCode, POOL, wib(DAY, "08:50"), 30));
    const repair = await gpsTruck(t.db, { status: "maintenance" });
    await feed(t.db, dwell(repair.deviceCode, POOL, wib(DAY, "08:00"), 10));

    const [res] = await runDeviceHealthCheck(wib(DAY, "09:20"), t.db);
    expect(res).toMatchObject({ skipped: null, vendorOutage: false, marked: 1 });
    const [ev] = await outages(t.db, dead.truckId);
    expect(ev).toMatchObject({ kind: "device_offline", status: "detected", startedAt: wib(DAY, "09:00") });
    expect((await deviceOf(t.db, dead.truckId)).gpsState).toBe("dead");
    const to = await recipientsOf(t.db, "gps.device_dead", ev!.id);
    expect(to.has(userIdByUsername("admin1"))).toBe(true);
    expect(to.has(userIdByUsername("dispatcher1"))).toBe(true);
    const [incident] = await t.db.select().from(incidents).where(and(eq(incidents.kind, "gps_device_dead"), eq(incidents.objectId, dead.deviceId)));
    expect(incident).toMatchObject({ status: "open", tenantId: EQUA_TENANT_ID });
    expect(await outages(t.db, fresh.truckId)).toHaveLength(0);
    expect(await outages(t.db, repair.truckId)).toHaveLength(0);
    // Idempoten: job berikutnya tidak menggandakan kejadian/peringatan.
    await runDeviceHealthCheck(wib(DAY, "09:25"), t.db);
    expect(await outages(t.db, dead.truckId)).toHaveLength(1);
    // Di luar jam layanan (PAR-07) tidak dinilai.
    const [night] = await runDeviceHealthCheck(wib(DAY, "23:30"), t.db);
    expect(night!.skipped).toBe("outside_service_hours");

    // Sinyal daya terputus dari perangkat → Dicabut seketika.
    unplugged = await gpsTruck(t.db);
    await feed(t.db, [fix(unplugged.deviceCode, wib(DAY, "09:05"), SA1), fix(unplugged.deviceCode, wib(DAY, "09:10"), SA1, { powerConnected: false })]);
    const [cut] = await outages(t.db, unplugged.truckId);
    expect(cut).toMatchObject({ kind: "device_unplugged", startedAt: wib(DAY, "09:10") });
    expect((await deviceOf(t.db, unplugged.truckId)).gpsState).toBe("unplugged");
    expect((await recipientsOf(t.db, "gps.device_dead", cut!.id)).has(userIdByUsername("dispatcher1"))).toBe(true);
  });

  it("US-M12-08 KP-2 selama Mati/Dicabut GPS ponsel cadangan aktif untuk truk itu; kejadian > 2 jam sehari tampil di H+0", async () => {
    const live = await t.db.select().from(phoneTrackingFlags).where(and(eq(phoneTrackingFlags.truckId, dead.truckId), isNull(phoneTrackingFlags.endedAt)));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ reason: "device_dead" });
    const early = await fleetDaySummary(t.db, EQUA_TENANT_ID, DAY, wib(DAY, "10:30"));
    expect(early.deviceOutageThresholdMinutes).toBe(120);
    expect(early.deviceOutages.map((d) => d.truckId)).not.toContain(dead.truckId);
    const late = await fleetDaySummary(t.db, EQUA_TENANT_ID, DAY, wib(DAY, "11:30"));
    const row = late.deviceOutages.find((d) => d.truckId === dead.truckId)!;
    expect(row.minutes).toBe(150);
    expect(late.deviceOutages.map((d) => d.truckId)).toContain(unplugged.truckId);
  });

  it("US-M12-08 KP-3 perangkat aktif kembali → kejadian ditutup dengan lama mati & GPS ponsel dimatikan; pola berulang per truk dilaporkan ke pemilik", async () => {
    await feed(t.db, [fix(dead.deviceCode, wib(DAY, "11:40"), POOL)], { receivedAt: wib(DAY, "11:40") });
    const [closed] = await outages(t.db, dead.truckId);
    expect(closed).toMatchObject({ status: "done", endedAt: wib(DAY, "11:40"), durationS: 160 * 60 });
    expect((await deviceOf(t.db, dead.truckId)).gpsState).toBe("active");
    expect(await t.db.select().from(phoneTrackingFlags).where(and(eq(phoneTrackingFlags.truckId, dead.truckId), isNull(phoneTrackingFlags.endedAt)))).toHaveLength(0);
    expect((await recipientsOf(t.db, "gps.device_restored", closed!.id)).has(userIdByUsername("admin1"))).toBe(true);

    // Dicabut 3× dalam seminggu → pemilik diberi tahu sekali (indikasi pencabutan disengaja).
    const p = await gpsTruck(t.db);
    const cycle = async (start: string, restore: string) => {
      await feed(t.db, [fix(p.deviceCode, wib(DAY, start), SA1, { powerConnected: false })]);
      await feed(t.db, [fix(p.deviceCode, wib(DAY, restore), SA1, { powerConnected: true })]);
    };
    await cycle("12:00", "12:30");
    await cycle("13:00", "13:20");
    expect(await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.device_outage_pattern"), eq(notifications.objectId, p.truckId)))).toHaveLength(0);
    await cycle("14:00", "14:10");
    await cycle("15:00", "15:05");
    const pattern = await t.db.select().from(notifications).where(and(eq(notifications.event, "fleet.device_outage_pattern"), eq(notifications.objectId, p.truckId)));
    expect(pattern.map((n) => n.recipientUserId)).toEqual([userIdByUsername("pemilik")]);
    const report = await deviceOutageReport(seededContext("pemilik", { now: wib(DAY, "18:00") }), { from: DAY, to: DAY });
    expect(report.find((r) => r.truckId === p.truckId)).toMatchObject({ count: 4, unplugged: 4, totalMinutes: 30 + 20 + 10 + 5, longestMinutes: 30, pattern: true });
  });

  it("US-M12-08 KP-4 kesehatan perangkat GPS (terakhir terlihat, daya, versi, status) untuk halaman perangkat; GPS ponsel paksa hanya admin sistem (berjejak)", async () => {
    const g = await gpsTruck(t.db);
    await feed(t.db, [fix(g.deviceCode, wib(DAY, "16:00"), SA1, { firmwareVersion: "FW-3.1", batteryPct: 77, powerConnected: true })], { receivedAt: wib(DAY, "16:00") });
    const admin = seededContext("admin1", { now: wib(DAY, "16:03") });
    const health = await getGpsDeviceHealth(admin, g.deviceId);
    expect(health).toMatchObject({ deviceCode: g.deviceCode, truckCode: g.code, firmwareVersion: "FW-3.1", batteryPct: 77, powerConnected: true, gpsState: "active", lastSeenAt: wib(DAY, "16:00"), minutesSinceLastPosition: 3, stale: false, openOutage: null });
    const list = await listGpsDevices(seededContext("dispatcher1", { now: wib(DAY, "16:03") }));
    expect(list.find((d) => d.deviceId === unplugged.deviceId)).toMatchObject({ gpsState: "unplugged", openOutage: expect.objectContaining({ kind: "device_unplugged" }) });
    await expect(listGpsDevices(seededContext("keuangan1"))).rejects.toBeInstanceOf(ForbiddenError);

    await expect(setPhoneTracking(seededContext("dispatcher1"), { truckId: g.truckId, enabled: true, reason: "Uji perangkat" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setPhoneTracking(admin, { truckId: g.truckId, enabled: true, reason: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(await setPhoneTracking(admin, { truckId: g.truckId, enabled: true, reason: "Antena GPS dipindah, pantau dengan ponsel" })).toEqual({ enabled: true, changed: true });
    expect((await getGpsDeviceHealth(admin, g.deviceId)).phoneTracking).toMatchObject({ reason: "admin_forced" });
    expect(await setPhoneTracking(admin, { truckId: g.truckId, enabled: false, reason: "Antena sudah dipasang kembali" })).toEqual({ enabled: false, changed: true });
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "phone_tracking_flag"), eq(auditLogs.objectId, g.truckId)));
    expect(trail.map((a) => a.action)).toEqual(["activate", "deactivate"]);
  });

  it("7.12.6 gangguan layanan vendor (semua perangkat basi sekaligus) → hanya tim IT diberi tahu, tanpa peringatan 'perangkat mati' per truk", async () => {
    const fleet = [await gpsTruck(t.db), await gpsTruck(t.db), await gpsTruck(t.db)];
    for (const g of fleet) await feed(t.db, dwell(g.deviceCode, POOL, wib(LATER, "11:30"), 30));
    const [res] = await runDeviceHealthCheck(wib(LATER, "12:30"), t.db);
    expect(res).toMatchObject({ vendorOutage: true, marked: 0 });
    for (const g of fleet) expect(await outages(t.db, g.truckId)).toHaveLength(0);
    const vendorNotes = await t.db.select().from(notifications).where(eq(notifications.event, "gps.vendor_outage"));
    const to = new Set(vendorNotes.map((n) => n.recipientUserId));
    expect(to.has(userIdByUsername("admin1"))).toBe(true);
    expect(to.has(userIdByUsername("dispatcher1"))).toBe(false);
    // Satu truk kembali mengirim → gangguan bukan sistemik lagi → yang basi ditandai per truk.
    await feed(t.db, [fix(fleet[0]!.deviceCode, wib(LATER, "12:34"), POOL)]);
    const [after] = await runDeviceHealthCheck(wib(LATER, "12:35"), t.db);
    expect(after!.vendorOutage).toBe(false);
    expect(await outages(t.db, fleet[1]!.truckId)).toHaveLength(1);
    expect(await outages(t.db, fleet[0]!.truckId)).toHaveLength(0);
  });
});
