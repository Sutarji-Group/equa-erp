import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as attachmentRoute } from "@/app/api/attachments/[id]/route";
import { attachments, userRoles, users } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, truckId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { buildActorContext, getActorContext, setActorResolver } from "@/server/core/actor";
import { ctxBusinessDate, systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import {
  DomainError,
  errorResponse,
  ForbiddenError,
  parseInput,
  toUserMessage,
  translateZodIssue,
  ValidationError,
} from "@/server/core/errors";
import { MODULES, registerAllModules } from "@/server/modules/register";
import { getUrl, put, readAttachment } from "@/server/core/storage";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

describe("errors.ts — pesan Indonesia", () => {
  it("ValidationError menerjemahkan isu Zod ke Indonesia dengan label isian", () => {
    const schema = z.object({ amount: z.number().int().min(1), name: z.string().min(3), kind: z.enum(["a", "b"]) });
    const err = (() => {
      try {
        parseInput(schema, { amount: "x", name: "ab", kind: "c" }, { amount: "Jumlah", name: "Nama" });
      } catch (e) {
        return e as ValidationError;
      }
    })()!;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues).toEqual([
      { path: "amount", message: "Jumlah: Harus berupa angka." },
      { path: "name", message: "Nama: Minimal 3 karakter." },
      { path: "kind", message: "Pilihan tidak valid. Pilih salah satu dari daftar." },
    ]);
    expect(err.message).toMatch(/Jumlah: Harus berupa angka\. \(dan 2 isian lain/);
    expect(err.status).toBe(400);
  });

  it("pesan kustom skema dipertahankan; wajib diisi dikenali", () => {
    expect(() => parseInput(z.object({ note: z.string({ error: "Catatan wajib." }) }), {})).toThrow("Catatan wajib.");
    expect(translateZodIssue({ code: "invalid_type", input: undefined, expected: "string" })).toBe("Wajib diisi.");
  });

  it("toUserMessage & errorResponse: DomainError apa adanya, galat lain tanpa kode teknis", async () => {
    expect(toUserMessage(new DomainError("X", "Setoran sudah ditutup."))).toBe("Setoran sudah ditutup.");
    expect(toUserMessage(new Error("relation does not exist"))).toMatch(/Terjadi kesalahan di server/);
    expect(toUserMessage(Object.assign(new Error("x"), { code: "EQ001" }))).toMatch(/tidak boleh dihapus/);
    const res = errorResponse(new ForbiddenError("Tidak boleh."));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "FORBIDDEN", message: "Tidak boleh." });
  });
});

describe("Konteks pelaku (ARCHITECTURE §3) & modul", () => {
  const t = useTestDb({ seed: true });
  afterAll(() => setActorResolver(null));

  it("systemContext & tanggal bisnis WIB dari perangkat", () => {
    const sys = systemContext({ now: new Date("2026-09-28T17:30:00Z") });
    expect(sys).toMatchObject({ userId: null, source: "system", tenantId: EQUA_TENANT_ID, roles: [] });
    expect(ctxBusinessDate(sys)).toBe("2026-09-29");
    expect(ctxBusinessDate({ ...sys, deviceTime: new Date("2026-09-28T16:00:00Z") })).toBe("2026-09-28");
    expect(ctxBusinessDate({ ...sys, businessDate: "2026-09-27" })).toBe("2026-09-27");
  });

  it("US-M10-01 KP-3 buildActorContext memuat peran & lingkup aktif dari DB", async () => {
    const sopir = await buildActorContext(t.db, userIdByUsername("sopir1"), { source: "field", deviceId: null });
    expect(sopir.roles).toEqual(["driver"]);
    expect(sopir.scope.truckIds).toEqual([truckId("T1")]);
    const depot = await buildActorContext(t.db, userIdByUsername("depot03"), { source: "pos" });
    expect(depot.scope.outletIds).toEqual([outletId("D03")]);
    const owner = await buildActorContext(t.db, userIdByUsername("pemilik"), { source: "web" });
    expect(owner.scope.tenantIds).toEqual([EQUA_TENANT_ID]);
    expect(owner).toEqual(seededContext("pemilik", { now: owner.now }));
  });

  it("US-M10-01 KP-4/KP-5 peran lewat masa berlaku tidak aktif; akun nonaktif ditolak", async () => {
    const akuntan = userIdByUsername("akuntan");
    await t.db.update(userRoles).set({ validUntil: "2026-01-31" }).where(eq(userRoles.userId, akuntan));
    const ctx = await buildActorContext(t.db, akuntan, { source: "web", now: new Date("2026-09-28T03:00:00Z") });
    expect(ctx.roles).toEqual([]);
    await t.db.update(users).set({ status: "inactive" }).where(eq(users.id, userIdByUsername("kernet7")));
    await expect(buildActorContext(t.db, userIdByUsername("kernet7"), { source: "field" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("resolver pelaku dapat diganti (TODO auth F3c); bawaan tanpa sesi = null", async () => {
    expect(await getActorContext()).toBeNull();
    setActorResolver(async () => seededContext("pemilik"));
    expect((await getActorContext())?.roles).toEqual(["owner"]);
    setActorResolver(null);
  });

  it("registrasi modul: 14 modul terdaftar dan idempoten", () => {
    expect(MODULES.map((m) => m.key)).toEqual([
      "m1-master",
      "m2-orders",
      "m3-driver",
      "m4-cash",
      "m5-receivables",
      "m6-pos",
      "m7-store",
      "m8-production",
      "m9-reports",
      "m10-access",
      "m11-accounting",
      "m12-fleet",
      "p2-customer",
      "p3-partner",
    ]);
    expect(() => {
      registerAllModules();
      registerAllModules();
    }).not.toThrow();
  });

  it("storage: simpan lampiran (memori di uji), idempoten per ID klien, disajikan lewat route terautentikasi", async () => {
    const ctx = seededContext("sopir1");
    const id = newId();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const row = await withTx((tx) => put(tx, ctx, { id, blob: jpeg, contentType: "image/jpeg", kind: "delivery_photo", objectRef: { type: "trip", id: "t-1" } }));
    expect(row).toMatchObject({ id, sizeBytes: 8, kind: "delivery_photo", objectType: "trip", uploadedBy: userIdByUsername("sopir1") });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await withTx((tx) => put(tx, ctx, { id, blob: Buffer.from("lain"), contentType: "image/jpeg", kind: "delivery_photo" }));
    expect(again.sha256).toBe(row.sha256);
    expect((await t.db.select().from(attachments).where(eq(attachments.id, id))).length).toBe(1);
    expect(getUrl(row)).toBe(`/api/attachments/${id}`);
    const read = await readAttachment(seededContext("keuangan1"), id);
    expect(read.body.equals(jpeg)).toBe(true);
    await expect(withTx((tx) => put(tx, ctx, { blob: Buffer.alloc(0), contentType: "image/jpeg", kind: "x" }))).rejects.toBeInstanceOf(ValidationError);

    const params = { params: Promise.resolve({ id }) };
    expect((await attachmentRoute(new Request(`http://x/api/attachments/${id}`), params)).status).toBe(401);
    setActorResolver(async () => seededContext("keuangan1"));
    const ok = await attachmentRoute(new Request(`http://x/api/attachments/${id}`), params);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await ok.arrayBuffer()).equals(jpeg)).toBe(true);
    const missing = await attachmentRoute(new Request("http://x"), { params: Promise.resolve({ id: newId() }) });
    expect(missing.status).toBe(404);
    setActorResolver(null);
  });
});
