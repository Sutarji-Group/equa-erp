import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { notifications } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { inJobTx, listJobs, runJobNow } from "@/server/core/jobs";
import { notify } from "@/server/core/notifications";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";

/**
 * D-12 butir 8 (arahan PM): job terjadwal dijalankan RUNNER dengan koneksi biasa (bukan transaksi) — setiap unit kerja
 * yang menulis lebih dari satu baris wajib di dalam transaksi (`inJobTx`/`withTx`). Uji ini menjalankan semua job modul
 * paket A lewat runner (`runJobNow` + koneksi uji biasa) dan memastikan pembantu inti bersifat atomik.
 */
describe("D-12 butir 8 job terjadwal per unit kerja dalam transaksi", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("D-12 butir 8 inJobTx: unit kerja yang gagal di tengah tidak meninggalkan baris setengah jadi (notifikasi multi-penerima dibatalkan utuh)", async () => {
    const groupKey = `uji:jobtx:${Date.now()}`;
    await expect(
      inJobTx(t.db, async (tx) => {
        await notify(tx, { event: "supplier_payable.due", tenantId: EQUA_TENANT_ID, recipients: { roles: ["finance_admin", "owner"] }, title: "Uji", body: "Uji", groupKey, now: new Date() });
        throw new Error("gagal di tengah unit kerja");
      }),
    ).rejects.toThrow(/gagal di tengah/);
    expect(await t.db.select().from(notifications).where(eq(notifications.groupKey, groupKey))).toHaveLength(0);
    // Unit kerja yang berhasil tersimpan utuh.
    await inJobTx(t.db, (tx) => notify(tx, { event: "supplier_payable.due", tenantId: EQUA_TENANT_ID, recipients: { roles: ["finance_admin"] }, title: "Uji", body: "Uji", groupKey, now: new Date() }));
    expect((await t.db.select().from(notifications).where(eq(notifications.groupKey, groupKey))).length).toBeGreaterThan(0);
  });

  it("D-12 butir 8 semua job M1, M2, M3, M6, M7, M8, M10, M12, P3 & inti berjalan lewat runner cron (koneksi bukan transaksi) tanpa galat", async () => {
    const prefixes = ["m1.", "m2.", "m3.", "m6.", "m7.", "m8.", "m10.", "m12.", "p3.", "core."];
    const keys = listJobs()
      .map((j) => j.key)
      .filter((k) => prefixes.some((p) => k.startsWith(p)));
    expect(keys).toContain("m7.reorder.sweep");
    const failed: string[] = [];
    for (const key of keys) {
      const run = await runJobNow(key, new Date(), { db: t.db, runKey: `uji-d12:${key}` });
      if (run.status !== "succeeded") failed.push(`${key}: ${run.status} ${run.error ?? ""}`);
    }
    expect(failed).toEqual([]);
  });
});
