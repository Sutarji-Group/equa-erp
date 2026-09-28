import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isHardeningViolation } from "@/db/hardening";
import { notifications, pushSubscriptions, users } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, userIdByUsername } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { NotFoundError, ValidationError } from "@/server/core/errors";
import {
  canDisable,
  clearSentEmailsForTests,
  getNotificationEvent,
  getPreferences,
  list,
  markActioned,
  markActionedForObject,
  markDone,
  markRead,
  notify,
  NOTIFICATION_EVENTS,
  sendDailyDigest,
  sentEmailsForTests,
  setPreference,
  setPushSenderForTests,
  setQuietHours,
  unreadCount,
} from "@/server/core/notifications";
import * as params from "@/server/core/params";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

const DAY = new Date("2026-09-28T03:00:00Z"); // 10.00 WIB
const NIGHT = new Date("2026-09-28T16:30:00Z"); // 23.30 WIB (jam tenang PAR-56 22.00–05.00)

const pushed: string[] = [];

/** Tunggu callback setelah commit (push) selesai. */
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("Katalog notifikasi (murni)", () => {
  it("Bab 6.3 memuat peristiwa kunci dengan penerima bawaan", () => {
    expect(getNotificationEvent("discrepancy.over_threshold")).toMatchObject({ severity: "critical", deadlineHours: 24 });
    expect(getNotificationEvent("credit.on_hold")!.defaultRoles).toEqual(["dispatcher", "finance_admin", "owner"]);
    expect(getNotificationEvent("gps.device_dead")!.defaultRoles).toContain("system_admin");
    expect(new Set(NOTIFICATION_EVENTS.map((e) => e.code)).size).toBe(NOTIFICATION_EVENTS.length);
    expect(canDisable("discrepancy.over_threshold")).toBe(false);
    expect(canDisable("order.duplicate")).toBe(true);
  });
});

describe("Layanan notifikasi (US-M9-04)", () => {
  const t = useTestDb({ seed: true });

  beforeAll(() => {
    setPushSenderForTests(async (sub) => {
      pushed.push(sub.endpoint);
      return { ok: true };
    });
  });
  afterAll(() => setPushSenderForTests(null));

  it("US-M9-04 KP-1 notifikasi per peran → pengguna aktif; memuat objek, nilai, tenggat, tautan", async () => {
    const res = await withTx((tx) =>
      notify(tx, { tenantId: EQUA_TENANT_ID,
        event: "discrepancy.over_threshold",
        title: "Selisih setoran sopir T1",
        body: "Kurang Rp 75.000",
        objectType: "discrepancy",
        objectId: "d-1",
        valueAmount: -75_000,
        link: "/kas/selisih/d-1",
        now: DAY,
      }),
    );
    const owner = userIdByUsername("pemilik");
    const keu = [userIdByUsername("keuangan1"), userIdByUsername("keuangan2")];
    expect(res.recipients.sort()).toEqual([owner, ...keu].sort());
    const n = res.created.find((c) => c.recipientUserId === owner)!;
    expect(n.severity).toBe("critical");
    expect(n.valueAmount).toBe(-75_000);
    expect(n.deadlineAt?.toISOString()).toBe(new Date(DAY.getTime() + 24 * 3_600_000).toISOString());
    expect(n.status).toBe("new");
  });

  it("US-M10-01 KP-3 penerima dibatasi lingkup unit (operator depot D01 + Admin Keuangan berlingkup tenant)", async () => {
    const res = await withTx((tx) =>
      notify(tx, { tenantId: EQUA_TENANT_ID, event: "outlet_cash.over_limit", title: "Kas D01 > Rp 2 juta", recipients: { roles: ["depot_operator", "finance_admin"], scope: { outletId: outletId("D01") } }, now: DAY }),
    );
    expect(res.recipients).toContain(userIdByUsername("depot01"));
    expect(res.recipients).not.toContain(userIdByUsername("depot02"));
    expect(res.recipients).toContain(userIdByUsername("keuangan1"));
  });

  it("pengguna nonaktif tidak menerima; excludeUserIds dihormati; kode di luar katalog ditolak", async () => {
    await t.db.update(users).set({ status: "inactive" }).where(eq(users.id, userIdByUsername("dispatcher2")));
    const res = await withTx((tx) =>
      notify(tx, { tenantId: EQUA_TENANT_ID, event: "order.duplicate", title: "Pesanan dobel", excludeUserIds: [userIdByUsername("dispatcher1")], now: DAY }),
    );
    expect(res.recipients).toEqual([]);
    await t.db.update(users).set({ status: "active" }).where(eq(users.id, userIdByUsername("dispatcher2")));
    await expect(withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "tidak.ada", title: "x" }))).rejects.toThrow(/tidak dikenal/);
  });

  it("US-M9-04 KP-3 notifikasi kritis tidak dapat dimatikan; non-kritis dapat mati/ringkasan", async () => {
    const keu = seededContext("keuangan1", { now: DAY });
    await expect(setPreference(keu, "discrepancy.over_threshold", "off")).rejects.toBeInstanceOf(ValidationError);
    await expect(setPreference(keu, "discrepancy.over_threshold", "daily_digest")).rejects.toThrow(/tidak dapat dimatikan/);
    await setPreference(keu, "pos.excessive_voids", "off");
    const res = await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "pos.excessive_voids", title: "Void berlebih D03", now: DAY }));
    expect(res.skippedOff).toContain(userIdByUsername("keuangan1"));
    expect(res.recipients).toContain(userIdByUsername("keuangan2"));
    // Kritis tetap sampai walau pengguna mencoba mematikan lewat DB.
    await t.db.execute(
      sql`insert into notification_preferences (id, user_id, event, mode) values (gen_random_uuid(), ${userIdByUsername("keuangan1")}, 'transfer.not_found', 'off')`,
    );
    const crit = await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "transfer.not_found", title: "Transfer tidak ditemukan", now: DAY }));
    expect(crit.created.map((c) => c.recipientUserId)).toContain(userIdByUsername("keuangan1"));
    const prefs = await getPreferences(keu);
    expect(prefs.items.find((i) => i.event === "transfer.not_found")!.mode).toBe("immediate");
    expect(prefs.items.find((i) => i.event === "pos.excessive_voids")!.mode).toBe("off");
  });

  it("US-M9-04 KP-3 push seketika setelah commit; jam tenang menahan non-kritis; kritis tetap di-push; ringkasan tidak di-push", async () => {
    const owner = userIdByUsername("pemilik");
    await t.db.insert(pushSubscriptions).values({ userId: owner, endpoint: "https://push.test/owner", p256dh: "k", auth: "a" });
    pushed.length = 0;
    await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "trip.location_deviation", title: "Penyimpangan > 1 km", now: DAY }));
    await flush();
    expect(pushed).toEqual(["https://push.test/owner"]);

    pushed.length = 0;
    await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "trip.location_deviation", title: "Penyimpangan malam", now: NIGHT }));
    await flush();
    expect(pushed).toEqual([]);
    await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "discrepancy.trip_lock", title: "Selisih besar mengunci rit", now: NIGHT }));
    await flush();
    expect(pushed).toEqual(["https://push.test/owner"]);

    pushed.length = 0;
    const ownerCtx = seededContext("pemilik", { now: DAY });
    await setPreference(ownerCtx, "special_price.review_due", "daily_digest");
    const res = await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "special_price.review_due", title: "Harga khusus perlu ditinjau", now: DAY }));
    await flush();
    expect(res.created).toHaveLength(1);
    expect(pushed).toEqual([]);

    // Jam tenang pribadi menggantikan PAR-56.
    await setQuietHours(ownerCtx, { start: "09:00", end: "11:00" });
    await withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "trip.location_deviation", title: "Penyimpangan pagi", now: DAY }));
    await flush();
    expect(pushed).toEqual([]);
    await setQuietHours(ownerCtx, null);
  });

  it("US-M9-04 KP-1 status maju Baru → Dibaca → Ditindaklanjuti → Selesai; tidak dapat dihapus", async () => {
    const ctx = seededContext("keuangan2", { now: DAY });
    const before = await unreadCount(ctx);
    const [n] = await list(ctx, { status: "new", limit: 1 });
    expect(n).toBeDefined();
    expect((await markRead(ctx, n!.id)).status).toBe("read");
    expect(await unreadCount(ctx)).toBe(before - 1);
    expect((await markActioned(ctx, n!.id)).status).toBe("actioned");
    expect((await markRead(ctx, n!.id)).status).toBe("actioned");
    const done = await markDone(ctx, n!.id);
    expect(done.status).toBe("done");
    expect(done.doneAt).not.toBeNull();
    await expect(markRead(seededContext("keuangan1"), n!.id)).rejects.toBeInstanceOf(NotFoundError);
    const del = await t.db.delete(notifications).where(eq(notifications.id, n!.id)).catch((e: unknown) => e);
    expect(isHardeningViolation(del)).toBe(true);
  });

  it("markActionedForObject menandai notifikasi objek yang sudah diputuskan", async () => {
    const count = await withTx((tx) => markActionedForObject(tx, { objectType: "discrepancy", objectId: "d-1" }));
    expect(count).toBeGreaterThanOrEqual(1);
    const rows = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.objectType, "discrepancy"), eq(notifications.objectId, "d-1"), inArray(notifications.status, ["new", "read"])));
    expect(rows).toHaveLength(0);
  });

  it("US-M9-04 KP-3 ringkasan e-mail harian ke pemilik (PAR-55) dan penanda emailed_at", async () => {
    clearSentEmailsForTests();
    const none = await sendDailyDigest(DAY);
    expect(none.sent).toBe(false);
    await params.set(seededContext("pemilik", { now: DAY }), "notifications.digest_recipients", { emails: ["pemilik@equa.test"] }, "2026-09-28", "Alamat e-mail pemilik");
    const res = await sendDailyDigest(new Date("2026-09-28T15:30:00Z"), { tenantId: EQUA_TENANT_ID });
    expect(res.sent).toBe(true);
    expect(res.notificationCount).toBeGreaterThan(0);
    const mail = sentEmailsForTests().at(-1)!;
    expect(mail.to).toEqual(["pemilik@equa.test"]);
    expect(mail.subject).toMatch(/Ringkasan harian EQUA/);
    expect(mail.text).toMatch(/Perlu perhatian segera/);
    const again = await sendDailyDigest(new Date("2026-09-28T15:35:00Z"));
    expect(again.notificationCount).toBe(0);
  });
});

describe("Katalog notifikasi: tenggat 6.3 & lingkup unit (pasca-tinjauan)", () => {
  const t = useTestDb({ seed: true });

  it("6.3 tenggat 'permintaan akses ≤ 2 hari kerja' & insiden ≤ 30 menit dari katalog; kode berlingkup outlet wajib scope", async () => {
    const { catalogDeadline, getNotificationEvent } = await import("@/server/core/notifications");
    const fri = new Date("2026-10-02T03:00:00Z"); // Jumat 10.00 WIB
    expect(catalogDeadline(getNotificationEvent("access.request_pending")!, fri)?.toISOString()).toBe("2026-10-06T16:59:00.000Z");
    expect(catalogDeadline(getNotificationEvent("incident.opened")!, DAY)?.toISOString()).toBe(new Date(DAY.getTime() + 30 * 60_000).toISOString());
    await expect(withTx((tx) => notify(tx, { tenantId: EQUA_TENANT_ID, event: "outlet_cash.over_limit", title: "Kas > batas", now: DAY }))).rejects.toThrow(
      /recipients\.scope\.outletId/,
    );
    await expect(withTx((tx) => notify(tx, { tenantId: "", event: "order.duplicate", title: "x", now: DAY }))).rejects.toThrow(/tenantId wajib/);
    expect(t.db).toBeDefined();
  });
});
