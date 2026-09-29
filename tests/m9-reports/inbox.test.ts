import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { discrepancies, fleetEvents, notifications, orders, unitPaperWithdrawals, waterBalances } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername, waterSourceId } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as notificationsCore from "@/server/core/notifications";
import { NOTIFICATION_EVENTS, notify } from "@/server/core/notifications";
import * as m4 from "@/server/modules/m4-cash";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTruck } from "../helpers/fixtures";
import { PRICE, driverDay, finance as m4Finance } from "../m4-cash/helpers";
import { dispatcher, earlyWithdrawalRequest, finance, makeTrip, owner } from "./helpers";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Kode 6.3 yang pengirimnya belum ada di cabang ini — alasan tercatat (hand-off M9). */
const PENDING_EMITTERS: Record<string, string> = {
  "partner.water_order_sla": "Tahap 3 (portal mitra)",
  "partner.support_sla": "Tahap 3 (portal mitra)",
  "access.request_pending": "M10 memakai approval.requested untuk permintaan akses (6.2a)",
};

/** Peristiwa berprioritas M yang wajib dibangun bersama modul asalnya (US-M9-04 KP-1). */
const PRIORITY_M = ["discrepancy.over_threshold", "deposit.not_received_at_close", "credit.on_hold", "trip.underpayment", "transfer.not_found", "gps.device_dead", "sync.mass_failure"];

describe("M9 — kotak masuk pengecualian & notifikasi pemilik (US-M9-04)", () => {
  const t = useTestDb({ seed: true });
  const today = toBusinessDate(new Date());

  beforeAll(() => bootstrapForTests());

  it("US-M9-04 KP-1 setiap peristiwa Bab 6.3 punya pengirim di modul asalnya; peristiwa prioritas M semuanya dibangun", () => {
    const files = sourceFiles(join(process.cwd(), "src/server")).filter((f) => !f.endsWith("notifications/catalog.ts") && !f.endsWith("events.types.ts") && !f.includes("m9-reports/service/inbox.ts"));
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    // Kotak masuk M9 hanya MEMBACA kode lain; pengirimannya sendiri = `event: "<kode>"`.
    const inboxText = readFileSync(join(process.cwd(), "src/server/modules/m9-reports/service/inbox.ts"), "utf8");
    const emitted = (code: string) => text.includes(`"${code}"`) || inboxText.includes(`event: "${code}"`);
    const missing = NOTIFICATION_EVENTS.map((e) => e.code).filter((code) => !emitted(code));
    expect(missing.filter((c) => !(c in PENDING_EMITTERS))).toEqual([]);
    for (const code of PRIORITY_M) expect(missing, code).not.toContain(code);
    // Kode M9 sendiri dikirim M9.
    const m9Text = sourceFiles(join(process.cwd(), "src/server/modules/m9-reports")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const code of ["daily_summary.published", "monthly_report.final", "inbox.explanation_requested"]) expect(m9Text).toContain(`event: "${code}"`);
  });

  it("US-M9-04 KP-2 kotak masuk \"Perlu tindakan\" per jenis (persetujuan, selisih, rit gagal, GPS, susut air) + \"Info\"; tindakan langsung setujui/tolak/minta keterangan", async () => {
    // Persetujuan menunggu: dua pengajuan tarik nota kertas lebih awal (PAR-84).
    const a1 = await earlyWithdrawalRequest(t.db, { start: addDays(today, -9) });
    const a2 = await earlyWithdrawalRequest(t.db, { start: addDays(today, -8) });
    // Selisih ≥ ambang menunggu pemilik (alur M3 → M4 nyata).
    const d = await driverDay(t.db, { trips: 1 });
    await m4.receiveDeposit(m4Finance(new Date()), { depositId: d.depositId, receivedAmount: PRICE - 60_000, discrepancyReason: "wrong_change" });
    const [disc] = await t.db.select().from(discrepancies).where(eq(discrepancies.depositId, d.depositId));
    // Rit gagal yang perlu dijadwal ulang.
    const failed = await makeTrip(t.db, { date: today, status: "failed", failReason: "customer_absent" });
    await t.db.update(orders).set({ needsReschedule: true }).where(eq(orders.id, failed.orderId));
    // Anomali GPS sudah dijelaskan sopir, menunggu tinjauan pemilik.
    const truck = await createTruck(t.db);
    const [gps] = await t.db
      .insert(fleetEvents)
      .values({ tenantId: EQUA_TENANT_ID, kind: "off_hours_trip", status: "explained", truckId: truck.id, businessDate: today, startedAt: new Date(), requiresExplanation: true, explanation: "Mengisi BBM di luar jam" })
      .returning();
    // Susut air dengan penjelasan operator.
    const [bal] = await t.db
      .insert(waterBalances)
      .values({ tenantId: EQUA_TENANT_ID, waterSourceId: waterSourceId("SA2"), businessDate: addDays(today, -1), status: "investigating", lossPct: 7.5, lossL: 1500, investigationReason: "leakage", investigationNote: "Pipa bocor", investigatedBy: userIdByUsername("produksi2") })
      .returning();
    // Info: notifikasi non-tindakan.
    await withTx((tx) => notify(tx, { event: "special_price.review_due", tenantId: EQUA_TENANT_ID, title: "Harga khusus Hotel Uji lewat 6 bulan", objectType: "customer", objectId: failed.customerId, link: "/master/pelanggan" }));

    const box = await m9.getInbox(owner());
    const kinds = box.action.map((g) => g.kind);
    expect(kinds).toEqual(expect.arrayContaining(["approval", "discrepancy", "failed_trip", "gps", "water_loss"]));
    const group = (k: string) => box.action.find((g) => g.kind === k)!;
    expect(group("approval").label).toBe("Persetujuan menunggu");
    const ap1 = group("approval").items.find((i) => i.id === a1.approvalId)!;
    expect(ap1).toMatchObject({ actions: ["approve", "reject", "request_explanation"], link: `/persetujuan?id=${a1.approvalId}` });
    expect(group("discrepancy").items.find((i) => i.id === disc!.id)).toMatchObject({ valueText: expect.stringContaining("60.000"), actions: ["approve", "reject", "request_explanation"] });
    expect(group("failed_trip").items.find((i) => i.id === failed.id)!.body).toMatch(/Pelanggan tidak ada/);
    expect(group("gps").items.find((i) => i.id === gps!.id)).toMatchObject({ actions: ["approve", "request_explanation"], approveLabel: "Terima alasan" });
    expect(group("water_loss").items.find((i) => i.id === bal!.id)!.body).toMatch(/Kebocoran — Pipa bocor/);
    const info = box.info.find((i) => i.title.startsWith("Harga khusus Hotel Uji"))!;
    expect(info).toMatchObject({ kind: "info", actions: ["done"] });
    expect(box.actionCount).toBe(box.action.reduce((s, g) => s + g.items.length, 0));

    // Tindakan langsung.
    const o = owner();
    await expect(m9.actOnInboxItem(o, { itemKind: "approval", itemId: a2.approvalId, action: "reject" })).rejects.toThrow(/Alasan wajib/);
    expect((await m9.actOnInboxItem(o, { itemKind: "approval", itemId: a1.approvalId, action: "approve" })).message).toBe("Permintaan disetujui.");
    const [w1] = await t.db.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, a1.withdrawalId));
    expect(w1).toMatchObject({ withdrawnDate: a1.withdrawnDate, earlyWithdrawalApprovedBy: userIdByUsername("pemilik") });
    await m9.actOnInboxItem(o, { itemKind: "approval", itemId: a2.approvalId, action: "request_explanation", note: "Mengapa unit ini perlu ditarik lebih awal?" });
    const asked = await t.db.select().from(notifications).where(and(eq(notifications.event, "inbox.explanation_requested"), eq(notifications.objectId, a2.approvalId)));
    expect(asked.map((n) => n.recipientUserId)).toEqual([userIdByUsername("keuangan1")]);
    await m9.actOnInboxItem(o, { itemKind: "approval", itemId: a2.approvalId, action: "reject", note: "Tunggu genap 14 hari" });
    const [w2] = await t.db.select().from(unitPaperWithdrawals).where(eq(unitPaperWithdrawals.id, a2.withdrawalId));
    expect(w2!.withdrawnDate).toBeNull();

    await m9.actOnInboxItem(o, { itemKind: "discrepancy", itemId: disc!.id, action: "approve" });
    expect((await t.db.select().from(discrepancies).where(eq(discrepancies.id, disc!.id)))[0]).toMatchObject({ decision: "approved" });
    await m9.actOnInboxItem(o, { itemKind: "failed_trip", itemId: failed.id, action: "request_explanation", note: "Sudah dihubungi ulang?" });
    const toDispatch = await t.db.select().from(notifications).where(and(eq(notifications.event, "inbox.explanation_requested"), eq(notifications.objectId, failed.id)));
    expect(toDispatch.map((n) => n.recipientUserId)).toEqual(expect.arrayContaining([userIdByUsername("dispatcher1"), userIdByUsername("dispatcher2")]));
    await m9.actOnInboxItem(o, { itemKind: "gps", itemId: gps!.id, action: "approve" });
    expect((await t.db.select().from(fleetEvents).where(eq(fleetEvents.id, gps!.id)))[0]!.status).toBe("done");
    await m9.actOnInboxItem(o, { itemKind: "water_loss", itemId: bal!.id, action: "approve", note: "Perbaikan pipa dijadwalkan" });
    expect((await t.db.select().from(waterBalances).where(eq(waterBalances.id, bal!.id)))[0]!.status).toBe("done");
    await m9.actOnInboxItem(o, { itemKind: "info", itemId: info.id, action: "done" });
    expect((await t.db.select().from(notifications).where(eq(notifications.id, info.id)))[0]!.status).toBe("done");
    await expect(m9.actOnInboxItem(o, { itemKind: "failed_trip", itemId: failed.id, action: "approve" })).rejects.toThrow(/tidak tersedia/);

    const after = await m9.getInbox(owner());
    const keys = after.action.flatMap((g) => g.items.map((i) => i.key));
    for (const k of [`approval:${a1.approvalId}`, `approval:${a2.approvalId}`, `discrepancy:${disc!.id}`, `gps:${gps!.id}`, `water_loss:${bal!.id}`]) expect(keys).not.toContain(k);
    expect(after.info.find((i) => i.id === info.id)).toBeUndefined();

    // Admin Keuangan melihat kotak masuk tetapi tidak memutuskan selisih; Dispatcher tidak berhak.
    const fa = await m9.getInbox(finance());
    expect(fa.action.every((g) => g.kind !== "discrepancy" || g.items.every((i) => !i.actions.includes("approve")))).toBe(true);
    await expect(m9.getInbox(dispatcher())).rejects.toThrow(/tidak diizinkan/);
  });

  it("US-M9-04 KP-3 pengaturan per jenis: seketika / ringkasan harian / mati; peristiwa kritis tidak dapat dimatikan", async () => {
    const o = owner();
    await notificationsCore.setPreference(o, "daily_summary.published", "daily_digest");
    await notificationsCore.setPreference(o, "monthly_report.final", "off");
    await expect(notificationsCore.setPreference(o, "discrepancy.over_threshold", "off")).rejects.toThrow();
    const prefs = await notificationsCore.getPreferences(o);
    const pref = (code: string) => prefs.items.find((p) => p.event === code)!;
    expect(pref("daily_summary.published")).toMatchObject({ mode: "daily_digest" });
    expect(pref("monthly_report.final")).toMatchObject({ mode: "off" });
    expect(pref("discrepancy.over_threshold")).toMatchObject({ mode: "immediate", canDisable: false });
    // Jam tenang non-kritis (bawaan PAR-56) dapat diatur per pengguna.
    await notificationsCore.setQuietHours(o, { start: "22:00", end: "05:30" });
    expect((await notificationsCore.getPreferences(o)).quietHours).toEqual({ start: "22:00", end: "05:30" });
    await notificationsCore.setQuietHours(o, null);
    await notificationsCore.setPreference(o, "monthly_report.final", "immediate");
  });

  it("US-M9-04 KP-4 butir lewat tenggat naik ke puncak dan bertanda; selisih lewat 24 jam dihitung KPI-03", async () => {
    const now = new Date();
    // Selisih lama (30 jam) dan baru (1 jam) menunggu pemilik.
    const [oldD] = await t.db
      .insert(discrepancies)
      .values({ tenantId: EQUA_TENANT_ID, source: "driver", businessDate: addDays(today, -2), amount: -75_000, requiresOwnerDecision: true, status: "explained", explanation: "Salah kembalian", createdAt: new Date(now.getTime() - 30 * 3_600_000) })
      .returning();
    const [newD] = await t.db
      .insert(discrepancies)
      .values({ tenantId: EQUA_TENANT_ID, source: "driver", businessDate: today, amount: -55_000, requiresOwnerDecision: true, status: "formed", createdAt: new Date(now.getTime() - 3_600_000) })
      .returning();
    const box = await m9.getInbox(owner(now));
    expect(box.action[0]!.kind).toBe("discrepancy");
    const items = box.action[0]!.items;
    const iOld = items.findIndex((i) => i.id === oldD!.id);
    const iNew = items.findIndex((i) => i.id === newD!.id);
    expect(items[iOld]!.overdue).toBe(true);
    expect(items[iNew]!.overdue).toBe(false);
    expect(iOld).toBeLessThan(iNew);
    expect(box.overdueCount).toBeGreaterThanOrEqual(1);
    expect(box.kpi03).toMatchObject({ followUpHours: 24 });
    expect(box.kpi03.overdue).toBeGreaterThanOrEqual(1);
    // Rumus KPI-03 yang sama dipakai laporan KPI (satu definisi).
    const kpi = await m4.kpi03(t.db, EQUA_TENANT_ID, { from: addDays(today, -60), to: today, now });
    expect(kpi.overdue).toBe(box.kpi03.overdue);
    expect(await m9.inboxCount(owner(now))).toMatchObject({ count: box.actionCount, overdue: box.overdueCount });
  });

  it("B-58 US-M9-04 KP-2 lencana menu Kotak masuk = hitungan COUNT murah (angka sama dengan kotak masuk penuh) + cache singkat per pengguna", async () => {
    const now = new Date();
    m9.clearInboxBadgeCache();
    const box = await m9.getInbox(owner(now));
    const badge = await m9.inboxBadgeCount(owner(now));
    expect(badge).toEqual({ count: box.actionCount, overdue: box.overdueCount });
    // Butir baru dalam jendela cache → lencana belum berubah (tanpa kueri ulang); setelah kedaluwarsa / segar → naik.
    await t.db.insert(discrepancies).values({ tenantId: EQUA_TENANT_ID, source: "driver", businessDate: today, amount: -60_000, requiresOwnerDecision: true, status: "formed", createdAt: now });
    expect(await m9.inboxBadgeCount(owner(new Date(now.getTime() + 5_000)))).toEqual(badge);
    const later = await m9.inboxBadgeCount(owner(new Date(now.getTime() + 60_000)));
    expect(later.count).toBe(badge.count + 1);
    expect(await m9.inboxBadgeCount(owner(now), { fresh: true })).toEqual({ count: (await m9.getInbox(owner(now))).actionCount, overdue: (await m9.getInbox(owner(now))).overdueCount });
    // Pengguna tanpa izin kotak masuk ditolak (lencana tidak tampil).
    await expect(m9.inboxBadgeCount(dispatcher(now))).rejects.toThrow();
  });
});
