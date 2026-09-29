import { beforeAll, describe, expect, it } from "vitest";

import * as approvals from "@/server/core/approvals";
import { AUDIT_PII_MASK, describeAudit, queryForActor, record } from "@/server/core/audit";
import { getDb } from "@/server/core/db";
import { getReport } from "@/server/core/export";
import { requestAnonymization } from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { createCustomer } from "../helpers/fixtures";

describe("B-09 jejak audit menyamarkan data pribadi pelanggan yang dianonimkan (D-09 butir 1)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-09 US-M10-06 KP-2 US-M10-05 KP-6 setelah anonimisasi: admin sistem & akuntan melihat nilai tersamar; pemilik melihat nilai asli; jejak tidak berubah", async () => {
    const c = await createCustomer(t.db, { name: "Bu Rahmi Sukaresmi" });
    const other = await createCustomer(t.db, { name: "Pak Dadang Cibeber" });
    const disp = seededContext("dispatcher1");
    await record(getDb(), {
      ctx: disp,
      objectType: "customer",
      objectId: c.id,
      action: "update",
      before: { name: "Bu Rahmi", waPhone: "6281200001111", creditLimit: 0 },
      after: { name: "Bu Rahmi Sukaresmi", waPhone: "6281200002222", creditLimit: 0 },
      reason: "Perbaikan data",
    });
    await record(getDb(), {
      ctx: disp,
      objectType: "customer_address",
      objectId: c.addressId!,
      action: "update",
      before: { addressText: "Jl. Lama 1", lat: -6.8, lng: 107.1, tariffZoneId: null },
      after: { addressText: "Jl. Baru 2", lat: -6.81, lng: 107.12, tariffZoneId: null },
    });
    await record(getDb(), { ctx: disp, objectType: "customer", objectId: other.id, action: "update", before: { name: "Pak Dadang" }, after: { name: "Pak Dadang Cibeber" } });

    const r = await requestAnonymization(seededContext("admin1"), { subjectType: "customer", subjectId: c.id, reason: "Permintaan penghapusan data pelanggan" });
    await approvals.decide(seededContext("pemilik"), r.approval!.id, "approve");

    const admin = await queryForActor(seededContext("admin1"), { objectType: ["customer", "customer_address"], limit: 500 });
    const cust = admin.find((a) => a.objectType === "customer" && a.objectId === c.id && a.action === "update")!;
    expect(cust.before).toEqual({ name: AUDIT_PII_MASK, waPhone: AUDIT_PII_MASK, creditLimit: 0 });
    expect(cust.after).toMatchObject({ name: AUDIT_PII_MASK, waPhone: AUDIT_PII_MASK });
    expect(describeAudit(cust)).not.toMatch(/Rahmi|62812000/);
    const addr = admin.find((a) => a.objectType === "customer_address" && a.objectId === c.addressId)!;
    expect(addr.after).toEqual({ addressText: AUDIT_PII_MASK, lat: AUDIT_PII_MASK, lng: AUDIT_PII_MASK, tariffZoneId: null });
    // Pelanggan yang TIDAK dianonimkan tidak disamarkan.
    const untouched = admin.find((a) => a.objectType === "customer" && a.objectId === other.id)!;
    expect(untouched.after).toEqual({ name: "Pak Dadang Cibeber" });

    // Pemilik tetap melihat nilai lama (catatan wajib hukum, append-only NFR-11).
    const owner = await queryForActor(seededContext("pemilik"), { objectType: "customer", objectId: c.id, limit: 50 });
    expect(owner.find((a) => a.action === "update")!.before).toMatchObject({ name: "Bu Rahmi", waPhone: "6281200001111" });

    // Ekspor jejak audit memakai aturan yang sama (fetch laporan dengan pelaku non-pemilik).
    const report = getReport("core.audit_log")!;
    const exported = (await report.fetch(seededContext("admin1"), { objectType: "customer", objectId: c.id }, { tx: t.db })) as { rows: { description: string; objectId: string }[] };
    expect(exported.rows.length).toBeGreaterThan(0);
    for (const row of exported.rows) expect(row.description).not.toMatch(/Rahmi|62812000/);
  });
});
