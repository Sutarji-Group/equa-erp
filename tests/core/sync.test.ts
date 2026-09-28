import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessLogs, attachments, crewRosters, devices, deviceUsageLogs, employees, outlets, syncCommands } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, outletId, SEED_DEMO_PIN, truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { activateDevice, authenticateDevice, issueActivationCode, pinLogin, signDeviceToken, type DeviceAuth } from "@/server/core/auth";
import { DomainError } from "@/server/core/errors";
import { setStorageDriverForTests, type StorageDriver } from "@/server/core/storage";
import {
  processPull,
  processPush,
  processUpload,
  recordHealth,
  registerPullProvider,
  registerSyncHandler,
  type PushResult,
} from "@/server/core/sync";

import { POST as pushRoute } from "@/app/api/sync/push/route";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";

const t = withTestDb({ seed: true });

const memory = new Map<string, Buffer>();
const memoryDriver: StorageDriver = {
  name: "memory",
  async put(key, body) {
    memory.set(key, body);
    return { url: null };
  },
  async get(key) {
    return memory.get(key) ?? null;
  },
};

const cleanups: (() => void)[] = [];
const seenAttachments: string[][] = [];

beforeAll(() => {
  setStorageDriverForTests(memoryDriver);
  cleanups.push(
    registerSyncHandler("test.owner_only", {
      permission: "m10.parameter.update",
      schema: z.object({}),
      handle: () => ({}),
    }),
    registerSyncHandler("test.conflict", {
      permission: "m3.trip.depart",
      schema: z.object({ tripId: z.string() }),
      handle: (_ctx, payload) => ({ status: "conflict", message: "Rit sudah ditarik kantor; data lapangan tetap disimpan.", objectType: "trip", objectId: payload.tripId }),
    }),
    registerSyncHandler("test.business_rule", {
      permission: null,
      schema: z.object({}),
      handle: () => {
        throw new DomainError("TEST_RULE", "Setoran hari ini sudah ditutup. Hubungi Admin Keuangan.");
      },
    }),
    registerSyncHandler("test.unique_clash", {
      permission: null,
      schema: z.object({}),
      handle: async (_ctx, _p, { tx }) => {
        await tx.insert(employees).values({ tenantId: EQUA_TENANT_ID, employeeNo: "EQ-001", fullName: "Duplikat", position: "Uji" });
      },
    }),
    registerSyncHandler("test.forbidden_delete", {
      permission: null,
      schema: z.object({}),
      handle: async (_ctx, _p, { tx }) => {
        await tx.delete(outlets).where(eq(outlets.id, outletId("D01")));
      },
    }),
    registerSyncHandler("test.with_photo", {
      permission: null,
      schema: z.object({}),
      handle: (_ctx, _p, meta) => {
        seenAttachments.push(meta.attachments.map((a) => a.id));
        return { result: { photos: meta.attachments.length } };
      },
    }),
    registerPullProvider("test.scope", ({ ctx }) => ({ truckIds: ctx.scope.truckIds, businessDate: toBusinessDate(ctx.now) })),
    registerPullProvider("test.office_only", { roles: ["owner"], fetch: () => ({ rahasia: true }) }),
    registerPullProvider("test.broken", () => {
      throw new DomainError("X", "Penyedia uji gagal.");
    }),
  );
});

afterAll(() => {
  cleanups.forEach((fn) => fn());
  setStorageDriverForTests(null);
});

type Dev = { deviceId: string; secret: string; sessionId: string; userId: string; auth: (opts?: { session?: boolean; now?: Date }) => Promise<DeviceAuth> };

async function setupDevice(code: string, username: string): Promise<Dev> {
  const issued = await issueActivationCode(seededContext("admin1"), deviceId(code));
  const act = await activateDevice(issued.code);
  const mk = async (sessionId?: string, now?: Date) =>
    authenticateDevice(
      new Request("http://localhost/api/sync/push", {
        headers: { authorization: `Bearer ${await signDeviceToken(act.deviceSecret, { deviceId: act.deviceId, sessionId }, { now })}` },
      }),
      { now },
    );
  const login = await pinLogin(await mk(), { userId: userIdByUsername(username), pin: SEED_DEMO_PIN });
  return {
    deviceId: act.deviceId,
    secret: act.deviceSecret,
    sessionId: login.sessionId,
    userId: login.user.id,
    auth: (opts = {}) => mk(opts.session === false ? undefined : login.sessionId, opts.now),
  };
}

function cmd(userId: string, type: string, payload: unknown, extra: Partial<{ id: string; deviceTime: string; businessDate: string; attachmentIds: string[] }> = {}) {
  const now = new Date();
  return {
    id: extra.id ?? newId(),
    type,
    payload,
    userId,
    deviceTime: extra.deviceTime ?? now.toISOString(),
    businessDate: extra.businessDate ?? toBusinessDate(now),
    attachmentIds: extra.attachmentIds ?? [],
  };
}

let dev: Dev;

describe("Sinkron push (docs/ARCHITECTURE.md §7)", () => {
  beforeAll(async () => {
    dev = await setupDevice("HP-T1", "sopir1");
  });

  it("US-M3-09 KP-2 / NFR-07 kirim perintah yang sama 2 kali → satu efek (duplicate)", async () => {
    const ping = cmd(dev.userId, "core.ping", { note: "uji" });
    const first = await processPush(await dev.auth(), { commands: [ping], sentAt: new Date().toISOString() });
    expect(first.results[0]).toMatchObject({ id: ping.id, status: "applied", objectType: "device" });
    const second = await processPush(await dev.auth(), { commands: [ping], sentAt: new Date().toISOString() });
    expect(second.results[0]).toMatchObject({ id: ping.id, status: "duplicate", originalStatus: "applied" });
    expect((second.results[0]!.result as { pong: boolean }).pong).toBe(true);
    const effects = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, dev.deviceId), eq(deviceUsageLogs.event, "ping")));
    expect(effects).toHaveLength(1);
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, ping.id))).toHaveLength(1);
  });

  it("US-M3-09 KP-2 perintah ditolak tidak menggagalkan batch (aturan bisnis, jenis tak dikenal, isian salah, izin)", async () => {
    const batch = [
      cmd(dev.userId, "core.ping", {}),
      cmd(dev.userId, "tidak.dikenal", {}),
      cmd(dev.userId, "core.ping", { note: "x".repeat(300) }),
      cmd(dev.userId, "test.business_rule", {}),
      cmd(dev.userId, "test.owner_only", {}),
      { id: "bukan-uuid", type: "core.ping" },
      cmd(dev.userId, "core.ping", {}),
    ];
    const res = await processPush(await dev.auth(), { commands: batch });
    expect(res.results.map((r) => r.status)).toEqual(["applied", "rejected", "rejected", "rejected", "rejected", "rejected", "applied"]);
    expect(res.results[3]!.message).toBe("Setoran hari ini sudah ditutup. Hubungi Admin Keuangan.");
    expect(res.results[4]!.message).toMatch(/tidak diizinkan/);
    // Penolakan izin dicatat di log akses (US-M10-03 KP-2).
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, dev.userId), eq(accessLogs.event, "action_denied")));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    // Penolakan final disimpan → pengiriman ulang = duplicate (tetap ditolak), tidak diproses ulang.
    const again = await processPush(await dev.auth(), { commands: [batch[3]] });
    expect(again.results[0]).toMatchObject({ status: "duplicate", originalStatus: "rejected" });
    const stored = await t.db.select().from(syncCommands).where(eq(syncCommands.id, (batch[3] as { id: string }).id));
    expect(stored[0]!.status).toBe("rejected");
  });

  it("NFR-07 pelanggaran unik data bisnis & larangan hapus DB → ditolak final (tidak diulang tanpa henti)", async () => {
    const clash = cmd(dev.userId, "test.unique_clash", {});
    const del = cmd(dev.userId, "test.forbidden_delete", {});
    const res = await processPush(await dev.auth(), { commands: [clash, del] });
    expect(res.results[0]).toMatchObject({ status: "rejected", code: "DUPLICATE_DATA" });
    expect(res.results[1]).toMatchObject({ status: "rejected", code: "HARDENING" });
    expect(res.results[1]!.message).toMatch(/tidak boleh dihapus/);
    expect((await processPush(await dev.auth(), { commands: [clash] })).results[0]).toMatchObject({ status: "duplicate", originalStatus: "rejected" });
  });

  it("Bab 6.4 butir 3 konflik dengan perubahan kantor tetap diterapkan dan ditandai conflict", async () => {
    const c = cmd(dev.userId, "test.conflict", { tripId: "rit-1" });
    const res = await processPush(await dev.auth(), { commands: [c] });
    expect(res.results[0]).toMatchObject({ status: "conflict", objectType: "trip", objectId: "rit-1" });
    const [row] = await t.db.select().from(syncCommands).where(eq(syncCommands.id, c.id));
    expect(row!.status).toBe("conflict");
  });

  it("PAR-42 selisih jam perangkat > 10 menit ditandai (clock_skew_ms)", async () => {
    const skewed = cmd(dev.userId, "core.ping", {});
    const now = new Date();
    const res = await processPush(await dev.auth(), { commands: [skewed], sentAt: new Date(now.getTime() + 15 * 60_000).toISOString() });
    expect(res.results[0]).toMatchObject({ status: "applied", clockSkewFlagged: true });
    const [row] = await t.db.select().from(syncCommands).where(eq(syncCommands.id, skewed.id));
    expect(row!.clockSkewMs).toBeGreaterThan(14 * 60_000);
    const fine = cmd(dev.userId, "core.ping", {});
    const ok = await processPush(await dev.auth(), { commands: [fine], sentAt: new Date(now.getTime() + 5 * 60_000).toISOString() });
    expect(ok.results[0]).toMatchObject({ status: "applied", clockSkewFlagged: false });
    // Waktu perangkat di masa depan tanpa sentAt juga ditandai.
    const future = cmd(dev.userId, "core.ping", {}, { deviceTime: new Date(now.getTime() + 30 * 60_000).toISOString() });
    expect((await processPush(await dev.auth(), { commands: [future] })).results[0]!.clockSkewFlagged).toBe(true);
  });

  it("US-M3-09 KP-4 perintah pengguna lain di perangkat yang sama: tanpa sesi → retry (antrean tidak hilang); setelah login → diterapkan", async () => {
    const kernetId = userIdByUsername("kernet1");
    const c = cmd(kernetId, "core.ping", {});
    const res = await processPush(await dev.auth(), { commands: [c] });
    expect(res.results[0]).toMatchObject({ status: "retry", code: "SESSION_REQUIRED" });
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, c.id))).toHaveLength(0);
    await pinLogin(await dev.auth({ session: false }), { userId: kernetId, pin: SEED_DEMO_PIN });
    const again = await processPush(await dev.auth(), { commands: [c] });
    expect(again.results[0]).toMatchObject({ status: "applied" });
  });

  it("US-M10-02 KP-6 perangkat diblokir → kiriman berikutnya ditolak (tidak menerima data baru)", async () => {
    const other = await setupDevice("HP-T2", "sopir2");
    await t.db.update(devices).set({ status: "blocked" }).where(eq(devices.id, other.deviceId));
    await expect(other.auth()).rejects.toMatchObject({ code: "DEVICE_BLOCKED" });
    const res = await pushRoute(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { authorization: `Bearer ${await signDeviceToken(other.secret, { deviceId: other.deviceId })}` },
        body: JSON.stringify({ commands: [cmd(other.userId, "core.ping", {})] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "DEVICE_BLOCKED" });
  });

  it("route POST /api/sync/push: token perangkat wajib; respons JSON hasil per perintah", async () => {
    const unauth = await pushRoute(new Request("http://localhost/api/sync/push", { method: "POST", body: JSON.stringify({ commands: [] }) }));
    expect(unauth.status).toBe(401);
    const token = await signDeviceToken(dev.secret, { deviceId: dev.deviceId, userId: dev.userId, sessionId: dev.sessionId });
    const c = cmd(dev.userId, "core.ping", {});
    const res = await pushRoute(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ commands: [c], sentAt: new Date().toISOString() }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: PushResult[] };
    expect(body.ok).toBe(true);
    expect(body.results[0]).toMatchObject({ id: c.id, status: "applied" });
    const tooMany = await pushRoute(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ commands: Array.from({ length: 51 }, () => cmd(dev.userId, "core.ping", {})) }),
      }),
    );
    expect(tooMany.status).toBe(400);
  });
});

describe("Sinkron upload, pull, kesehatan", () => {
  it("unggah lampiran idempoten per attachmentId; perintah merujuk lampiran setelah terunggah", async () => {
    const attachmentId = newId();
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" });
    const form = () => {
      const f = new FormData();
      f.set("file", photo, "bukti.jpg");
      f.set("attachmentId", attachmentId);
      f.set("userId", dev.userId);
      f.set("kind", "delivery_photo");
      f.set("capturedAt", new Date().toISOString());
      return f;
    };
    // Perintah sebelum lampiran terunggah → retry (klien mengunggah dulu).
    const early = cmd(dev.userId, "test.with_photo", {}, { attachmentIds: [attachmentId] });
    expect((await processPush(await dev.auth(), { commands: [early] })).results[0]).toMatchObject({ status: "retry", code: "ATTACHMENT_MISSING" });

    const first = await processUpload(await dev.auth(), form());
    expect(first).toMatchObject({ ok: true, attachmentId, duplicate: false, sizeBytes: 6 });
    const second = await processUpload(await dev.auth(), form());
    expect(second.duplicate).toBe(true);
    expect(await t.db.select().from(attachments).where(eq(attachments.id, attachmentId))).toHaveLength(1);

    const res = await processPush(await dev.auth(), { commands: [early] });
    expect(res.results[0]).toMatchObject({ status: "applied", result: { photos: 1 } });
    expect(seenAttachments.at(-1)).toEqual([attachmentId]);

    const bad = new FormData();
    bad.set("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
    bad.set("attachmentId", newId());
    bad.set("userId", dev.userId);
    bad.set("kind", "delivery_photo");
    await expect(processUpload(await dev.auth(), bad)).rejects.toThrow(/tidak didukung/);
  });

  it("pull sesuai lingkup: data referensi per pengguna, parameter offline, versi minimal; penyedia gagal tidak menggagalkan pull", async () => {
    const res = await processPull(await dev.auth(), {});
    expect(res.data["test.scope"]).toMatchObject({ truckIds: [truckId("T1")] });
    expect(res.data["core.me"]).toMatchObject({ userId: dev.userId, roles: ["driver"], scope: { truckIds: [truckId("T1")] } });
    expect(Array.isArray(res.data["core.device_users"])).toBe(true);
    expect(res.data["test.office_only"]).toBeUndefined();
    expect(res.errors["test.broken"]).toBe("Penyedia uji gagal.");
    expect(res.params).toMatchObject({ pinLock: { maxAttempts: 5, lockMinutes: 15 }, screenLockMinutes: 10, photoMaxKb: 300, clockSkewMinutes: 10 });
    expect(res.minVersion).toBe("0.1.0");
    expect(res.device.home).toBe("/sopir");

    // Jadwal kru hari ini memindahkan sopir ke truk lain → pull mengikuti truk hari itu.
    const today = toBusinessDate(new Date());
    await t.db.insert(crewRosters).values({
      tenantId: EQUA_TENANT_ID,
      employeeId: seededContext("sopir1").employeeId!,
      businessDate: today,
      status: "on_duty",
      truckId: truckId("T3"),
      role: "driver",
    });
    const moved = await processPull(await dev.auth(), { keys: "test.scope" });
    expect(moved.data).toEqual({ "test.scope": { truckIds: [truckId("T3")], businessDate: today } });

    // Tanpa sesi → ditolak (SESSION_EXPIRED).
    await expect(processPull(await dev.auth({ session: false }), {})).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("US-M10-07 KP-1 laporan kesehatan menyimpan antrean, versi, baterai di perangkat", async () => {
    await recordHealth(await dev.auth(), { queueCount: 4, appVersion: "0.1.0", batteryPct: 55, queueByUser: { [dev.userId]: 4 } });
    const [row] = await t.db.select().from(devices).where(eq(devices.id, dev.deviceId));
    expect(row).toMatchObject({ reportedQueueCount: 4, appVersion: "0.1.0", batteryPct: 55 });
    const logs = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, dev.deviceId), eq(deviceUsageLogs.event, "health_report")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
