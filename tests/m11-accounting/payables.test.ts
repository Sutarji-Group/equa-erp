import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { dataSignoffs, journalPayables } from "@/db/schema";
import { addDays } from "@/lib/time";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport } from "@/server/core/export";
import * as m11 from "@/server/modules/m11-accounting";
import { recordOpeningPayable, recordSupplierPayment } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { SP, activeSupplier, expectApplied, makeStore, receiveVia } from "../m7-store/helpers";
import { THIS_PERIOD, TODAY, accountant, at, dispatcher, finance, journalsOfSource, linesOf, manualJournal, notificationsOf, owner, pair, setPeriod } from "./helpers";

describe("M11 utang usaha kepada pemasok (US-M11-07)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());
  let supplierId = "";
  let receiptId = "";
  let manualPayableJournal = "";

  beforeAll(async () => {
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  it("US-M11-07 KP-1 utang terbentuk dari nota pembelian M7 dan jurnal manual bertanda utang; umur & jadwal; pembayaran mengurangi utang", async () => {
    const base = await m11.payablesView(accountant());
    const pos = await makeStore(t.db);
    supplierId = await activeSupplier(t.db, "CV Sumber Plastik", 14);
    const note = await receiveVia(pos, { supplierId, lines: [{ productId: SP.SABUN, quantity: 10, unitCost: 20_000 }], noteDate: TODAY, dueDate: addDays(TODAY, 14) });
    expectApplied(note.res);
    receiptId = note.receiptId;
    const nj = await journalsOfSource(t.db, "purchase_receipt", receiptId);
    expect((await linesOf(t.db, nj[0]!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["1-1501", 200_000, 0],
      ["2-1101", 0, 200_000],
    ]);

    // Jurnal manual bertanda utang (bengkel, jatuh tempo 2 hari lagi).
    await expect(
      manualJournal(finance(), { date: TODAY, description: "Servis truk belum dibayar", lines: pair("6-1401", "1-1201", 750_000, { debit: "L2" }), payable: { payeeName: "Bengkel Maju", dueDate: addDays(TODAY, 2) } }),
    ).rejects.toThrow(/harus mengkredit akun utang/);
    const mj = await manualJournal(finance(), { date: TODAY, description: "Servis truk belum dibayar", lines: pair("6-1401", "2-1101", 750_000, { debit: "L2", credit: "L4" }), payable: { payeeName: "Bengkel Maju", dueDate: addDays(TODAY, 2) } });
    manualPayableJournal = mj.draft.id;
    const [payable] = await t.db.select().from(journalPayables).where(eq(journalPayables.journalId, mj.draft.id));
    expect(payable).toMatchObject({ payeeName: "Bengkel Maju", amount: 750_000, settledAmount: 0, status: "open" });

    const view = await m11.payablesView(accountant());
    expect(view.rows.map((r) => [r.source, r.outstanding])).toEqual(expect.arrayContaining([["purchase_receipt", 200_000], ["journal", 750_000]]));
    expect(view.total - base.total).toBe(950_000);
    expect(view.bookBalance! - base.bookBalance!).toBe(950_000);
    expect(view.schedule.reduce((s, r) => s + r.amount, 0)).toBe(view.total);
    // Umur: dilihat 20 hari kemudian → nota lewat 6 hari, jurnal lewat 18 hari.
    const later = await m11.payablesView(accountant(), { asOf: addDays(TODAY, 20) });
    expect(later.rows.find((r) => r.id === receiptId)).toMatchObject({ bucket: "d1_7", daysOverdue: 6 });
    expect(later.rows.find((r) => r.source === "journal")).toMatchObject({ bucket: "d8_30", daysOverdue: 18 });

    // Pembayaran nota dari kas kantor (M7/M4) → jurnal utang / kas & sisa nota berkurang.
    const pay = await recordSupplierPayment(finance(), { supplierId, amount: 50_000, method: "cash", allocations: [{ purchaseReceiptId: receiptId, amount: 50_000 }] });
    const pj = await journalsOfSource(t.db, "supplier_payment", pay.payment.id);
    expect((await linesOf(t.db, pj[0]!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["2-1101", 50_000, 0],
      ["1-1101", 0, 50_000],
    ]);
    // Pembayaran utang jurnal manual lewat jurnal pembayaran (tidak boleh melebihi sisa).
    await expect(
      manualJournal(finance(), { date: TODAY, description: "Bayar bengkel kelebihan", lines: pair("2-1101", "1-1201", 800_000, { debit: "L4" }), settlesPayableId: payable!.id }),
    ).rejects.toThrow(/melebihi sisa utang/);
    await manualJournal(finance(), { date: TODAY, description: "Bayar bengkel sebagian", lines: pair("2-1101", "1-1201", 300_000, { debit: "L4" }), settlesPayableId: payable!.id });
    const after = await m11.payablesView(finance());
    expect(after.rows.find((r) => r.id === receiptId)).toMatchObject({ outstanding: 150_000 });
    expect(after.rows.find((r) => r.id === payable!.id)).toMatchObject({ outstanding: 450_000, paid: 300_000 });
    expect(after.bookBalance! - base.bookBalance!).toBe(after.total - base.total);
    await expect(m11.reverseManualJournal(finance(), { journalId: manualPayableJournal, reason: "Salah catat utang" })).rejects.toThrow(/sudah dibayar sebagian/);
  });

  it("US-M11-07 KP-2 saldo awal utang saat cut-over dari nota (M7) masuk saldo awal kelompok utang dan ditandatangani pemilik", async () => {
    await m11.setCutoverDate(owner(), { date: `${THIS_PERIOD}-01`, reason: "Cut-over akuntansi PT" });
    const opening = await recordOpeningPayable(finance(), { supplierId, supplierNoteNumber: "NOTA-LAMA-7", supplierNoteDate: addDays(`${THIS_PERIOD}-01`, -12), amount: 1_250_000 });
    expect(opening.isOpeningPayable).toBe(true);
    // Tidak dijurnal otomatis (masuk jurnal saldo awal).
    expect(await journalsOfSource(t.db, "purchase_receipt", opening.id)).toHaveLength(0);
    const pre = await m11.prefillOpeningGroup(finance(), { group: "payables" });
    expect(pre.lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: "2-1101", credit: 1_250_000, referenceType: "purchase_receipt", referenceId: opening.id })]));
    const batch = await m11.saveOpeningBatch(finance(), { group: "payables", lines: pre.lines.map(({ accountCode: _c, ...l }) => l) });
    await expect(m11.signOpeningBatch(finance(), { batchId: batch.id })).rejects.toBeInstanceOf(ForbiddenError);
    const signed = await m11.signOpeningBatch(owner(), { batchId: batch.id, note: "Sesuai nota pemasok" });
    expect(signed.status).toBe("signed");
    const [s] = await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, signed.signoffId!));
    expect(s).toMatchObject({ group: "opening_payables", status: "signed", signedBy: owner().userId });
    const view = await m11.payablesView(accountant());
    expect(view.rows.find((r) => r.id === opening.id)).toMatchObject({ isOpening: true, outstanding: 1_250_000 });
  });

  it("US-M11-07 KP-3 laporan utang per pemasok & jatuh tempo (ekspor) dan pengingat jatuh tempo (Bab 6.3)", async () => {
    const view = await m11.payablesView(owner());
    const sup = view.bySupplier.find((r) => r.supplierName === "CV Sumber Plastik")!;
    expect(sup.total).toBe(150_000 + 1_250_000);
    expect(view.bySupplier.find((r) => r.supplierName === "Bengkel Maju")!.total).toBe(450_000);
    const x = await exportReport(accountant(), "m11.payables", "xlsx", {});
    expect(x.rowCount).toBe(view.rows.length);
    await expect(m11.payablesView(dispatcher())).rejects.toBeInstanceOf(ForbiddenError);

    expect(await m11.runJournalPayableReminders(at(TODAY, "07:20"))).toBe(1);
    expect(await m11.runJournalPayableReminders(at(TODAY, "07:21"))).toBe(0);
    const notes = await notificationsOf(t.db, "supplier_payable.due");
    expect(notes.some((n) => n.title.includes("Bengkel Maju"))).toBe(true);
    // Jatuh tempo lewat → pengingat "jatuh tempo" terpisah sekali lagi.
    expect(await m11.runJournalPayableReminders(at(addDays(TODAY, 3), "07:20"))).toBe(1);
  });
});
