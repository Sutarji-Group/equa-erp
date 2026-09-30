import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessLogs, attachments, crewAssignments, crewRosters, devices, deviceUsageLogs, employees, outlets, sessions, syncCommands } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { signDeviceToken, substituteDriverConditions, type DeviceAuth, type FieldLoginResult } from "@/server/core/auth";
import { ctxBusinessDate } from "@/server/core/context";
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
import { fieldDevice, sha256Hex, signedCommand, type FieldDevice } from "../helpers/field";

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
    registerSyncHandler("test.substitute_depart", {
      permission: "m3.trip.depart",
      schema: z.object({ truckId: z.string() }),
      conditions: (ctx, payload, { tx }) => substituteDriverConditions(tx, ctx, payload.truckId, ctxBusinessDate(ctx)),
      handle: (_ctx, payload) => ({ objectType: "truck", objectId: payload.truckId }),
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

type Dev = {
  hp: FieldDevice;
  deviceId: string;
  secret: string;
  sessionId: string;
  userId: string;
  login: FieldLoginResult;
  auth: (opts?: { session?: boolean; now?: Date }) => Promise<DeviceAuth>;
};

async function setupDevice(code: string, username: string): Promise<Dev> {
  const hp = await fieldDevice(code);
  const login = await hp.login(username);
  return {
    hp,
    deviceId: hp.deviceId,
    secret: hp.secret,
    sessionId: login.sessionId,
    userId: login.user.id,
    login,
    auth: (opts = {}) => hp.auth({ sessionId: opts.session === false ? null : login.sessionId, now: opts.now }),
  };
}

/** Perintah bertanda tangan sesi pengguna perangkat `dev` (bawaan) — seperti `enqueue` klien. */
function cmd(
  owner: Dev | { userId: string; sessionId: string },
  type: string,
  payload: unknown,
  extra: Partial<{ id: string; deviceTime: string; businessDate: string; attachmentIds: string[]; attachmentHashes: string[] }> = {},
) {
  return signedCommand({ userId: owner.userId, sessionId: owner.sessionId }, type, payload, extra);
}

/** Kirim batch dengan jam kirim perangkat = sekarang (sentAt wajib). */
async function push(d: Dev, commands: unknown[], opts: { sentAt?: Date } = {}) {
  return processPush(await d.auth(), { commands, sentAt: (opts.sentAt ?? new Date()).toISOString() });
}

let dev: Dev;

describe("Sinkron push (docs/ARCHITECTURE.md §7)", () => {
  beforeAll(async () => {
    dev = await setupDevice("HP-T1", "sopir1");
  });

  it("US-M3-09 KP-2 / NFR-07 kirim perintah yang sama 2 kali → satu efek (duplicate)", async () => {
    const ping = cmd(dev, "core.ping", { note: "uji" });
    const first = await push(dev, [ping]);
    expect(first.results[0]).toMatchObject({ id: ping.id, status: "applied", objectType: "device" });
    const second = await push(dev, [ping]);
    expect(second.results[0]).toMatchObject({ id: ping.id, status: "duplicate", originalStatus: "applied" });
    expect((second.results[0]!.result as { pong: boolean }).pong).toBe(true);
    const effects = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, dev.deviceId), eq(deviceUsageLogs.event, "ping")));
    expect(effects).toHaveLength(1);
    // NFR-30: riwayat pemakaian perangkat membawa tenant perangkatnya.
    expect(effects[0]!.tenantId).toBe(EQUA_TENANT_ID);
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, ping.id))).toHaveLength(1);
  });

  it("US-M3-09 KP-2 perintah ditolak tidak menggagalkan batch (aturan bisnis, jenis tak dikenal, isian salah, izin)", async () => {
    const batch = [
      cmd(dev, "core.ping", {}),
      cmd(dev, "tidak.dikenal", {}),
      cmd(dev, "core.ping", { note: "x".repeat(300) }),
      cmd(dev, "test.business_rule", {}),
      cmd(dev, "test.owner_only", {}),
      { id: "bukan-uuid", type: "core.ping" },
      cmd(dev, "core.ping", {}),
    ];
    const res = await push(dev, batch);
    expect(res.results.map((r) => r.status)).toEqual(["applied", "rejected", "rejected", "rejected", "rejected", "rejected", "applied"]);
    expect(res.results[3]!.message).toBe("Setoran hari ini sudah ditutup. Hubungi Admin Keuangan.");
    expect(res.results[4]!.message).toMatch(/tidak diizinkan/);
    // Penolakan izin dicatat di log akses (US-M10-03 KP-2).
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, dev.userId), eq(accessLogs.event, "action_denied")));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    // Penolakan final disimpan → pengiriman ulang = duplicate (tetap ditolak), tidak diproses ulang.
    const again = await push(dev, [batch[3]]);
    expect(again.results[0]).toMatchObject({ status: "duplicate", originalStatus: "rejected" });
    const stored = await t.db.select().from(syncCommands).where(eq(syncCommands.id, (batch[3] as { id: string }).id));
    expect(stored[0]!.status).toBe("rejected");
  });

  it("NFR-07 pelanggaran unik data bisnis & larangan hapus DB → ditolak final (tidak diulang tanpa henti)", async () => {
    const clash = cmd(dev, "test.unique_clash", {});
    const del = cmd(dev, "test.forbidden_delete", {});
    const res = await push(dev, [clash, del]);
    expect(res.results[0]).toMatchObject({ status: "rejected", code: "DUPLICATE_DATA" });
    expect(res.results[1]).toMatchObject({ status: "rejected", code: "HARDENING" });
    expect(res.results[1]!.message).toMatch(/tidak boleh dihapus/);
    expect((await push(dev, [clash])).results[0]).toMatchObject({ status: "duplicate", originalStatus: "rejected" });
  });

  it("Bab 6.4 butir 3 konflik dengan perubahan kantor tetap diterapkan dan ditandai conflict", async () => {
    const c = cmd(dev, "test.conflict", { tripId: "rit-1" });
    const res = await push(dev, [c]);
    expect(res.results[0]).toMatchObject({ status: "conflict", objectType: "trip", objectId: "rit-1" });
    const [row] = await t.db.select().from(syncCommands).where(eq(syncCommands.id, c.id));
    expect(row!.status).toBe("conflict");
  });

  it("PAR-42 selisih jam perangkat > 10 menit ditandai (clock_skew_ms)", async () => {
    const skewed = cmd(dev, "core.ping", {});
    const now = new Date();
    const res = await push(dev, [skewed], { sentAt: new Date(now.getTime() + 15 * 60_000) });
    expect(res.results[0]).toMatchObject({ status: "applied", clockSkewFlagged: true });
    const [row] = await t.db.select().from(syncCommands).where(eq(syncCommands.id, skewed.id));
    expect(row!.clockSkewMs).toBeGreaterThan(14 * 60_000);
    const fine = cmd(dev, "core.ping", {});
    const ok = await push(dev, [fine], { sentAt: new Date(now.getTime() + 5 * 60_000) });
    expect(ok.results[0]).toMatchObject({ status: "applied", clockSkewFlagged: false });
    // Waktu perangkat di masa depan juga ditandai.
    const future = cmd(dev, "core.ping", {}, { deviceTime: new Date(now.getTime() + 30 * 60_000).toISOString() });
    expect((await push(dev, [future])).results[0]!.clockSkewFlagged).toBe(true);
    // sentAt wajib (dasar selisih jam) — kiriman tanpa sentAt ditolak utuh.
    await expect(processPush(await dev.auth(), { commands: [cmd(dev, "core.ping", {})] })).rejects.toMatchObject({ status: 400 });
  });

  it("US-M3-09 KP-4 perintah pengguna lain di perangkat yang sama: tanpa sesi → retry (antrean tidak hilang); setelah login → diterapkan", async () => {
    const kernetId = userIdByUsername("kernet1");
    // Klien lama / pengguna belum login daring: perintah tanpa sesi & tanda tangan → retry.
    const unsigned = signedCommand({ userId: kernetId, sessionId: newId() }, "core.ping", {}, { unsigned: true });
    const res = await push(dev, [{ ...unsigned, sessionId: null }]);
    expect(res.results[0]).toMatchObject({ status: "retry", code: "SESSION_REQUIRED" });
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, unsigned.id))).toHaveLength(0);
    // Setelah kernet login PIN daring, klien mengikat ulang antreannya ke sesi baru → diterapkan.
    const kernet = await dev.hp.login("kernet1");
    const again = await push(dev, [signedCommand(kernet, "core.ping", {}, { id: unsigned.id, deviceTime: unsigned.deviceTime })]);
    expect(again.results[0]).toMatchObject({ status: "applied" });
  });

  it("US-M2-11 / Bab 6.5 perintah atas nama pengguna lain di perangkat bersama DITOLAK (sesi & tanda tangan per pengguna)", async () => {
    const sopir = dev.login;
    const kernet = await dev.hp.login("kernet1");
    // Kernet memakai sesinya sendiri tetapi mengaku sebagai sopir.
    const forgedUser = { ...signedCommand(kernet, "core.ping", { note: "palsu" }), userId: sopir.user.id };
    // Kernet memakai ID sesi sopir tetapi tidak punya kunci perintah sopir.
    const forgedSig = signedCommand(sopir, "core.ping", { note: "palsu" }, { signWithSessionId: kernet.sessionId });
    const res = await push(dev, [forgedUser, forgedSig]);
    expect(res.results.map((r) => [r.status, r.code])).toEqual([
      ["rejected", "SESSION_MISMATCH"],
      ["rejected", "SESSION_MISMATCH"],
    ]);
    // Tidak tersimpan atas nama sopir; percobaan dicatat di log akses.
    expect(await t.db.select().from(syncCommands).where(inArray(syncCommands.id, [forgedUser.id, forgedSig.id]))).toHaveLength(0);
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.deviceId, dev.deviceId), eq(accessLogs.rule, "SYNC_IDENTITY")));
    expect(denied.length).toBeGreaterThanOrEqual(2);
    // Perintah sah kernet tetap tercatat atas nama kernet.
    const own = signedCommand(kernet, "core.ping", {});
    expect((await push(dev, [own])).results[0]).toMatchObject({ status: "applied" });
    const [row] = await t.db.select().from(syncCommands).where(eq(syncCommands.id, own.id));
    expect(row!.userId).toBe(kernet.user.id);
  });

  it("US-M3-09 KP-2 perintah offline sah dalam masa sesi diterima (late_sync); dibuat setelah sesi habis → perlu login ulang", async () => {
    const hp = await fieldDevice("HP-T3");
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    const old = await hp.login("sopir3", { now: fiveDaysAgo });
    // Dicatat 4 hari lalu (dalam masa sesi 72 jam) → diterima & ditandai terlambat sinkron.
    const inWindow = signedCommand(old, "core.ping", {}, { deviceTime: new Date(Date.now() - 4 * 86_400_000) });
    // Dicatat kemarin (sesi sudah habis) → retry, klien meminta login PIN lalu mengikat ulang.
    const afterExpiry = signedCommand(old, "core.ping", {}, { deviceTime: new Date(Date.now() - 86_400_000) });
    const res = await hp.push([inWindow, afterExpiry]);
    expect(res.results[0]).toMatchObject({ status: "applied", lateSync: true, clockSkewFlagged: false });
    expect(res.results[1]).toMatchObject({ status: "retry", code: "SESSION_REQUIRED" });
    const fresh = await hp.login("sopir3");
    const rebound = signedCommand(fresh, "core.ping", {}, { id: afterExpiry.id, deviceTime: afterExpiry.deviceTime, reboundFrom: old.sessionId });
    expect((await hp.push([rebound])).results[0]).toMatchObject({ status: "applied", clockSkewFlagged: false });
    // Waktu perangkat jauh sebelum sesi asal dibuat → tetap diterima pemiliknya tetapi ditandai (jam mundur).
    const backdated = signedCommand(fresh, "core.ping", {}, { deviceTime: new Date(Date.now() - 6 * 86_400_000), reboundFrom: old.sessionId });
    expect((await hp.push([backdated])).results[0]).toMatchObject({ status: "applied", clockSkewFlagged: true });
  });

  it("Bab 5.3 tanggal bisnis wajib = tanggal WIB saat dicatat di perangkat (toleransi PAR-42 di tengah malam)", async () => {
    const wrong = cmd(dev, "core.ping", {}, { businessDate: "2026-01-02" });
    const res = await push(dev, [wrong]);
    expect(res.results[0]).toMatchObject({ status: "rejected", code: "BUSINESS_DATE_MISMATCH" });
    expect(res.results[0]!.message).toMatch(/Tanggal bisnis/);
    // 00.05 WIB tanggal 28 dengan tanggal bisnis 27 (jam ponsel sedikit cepat) → masih diterima.
    const midnight = new Date("2026-09-27T17:05:00Z");
    const edge = cmd(dev, "core.ping", {}, { deviceTime: midnight.toISOString(), businessDate: "2026-09-27" });
    const tooFar = cmd(dev, "core.ping", {}, { deviceTime: new Date("2026-09-27T17:30:00Z").toISOString(), businessDate: "2026-09-27" });
    const outcome = await push(dev, [edge, tooFar]);
    expect(outcome.results[0]).toMatchObject({ status: "applied" });
    expect(outcome.results[1]).toMatchObject({ status: "rejected", code: "BUSINESS_DATE_MISMATCH" });
  });

  it("BR-37 karyawan lewat tanggal keluar: perintah ditolak final dan semua sesinya dicabut", async () => {
    const hp = await fieldDevice("HP-T4");
    const sopir4 = await hp.login("sopir4");
    const yesterday = toBusinessDate(new Date(Date.now() - 86_400_000));
    await t.db.update(employees).set({ exitDate: yesterday }).where(eq(employees.id, sopir4.user.employeeId));
    const c = signedCommand(sopir4, "core.ping", {});
    const res = await hp.push([c]);
    expect(res.results[0]).toMatchObject({ status: "rejected", code: "USER_INACTIVE" });
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, sopir4.sessionId));
    expect(s!.revokeReason).toBe("exit_date");
    // Job harian juga mencabut sesi karyawan yang keluar.
    const hp5 = await fieldDevice("HP-T5");
    const sopir5 = await hp5.login("sopir5");
    await t.db.update(employees).set({ exitDate: toBusinessDate(new Date()) }).where(eq(employees.id, sopir5.user.employeeId));
    const { sessionHygiene } = await import("@/server/core/auth");
    const out = await sessionHygiene(new Date());
    expect(out.exited).toBeGreaterThanOrEqual(1);
    const [s5] = await t.db.select().from(sessions).where(eq(sessions.id, sopir5.sessionId));
    expect(s5!.revokedAt).not.toBeNull();
  });

  it("US-M2-11 kernet pengganti: izin bersyarat dihitung handler (conditions) → diterapkan; kernet biasa ditolak", async () => {
    const today = toBusinessDate(new Date());
    const hp = await fieldDevice("HP-T2");
    const kernet2 = await hp.login("kernet2");
    const plain = signedCommand(kernet2, "test.substitute_depart", { truckId: truckId("T2") });
    const denied = await hp.push([plain]);
    expect(denied.results[0]).toMatchObject({ status: "rejected" });
    expect(denied.results[0]!.message).toMatch(/pengemudi pengganti/);
    await t.db.insert(crewAssignments).values({
      tenantId: EQUA_TENANT_ID,
      truckId: truckId("T2"),
      businessDate: today,
      driverEmployeeId: kernet2.user.employeeId,
      source: "helper",
      reason: "Sopir 2 sakit",
    });
    const allowed = await hp.push([signedCommand(kernet2, "test.substitute_depart", { truckId: truckId("T2") })]);
    expect(allowed.results[0]).toMatchObject({ status: "applied" });
  });

  it("US-M10-02 KP-6 perangkat diblokir → kiriman berikutnya ditolak (tidak menerima data baru)", async () => {
    const other = await setupDevice("HP-T2", "sopir2");
    await t.db.update(devices).set({ status: "blocked" }).where(eq(devices.id, other.deviceId));
    await expect(other.auth()).rejects.toMatchObject({ code: "DEVICE_BLOCKED" });
    const res = await pushRoute(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { authorization: `Bearer ${await signDeviceToken(other.secret, { deviceId: other.deviceId })}` },
        body: JSON.stringify({ commands: [cmd(other, "core.ping", {})], sentAt: new Date().toISOString() }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "DEVICE_BLOCKED" });
  });

  it("route POST /api/sync/push: token perangkat wajib; respons JSON hasil per perintah", async () => {
    const unauth = await pushRoute(new Request("http://localhost/api/sync/push", { method: "POST", body: JSON.stringify({ commands: [] }) }));
    expect(unauth.status).toBe(401);
    const token = await signDeviceToken(dev.secret, { deviceId: dev.deviceId, userId: dev.userId, sessionId: dev.sessionId });
    const c = cmd(dev, "core.ping", {});
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
        body: JSON.stringify({ commands: Array.from({ length: 51 }, () => cmd(dev, "core.ping", {})), sentAt: new Date().toISOString() }),
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
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const early = cmd(dev, "test.with_photo", {}, { attachmentIds: [attachmentId], attachmentHashes: [sha256Hex(bytes)] });
    expect((await push(dev, [early])).results[0]).toMatchObject({ status: "retry", code: "ATTACHMENT_MISSING" });

    const first = await processUpload(await dev.auth(), form());
    expect(first).toMatchObject({ ok: true, attachmentId, duplicate: false, sizeBytes: 6 });
    const second = await processUpload(await dev.auth(), form());
    expect(second.duplicate).toBe(true);
    expect(await t.db.select().from(attachments).where(eq(attachments.id, attachmentId))).toHaveLength(1);

    const res = await push(dev, [early]);
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
    expect(res.params).toMatchObject({ pinLock: { maxAttempts: 5, lockMinutes: 15 }, screenLockMinutes: 10, photoMaxKb: 150, clockSkewMinutes: 10 }); // PAR-38 bawaan v1.0.1 (D-14 butir 2)
    expect(res.minVersion).toBe("0.1.0");
    expect(res.device.home).toBe("/sopir");
    // Batas bawah urutan nomor lokal perangkat (US-M6-06 KP-2).
    expect(res.deviceSeq).toMatchObject({ pos_sale: 0, purchase_receipt: 0, internal_transfer: 0 });

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

  it("US-M3-09 KP-2 lampiran milik pengguna lain / isi berbeda tidak dapat dipakai perintah (hash ikut ditandatangani)", async () => {
    const kernet = await dev.hp.login("kernet1");
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 7, 7, 7]);
    const kernetPhoto = await dev.hp.upload(kernet, { bytes });
    // Sopir merujuk foto yang diunggah atas nama kernet.
    const stolen = cmd(dev, "test.with_photo", {}, { attachmentIds: [kernetPhoto.attachmentId], attachmentHashes: [kernetPhoto.sha256] });
    // Sopir merujuk fotonya sendiri tetapi hash berbeda (isi diganti).
    const mine = await dev.hp.upload(dev.login, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 8, 8, 8]) });
    const swapped = cmd(dev, "test.with_photo", {}, { attachmentIds: [mine.attachmentId], attachmentHashes: [sha256Hex(bytes)] });
    const res = await push(dev, [stolen, swapped]);
    expect(res.results.map((r) => r.code)).toEqual(["ATTACHMENT_MISMATCH", "ATTACHMENT_MISMATCH"]);
    // Foto sendiri dengan hash benar → diterima.
    const ok = cmd(dev, "test.with_photo", {}, { attachmentIds: [mine.attachmentId], attachmentHashes: [mine.sha256] });
    expect((await push(dev, [ok])).results[0]).toMatchObject({ status: "applied" });
  });

  it("US-M3-10 KP-1 kejadian PIN offline hanya untuk pengguna yang pernah masuk di perangkat; waktu log = waktu server", async () => {
    const hp = await fieldDevice("HP-CAD-1");
    const target = userIdByUsername("kasir");
    await recordHealth(await hp.auth(), { events: [{ type: "pin_locked", userId: target, at: "2020-01-01T00:00:00Z" }] });
    expect(await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, target), eq(accessLogs.event, "pin_locked")))).toHaveLength(0);

    const sopir7 = await hp.login("sopir7");
    const before = Date.now();
    await recordHealth(await hp.auth(), { events: [{ type: "pin_failed", userId: sopir7.user.id, at: "2020-01-01T00:00:00Z" }] });
    const logs = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, sopir7.user.id), eq(accessLogs.event, "pin_failed")));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(logs[0]!.details).toMatchObject({ reportedByDevice: true, deviceTime: "2020-01-01T00:00:00Z" });
  });

  it("US-M10-07 KP-1 laporan kesehatan menyimpan antrean, versi, baterai di perangkat", async () => {
    await recordHealth(await dev.auth(), { queueCount: 4, appVersion: "0.1.0", batteryPct: 55, queueByUser: { [dev.userId]: 4 } });
    const [row] = await t.db.select().from(devices).where(eq(devices.id, dev.deviceId));
    expect(row).toMatchObject({ reportedQueueCount: 4, appVersion: "0.1.0", batteryPct: 55 });
    const logs = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, dev.deviceId), eq(deviceUsageLogs.event, "health_report")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
