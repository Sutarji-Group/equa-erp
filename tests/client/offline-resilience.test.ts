import "fake-indexeddb/auto";

import { eq } from "drizzle-orm";
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
  ATTACHMENT_FAILED_CODE,
  canRetryOutboxItem,
  enqueue,
  fieldDb,
  forgetDevice,
  listOutbox,
  loginWithPin,
  markRejectedReviewed,
  OUTBOX_KEEP_RECENT,
  pruneOutbox,
  refreshDeviceUsers,
  retryOutboxItem,
  syncNow,
  type OutboxItem,
} from "@/client/offline";
import { setFetchForTests } from "@/client/offline/api";
import { setFieldDbNameForTests } from "@/client/offline/db";
import { attachments } from "@/db/schema";
import { deviceId, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { issueActivationCode } from "@/server/core/auth";
import { setStorageDriverForTests, type StorageDriver } from "@/server/core/storage";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";

/**
 * Ketahanan antrean lapangan (temuan S5B): galat unggah lampiran yang SEMENTARA tidak menolak perintah (NFR-07,
 * US-M3-09 KP-2, Bab 6.4), aksi "Kirim ulang"/"Sudah dibaca" (NFR-08), dan pemangkasan penyimpanan ponsel (NFR-17).
 */
const t = withTestDb({ seed: true });

const memory = new Map<string, Buffer>();
let failPuts = 0;
const memoryDriver: StorageDriver = {
  name: "memory",
  async put(key, body) {
    if (failPuts > 0) {
      failPuts--;
      throw new Error("blob store timeout");
    }
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

async function routeFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!networkUp) throw new TypeError("Failed to fetch");
  const url = new URL(input, "http://localhost");
  const handler = ROUTES[`${init?.method ?? "GET"} ${url.pathname}`];
  if (!handler) return new Response("not found", { status: 404 });
  return handler(new Request(url, init));
}

const SOPIR = userIdByUsername("sopir1");
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: "image/jpeg" });

beforeAll(async () => {
  setStorageDriverForTests(memoryDriver);
  setFetchForTests(routeFetch);
  setFieldDbNameForTests(`equa-field-ketahanan-${Date.now()}`);
  const issued = await issueActivationCode(seededContext("admin1"), deviceId("HP-T1"));
  await activateWithCode(issued.displayCode);
  await refreshDeviceUsers();
  await loginWithPin(SOPIR, SEED_DEMO_PIN, { online: true });
});

afterAll(() => {
  setFetchForTests(null);
  setStorageDriverForTests(null);
});

describe("Antrean lapangan: galat unggah sementara, kirim ulang, pemangkasan", () => {
  it("NFR-07 US-M3-09 KP-2 galat server 500 saat unggah foto (penyimpanan berkas timeout): foto tetap menunggu, perintah TIDAK ditolak; putaran berikutnya terkirim", async () => {
    const { id, attachmentIds } = await enqueue({ type: "core.ping", payload: { note: "foto 500" } }, [{ kind: "delivery_photo", blob: photo() }]);
    failPuts = 1;
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(id))?.status).toBe("queued");
    const att = await fieldDb().attachments.get(attachmentIds[0]!);
    expect(att).toMatchObject({ status: "pending", attempts: 1 });
    expect(att?.nextAttemptAt).toBeGreaterThan(Date.now());
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(id))?.status).toBe("sent");
    expect(await t.db.select().from(attachments).where(eq(attachments.id, attachmentIds[0]!))).toHaveLength(1);
    // NFR-17: Blob foto dihapus dari ponsel setelah perintahnya terkirim.
    expect(await fieldDb().attachments.get(attachmentIds[0]!)).toBeUndefined();
  });

  it("Bab 6.4 NFR-07 kode aktivasi baru diterbitkan saat perintah berfoto menunggu → tidak ditolak; setelah aktivasi ulang + login PIN terkirim", async () => {
    networkUp = false;
    const { id, attachmentIds } = await enqueue({ type: "core.ping", payload: { note: "sebelum aktivasi ulang" } }, [{ kind: "delivery_photo", blob: photo() }]);
    networkUp = true;
    const issued = await issueActivationCode(seededContext("admin1"), deviceId("HP-T1"));
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(id))?.status).toBe("queued");
    expect((await fieldDb().attachments.get(attachmentIds[0]!))?.status).toBe("pending");
    // Layar FieldGate: "Data yang belum terkirim tetap tersimpan dan dikirim setelah aktivasi ulang".
    await forgetDevice();
    await activateWithCode(issued.displayCode);
    await loginWithPin(SOPIR, SEED_DEMO_PIN, { online: true });
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(id))?.status).toBe("sent");
  });

  it("NFR-08 berkas ditolak final (jenis tidak didukung) → perintah ditolak di perangkat dengan penanda; 'Sudah dibaca' menghapusnya dari hitungan pita merah", async () => {
    const gif = new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: "image/gif" });
    const { id } = await enqueue({ type: "core.ping", payload: { note: "gif" } }, [{ kind: "delivery_photo", blob: gif, contentType: "image/gif" }]);
    await syncNow({ force: true });
    const item = (await fieldDb().outbox.get(id))!;
    expect(item).toMatchObject({ status: "rejected", code: ATTACHMENT_FAILED_CODE });
    expect(item.message).toMatch(/Jenis berkas tidak didukung/);
    expect(canRetryOutboxItem(item)).toBe(true);
    const unread = async () => (await fieldDb().outbox.where("[userId+status]").equals([SOPIR, "rejected"]).toArray()).filter((r) => !r.reviewedAt).length;
    expect(await unread()).toBe(1);
    expect(await markRejectedReviewed(SOPIR, [id])).toBe(1);
    expect(await unread()).toBe(0);
  });

  it("NFR-07 'Kirim ulang' memulihkan perintah berfoto yang telanjur ditolak karena galat unggah sementara (data dari versi aplikasi lama)", async () => {
    const { id, attachmentIds } = await enqueue({ type: "core.ping", payload: { note: "korban versi lama" } }, [{ kind: "delivery_photo", blob: photo() }]);
    // Keadaan yang dibuat versi lama: lampiran 'failed', perintah 'rejected' tanpa pernah dikirim.
    await fieldDb().attachments.update(attachmentIds[0]!, { status: "failed", attempts: 1, message: "Perangkat perlu diaktifkan ulang." });
    await fieldDb().outbox.update(id, { status: "rejected", message: "Foto/lampiran gagal diunggah: Perangkat perlu diaktifkan ulang." });
    expect(canRetryOutboxItem((await fieldDb().outbox.get(id))!)).toBe(true);
    expect(await retryOutboxItem(id)).toBe(true);
    expect((await fieldDb().attachments.get(attachmentIds[0]!))?.status).toBe("pending");
    await syncNow({ force: true });
    expect((await fieldDb().outbox.get(id))?.status).toBe("sent");
    // Perintah yang ditolak SERVER tidak dapat "dikirim ulang" (hasil server idempoten).
    const { id: unknownType } = await enqueue({ type: "tidak.dikenal", payload: {} });
    await syncNow({ force: true });
    const rejected = (await fieldDb().outbox.get(unknownType))!;
    expect(rejected.status).toBe("rejected");
    expect(canRetryOutboxItem(rejected)).toBe(false);
    expect(await retryOutboxItem(unknownType)).toBe(false);
  });

  it("NFR-17 pemangkasan: riwayat terkirim lama dipangkas (menyisakan item terbaru), antrean belum terkirim & ditolak belum dibaca TIDAK pernah dipangkas", async () => {
    const user = "01990000-0000-7000-8000-00000000abcd";
    const old = Date.now() - 10 * 86_400_000;
    const base = { userId: user, type: "core.ping", payload: {}, deviceTime: new Date(old).toISOString(), businessDate: "2026-09-01", attachmentIds: [], attempts: 1 };
    const rows: OutboxItem[] = [
      { ...base, id: `${user}-q`, status: "queued", createdAt: old - 1_000 },
      { ...base, id: `${user}-r`, status: "rejected", createdAt: old - 999 },
      { ...base, id: `${user}-rr`, status: "rejected", reviewedAt: old, createdAt: old - 998 },
      ...Array.from({ length: 150 }, (_, i) => ({ ...base, id: `${user}-s${i}`, status: "sent" as const, createdAt: old + i })),
    ];
    await fieldDb().outbox.bulkAdd(rows);
    const res = await pruneOutbox();
    expect(res.items).toBeGreaterThanOrEqual(51);
    const left = await fieldDb().outbox.where("userId").equals(user).toArray();
    expect(left.map((r) => r.id)).toEqual(expect.arrayContaining([`${user}-q`, `${user}-r`]));
    expect(left.find((r) => r.id === `${user}-rr`)).toBeUndefined();
    expect(left.filter((r) => r.status === "sent")).toHaveLength(OUTBOX_KEEP_RECENT);
    // Daftar antrean memakai indeks (terbaru dulu, dibatasi).
    const list = await listOutbox(user, 5);
    expect(list.map((r) => r.id)).toEqual([149, 148, 147, 146, 145].map((i) => `${user}-s${i}`));
  });
});
