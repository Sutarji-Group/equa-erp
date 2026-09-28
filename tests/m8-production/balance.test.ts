import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { attachments, domainEvents, tankLevelReadings, waterBalances } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { addDays } from "@/lib/time";
import { exportReport } from "@/server/core/export";
import { acceptLossInvestigation, computeMonthlyBalance, monthlyWaterBalance, returnLossInvestigation, verifyNegativeBalance } from "@/server/modules/m8-production";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, productionWorld, type ProdWorld } from "./helpers";

describe("M8 — neraca air harian per sumber & susut (US-M8-04)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  /** Produksi 40.000 L + pengisian pelanggan & pasokan depot → neraca. */
  async function dayWithLoss(w: ProdWorld, fills: number[], producedL = 40_000) {
    for (const [i, v] of fills.entries()) {
      const trip = await w.addTrip();
      await w.fill({ tripId: trip.id, volumeL: v, volumeReason: v === 5_000 ? undefined : "Tangki tidak diisi penuh", at: w.at(`${String(8 + i).padStart(2, "0")}:00`) });
    }
    await w.reading("morning", 1_000_000);
    return w.reading("evening", 1_000_000 + producedL);
  }

  it("US-M8-04 KP-1 neraca = produksi − Σ pengisian (termasuk pasokan depot); susut liter & %; dihitung otomatis setelah pembacaan malam", async () => {
    const w = await productionWorld(t.db);
    await w.reading("morning", 1_000_000);
    for (let i = 0; i < 7; i++) {
      const trip = await w.addTrip();
      await w.fill({ tripId: trip.id, at: w.at(`${String(8 + i).padStart(2, "0")}:00`) });
    }
    expect(await w.balance()).toBeUndefined(); // belum dihitung sebelum pembacaan malam
    await w.reading("evening", 1_038_000);
    const bal = await w.balance();
    expect(bal).toMatchObject({ producedL: 38_000, filledTotalL: 35_000, filledCustomerL: 35_000, filledDepotL: 0, lossL: 3_000, isIncomplete: false });
    expect(bal!.lossPct).toBeCloseTo(7.89, 2);
    expect(bal!.utilizationPct).toBe(70);
    const ev = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "water_balance.computed"), eq(domainEvents.objectId, bal!.id)));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0]!.payload).toMatchObject({ productionL: 38_000, fillsL: 35_000, lossL: 3_000, overThreshold: true });
    // Pengisian yang tersinkron terlambat → neraca dihitung ulang.
    const late = await w.addTrip();
    await w.fill({ tripId: late.id, at: w.at("20:00"), volumeL: 2_000, volumeReason: "Tangki tidak diisi penuh" });
    expect((await w.balance())!.lossL).toBe(1_000);
  });

  it("US-M8-04 KP-2 susut > PAR-18 → tugas investigasi operator (alasan dari daftar + foto) & laporan pemilik; Investigasi → Selesai setelah pemilik menerima", async () => {
    const w = await productionWorld(t.db);
    await dayWithLoss(w, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000]); // 40.000 − 30.000 = 25%
    const bal = (await w.balance())!;
    expect(bal.status).toBe("over_threshold");
    const notes = await w.notificationsFor("water.loss_over_threshold", bal.id);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("pemilik"))).toBe(true);
    expect(recipients.has(w.operator.userId)).toBe(true);
    expect(recipients.has(userIdByUsername("produksi1"))).toBe(false); // operator sumber lain tidak menerima
    // Tugas muncul di aplikasi operator.
    const today = await w.today(w.at("22:00"));
    expect(today.investigations.map((i) => i.waterBalanceId)).toContain(bal.id);

    // Tanpa foto ditolak; "Lainnya" wajib keterangan.
    const noPhoto = await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "leakage", note: null }, { at: w.at("22:10") });
    expect(noPhoto.status).toBe("rejected");
    const otherNoNote = await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "other", note: null }, { at: w.at("22:11"), attach: [{ kind: "loss_investigation_photo" }] });
    expect(otherNoNote.status).toBe("rejected");
    const ok = await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "leakage", note: "Pipa tandon retak" }, { at: w.at("22:15"), attach: [{ kind: "loss_investigation_photo" }] });
    expect(ok.status).toBe("applied");
    let row = (await w.balance())!;
    expect(row).toMatchObject({ status: "investigating", investigationReason: "leakage", investigationNote: "Pipa tandon retak", investigatedBy: w.operator.userId });
    const [photo] = await t.db.select().from(attachments).where(eq(attachments.id, row.investigationPhotoId!));
    expect(photo).toMatchObject({ objectType: "water_balance", objectId: bal.id });
    expect((await w.notificationsFor("water.loss_explained", bal.id)).length).toBeGreaterThan(0);

    // Pemilik mengembalikan (butuh penjelasan) → kembali di atas ambang, operator diberi tahu.
    await expect(returnLossInvestigation(finance(), { waterBalanceId: bal.id, note: "Lengkapi foto pipa" })).rejects.toThrow(/tidak diizinkan/);
    row = await returnLossInvestigation(owner(), { waterBalanceId: bal.id, note: "Lengkapi foto pipa yang retak dari dekat" });
    expect(row.status).toBe("over_threshold");
    expect((await w.notificationsFor("water.loss_explanation_returned", bal.id)).map((n) => n.recipientUserId)).toContain(w.operator.userId);
    expect((await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "leakage", note: "Foto pipa retak dari dekat" }, { at: w.at("22:40"), attach: [{ kind: "loss_investigation_photo" }] })).status).toBe("applied");
    await expect(acceptLossInvestigation(dispatcher(), { waterBalanceId: bal.id })).rejects.toThrow();
    row = await acceptLossInvestigation(owner(), { waterBalanceId: bal.id, note: "Diterima; perbaikan pipa dijadwalkan" });
    expect(row).toMatchObject({ status: "done", acceptedBy: userIdByUsername("pemilik") });
    // Setelah Selesai, investigasi baru ditolak.
    expect((await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "other", note: "ubah" }, { at: w.at("22:50"), attach: [{ kind: "loss_investigation_photo" }] })).status).toBe("rejected");
  });

  it("US-M8-04 KP-2 susut dalam batas PAR-18 → Susut normal, tanpa tugas investigasi", async () => {
    const w = await productionWorld(t.db);
    await dayWithLoss(w, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000], 41_000); // 1.000 / 41.000 = 2,44%
    const bal = (await w.balance())!;
    expect(bal.status).toBe("normal");
    expect((await w.notificationsFor("water.loss_over_threshold", bal.id)).length).toBe(0);
    const res = await w.send("m8.loss_investigation.submit", { waterBalanceId: bal.id, reason: "leakage", note: null }, { at: w.at("22:30"), attach: [{ kind: "loss_investigation_photo" }] });
    expect(res.status).toBe("rejected");
  });

  it("US-M8-04 KP-3 rata-rata susut 7 hari & level tandon opsional sebagai informasi; peringatan tetap memakai angka harian (PTB-41)", async () => {
    const w = await productionWorld(t.db);
    for (let i = 1; i <= 3; i++) {
      await t.db.insert(waterBalances).values({ tenantId: EQUA_TENANT_ID, waterSourceId: w.source.id, businessDate: addDays(w.date, -i), producedL: 40_000, filledTotalL: 39_000, lossL: 1_000, lossPct: 2.5, status: "normal" });
    }
    const lvl = await w.send("m8.tank_level.create", { tankLevelId: newId(), levelL: 18_000, notes: "Tandon utama" }, { at: w.at("20:00"), attach: [{ kind: "tank_level_photo" }] });
    expect(lvl.status).toBe("applied");
    expect((await w.send("m8.tank_level.create", { tankLevelId: newId() }, { at: w.at("20:01") })).status).toBe("rejected");
    await dayWithLoss(w, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000], 40_000); // 12,5%
    const bal = (await w.balance())!;
    expect(bal.avgLoss7dPct).toBe(2.5);
    expect(bal.status).toBe("over_threshold"); // BR-26 memakai angka harian, bukan rata-rata
    const [tank] = await t.db.select().from(tankLevelReadings).where(eq(tankLevelReadings.waterSourceId, w.source.id));
    expect(tank).toMatchObject({ levelL: 18_000, notes: "Tandon utama" });
    expect(tank!.photoAttachmentId).toBeTruthy();
    expect((await w.today(w.at("22:00"))).tankLevels.map((x) => x.levelL)).toContain(18_000);
  });

  it("US-M8-04 KP-4 neraca bulanan per sumber: produksi, pengisian pelanggan, pasokan depot, susut, rata-rata per hari + ekspor", async () => {
    const w = await productionWorld(t.db, { date: "2026-08-10" });
    await dayWithLoss(w, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000], 38_000);
    await t.db.insert(waterBalances).values({ tenantId: EQUA_TENANT_ID, waterSourceId: w.source.id, businessDate: "2026-08-11", producedL: 42_000, filledCustomerL: 30_000, filledDepotL: 10_000, filledTotalL: 40_000, lossL: 2_000, lossPct: 4.76, status: "normal" });
    const rows = await computeMonthlyBalance(t.db, EQUA_TENANT_ID, "2026-08", "2026-09-28", w.source.id);
    const row = rows.find((r) => r.sourceId === w.source.id)!;
    expect(row).toMatchObject({ producedL: 38_000, customerFillsL: 35_000, depotSupplyL: 0, lossL: 3_000 + 2_000, daysWithProduction: 1 });
    expect(row.avgLossPerDayL).toBe(2_500);
    const viaService = await monthlyWaterBalance(owner(), { month: "2026-08", sourceId: w.source.id });
    expect(viaService[0]!.lossL).toBe(5_000);
    await expect(monthlyWaterBalance(dispatcher(), { month: "2026-08" })).rejects.toThrow();
    const exp = await exportReport(owner(), "m8.water_balance_monthly", "xlsx", { month: "2026-08", sourceId: w.source.id });
    expect(exp.rowCount).toBe(1);
    const pdf = await exportReport(finance(), "m8.water_balance_daily", "pdf", { from: "2026-08-01", to: "2026-08-31", sourceId: w.source.id });
    expect(pdf.contentType).toBe("application/pdf");
  });

  it("US-M8-04 KP-5 susut negatif (pengisian > produksi) → anomali pencatatan, wajib verifikasi Admin Keuangan", async () => {
    const w = await productionWorld(t.db);
    await dayWithLoss(w, [5_000, 5_000, 5_000], 10_000); // 10.000 − 15.000 = −5.000
    const bal = (await w.balance())!;
    expect(bal).toMatchObject({ status: "negative_anomaly", lossL: -5_000 });
    const notes = await w.notificationsFor("production.missing_or_negative", bal.id);
    const recipients = new Set(notes.map((n) => n.recipientUserId));
    expect(recipients.has(userIdByUsername("keuangan1"))).toBe(true);
    expect(recipients.has(userIdByUsername("pemilik"))).toBe(true);
    await expect(verifyNegativeBalance(owner(), { waterBalanceId: bal.id, note: "Sudah dicek" })).rejects.toThrow(/tidak diizinkan/);
    const done = await verifyNegativeBalance(finance(), { waterBalanceId: bal.id, note: "Pengisian ganda T-? sudah diperiksa; meter pagi salah baca" });
    expect(done).toMatchObject({ status: "done", verifiedBy: userIdByUsername("keuangan1") });
    await expect(verifyNegativeBalance(finance(), { waterBalanceId: bal.id, note: "Ulang verifikasi" })).rejects.toThrow(/bukan susut negatif/);
  });
});
