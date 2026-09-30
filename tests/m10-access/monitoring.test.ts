import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditLogs, deviceUsageLogs, devices, incidents, jobRuns, supportTickets, syncCommands } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { toBusinessDate, wibToUtc } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import { pinLogin } from "@/server/core/auth";
import { compareVersions, minSupportedVersion, processPush } from "@/server/core/sync";
import {
  acknowledgeIncident,
  answerSupportTicket,
  listIncidents,
  listSupportTickets,
  listSyncHealth,
  MONITOR_JOB_KEY,
  raiseIncident,
  remindUnansweredTickets,
  resolveIncident,
  runMonitoring,
  setMinAppVersion,
} from "@/server/modules/m10-access";
import { withTx } from "@/server/core/db";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";
import { notificationsOf } from "./helpers";

/** Jam layanan (10.00 WIB hari ini) dan di luar jam layanan (23.30 WIB). */
const today = toBusinessDate(new Date());
const IN_HOURS = wibToUtc(today, "10:00");
const OFF_HOURS = wibToUtc(today, "23:30");

describe("US-M10-07 Kesehatan perangkat, sinkron, dan pemantauan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M10-07 KP-1 halaman Perangkat & sinkron: pengguna terakhir, sinkron terakhir, antrean menurut perangkat, versi, baterai; Dispatcher hanya perangkat truk", async () => {
    const hp = await fieldDevice("HP-T3");
    const sopir = await hp.login("sopir3");
    await hp.push([], { health: { queueCount: 4, queueByUser: { [sopir.user.id]: 4 }, appVersion: "0.0.9", batteryPct: 35, lastSyncAt: new Date().toISOString() } });
    await hp.pull(sopir);
    const view = await listSyncHealth(seededContext("admin1"));
    const item = view.items.find((i) => i.id === deviceId("HP-T3"))!;
    expect(item).toMatchObject({ lastUserName: "Dede Rohmat", reportedQueueCount: 4, appVersion: "0.0.9", batteryPct: 35, belowMinVersion: true, unitKind: "truck" });
    expect(item.lastSyncAt).not.toBeNull();
    expect(item.queueByUser).toEqual([{ userId: sopir.user.id, name: "Dede Rohmat", count: 4 }]);
    expect(view.items.some((i) => i.unitKind === "outlet")).toBe(true);
    const disp = await listSyncHealth(seededContext("dispatcher1"));
    expect(disp.scope).toBe("trucks");
    expect(disp.items.every((i) => !!i.truckId)).toBe(true);
    expect((await listSyncHealth(seededContext("keuangan1"))).items.length).toBe(view.items.length);
    await expect(listSyncHealth(seededContext("depot01"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M10-07 KP-2 peringatan otomatis ke tim IT: sinkron gagal massal (> 3 perangkat > 30 menit pada jam layanan) → insiden sekali", async () => {
    const stale = new Date(IN_HOURS.getTime() - 40 * 60_000);
    const codes = ["POS-D01", "POS-D02", "POS-D03", "POS-D04"];
    await t.db
      .update(devices)
      .set({ status: "active", reportedQueueCount: 3, lastSyncAt: stale })
      .where(inArray(devices.id, codes.map((c) => deviceId(c))));
    const openMass = async () =>
      t.db.select().from(incidents).where(and(eq(incidents.kind, "mass_sync_failure"), inArray(incidents.status, ["open", "acknowledged"])));
    await runMonitoring(OFF_HOURS);
    expect(await openMass()).toHaveLength(0);
    const [res] = await runMonitoring(IN_HOURS);
    expect(res!.massSyncFailure.failing).toBeGreaterThanOrEqual(4);
    await runMonitoring(new Date(IN_HOURS.getTime() + 5 * 60_000));
    const rows = await openMass();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("critical");
    expect((await notificationsOf(t.db, "admin1", "sync.mass_failure")).length).toBe(1);
    expect((await notificationsOf(t.db, "admin1", "incident.opened")).some((n) => n.objectId === rows[0]!.id)).toBe(true);
  });

  it("US-M10-07 KP-2 B-42 layanan tidak dapat diakses (jeda denyut pemantauan) tercatat sebagai insiden; GPS mati hanya dihitung (insiden & peringatan milik M12 lewat raiseIncident, tanpa ganda)", async () => {
    await t.db.insert(jobRuns).values({ jobKey: MONITOR_JOB_KEY, runKey: "uji-denyut", status: "succeeded", startedAt: new Date(IN_HOURS.getTime() - 45 * 60_000) });
    await t.db.update(devices).set({ gpsLastPositionAt: new Date(IN_HOURS.getTime() - 20 * 60_000) }).where(eq(devices.kind, "gps"));
    await t.db.update(devices).set({ gpsLastPositionAt: new Date(IN_HOURS.getTime() - 2 * 60_000) }).where(inArray(devices.id, [deviceId("GPS-T2"), deviceId("GPS-T3")]));
    const [res] = await runMonitoring(new Date(IN_HOURS.getTime() + 60_000));
    expect(res!.serviceGap.incident).not.toBeNull();
    const down = await t.db.select().from(incidents).where(eq(incidents.kind, "service_down"));
    expect(down).toHaveLength(1);
    // 7 GPS truk aktif; T2 & T3 masih mengirim posisi → 5 dianggap mati (> PAR-25 = 15 menit tanpa sinyal).
    expect(res!.gpsDead.devices).toBe(5);
    // B-42: job M10 tidak membuat insiden/peringatan GPS mati sendiri (tidak menggandakan `gps.device_dead` M12).
    expect(res!.gpsDead.incidentsCreated).toBe(0);
    expect(await t.db.select().from(incidents).where(eq(incidents.kind, "gps_device_dead"))).toHaveLength(0);
    // M12 mencatat insiden lewat API publik M10; pemanggilan berulang tidak menggandakan insiden terbuka.
    const first = await withTx((tx) =>
      raiseIncident(tx, { tenantId: EQUA_TENANT_ID, kind: "gps_device_dead", title: "GPS T1 mati (M12)", objectType: "device", objectId: deviceId("GPS-T1") }),
    );
    expect(first.created).toBe(true);
    const again = await withTx((tx) =>
      raiseIncident(tx, { tenantId: EQUA_TENANT_ID, kind: "gps_device_dead", title: "GPS T1 mati (M12)", objectType: "device", objectId: deviceId("GPS-T1") }),
    );
    expect(again.created).toBe(false);
    await runMonitoring(new Date(IN_HOURS.getTime() + 6 * 60_000));
    expect(await t.db.select().from(incidents).where(eq(incidents.kind, "gps_device_dead"))).toHaveLength(1);
  });

  it("US-M10-07 KP-2 insiden mencatat waktu tanggap (≤ 30 menit) & pemulihan (≤ 4 jam) terhadap target NFR-31", async () => {
    const { incident } = await withTx((tx) =>
      raiseIncident(tx, { tenantId: EQUA_TENANT_ID, kind: "other", title: "Uji tanggap insiden", detectedAt: IN_HOURS, now: IN_HOURS, dedupe: false }),
    );
    await expect(acknowledgeIncident(seededContext("pemilik"), { incidentId: incident.id })).rejects.toBeInstanceOf(ForbiddenError);
    await acknowledgeIncident(seededContext("admin1", { now: new Date(IN_HOURS.getTime() + 20 * 60_000) }), { incidentId: incident.id, note: "Sedang diperiksa" });
    await resolveIncident(seededContext("admin1", { now: new Date(IN_HOURS.getTime() + 5 * 3_600_000) }), { incidentId: incident.id, resolution: "Koneksi basis data dipulihkan" });
    const list = await listIncidents(seededContext("pemilik", { now: new Date(IN_HOURS.getTime() + 6 * 3_600_000) }));
    const row = list.items.find((i) => i.id === incident.id)!;
    expect(list.targets).toEqual({ response_minutes: 30, recovery_hours: 4 });
    expect(row).toMatchObject({ status: "resolved", responseMinutes: 20, recoveryMinutes: 300, responseBreached: false, recoveryBreached: true, acknowledgedByName: "Fajar Nugraha" });
  });

  it("US-M10-07 KP-3 laporan kendala dari aplikasi lapangan: status Diterima → Dijawab → Selesai terlihat pelapor; tenggat PAR-87 dipantau (notifikasi admin sistem)", async () => {
    const hp = await fieldDevice("HP-T5");
    const sopir = await hp.login("sopir5");
    const report = hp.command(sopir, "core.support.report", { subject: "Foto bukti gagal terkirim", description: "Foto bukti kirim tidak mau terkirim sejak pagi.", appVersion: "0.1.3", syncStatus: { queue: 2 } });
    expect((await hp.push([report])).results[0]!.status).toBe("applied");
    const pull1 = await hp.pull(sopir, { keys: "m10.support_tickets" });
    const mine = pull1.data["m10.support_tickets"] as { id: string; status: string; answer: string | null }[];
    expect(mine[0]).toMatchObject({ status: "received", answer: null });

    // Belum dijawab melewati PAR-87 → admin sistem ("manajer proyek IT") diberi tahu, sekali.
    const later = new Date(Date.now() + 8 * 86_400_000);
    await remindUnansweredTickets(later);
    await remindUnansweredTickets(later);
    const reminders = (await notificationsOf(t.db, "admin1", "support.feedback_unanswered")).filter((n) => n.objectId === mine[0]!.id);
    expect(reminders).toHaveLength(1);
    expect((await listSupportTickets(seededContext("admin1", { now: later }))).find((x) => x.id === mine[0]!.id)!.overdue).toBe(true);

    await answerSupportTicket(seededContext("admin1"), { ticketId: mine[0]!.id, answer: "Perbarui aplikasi ke versi 0.1.4 lalu kirim ulang." });
    expect((await notificationsOf(t.db, "sopir5", "support.ticket_answered")).length).toBe(1);
    const pull2 = await hp.pull(sopir, { keys: "m10.support_tickets" });
    expect((pull2.data["m10.support_tickets"] as { status: string; answer: string }[])[0]).toMatchObject({ status: "answered", answer: expect.stringContaining("0.1.4") });

    const other = await hp.login("kernet5");
    const foreign = await hp.push([hp.command(other, "m10.support_ticket.close", { ticketId: mine[0]!.id })]);
    expect(foreign.results[0]!.status).toBe("rejected");
    const close = hp.command(sopir, "m10.support_ticket.close", { ticketId: mine[0]!.id });
    expect((await hp.push([close])).results[0]!.status).toBe("applied");
    expect((await hp.push([close])).results[0]!.status).toBe("duplicate");
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.id, mine[0]!.id)))[0]!.status).toBe("done");
  });

  it("US-M10-07 KP-4 versi minimal aplikasi diatur admin sistem (berjejak); perangkat di bawahnya diminta memperbarui", async () => {
    await expect(setMinAppVersion(seededContext("dispatcher1"), { version: "0.2.0", reason: "Rilis baru" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setMinAppVersion(seededContext("admin1"), { version: "v2", reason: "Rilis baru" })).rejects.toThrow(/X\.Y\.Z/);
    await setMinAppVersion(seededContext("admin1"), { version: "0.2.0", reason: "Rilis 0.2.0: perbaikan sinkron foto" });
    expect(await minSupportedVersion(new Date())).toBe("0.2.0");
    expect(compareVersions("0.1.3", "0.2.0")).toBeLessThan(0);
    await t.db.update(devices).set({ appVersion: "0.1.3" }).where(eq(devices.id, deviceId("HP-T5")));
    const view = await listSyncHealth(seededContext("admin1"));
    expect(view.minVersion).toBe("0.2.0");
    expect(view.items.find((i) => i.id === deviceId("HP-T5"))!.belowMinVersion).toBe(true);
    const trail = await t.db.select().from(auditLogs).where(and(eq(auditLogs.objectType, "parameter"), eq(auditLogs.objectId, "app.min_supported_version")));
    expect(trail.at(-1)).toMatchObject({ rule: "NFR-32", actorUserId: userIdByUsername("admin1") });
  });

  it("US-M10-07 KP-4 NFR-32 versi minimal ditegakkan SERVER: kiriman dari aplikasi lama dijawab 'perbarui aplikasi' (antrean tetap, tidak ditolak), login PIN daring ditolak, kejadian tercatat di log perangkat", async () => {
    // Versi minimal 0.2.0 dari uji sebelumnya.
    const hp = await fieldDevice("HP-T4");
    const sopir = await hp.login("sopir4");
    const old = { ...(await hp.auth()), appVersion: "0.1.3" };
    const cmd = hp.command(sopir, "core.ping", { note: "aplikasi lama" });
    const res = await processPush(old, { commands: [cmd], sentAt: new Date().toISOString() });
    expect(res.results[0]).toMatchObject({ id: cmd.id, status: "retry", code: "APP_UPDATE_REQUIRED" });
    expect(res.results[0]!.message).toMatch(/perlu diperbarui ke versi 0\.2\.0/);
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, cmd.id))).toHaveLength(0);
    const logs = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, hp.deviceId), eq(deviceUsageLogs.event, "update_required")));
    expect(logs[0]).toMatchObject({ appVersion: "0.1.3" });
    await expect(pinLogin(old, { userId: userIdByUsername("sopir4"), pin: SEED_DEMO_PIN })).rejects.toMatchObject({ code: "APP_UPDATE_REQUIRED", status: 426 });
    // Setelah diperbarui: perintah yang sama diterapkan.
    const updated = { ...(await hp.auth()), appVersion: "0.2.0" };
    expect((await processPush(updated, { commands: [cmd], sentAt: new Date().toISOString() })).results[0]!.status).toBe("applied");
  });
});
