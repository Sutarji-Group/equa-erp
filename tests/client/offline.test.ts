import "fake-indexeddb/auto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as activateRoute } from "@/app/api/device/activate/route";
import { POST as enrollRoute } from "@/app/api/device/pin-enroll/route";
import { POST as pinLoginRoute } from "@/app/api/device/pin-login/route";
import { GET as usersRoute } from "@/app/api/device/users/route";
import { GET as pullRoute } from "@/app/api/sync/pull/route";
import { POST as pushRoute } from "@/app/api/sync/push/route";
import { POST as uploadRoute } from "@/app/api/sync/upload/route";
import {
  activateWithCode,
  enqueue,
  FieldApiError,
  fieldDb,
  getActiveUserId,
  knownUsers,
  listOutbox,
  loadDevice,
  lockScreen,
  loginWithPin,
  pendingCount,
  refreshDeviceUsers,
  switchUser,
  syncNow,
  unlockScreen,
  verifyPinOffline,
} from "@/client/offline";
import { setFetchForTests } from "@/client/offline/api";
import { setFieldDbNameForTests } from "@/client/offline/db";
import { attachments, deviceUsageLogs, sessions, syncCommands } from "@/db/schema";
import { deviceId, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { issueActivationCode, requestWipe } from "@/server/core/auth";
import { setStorageDriverForTests, type StorageDriver } from "@/server/core/storage";

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

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  "POST /api/device/activate": activateRoute,
  "POST /api/device/pin-login": pinLoginRoute,
  "POST /api/device/pin-enroll": enrollRoute,
  "GET /api/device/users": usersRoute,
  "POST /api/sync/push": pushRoute,
  "POST /api/sync/upload": uploadRoute,
  "GET /api/sync/pull": pullRoute,
};

let networkUp = true;

/** `fetch` klien diarahkan langsung ke route handler Next (tanpa server HTTP). */
async function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!networkUp) throw new TypeError("Failed to fetch");
  const url = new URL(input, "http://localhost");
  const handler = ROUTES[`${init?.method ?? "GET"} ${url.pathname}`];
  if (!handler) return new Response("not found", { status: 404 });
  return handler(new Request(url, init));
}

const SOPIR = userIdByUsername("sopir1");
const KERNET = userIdByUsername("kernet1");

beforeAll(() => {
  setStorageDriverForTests(memoryDriver);
  setFetchForTests(routeFetch);
  setFieldDbNameForTests(`equa-field-uji-${Date.now()}`);
});

afterAll(() => {
  setFetchForTests(null);
  setStorageDriverForTests(null);
});

describe("Klien offline lapangan (Dexie + worker sinkron)", () => {
  it("US-M10-02 KP-1 aktivasi perangkat: kunci perangkat disimpan sebagai CryptoKey non-extractable", async () => {
    const issued = await issueActivationCode(seededContext("admin1"), deviceId("HP-T1"));
    const dev = await activateWithCode(issued.displayCode);
    expect(dev.device.home).toBe("/sopir");
    const stored = await loadDevice();
    expect(stored?.secretKey).toBeInstanceOf(CryptoKey);
    expect(stored?.secretKey?.extractable).toBe(false);
    expect(stored?.secretRaw).toBeNull();
    const users = await refreshDeviceUsers();
    expect(users.map((u) => u.id).sort()).toEqual([SOPIR, KERNET].sort());
    expect((await knownUsers()).map((u) => u.id).sort()).toEqual([SOPIR, KERNET].sort());
  });

  it("US-M10-02 KP-5 / NFR-10 login PIN daring menyimpan verifier (bukan PIN); login PIN offline berfungsi", async () => {
    const cred = await loginWithPin(SOPIR, SEED_DEMO_PIN, { online: true });
    expect(await getActiveUserId()).toBe(SOPIR);
    const all = JSON.stringify(await fieldDb().credentials.toArray());
    expect(all).not.toContain(SEED_DEMO_PIN);
    expect(cred.verifier.iterations).toBeGreaterThanOrEqual(100_000);
    expect(await verifyPinOffline(SEED_DEMO_PIN, cred.verifier)).toBe(true);
    expect(await verifyPinOffline("654321", cred.verifier)).toBe(false);
    // Tanpa sinyal: verifikasi lokal.
    networkUp = false;
    await expect(loginWithPin(SOPIR, SEED_DEMO_PIN)).resolves.toMatchObject({ userId: SOPIR });
    // Pengguna yang belum pernah login daring di perangkat ini tidak dapat login offline.
    await expect(loginWithPin(KERNET, SEED_DEMO_PIN, { online: false })).rejects.toMatchObject({ code: "OFFLINE_FIRST_LOGIN" });
    networkUp = true;
  });

  it("PAR-36 5 kali PIN salah saat offline → terkunci 15 menit; kejadian dilaporkan saat sinkron", async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await expect(loginWithPin(SOPIR, "000999", { online: false, now })).rejects.toMatchObject({ code: "PIN_INVALID" });
    }
    await expect(loginWithPin(SOPIR, "000999", { online: false, now })).rejects.toMatchObject({ code: "PIN_LOCKED" });
    await expect(loginWithPin(SOPIR, SEED_DEMO_PIN, { online: false, now: now + 60_000 })).rejects.toMatchObject({ code: "PIN_LOCKED" });
    await expect(loginWithPin(SOPIR, SEED_DEMO_PIN, { online: false, now: now + 16 * 60_000 })).resolves.toMatchObject({ userId: SOPIR });
  });

  it("US-M10-02 KP-2 antrean per pengguna: ganti pengguna tidak menghapus antrean pengguna lain", async () => {
    networkUp = false;
    await enqueue({ type: "core.ping", payload: { note: "sopir 1" }, label: "Uji sopir 1" });
    await enqueue({ type: "core.ping", payload: { note: "sopir 2" }, label: "Uji sopir 2" });
    networkUp = true;
    await switchUser();
    expect(await getActiveUserId()).toBeNull();
    await loginWithPin(KERNET, SEED_DEMO_PIN, { online: true });
    await enqueue({ type: "core.ping", payload: { note: "kernet" } });
    expect(await pendingCount(SOPIR)).toBe(2);
    expect(await pendingCount(KERNET)).toBe(1);
    expect(await pendingCount()).toBe(3);
    const kernetList = await listOutbox(KERNET);
    expect(kernetList.every((i) => i.userId === KERNET)).toBe(true);
  });

  it("US-M3-09 KP-2 sinkron mengirim antrean semua pengguna (lampiran dulu), status per item, pengiriman ulang tidak menggandakan", async () => {
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9, 9])], { type: "image/jpeg" });
    const withPhoto = await enqueue({ type: "core.ping", payload: {} }, [{ kind: "delivery_photo", blob: photo }]);
    await enqueue({ type: "tidak.dikenal", payload: {} });
    const summary = await syncNow({ force: true });
    expect(summary.uploaded).toBe(1);
    expect(summary.sent).toBe(4);
    expect(summary.rejected).toBe(1);
    expect(summary.pulled).toBe(true);
    expect(await pendingCount()).toBe(0);
    const rejected = (await fieldDb().outbox.toArray()).find((i) => i.type === "tidak.dikenal");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.message).toMatch(/tidak dikenal/);
    expect(await t.db.select().from(attachments).where(eq(attachments.id, withPhoto.attachmentIds[0]!))).toHaveLength(1);

    // Kirim ulang item yang sudah terkirim (mis. respons hilang di jaringan) → server "duplicate", tidak dobel.
    const first = (await fieldDb().outbox.toArray()).find((i) => i.status === "sent")!;
    await fieldDb().outbox.update(first.id, { status: "queued" });
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(first.id))?.status).toBe("sent");
    const pings = await t.db.select().from(deviceUsageLogs).where(and(eq(deviceUsageLogs.deviceId, deviceId("HP-T1")), eq(deviceUsageLogs.event, "ping")));
    expect(pings).toHaveLength(4);
    expect(await t.db.select().from(syncCommands).where(eq(syncCommands.id, first.id))).toHaveLength(1);

    // Data referensi pengguna aktif tersimpan per pengguna.
    const me = await fieldDb().refs.get([KERNET, "core.me"]);
    expect((me?.data as { userId: string }).userId).toBe(KERNET);
  });

  it("Bab 6.4 tanpa sinyal: sinkron dilewati, antrean tetap; sinyal kembali → terkirim", async () => {
    networkUp = false;
    await enqueue({ type: "core.ping", payload: {} });
    const off = await syncNow({ force: true });
    expect(off.sent).toBe(0);
    expect(await pendingCount(KERNET)).toBe(1);
    networkUp = true;
    const on = await syncNow({ force: true });
    expect(on.sent).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("US-M2-11 / Bab 6.5 kunci perintah per pengguna: terbungkus PIN, dilepas saat kunci layar; tidak bisa mencatat atas nama orang lain", async () => {
    const cred = await fieldDb().credentials.get(KERNET);
    expect(cred?.commandKeyWrap?.ct).toBeTruthy();
    // Pengguna aktif = kernet → mencatat atas nama sopir ditolak di perangkat.
    await expect(enqueue({ type: "core.ping", payload: {} }, [], { userId: SOPIR })).rejects.toMatchObject({ code: "PIN_REQUIRED" });
    const { id } = await enqueue({ type: "core.ping", payload: { note: "ttd" } });
    const item = await fieldDb().outbox.get(id);
    expect(item).toMatchObject({ userId: KERNET, sessionId: cred!.sessionId });
    expect(item?.sig).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    await lockScreen();
    await expect(enqueue({ type: "core.ping", payload: {} })).rejects.toMatchObject({ code: "PIN_REQUIRED" });
    // Buka kunci OFFLINE dengan PIN → kunci perintah dibuka dari bungkusan PIN.
    networkUp = false;
    await unlockScreen(SEED_DEMO_PIN, { online: false });
    networkUp = true;
    await enqueue({ type: "core.ping", payload: {} });
    const summary = await syncNow({ force: true });
    expect(summary.rejected).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it("US-M10-02 KP-3 sesi dicabut (reset PIN) → antrean menunggu login; login ulang mengikat ulang antrean ke sesi baru lalu terkirim", async () => {
    await enqueue({ type: "core.ping", payload: { note: "sebelum reset" } });
    await t.db.update(sessions).set({ revokedAt: new Date(), revokeReason: "admin" }).where(eq(sessions.userId, KERNET));
    await syncNow({ force: true });
    const waiting = (await fieldDb().outbox.where("userId").equals(KERNET).toArray()).filter((i) => i.status === "needs_login");
    expect(waiting).toHaveLength(1);
    await loginWithPin(KERNET, SEED_DEMO_PIN, { online: true });
    const rebound = await fieldDb().outbox.get(waiting[0]!.id);
    expect(rebound?.reboundFrom).toBe(waiting[0]!.sessionId);
    expect(rebound?.sessionId).not.toBe(waiting[0]!.sessionId);
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(waiting[0]!.id))?.status).toBe("sent");
  });

  it("US-M6-06 KP-2 urutan nomor lokal PER PERANGKAT: atomik, disemai server (aktivasi ulang tidak mengulang nomor)", async () => {
    const { nextDeviceSeq, seedDeviceSeqFloors, formatLocalNumber } = await import("@/client/offline");
    expect(await nextDeviceSeq("pos_sale")).toBe(1);
    await seedDeviceSeqFloors({ pos_sale: 41 });
    const [a, b] = await Promise.all([nextDeviceSeq("pos_sale"), nextDeviceSeq("pos_sale")]);
    expect([a, b].sort()).toEqual([42, 43]);
    await seedDeviceSeqFloors({ pos_sale: 10 }); // batas lebih rendah tidak menurunkan
    expect(await nextDeviceSeq("pos_sale")).toBe(44);
    expect(await nextDeviceSeq("purchase_receipt")).toBe(1);
    expect(formatLocalNumber({ prefix: "D01", businessDate: "2026-09-27", deviceTag: "POS-D01", seq: 7 })).toBe("D01-260927-POSD01-0007");
  });

  it("penyimpanan lokal modul (moduleStore v2) & pembaruan optimistis diterapkan ulang di atas hasil pull", async () => {
    const { moduleStore, registerOptimistic, withOptimistic } = await import("@/client/offline");
    const cart = moduleStore<{ lines: number }>("m6-pos");
    await cart.put("cart", { lines: 2 }, { userId: KERNET });
    expect(await cart.get("cart")).toEqual({ lines: 2 });
    expect((await cart.list({ userId: KERNET })).map((r) => r.key)).toEqual(["cart"]);
    await cart.remove("cart");
    expect(await cart.get("cart")).toBeUndefined();

    const off = registerOptimistic<{ trips: { id: string; status: string }[] }, { tripId: string }>("m3.trip.depart", {
      refKey: "m3.trips_today",
      apply: (data, payload) => ({ trips: data.trips.map((t) => (t.id === payload.tripId ? { ...t, status: "departed" } : t)) }),
    });
    try {
      const pulled = { trips: [{ id: "r1", status: "assigned" }, { id: "r2", status: "assigned" }] };
      const base = { userId: KERNET, deviceTime: "", businessDate: "2026-09-28", attachmentIds: [], attempts: 0 };
      const items = [
        { ...base, id: "a", type: "m3.trip.depart", payload: { tripId: "r1" }, status: "queued" as const, createdAt: 1 },
        { ...base, id: "b", type: "m3.trip.depart", payload: { tripId: "r2" }, status: "sent" as const, createdAt: 2 },
      ];
      expect(withOptimistic("m3.trips_today", pulled, items)?.trips.map((t) => t.status)).toEqual(["departed", "assigned"]);
    } finally {
      off();
    }
  });

  it("US-M10-02 KP-6 perintah hapus jarak jauh menghapus seluruh IndexedDB pada kontak berikutnya", async () => {
    await enqueue({ type: "core.ping", payload: {} });
    await requestWipe(seededContext("admin1"), deviceId("HP-T1"), "Ponsel hilang, hapus data");
    await syncNow({ force: true });
    expect(await loadDevice()).toBeUndefined();
    expect(await fieldDb().outbox.count()).toBe(0);
    expect(await fieldDb().credentials.count()).toBe(0);
    await expect(enqueue({ type: "core.ping", payload: {} })).rejects.toThrow(/Masuk dengan PIN/);
    expect(FieldApiError).toBeDefined();
  });
});
