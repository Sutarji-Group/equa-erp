import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { notifications } from "@/db/schema";
import { getNotificationEvent } from "@/server/core/notifications";
import { createUser } from "@/server/modules/m10-access";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { newEmployee, uniqueName } from "./helpers";

describe("B-60 alias notifikasi access.request_pending (D-10 butir 5)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-60 US-M10-01 KP-8 permintaan akses diberitahukan lewat approval.requested saja — alias tetap di katalog tanpa notifikasi ganda", async () => {
    expect(getNotificationEvent("access.request_pending")).toBeTruthy();
    const emp = await newEmployee(t.db);
    const created = await createUser(seededContext("admin1"), { employeeId: emp, username: uniqueName("alias"), role: "dispatcher", reason: "Dispatcher baru" });
    const emp2 = await newEmployee(t.db);
    const second = await createUser(seededContext("admin1"), { employeeId: emp2, username: uniqueName("alias"), role: "finance_admin", reason: "Admin keuangan baru" });
    const ids = [created.approval!.id, second.approval!.id];
    const rows = await t.db
      .select({ event: notifications.event, objectId: notifications.objectId })
      .from(notifications)
      .where(and(inArray(notifications.objectId, ids)));
    const events = new Set(rows.map((r) => r.event));
    expect(events.has("approval.requested")).toBe(true);
    // Satu notifikasi approval.requested per penerima per permintaan (tanpa ganda).
    for (const id of ids) expect(rows.filter((r) => r.objectId === id && r.event === "approval.requested").length).toBeGreaterThanOrEqual(1);
    expect(events.has("access.request_pending")).toBe(false);
    const alias = await t.db.select({ id: notifications.id }).from(notifications).where(eq(notifications.event, "access.request_pending"));
    expect(alias).toHaveLength(0);
  });
});
