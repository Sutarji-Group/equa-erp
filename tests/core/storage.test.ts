import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as attachmentRoute } from "@/app/api/attachments/[id]/route";
import { truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { setActorResolver } from "@/server/core/actor";
import { ensureBootstrapped } from "@/server/core/bootstrap";
import { withTx } from "@/server/core/db";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import { inTruckScope } from "@/server/core/rbac";
import { linkAttachment, put, readAttachment, registerAttachmentAccess, setStorageDriverForTests, type StorageDriver } from "@/server/core/storage";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";

const t = withTestDb({ seed: true });

const memory = new Map<string, Buffer>();
const driver: StorageDriver = {
  name: "memory",
  async put(key, body) {
    memory.set(key, body);
    return { url: null };
  },
  async get(key) {
    return memory.get(key) ?? null;
  },
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 5, 5]);
const PDF = Buffer.from("%PDF-1.4 perjanjian kerja");

beforeAll(() => setStorageDriverForTests(driver));
afterAll(() => {
  setStorageDriverForTests(null);
  setActorResolver(null);
});

describe("Lampiran: otorisasi per objek & jenis berkas (BR-39, NFR-09)", () => {
  it("BR-39 lampiran ber-PII (perjanjian) hanya pemilik/Admin Keuangan & pengunggah — sopir ditolak walau satu tenant", async () => {
    const owner = seededContext("pemilik");
    const att = await withTx((tx) => put(tx, owner, { blob: PDF, contentType: "application/pdf", kind: "agreement", objectRef: { type: "employee", id: newId() } }));
    await expect(readAttachment(seededContext("sopir5"), att.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(readAttachment(seededContext("dispatcher1"), att.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await readAttachment(seededContext("keuangan1"), att.id)).row.id).toBe(att.id);
    expect((await readAttachment(owner, att.id)).row.id).toBe(att.id);
    // Penolakan tercatat di log akses.
    const { accessLogs } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const denied = await t.db.select().from(accessLogs).where(and(eq(accessLogs.userId, userIdByUsername("sopir5")), eq(accessLogs.event, "action_denied")));
    expect(denied.some((d) => d.objectId === att.id)).toBe(true);
  });

  it("BR-39 objek terdaftar modul (registerAttachmentAccess): izin baca + lingkup truk; objek tak terdaftar hanya pemilik/Admin Keuangan", async () => {
    const off = registerAttachmentAccess("test_trip", {
      permission: "m3.trip.read",
      check: (_tx, ctx, row) => inTruckScope(ctx, row.objectId!),
    });
    try {
      const sopir1 = seededContext("sopir1");
      const photo = await withTx((tx) => put(tx, sopir1, { blob: JPEG, contentType: "image/jpeg", kind: "delivery_photo", objectRef: { type: "test_trip", id: truckId("T1") } }));
      // Kernet truk yang sama boleh (izin baca + lingkup), sopir truk lain tidak.
      expect((await readAttachment(seededContext("kernet1"), photo.id)).row.id).toBe(photo.id);
      await expect(readAttachment(seededContext("sopir2"), photo.id)).rejects.toBeInstanceOf(ForbiddenError);
      // Objek tak terdaftar.
      const other = await withTx((tx) => put(tx, sopir1, { blob: JPEG, contentType: "image/jpeg", kind: "meter_photo", objectRef: { type: "tak_terdaftar", id: "x" } }));
      await expect(readAttachment(seededContext("dispatcher1"), other.id)).rejects.toBeInstanceOf(ForbiddenError);
      expect((await readAttachment(sopir1, other.id)).row.id).toBe(other.id);
      expect((await readAttachment(seededContext("keuangan1"), other.id)).row.id).toBe(other.id);
    } finally {
      off();
    }
  });

  it("NFR-09 jenis berkas di luar allowlist (HTML/SVG) & isi yang tidak sesuai jenis ditolak", async () => {
    const ctx = seededContext("keuangan1");
    await expect(withTx((tx) => put(tx, ctx, { blob: Buffer.from("<script>alert(1)</script>"), contentType: "text/html", kind: "x" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(withTx((tx) => put(tx, ctx, { blob: Buffer.from("<svg onload=alert(1)>"), contentType: "image/svg+xml", kind: "x" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(withTx((tx) => put(tx, ctx, { blob: Buffer.from("<html>bukan jpeg"), contentType: "image/jpeg", kind: "x" }))).rejects.toThrow(/tidak sesuai jenisnya/);
  });

  it("NFR-09 route lampiran: nosniff + CSP sandbox; selain gambar sebagai unduhan", async () => {
    const owner = seededContext("pemilik");
    const pdf = await withTx((tx) => put(tx, owner, { blob: PDF, contentType: "application/pdf", kind: "deposit_slip" }));
    const img = await withTx((tx) => put(tx, owner, { blob: JPEG, contentType: "image/jpeg", kind: "deposit_slip" }));
    ensureBootstrapped(); // resolver bawaan dipasang saat bootstrap — ganti SESUDAHNYA
    setActorResolver(async () => owner);
    const resPdf = await attachmentRoute(new Request(`http://x/api/attachments/${pdf.id}`), { params: Promise.resolve({ id: pdf.id }) });
    expect(resPdf.status).toBe(200);
    expect(resPdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resPdf.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(resPdf.headers.get("content-disposition")).toMatch(/^attachment;/);
    const resImg = await attachmentRoute(new Request(`http://x/api/attachments/${img.id}`), { params: Promise.resolve({ id: img.id }) });
    expect(resImg.headers.get("content-disposition")).toMatch(/^inline;/);
    setActorResolver(null);
  });

  it("US-M3-09 KP-2 lampiran yang sudah tertaut ke objek lain tidak dapat ditautkan ulang", async () => {
    const ctx = seededContext("sopir1");
    const att = await withTx((tx) => put(tx, ctx, { blob: JPEG, contentType: "image/jpeg", kind: "delivery_photo", objectRef: { type: "sync_command", id: newId() } }));
    await withTx((tx) => linkAttachment(tx, att.id, { type: "trip", id: "rit-A" }));
    await withTx((tx) => linkAttachment(tx, att.id, { type: "trip", id: "rit-A" })); // idempoten
    await expect(withTx((tx) => linkAttachment(tx, att.id, { type: "trip", id: "rit-B" }))).rejects.toThrow(/sudah dipakai/);
  });
});
