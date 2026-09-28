import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { incomingTransfers, officeCashMovements } from "@/db/schema";
import { EQUA_TENANT_ID, customerId } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import { getApprovalHandlers } from "@/server/core/approvals";
import { systemContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { emit, listHandlers } from "@/server/core/events";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs, runJobNow } from "@/server/core/jobs";
import { listPullProviders } from "@/server/core/sync";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createPartnerTenant } from "../helpers/db-fixtures";
import { finance, owner } from "./helpers";

describe("M4 — registrasi modul (event, persetujuan, job, laporan, pull)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  const date = toBusinessDate(new Date());

  it("US-M4-04 KP-1 handler event M4 terdaftar untuk sumber transfer & kas kantor; persetujuan cash_discrepancy/petty_cash/cash_close_exception/correction", () => {
    expect(listHandlers("trip.payment_recorded")).toContain("m4-cash:transfer_trip_payment");
    expect(listHandlers("collection.recorded")).toContain("m4-cash:transfer_collection");
    expect(listHandlers("shift.closed")).toContain("m4-cash:transfer_qris_shift");
    expect(listHandlers("deposit.submitted")).toContain("m4-cash:transfer_bank_slip");
    expect(listHandlers("supplier_payment.recorded")).toContain("m4-cash:supplier_payment_cash");
    for (const type of ["cash_discrepancy", "petty_cash", "cash_close_exception"] as const) expect(getApprovalHandlers(type)?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("cash_close_exception")?.onExpired).toBeTypeOf("function");
    expect(getApprovalHandlers("correction", "bank_deposit")?.onApproved).toBeTypeOf("function");
    expect(getApprovalHandlers("correction", "restitution_settlement")?.onApproved).toBeTypeOf("function");
    const pull = listPullProviders().find(([k]) => k === "m4.my_cash");
    expect(pull?.[1].roles).toEqual(expect.arrayContaining(["driver", "depot_operator", "store_cashier"]));
  });

  it("US-M4-04 KP-4 job M4 terdaftar & berjalan idempoten (tidak ditemukan, slip, belum setor, setoran tertunda)", async () => {
    const keys = listJobs().map((j) => j.key);
    expect(keys).toEqual(expect.arrayContaining(["m4.transfer.not_found_check", "m4.transfer.slip_sweep", "m4.deposit.not_submitted_check", "m4.cash_close_exception.due_check"]));
    for (const k of ["m4.transfer.slip_sweep", "m4.deposit.not_submitted_check", "m4.cash_close_exception.due_check"]) {
      const r = await runJobNow(k, new Date());
      expect(r.status, `${k}: ${r.error ?? ""}`).toBe("succeeded");
    }
  });

  it("US-M4-01 KP-5 setiap laporan M4 dapat diekspor Excel & PDF oleh pemilik/Admin Keuangan", async () => {
    const reports = listReports().filter((r) => r.key.startsWith("m4."));
    expect(reports.map((r) => r.key).sort()).toEqual(
      [
        "m4.bank_deposits",
        "m4.cash_days",
        "m4.cash_position",
        "m4.daily_matching",
        "m4.deposits",
        "m4.discrepancies",
        "m4.discrepancy_history",
        "m4.incoming_transfers",
        "m4.office_cash",
        "m4.petty_cash",
        "m4.restitution_recap",
        "m4.restitutions",
        "m4.statement_lines",
      ].sort(),
    );
    for (const r of reports) {
      const x = await exportReport(owner(), r.key, "xlsx", {});
      expect(x.body.length, r.key).toBeGreaterThan(0);
      const p = await exportReport(finance(), r.key, "pdf", {});
      expect(p.contentType, r.key).toContain("pdf");
    }
  });

  it("US-M4-05 KP-3 pembayaran pemasok tunai (M7) → mutasi kas kantor keluar; pembalik → masuk (B-21)", async () => {
    const paymentId = newId();
    const ctx = systemContext({ tenantId: EQUA_TENANT_ID });
    await withTx((tx) => emit(tx, "supplier_payment.recorded", { supplierPaymentId: paymentId, supplierId: newId(), amount: 300_000, method: "cash", businessDate: date }, { ctx }));
    const out = (await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, paymentId)))[0]!;
    expect(out).toMatchObject({ kind: "supplier_payment", direction: "out", amount: 300_000 });
    const revId = newId();
    await withTx((tx) => emit(tx, "supplier_payment.recorded", { supplierPaymentId: revId, supplierId: newId(), amount: -300_000, method: "cash", businessDate: date, reversalOfId: paymentId, reason: "Salah bayar" }, { ctx }));
    const back = (await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, revId)))[0]!;
    expect(back).toMatchObject({ direction: "in", amount: 300_000, reversalOfId: out.id });
    // Transfer tidak mengubah kas kantor.
    const trfId = newId();
    await withTx((tx) => emit(tx, "supplier_payment.recorded", { supplierPaymentId: trfId, supplierId: newId(), amount: 100_000, method: "transfer", businessDate: date }, { ctx }));
    expect(await t.db.select().from(officeCashMovements).where(eq(officeCashMovements.sourceObjectId, trfId))).toHaveLength(0);
  });

  it("US-M4-04 KP-1 kas & transfer tenant mitra tidak masuk M4 EQUA (US-M6-07 KP-3)", async () => {
    const partner = await createPartnerTenant(t.db);
    const paymentId = newId();
    await withTx((tx) =>
      emit(
        tx,
        "collection.recorded",
        { customerPaymentId: paymentId, customerId: customerId("PLG-0001"), amount: 90_000, channel: "store", method: "transfer", allocations: [], advanceAmount: 0 },
        { ctx: systemContext({ tenantId: partner.tenantId }) },
      ),
    );
    expect(await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceObjectId, paymentId))).toHaveLength(0);
  });
});
