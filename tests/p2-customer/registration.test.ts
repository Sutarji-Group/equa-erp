import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { complaints, customerAccounts, customerAppOrders, tripRatings } from "@/db/schema";
import { seedDemoM2Orders } from "@/db/seed/demo-m2-orders";
import { seedDemoP2Customer } from "@/db/seed/demo-p2-customer";
import { NOTIFICATION_EVENTS } from "@/server/core/notifications/catalog";
import { listReports } from "@/server/core/export";
import { listJobs } from "@/server/core/jobs";
import { listPullProviders } from "@/server/core/sync";
import * as p2 from "@/server/modules/p2-customer";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, T0 } from "./helpers";

describe("P2 registrasi modul, laporan ekspor & seed demo", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-P2-06 KP-3 / US-P2-04 / US-P2-08 KP-3 setiap daftar & laporan kantor P2 terdaftar untuk ekspor Excel/PDF dengan izin yang tepat", () => {
    const keys = listReports().map((r) => r.key).filter((k) => k.startsWith("p2."));
    expect(keys.sort()).toEqual(["p2.app_orders", "p2.complaints", "p2.complaints_monthly", "p2.customer_accounts", "p2.payment_intents", "p2.rating_comments", "p2.ratings", "p2.wa_costs"]);
    expect(listReports(finance()).map((r) => r.key)).not.toContain("p2.rating_comments");
    expect(listReports(dispatcher()).map((r) => r.key)).toEqual(expect.arrayContaining(["p2.app_orders", "p2.complaints", "p2.rating_comments"]));
    expect(listReports(owner()).find((r) => r.key === "p2.customer_accounts")!.containsPii).toBe(true);
  });

  it("US-P2-02 KP-4 / US-P2-06 KP-2 / US-P2-05 job terjadwal terdaftar (tenggat PAR-75, pengingat isi ulang, kegagalan langganan, kedaluwarsa kode bayar)", () => {
    const keys = listJobs().map((j) => j.key).filter((k) => k.startsWith("p2."));
    expect(keys.sort()).toEqual(["p2.app_orders.overdue", "p2.complaints.overdue", "p2.payments.expire", "p2.recurring.failures", "p2.refill.reminders"]);
    expect(listPullProviders().map(([k]) => k)).toContain("p2.prepaid_trips");
  });

  it("US-P2-02 KP-4 kode notifikasi kantor P2 terdaftar di katalog 6.3 (dengan peran penerima bawaan)", () => {
    const codes = NOTIFICATION_EVENTS.filter((e) => e.code.startsWith("customer_app."));
    expect(codes.map((c) => c.code).sort()).toEqual([
      "customer_app.account_review",
      "customer_app.complaint_overdue",
      "customer_app.complaint_submitted",
      "customer_app.deletion_requested",
      "customer_app.order_confirm_overdue",
      "customer_app.order_submitted",
      "customer_app.payment_succeeded",
    ]);
  });

  it("seed demo P2 idempoten: akun tertaut & menunggu verifikasi, pesanan aplikasi lewat tenggat, penilaian & keluhan (flag tetap mati)", async () => {
    await seedDemoM2Orders(t.db, T0, { force: true });
    const first = await seedDemoP2Customer(t.db, T0, { force: true });
    expect(first.accounts).toBe(3);
    expect(first.complaints).toBe(2);
    const again = await seedDemoP2Customer(t.db, T0, { force: true });
    expect(again).toEqual({ accounts: 0, complaints: 0 });
    const accs = await t.db.select().from(customerAccounts);
    expect(accs.filter((a) => a.status === "linked")).toHaveLength(2);
    expect(await t.db.select().from(customerAppOrders)).toHaveLength(1);
    expect(await t.db.select().from(tripRatings)).toHaveLength(1);
    const [billing] = await t.db.select().from(complaints).where(eq(complaints.kind, "billing"));
    expect(billing!.assignedRole).toBe("finance_admin");
    const pending = await p2.listAppOrders(dispatcher(T0));
    expect(pending[0]).toMatchObject({ overdue: true, paymentPreference: "credit" });
    expect((await p2.listAccountRequests(owner(T0), { status: "open" })).map((r) => r.kind)).toEqual(["review"]);
    expect((await p2.customerAppStatus(owner(T0))).enabled).toBe(false);
  });
});
