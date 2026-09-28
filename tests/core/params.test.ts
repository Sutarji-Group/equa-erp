import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, notifications, parameters } from "@/db/schema";
import { EQUA_TENANT_ID, LAMPIRAN_B_PARAMETERS, outletId, userIdByUsername } from "@/db/seed";
import { ForbiddenError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const NOW = new Date("2026-09-28T03:00:00Z"); // 10.00 WIB

describe("Registri parameter (murni)", () => {
  it("US-M10-04 KP-6 PAR-01..PAR-89 lengkap dan nilai bawaan seed valid terhadap skemanya", () => {
    const expected = Array.from({ length: 89 }, (_, i) => `PAR-${String(i + 1).padStart(2, "0")}`);
    for (const key of expected) expect(params.isParamKey(key), key).toBe(true);
    for (const seed of LAMPIRAN_B_PARAMETERS) {
      expect(params.isParamKey(seed.key)).toBe(true);
      const meta = params.paramMeta(seed.key as params.ParamKey);
      const parsed = params.PARAM_REGISTRY[seed.key as params.ParamKey].schema.safeParse(meta.defaultValue);
      expect(parsed.success, `${seed.key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    expect(params.paramMeta("PAR-01").name).toMatch(/Ambang selisih/);
  });
});

describe("params.get / set / history (PGlite)", () => {
  const t = useTestDb({ seed: true });
  const owner = () => seededContext("pemilik", { now: NOW });

  it("US-M10-04 KP-6 get mengembalikan nilai bawaan Lampiran B yang bertipe", async () => {
    const { amount } = await params.get(t.db, "PAR-01", "2026-09-28");
    expect(amount).toBe(50_000);
    const cutoff = await params.get(t.db, "PAR-05", "2026-09-28");
    expect(cutoff.time).toBe("15:00");
  });

  it("6.2b nilai berlaku per tanggal: perubahan pemilik berlaku mulai effective_from, riwayat tersimpan", async () => {
    await params.set(owner(), "PAR-01", { amount: 75_000 }, "2026-10-01", "Evaluasi 3 bulan pilot");
    expect((await params.get(t.db, "PAR-01", "2026-09-30")).amount).toBe(50_000);
    expect((await params.get(t.db, "PAR-01", "2026-10-01")).amount).toBe(75_000);
    expect((await params.get(t.db, "PAR-01", "2027-01-15")).amount).toBe(75_000);
    const hist = await params.history(t.db, "PAR-01");
    expect(hist.map((h) => h.effectiveFrom)).toEqual(["2026-10-01", "2025-01-01"]);
  });

  it("6.2b perubahan berjejak audit dan diberitahukan ke Admin Keuangan", async () => {
    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.objectType, "parameter"), eq(auditLogs.objectId, "PAR-01")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe("Evaluasi 3 bulan pilot");
    expect(audit[0]!.actorRoles).toEqual(["owner"]);
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "parameter.changed"), eq(notifications.recipientUserId, userIdByUsername("keuangan1"))));
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it("US-M10-04 KP-6 hanya pemilik yang dapat mengubah parameter", async () => {
    await expect(params.set(seededContext("keuangan1", { now: NOW }), "PAR-01", { amount: 1 }, "2026-10-02", "coba ubah")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(params.set(seededContext("admin1", { now: NOW }), "PAR-36", { max_attempts: 3, lock_minutes: 5 }, "2026-10-02", "coba ubah")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("6.2b tanggal berlaku tidak boleh surut & nilai divalidasi skema", async () => {
    await expect(params.set(owner(), "PAR-01", { amount: 60_000 }, "2026-09-01", "koreksi mundur")).rejects.toBeInstanceOf(ValidationError);
    await expect(params.set(owner(), "PAR-01", { amount: -1 } as never, "2026-10-05", "nilai negatif")).rejects.toBeInstanceOf(ValidationError);
    await expect(params.set(owner(), "PAR-05", { time: "25:00" } as never, "2026-10-05", "jam salah")).rejects.toThrow(/HH:mm/);
    await expect(params.set(owner(), "PAR-01", { amount: 60_000 }, "2026-10-05", "")).rejects.toThrow(/Alasan/);
  });

  it("US-M6-07 KP-3 parameter per outlet mengalahkan nilai global (paling spesifik menang)", async () => {
    await params.set(owner(), "PAR-57", { amount: 300_000 }, "2026-09-28", "Kas awal D02 lebih besar", { outletId: outletId("D02") });
    expect((await params.get(t.db, "PAR-57", "2026-09-28", { outletId: outletId("D02"), tenantId: EQUA_TENANT_ID })).amount).toBe(300_000);
    expect((await params.get(t.db, "PAR-57", "2026-09-28", { outletId: outletId("D01"), tenantId: EQUA_TENANT_ID })).amount).toBe(200_000);
    await expect(params.set(owner(), "PAR-01", { amount: 1 }, "2026-10-09", "tidak boleh per outlet", { outletId: outletId("D02") })).rejects.toThrow(
      /tidak dapat diatur per outlet/,
    );
  });

  it("parameter non-seed memakai fallback registri", async () => {
    const r = await params.resolve(t.db, "notifications.digest_recipients", "2026-09-28");
    expect(r.source).toBe("default");
    expect(r.value.emails).toEqual([]);
    const rows = await t.db.select().from(parameters).where(eq(parameters.key, "notifications.digest_recipients"));
    expect(rows).toHaveLength(0);
  });

  it("listCurrent memuat seluruh registri", async () => {
    const all = await params.listCurrent(t.db, "2026-09-28");
    expect(all.length).toBe(params.PARAM_KEYS.length);
    expect(all.find((p) => p.key === "company.identity")?.value).toMatchObject({ name: "EQUA" });
  });
});
