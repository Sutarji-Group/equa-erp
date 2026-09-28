import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { isHardeningViolation, SQLSTATE_APPEND_ONLY } from "@/db/hardening";
import { auditLogs } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import { describeAudit, FINANCIAL_OBJECT_TYPES, query, queryForActor, record, verifyAuditChain } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { ForbiddenError } from "@/server/core/errors";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("Jejak audit (US-M10-05)", () => {
  const t = useTestDb({ seed: true });

  it("US-M10-05 KP-1 mencatat pelaku, peran, waktu server & perangkat, nilai lama/baru, alasan, sumber", async () => {
    const ctx = seededContext("keuangan1", { deviceTime: new Date("2026-09-28T02:00:00Z"), businessDate: "2026-09-28" });
    const row = await withTx((tx) =>
      record(tx, {
        ctx,
        objectType: "zone_tariff",
        objectId: "Z1",
        action: "update",
        before: { pricePerTrip: 200_000 },
        after: { pricePerTrip: 210_000 },
        reason: "kenaikan BBM",
      }),
    );
    expect(row.actorUserId).toBe(userIdByUsername("keuangan1"));
    expect(row.actorRoles).toEqual(["finance_admin"]);
    expect(row.source).toBe("web");
    expect(row.deviceTime?.toISOString()).toBe("2026-09-28T02:00:00.000Z");
    expect(row.businessDate).toBe("2026-09-28");
    expect(row.before).toEqual({ pricePerTrip: 200_000 });
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("US-M10-05 KP-2 rantai hash tersambung (prev_hash = hash sebelumnya) dan dapat diverifikasi", async () => {
    const owner = seededContext("pemilik");
    await withTx(async (tx) => {
      for (let i = 0; i < 5; i++) {
        await record(tx, { ctx: owner, objectType: "order", objectId: `P-26-00000${i}`, action: "create", after: { i, when: new Date("2026-09-28T00:00:00Z") } });
      }
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withTx((tx) => record(tx, { ctx: owner, objectType: "order", objectId: `par-${i}`, action: "update", before: { a: i }, after: { a: i + 1 } })),
      ),
    );
    const rows = await t.db.select().from(auditLogs).orderBy(auditLogs.seq);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    expect(rows[0]!.prevHash).toBeNull();
    const result = await verifyAuditChain(t.db);
    expect(result).toEqual({ ok: true, checked: rows.length });
  });

  it("US-M10-05 KP-2 NFR-11 UPDATE dan DELETE jejak audit ditolak trigger DB", async () => {
    const upd = await t.db.execute(sql`update audit_logs set reason = 'diubah'`).catch((e: unknown) => e);
    expect(sqlState(upd)).toBe(SQLSTATE_APPEND_ONLY);
    expect(isHardeningViolation(upd)).toBe(true);
    const del = await t.db.execute(sql`delete from audit_logs`).catch((e: unknown) => e);
    expect(isHardeningViolation(del)).toBe(true);
  });

  it("US-M10-05 KP-2 verifyAuditChain mendeteksi manipulasi isi baris (trigger dimatikan khusus uji)", async () => {
    const target = (await t.db.select().from(auditLogs).orderBy(auditLogs.seq).limit(3))[2]!;
    await t.db.execute(sql`alter table audit_logs disable trigger equa_append_only`);
    try {
      await t.db.update(auditLogs).set({ after: { pricePerTrip: 1 } }).where(eq(auditLogs.id, target.id));
      const broken = await verifyAuditChain(t.db);
      expect(broken.ok).toBe(false);
      expect(broken.brokenAtSeq).toBe(target.seq);
      expect(broken.reason).toMatch(/tidak cocok/);
      await t.db.update(auditLogs).set({ after: target.after }).where(eq(auditLogs.id, target.id));
      expect((await verifyAuditChain(t.db)).ok).toBe(true);

      // Menghapus baris di tengah memutus rantai (prev_hash baris berikutnya tidak lagi cocok).
      await t.db.execute(sql`alter table audit_logs disable trigger equa_no_delete`);
      const middle = (await t.db.select().from(auditLogs).orderBy(auditLogs.seq).limit(5))[3]!;
      await t.db.delete(auditLogs).where(eq(auditLogs.id, middle.id));
      const gap = await verifyAuditChain(t.db);
      expect(gap.ok).toBe(false);
      expect(gap.reason).toMatch(/Rantai terputus/);
      await t.db.insert(auditLogs).values(middle);
      expect((await verifyAuditChain(t.db)).ok).toBe(true);
    } finally {
      await t.db.execute(sql`alter table audit_logs enable trigger equa_append_only`);
      await t.db.execute(sql`alter table audit_logs enable trigger equa_no_delete`);
    }
  });

  it("US-M10-05 KP-3 kalimat bahasa lapangan untuk perubahan nilai", () => {
    const text = describeAudit({
      objectType: "trip",
      objectId: "P-26-000123/1",
      action: "update",
      before: { price: 200_000 },
      after: { price: 210_000 },
      reason: "kenaikan BBM",
      rule: null,
      source: "web",
      actorRoles: ["owner"],
    });
    expect(text).toBe("harga rit diubah dari Rp 200.000 menjadi Rp 210.000 oleh Pemilik, alasan: kenaikan BBM");
  });

  it("US-M10-05 KP-5 tindakan otomatis sistem dicatat dengan pelaku Sistem dan aturan pemicunya", async () => {
    const row = await withTx((tx) =>
      record(tx, {
        ctx: systemContext(),
        objectType: "customer",
        objectId: "PLG-0034",
        action: "update",
        before: { creditStatus: "credit" },
        after: { creditStatus: "on_hold" },
        rule: "BR-03",
      }),
    );
    expect(row.actorUserId).toBeNull();
    expect(row.source).toBe("system");
    expect(describeAudit(row)).toBe("status kredit pelanggan diubah dari Tempo menjadi Ditahan oleh Sistem (aturan BR-03)");
  });

  it("US-M10-05 KP-3 pencarian per objek, pengguna, jenis tindakan", async () => {
    const byObject = await query(t.db, { objectType: "zone_tariff", objectId: "Z1" });
    expect(byObject).toHaveLength(1);
    const byUser = await query(t.db, { actorUserId: userIdByUsername("pemilik"), action: "update" });
    expect(byUser.length).toBeGreaterThanOrEqual(6);
    const page = await query(t.db, { limit: 2 });
    const next = await query(t.db, { limit: 2, beforeSeq: page[1]!.seq });
    expect(next[0]!.seq).toBeLessThan(page[1]!.seq);
  });

  it("US-M10-05 KP-6 akuntan hanya melihat objek keuangan; admin sistem tanpa nilai keuangan; sopir ditolak", async () => {
    await withTx((tx) =>
      record(tx, { ctx: seededContext("keuangan1"), objectType: "deposit", objectId: "S-26-000001", action: "update", before: { receivedAmount: 0 }, after: { receivedAmount: 480_000 } }),
    );
    const acc = await queryForActor(seededContext("akuntan"));
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.every((r) => FINANCIAL_OBJECT_TYPES.has(r.objectType))).toBe(true);
    expect(acc.some((r) => r.objectType === "order")).toBe(false);
    const admin = await queryForActor(seededContext("admin1"));
    const dep = admin.find((r) => r.objectType === "deposit")!;
    expect(dep.before).toBeNull();
    expect(dep.after).toBeNull();
    expect(admin.find((r) => r.objectType === "order")?.after).not.toBeNull();
    await expect(queryForActor(seededContext("sopir1"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
