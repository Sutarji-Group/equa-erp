import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creditNotes, customers, invoiceLines, invoices, journalLines, journals, outlets, partnerContracts, unbilledCharges } from "@/db/schema";
import { accountId, EQUA_TENANT_ID } from "@/db/seed";
import { setActorResolver } from "@/server/core/actor";
import * as approvals from "@/server/core/approvals";
import { query as auditQuery } from "@/server/core/audit";
import { withTx } from "@/server/core/db";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { agingReport, recordOfficePayment, requestCreditNote } from "@/server/modules/m5-receivables";
import {
  computePartnerBill,
  createContract,
  disputePartnerInvoice,
  proposeContractTerms,
  royaltyDetail,
  runContractLifecycle,
  runSubscriptionBilling,
  runSubscriptionBillingNow,
} from "@/server/modules/p3-partner";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { ensurePeriod, sqlState } from "../helpers/db-fixtures";
import { at, disablePhase3, dispatcher, enablePhase3, finance, insertSale, owner, setupPartner, T_OCT1, T_SEPT } from "./helpers";

async function invoicesOf(db: ReturnType<typeof useTestDb>["db"], customerId: string) {
  return db.select().from(invoices).where(and(eq(invoices.customerId, customerId), eq(invoices.kind, "partner_subscription")));
}

describe("US-P3-09 Tagihan langganan sistem bulanan untuk mitra (RL-7)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-09");
    await ensurePeriod(t.db, "2026-10");
    await ensurePeriod(t.db, "2026-11");
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-09 KP-1 tarif & tanggal mulai dari kontrak yang diinput Admin Keuangan dan disetujui pemilik (6.2a); draf/ditolak tidak ditagih", async () => {
    const p = await setupPartner(t.db, { contract: false });
    await expect(createContract(dispatcher(), { tenantId: p.tenantId, customerId: p.customerId, startDate: "2026-08-01", reason: "Dispatcher mencoba" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createContract(owner(), { tenantId: p.tenantId, customerId: p.customerId, startDate: "2026-08-01", reason: "Pemilik tidak menginput" })).rejects.toBeInstanceOf(ForbiddenError);
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, startDate: "2026-08-01", subscriptionFeePerOutlet: 175_000, reason: "Perjanjian Opsi B" });
    expect(res.contract).toMatchObject({ status: "draft", subscriptionFeePerOutlet: 175_000, option: "option_b", royaltyBp: 0, termMonths: 24, endDate: "2028-07-31" });
    expect(res.approval).toMatchObject({ type: "partner_contract", approverRole: "owner", status: "submitted" });
    // Pemohon tidak dapat memutuskan sendiri (SOD-01).
    await expect(approvals.decide(finance(), res.approval.id, "approve", "Setujui sendiri")).rejects.toThrow();
    // Draf belum ditagih.
    const draftRun = await runSubscriptionBilling(T_OCT1);
    expect(draftRun.issued.find((i) => i.contractId === res.contract.id)).toBeUndefined();
    await approvals.decide(owner(), res.approval.id, "approve", "Sesuai perjanjian");
    const [c] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, res.contract.id));
    expect(c!.status).toBe("active");
    const [o] = await t.db.select().from(outlets).where(eq(outlets.id, p.outletId));
    expect(o!.billingStartDate).toBe("2026-09-10");
    // Kontrak ditolak tidak ditagih.
    const q = await setupPartner(t.db, { contract: false });
    const rej = await createContract(finance(), { tenantId: q.tenantId, customerId: q.customerId, startDate: "2026-08-01", reason: "Perjanjian Opsi B" });
    await approvals.decide(owner(), rej.approval.id, "reject", "Perjanjian belum ditandatangani");
    const run = await runSubscriptionBilling(T_OCT1);
    expect(run.issued.find((i) => i.contractId === rej.contract.id)).toBeUndefined();
    const issued = run.issued.find((i) => i.contractId === res.contract.id)!;
    expect(issued).toMatchObject({ outletCount: 1, amount: 175_000 });
  });

  it("US-P3-09 KP-1 faktur berulang terbit tgl 1 untuk bulan lalu: outlet AKTIF × tarif (PAR-35), jatuh tempo PAR-12; idempoten; belum tanggal terbit → tidak terbit", async () => {
    const p = await setupPartner(t.db);
    // Outlet kedua belum Aktif (onboarding belum lengkap) → tidak ditagih.
    await t.db.insert(outlets).values({ tenantId: p.tenantId, code: "M02", name: "Depot mitra kedua", kind: "depot", activatedOn: null });
    const early = await runSubscriptionBilling(at("2026-09-30T05:00:00Z"));
    expect(early.issued.find((i) => i.tenantId === p.tenantId)).toBeUndefined();
    const run = await runSubscriptionBilling(T_OCT1);
    expect(run.serviceMonth).toBe("2026-09");
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    expect(mine).toMatchObject({ outletCount: 1, amount: 150_000, l5Amount: 150_000 });
    const [inv] = await invoicesOf(t.db, p.customerId);
    expect(inv).toMatchObject({ issueDate: "2026-10-01", dueDate: "2026-10-15", periodMonth: "2026-09-01", partnerContractId: p.contractId, amount: 150_000, status: "open" });
    expect(inv!.number).toMatch(/^F-26-\d{6}$/);
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    expect(lines.map((l) => l.component)).toEqual(["subscription"]);
    expect((await runSubscriptionBilling(T_OCT1)).issued.find((i) => i.tenantId === p.tenantId)).toBeUndefined();
    expect(await invoicesOf(t.db, p.customerId)).toHaveLength(1);
    // Terbitkan sekarang: izin Admin Keuangan; sebelum tanggal terbit ditolak dengan pesan.
    await expect(runSubscriptionBillingNow(dispatcher(T_OCT1))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runSubscriptionBillingNow(finance(at("2026-10-20T02:00:00Z")), { date: "2026-10-20" })).resolves.toMatchObject({ serviceMonth: "2026-09" });
    const again = await runSubscriptionBillingNow(finance(at("2026-10-31T03:00:00Z")), { date: "2026-10-31" });
    expect(again.issued.find((i) => i.tenantId === p.tenantId)).toBeUndefined();
    expect(again.skipped.find((s) => s.contractId === p.contractId)?.reason).toMatch(/Sudah terbit/);
  });

  it("US-P3-09 KP-2 faktur mengikuti M5 (pelunasan, umur piutang lini Kemitraan); mitra bertanda tagihan bulanan menggabungkan rit air tempo belum ditagih (BR-05)", async () => {
    const p = await setupPartner(t.db, { creditStatus: "credit", creditLimit: 5_000_000, contract: { monthlyBilling: true, creditLimit: 5_000_000 } });
    const [cust] = await t.db.select().from(customers).where(eq(customers.id, p.customerId));
    expect(cust).toMatchObject({ monthlyBilling: true, creditLimit: 5_000_000, creditStatus: "credit" });
    await t.db.insert(unbilledCharges).values([
      { tenantId: EQUA_TENANT_ID, customerId: p.customerId, serviceDate: "2026-09-12", description: "Rit air P-26-000001/1 (tempo)", amount: 200_000, volumeL: 5_000 },
      { tenantId: EQUA_TENANT_ID, customerId: p.customerId, serviceDate: "2026-09-20", description: "Rit air P-26-000002/1 (tempo)", amount: 200_000, volumeL: 5_000 },
    ]);
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    expect(mine).toMatchObject({ amount: 550_000, l5Amount: 150_000 });
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, mine.invoiceId));
    expect(lines.map((l) => l.component).sort()).toEqual(["subscription", "water", "water"]);
    const charges = await t.db.select().from(unbilledCharges).where(eq(unbilledCharges.customerId, p.customerId));
    expect(charges.every((c) => c.status === "billed" && c.invoiceId === mine.invoiceId)).toBe(true);
    // Umur piutang lini "Kemitraan" (M5) memuat faktur ini.
    const aging = await agingReport(finance(T_OCT1), { line: "partner" });
    expect(JSON.stringify(aging)).toContain(p.customerId);
    // Pelunasan M5 → Lunas.
    await recordOfficePayment(finance(at("2026-10-05T03:00:00Z")), { customerId: p.customerId, businessDate: "2026-10-05", amount: 550_000, method: "cash" });
    const [paid] = await t.db.select().from(invoices).where(eq(invoices.id, mine.invoiceId));
    expect(paid).toMatchObject({ status: "paid", outstandingAmount: 0 });
  });

  it("US-P3-09 KP-3 jurnal otomatis pendapatan langganan sistem pada pusat laba L5 (US-M11-02); Opsi B tanpa royalti", async () => {
    const p = await setupPartner(t.db);
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, mine.invoiceId));
    expect(lines.some((l) => l.component === "royalty")).toBe(false);
    const [j] = await t.db.select().from(journals).where(and(eq(journals.sourceObjectType, "invoice"), eq(journals.sourceObjectId, mine.invoiceId)));
    expect(j).toBeTruthy();
    const jl = await t.db.select().from(journalLines).where(eq(journalLines.journalId, j!.id));
    const credit = jl.find((l) => l.credit > 0)!;
    expect(credit).toMatchObject({ profitCenter: "L5", credit: 150_000, accountId: accountId("4-1401") });
  });

  it("US-P3-09 KP-4 faktur tidak dapat dihapus (DB menolak); koreksi lewat nota kredit beralasan (BR-38)", async () => {
    const p = await setupPartner(t.db);
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    const del = await t.db.delete(invoices).where(eq(invoices.id, mine.invoiceId)).catch((e: unknown) => e);
    expect(sqlState(del)).toBe("EQ001");
    const cn = await requestCreditNote(finance(at("2026-10-02T03:00:00Z")), { invoiceId: mine.invoiceId, amount: 50_000, reason: "Outlet kedua libur, potong sebagian langganan" });
    expect(cn.status).toBe("issued");
    const [inv] = await t.db.select().from(invoices).where(eq(invoices.id, mine.invoiceId));
    expect(inv).toMatchObject({ creditedAmount: 50_000, outstandingAmount: 100_000 });
    expect(await t.db.select().from(creditNotes).where(eq(creditNotes.invoiceId, mine.invoiceId))).toHaveLength(1);
  });
});

describe("US-P3-04 Royalti/fee otomatis, tagihan mitra, dan pembayaran (Tahap 3, flag)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await ensurePeriod(t.db, "2026-09");
    await ensurePeriod(t.db, "2026-10");
    await ensurePeriod(t.db, "2026-11");
  });
  afterAll(() => setActorResolver(null));

  it("US-P3-04 KP-1 Opsi A hanya dengan portal Tahap 3 aktif; tgl 1: langganan × outlet + royalti % × omzet POS Sah tanpa void + fee awal sekali + tempo belum ditagih = satu faktur M5 berrincian, jatuh tempo tgl 15", async () => {
    const p = await setupPartner(t.db, { contract: false, creditStatus: "credit", creditLimit: 3_000_000 });
    await expect(createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 4, waterDiscountPercent: 5, reason: "Waralaba" })).rejects.toThrow(/Tahap 3/);
    await enablePhase3();
    await expect(createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 9, waterDiscountPercent: 5, reason: "Royalti di luar batas" })).rejects.toThrow(/PAR-35/);
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 4, waterDiscountPercent: 5, initialFee: 10_000_000, monthlyBilling: true, creditLimit: 3_000_000, reason: "Waralaba Opsi A" });
    await approvals.decide(owner(), res.approval.id, "approve", "Setuju");
    await insertSale(t.db, p, { businessDate: "2026-09-11", gallons: 100 });
    await insertSale(t.db, p, { businessDate: "2026-09-12", gallons: 60 });
    await insertSale(t.db, p, { businessDate: "2026-09-12", gallons: 20, status: "voided" });
    await t.db.insert(unbilledCharges).values({ tenantId: EQUA_TENANT_ID, customerId: p.customerId, serviceDate: "2026-09-15", description: "Rit air tempo", amount: 190_000, volumeL: 5_000 });
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    // Omzet Sah = (100 + 60) × 5.000 = 800.000 → royalti 4% = 32.000.
    expect(mine).toMatchObject({ l5Amount: 150_000 + 32_000 + 10_000_000, amount: 150_000 + 32_000 + 10_000_000 + 190_000 });
    const lines = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, mine.invoiceId));
    expect(lines.map((l) => l.component).sort()).toEqual(["other", "royalty", "subscription", "water"]);
    const [inv] = await t.db.select().from(invoices).where(eq(invoices.id, mine.invoiceId));
    expect(inv).toMatchObject({ dueDate: "2026-10-15" });
    // Bulan berikutnya: fee awal tidak ditagih lagi.
    const [contract] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, res.contract.id));
    const nextBill = await withTx((tx) => computePartnerBill(tx, contract!, "2026-10"));
    expect(nextBill.initialFee).toBe(0);
    await disablePhase3();
  });

  it("US-P3-04 KP-2 rincian royalti menampilkan omzet per outlet per hari; mitra dapat mengajukan sengketa ≤ 7 hari (lewat portal)", async () => {
    await enablePhase3();
    const p = await setupPartner(t.db, { contract: false });
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 3, waterDiscountPercent: 5, reason: "Waralaba" });
    await approvals.decide(owner(), res.approval.id, "approve", "Setuju");
    await insertSale(t.db, p, { businessDate: "2026-09-11", gallons: 10 });
    await insertSale(t.db, p, { businessDate: "2026-09-13", gallons: 30 });
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    const calc = await royaltyDetail(finance(T_OCT1), { contractId: res.contract.id, month: "2026-09" });
    const detail = (calc!.detail as { royaltyDetail: { businessDate: string; sales: number; outletId: string }[] }).royaltyDetail;
    expect(detail.map((d) => [d.businessDate, d.sales])).toEqual([
      ["2026-09-11", 50_000],
      ["2026-09-13", 150_000],
    ]);
    expect(detail.every((d) => d.outletId === p.outletId)).toBe(true);
    // Sengketa lewat portal (pemilik mitra, flag aktif): ≤ 7 hari diterima, sesudahnya ditolak.
    await expect(disputePartnerInvoice(p.portal(at("2026-10-12T03:00:00Z")), { invoiceId: mine.invoiceId, note: "Omzet tanggal 13 termasuk transaksi uji coba" })).rejects.toThrow(/7 hari/);
    const disputed = await disputePartnerInvoice(p.portal(at("2026-10-05T03:00:00Z")), { invoiceId: mine.invoiceId, note: "Omzet tanggal 13 termasuk transaksi uji coba" });
    expect(disputed.disputeStatus).toBe("disputed");
    // Tagihan mitra lain → tidak ditemukan.
    const q = await setupPartner(t.db);
    await expect(disputePartnerInvoice(q.portal(at("2026-10-05T03:00:00Z")), { invoiceId: mine.invoiceId, note: "Mencoba tagihan mitra lain" })).rejects.toBeInstanceOf(NotFoundError);
    await disablePhase3();
    // Flag mati → tindakan portal Tahap 3 ditolak (pemilik mitra baca-saja RL-7).
    await expect(disputePartnerInvoice(p.portal(at("2026-10-05T03:00:00Z")), { invoiceId: mine.invoiceId, note: "Flag mati, harus ditolak" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-P3-04 KP-4 jurnal L5 hanya untuk langganan + royalti + fee awal; air tempo yang digabung tidak dijurnal ulang (D-10)", async () => {
    await enablePhase3();
    const p = await setupPartner(t.db, { contract: false, creditStatus: "credit", creditLimit: 2_000_000 });
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 5, waterDiscountPercent: 5, monthlyBilling: true, creditLimit: 2_000_000, reason: "Waralaba" });
    await approvals.decide(owner(), res.approval.id, "approve", "Setuju");
    await insertSale(t.db, p, { businessDate: "2026-09-11", gallons: 100 });
    await t.db.insert(unbilledCharges).values({ tenantId: EQUA_TENANT_ID, customerId: p.customerId, serviceDate: "2026-09-15", description: "Rit air tempo", amount: 190_000, volumeL: 5_000 });
    const run = await runSubscriptionBilling(T_OCT1);
    const mine = run.issued.find((i) => i.tenantId === p.tenantId)!;
    const [j] = await t.db.select().from(journals).where(and(eq(journals.sourceObjectType, "invoice"), eq(journals.sourceObjectId, mine.invoiceId)));
    const jl = await t.db.select().from(journalLines).where(eq(journalLines.journalId, j!.id));
    expect(jl.filter((l) => l.credit > 0).reduce((s, l) => s + l.credit, 0)).toBe(150_000 + 25_000);
    expect(jl.filter((l) => l.credit > 0).every((l) => l.profitCenter === "L5")).toBe(true);
    await disablePhase3();
  });

  it("US-P3-04 KP-5 perubahan parameter kontrak (royalti %, langganan) berlaku mulai periode berikutnya & berjejak", async () => {
    await enablePhase3();
    const p = await setupPartner(t.db, { contract: false });
    const res = await createContract(finance(), { tenantId: p.tenantId, customerId: p.customerId, option: "option_a", startDate: "2026-08-01", royaltyPercent: 3, waterDiscountPercent: 5, reason: "Waralaba" });
    await approvals.decide(owner(), res.approval.id, "approve", "Setuju");
    const prop = await proposeContractTerms(finance(at("2026-09-20T03:00:00Z")), { contractId: res.contract.id, royaltyPercent: 5, subscriptionFeePerOutlet: 200_000, reason: "Adendum kontrak Oktober" });
    expect(prop.effectiveFrom).toBe("2026-10-01");
    await approvals.decide(owner(at("2026-09-21T03:00:00Z")), prop.approval.id, "approve", "Setuju adendum");
    const [c] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, res.contract.id));
    const sept = await withTx((tx) => computePartnerBill(tx, c!, "2026-09"));
    const oct = await withTx((tx) => computePartnerBill(tx, c!, "2026-10"));
    expect(sept.terms).toMatchObject({ royaltyBp: 300, subscriptionFeePerOutlet: 150_000 });
    expect(oct.terms).toMatchObject({ royaltyBp: 500, subscriptionFeePerOutlet: 200_000 });
    // Job siklus kontrak menerapkan parameter pada tanggal berlakunya (berjejak).
    const life = await runContractLifecycle(at("2026-10-01T00:00:00Z"));
    expect(life.termsApplied).toContain(res.contract.id);
    const [after] = await t.db.select().from(partnerContracts).where(eq(partnerContracts.id, res.contract.id));
    expect(after).toMatchObject({ royaltyBp: 500, subscriptionFeePerOutlet: 200_000, pendingTerms: null });
    const trail = await withTx((tx) => auditQuery(tx, { objectType: "partner_contract", objectId: res.contract.id }));
    const actions = trail.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["propose_terms", "schedule_terms", "apply_terms"]));
    await disablePhase3();
    void inArray;
    void T_SEPT;
  });
});
