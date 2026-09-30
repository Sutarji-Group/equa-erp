/**
 * Uji penerimaan "PRD 9.7 mitra dua outlet" (D-13 butir 1, B-82): satu tenant mitra, dua outlet → dua kontrak (satu per
 * outlet; tiap outlet = satu pelanggan mitra dengan batas kredit & faktur sendiri), wilayah eksklusif per outlet,
 * tagihan langganan per outlet, isolasi data antar tenant tetap (NFR-30). Batas kredit bersama & faktur gabungan lintas
 * outlet TIDAK dibangun (bukan tuntutan PRD). Semua waktu tetap (D-10 butir 6).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { customers, exclusiveTerritories, invoiceLines, invoices, outlets, partnerContracts } from "@/db/schema";
import { tariffZoneId } from "@/db/seed";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { DomainError, ForbiddenError } from "@/server/core/errors";
import { createPartnerTenant } from "@/server/modules/m6-pos";
import { createContract, linkPartnerCustomer, portalInvoice, portalInvoices, runSubscriptionBilling } from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ensurePeriod, uniqueSeq } from "../helpers/db-fixtures";
import { createTestUser } from "../helpers/factories";
import { createCustomer } from "../helpers/fixtures";
import { admin, finance, owner, setupPartner, T_OCT1, T_SEPT } from "./helpers";

const OUTLET_POINTS = {
  M01: { lat: -6.7512, lng: 107.0511 },
  M02: { lat: -6.8123, lng: 107.2011 },
} as const;

describe("PRD 9.7 mitra dua outlet (D-13 butir 1)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-09");
    await ensurePeriod(t.db, "2026-10");
  });
  afterAll(() => setActorResolver(null));

  async function twoOutletPartner() {
    const code = `MD${uniqueSeq()}`;
    const created = await createPartnerTenant(admin(), {
      code,
      name: `Mitra Dua Outlet ${code}`,
      outlets: [
        { code: "M01", name: `Depot ${code} Satu`, storageCapacityL: 5_000 },
        { code: "M02", name: `Depot ${code} Dua`, storageCapacityL: 5_000 },
      ],
      reason: "Mitra dengan dua outlet (PRD 9.7)",
    });
    const tenantId = created.tenant.id;
    const byCode = Object.fromEntries(created.outlets.map((o) => [o.code, o.id])) as Record<"M01" | "M02", string>;
    for (const c of ["M01", "M02"] as const) {
      await t.db.update(outlets).set({ ...OUTLET_POINTS[c], activatedOn: "2026-08-15" }).where(eq(outlets.id, byCode[c]));
    }
    // Satu outlet mitra = satu pelanggan mitra (US-P3-08 KP-1).
    const cust1 = await createCustomer(t.db, { segment: "third_party_depot", zoneId: tariffZoneId("Z1"), name: `Pelanggan ${code} M01` });
    const cust2 = await createCustomer(t.db, { segment: "third_party_depot", zoneId: tariffZoneId("Z1"), name: `Pelanggan ${code} M02` });
    await linkPartnerCustomer(finance(), { customerId: cust1.id, tenantId, outletId: byCode.M01, reason: "Perjanjian outlet pertama" });
    await linkPartnerCustomer(finance(), { customerId: cust2.id, tenantId, outletId: byCode.M02, reason: "Perjanjian outlet kedua" });
    const partnerOwner = await createTestUser(t.db, { role: "partner_owner", tenantId, scope: { tenantIds: [tenantId] }, now: T_SEPT });
    return { tenantId, outletIds: byCode, cust1, cust2, partnerOwner };
  }

  it("PRD 9.7 US-P3-09 KP-1 US-P3-01 KP-3 satu tenant dua outlet → dua kontrak (satu per outlet), batas kredit sendiri, wilayah eksklusif per outlet, tagihan langganan per outlet", async () => {
    const p = await twoOutletPartner();
    const c1 = await createContract(finance(), {
      tenantId: p.tenantId,
      customerId: p.cust1.id,
      startDate: "2026-08-01",
      creditLimit: 3_000_000,
      reason: "Kontrak outlet M01",
    });
    await approvals.decide(owner(), c1.approval.id, "approve", "Sesuai perjanjian outlet M01");
    // Kontrak kedua untuk outlet KEDUA pada tenant yang sama diterima (tarif berbeda per outlet boleh).
    const c2 = await createContract(finance(), {
      tenantId: p.tenantId,
      customerId: p.cust2.id,
      startDate: "2026-08-01",
      subscriptionFeePerOutlet: 175_000,
      creditLimit: 1_000_000,
      reason: "Kontrak outlet M02",
    });
    await approvals.decide(owner(), c2.approval.id, "approve", "Sesuai perjanjian outlet M02");

    const contracts = await t.db.select().from(partnerContracts).where(eq(partnerContracts.tenantId, p.tenantId));
    expect(contracts.map((c) => [c.customerId, c.status]).sort()).toEqual(
      [
        [p.cust1.id, "active"],
        [p.cust2.id, "active"],
      ].sort(),
    );

    // Batas kredit per pelanggan mitra (per outlet), bukan bersama.
    const custRows = await t.db.select({ id: customers.id, limit: customers.creditLimit, status: customers.creditStatus }).from(customers).where(eq(customers.partnerTenantId, p.tenantId));
    expect(Object.fromEntries(custRows.map((c) => [c.id, [c.limit, c.status]]))).toEqual({
      [p.cust1.id]: [3_000_000, "credit"],
      [p.cust2.id]: [1_000_000, "credit"],
    });

    // Wilayah eksklusif per outlet: kontrak M01 hanya M01, kontrak M02 hanya M02 (pusat = koordinat outlet).
    const territoriesOf = async (contractId: string) =>
      t.db
        .select({ outletId: exclusiveTerritories.outletId, lat: exclusiveTerritories.centerLat, lng: exclusiveTerritories.centerLng, radius: exclusiveTerritories.radiusM })
        .from(exclusiveTerritories)
        .where(eq(exclusiveTerritories.contractId, contractId));
    const t1 = await territoriesOf(c1.contract.id);
    const t2 = await territoriesOf(c2.contract.id);
    expect(t1).toEqual([{ outletId: p.outletIds.M01, ...OUTLET_POINTS.M01, radius: c1.contract.exclusiveRadiusM }]);
    expect(t2).toEqual([{ outletId: p.outletIds.M02, ...OUTLET_POINTS.M02, radius: c2.contract.exclusiveRadiusM }]);

    // Tagihan langganan per outlet: satu faktur per kontrak/pelanggan, masing-masing 1 outlet × tarifnya.
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.filter((i) => i.tenantId === p.tenantId);
    expect(mine.map((i) => [i.contractId, i.outletCount, i.amount]).sort()).toEqual(
      [
        [c1.contract.id, 1, 150_000],
        [c2.contract.id, 1, 175_000],
      ].sort(),
    );
    const invOf = async (customerId: string) =>
      t.db.select().from(invoices).where(and(eq(invoices.customerId, customerId), eq(invoices.kind, "partner_subscription")));
    const [inv1] = await invOf(p.cust1.id);
    const [inv2] = await invOf(p.cust2.id);
    expect(inv1).toMatchObject({ partnerContractId: c1.contract.id, amount: 150_000, periodMonth: "2026-09-01" });
    expect(inv2).toMatchObject({ partnerContractId: c2.contract.id, amount: 175_000, periodMonth: "2026-09-01" });
    const [l1] = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv1!.id));
    const [l2] = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv2!.id));
    expect(l1!.description).toContain("(M01)");
    expect(l2!.description).toContain("(M02)");
    // Idempoten per kontrak-bulan.
    expect((await runSubscriptionBilling(T_OCT1)).issued.filter((i) => i.tenantId === p.tenantId)).toEqual([]);

    // Portal pemilik mitra melihat tagihan KEDUA outlet tenantnya.
    const portalCtx = { ...p.partnerOwner.ctx, now: T_OCT1, source: "partner_portal" as const };
    const seen = await portalInvoices(portalCtx);
    expect(seen.map((i) => i.id).sort()).toEqual([inv1!.id, inv2!.id].sort());
  });

  it("PRD 9.7 D-13 kontrak kedua untuk outlet yang SAMA tetap ditolak (satu kontrak berlaku per outlet)", async () => {
    const p = await twoOutletPartner();
    const c1 = await createContract(finance(), { tenantId: p.tenantId, customerId: p.cust1.id, startDate: "2026-08-01", reason: "Kontrak outlet M01" });
    await approvals.decide(owner(), c1.approval.id, "approve", "Sesuai perjanjian");
    const err = await createContract(finance(), { tenantId: p.tenantId, customerId: p.cust1.id, startDate: "2026-09-01", reason: "Kontrak ganda M01" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("CONTRACT_ACTIVE_EXISTS");
    expect((err as Error).message).toMatch(/Ajukan perubahan parameter/);
  });

  it("PRD 9.7 NFR-30 isolasi tenant tetap: mitra lain tidak melihat/membuka tagihan outlet mitra dua outlet", async () => {
    const p = await twoOutletPartner();
    for (const cust of [p.cust1, p.cust2]) {
      const c = await createContract(finance(), { tenantId: p.tenantId, customerId: cust.id, startDate: "2026-08-01", reason: "Kontrak per outlet" });
      await approvals.decide(owner(), c.approval.id, "approve", "Sesuai perjanjian");
    }
    const other = await setupPartner(t.db);
    await runSubscriptionBilling(T_OCT1);
    const mineInvoices = await t.db
      .select({ id: invoices.id })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(customers.partnerTenantId, p.tenantId), eq(invoices.kind, "partner_subscription")));
    expect(mineInvoices).toHaveLength(2);
    const otherPortal = other.portal(T_OCT1);
    const otherSeen = (await portalInvoices(otherPortal)).map((i) => i.id);
    for (const inv of mineInvoices) {
      expect(otherSeen).not.toContain(inv.id);
      await expect(portalInvoice(otherPortal, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
