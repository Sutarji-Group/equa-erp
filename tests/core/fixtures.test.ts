import { describe, expect, it } from "vitest";

import { outletId, userIdByUsername } from "@/db/seed";
import { isActingDriver } from "@/server/core/auth";

import { seededContext } from "../helpers/context";
import { useTestDb as withTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { assignCrew, createCustomer, createDeposit, createOpenShift, createOrder, createScheduledTrip, createTruck, today } from "../helpers/fixtures";

const t = withTestDb({ seed: true });

describe("Helper uji modul (docs/ARCHITECTURE.md §10)", () => {
  it("US-M2-11 fixture pelanggan → truk + kru (kernet pengganti) → pesanan → rit terjadwal → shift → setoran lolos hardening", async () => {
    const date = today();
    const cust = await createCustomer(t.db, { segment: "hotel", creditStatus: "credit", creditLimit: 5_000_000 });
    expect(cust.addressId).toBeTruthy();
    const truck = await createTruck(t.db);
    const helper = await createTestUser(t.db, { role: "helper", scope: { truckIds: [truck.id] } });
    await assignCrew(t.db, { truckId: truck.id, driverEmployeeId: helper.employeeId, date, substituteHelper: true });
    expect(await isActingDriver(t.db, { ...helper.ctx, scope: { ...helper.ctx.scope, truckIds: [truck.id] } }, truck.id, date)).toBe(true);
    const order = await createOrder(t.db, { customerId: cust.id, addressId: cust.addressId!, date });
    const trip = await createScheduledTrip(t.db, { order, truckId: truck.id, date });
    expect(trip.number).toBe(`${order.number}/1`);
    const second = await createScheduledTrip(t.db, { order, truckId: truck.id, date, sequence: 2 });
    expect(second.scheduleId).toBe(trip.scheduleId);
    const shift = await createOpenShift(t.db, { outletId: outletId("D03"), operatorUserId: userIdByUsername("depot03"), date });
    const dep = await createDeposit(t.db, { date, sourceType: "depot_shift", outletId: shift.outletId, shiftId: shift.shiftId, expectedCash: 350_000 });
    expect(dep.number).toMatch(/^S-\d{2}-\d{6}$/);
    expect(seededContext("pemilik").tenantId).toBe(cust.tenantId);
  });
});
