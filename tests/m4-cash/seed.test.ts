import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, cashDays, deposits, discrepancies, incomingTransfers, officeCashMovements } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { DEMO_M4, seedDemoM4Cash } from "@/db/seed/demo-m4-cash";
import { DEMO_M6_SHIFT_ID } from "@/db/seed/demo-m6-pos";
import { DEMO_M7_SHIFT_ID } from "@/db/seed/demo-m7-store";
import { addDays, toBusinessDate } from "@/lib/time";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { at, finance, owner } from "./helpers";

describe("seed demo M4 (Kas & Setoran)", () => {
  const t = useTestDb({ seed: true });
  const now = new Date();
  const today = toBusinessDate(now);
  const d1 = addDays(today, -1);
  const d2 = addDays(today, -2);
  beforeAll(async () => {
    bootstrapForTests();
    await seedDemoM4Cash(t.db, now, { force: true });
  });

  it("idempoten: dijalankan ulang tidak menggandakan setoran, selisih, mutasi kas, transfer", async () => {
    const count = async () => ({
      deposits: Number((await t.db.select({ n: sql<number>`count(*)` }).from(deposits))[0]!.n),
      discrepancies: Number((await t.db.select({ n: sql<number>`count(*)` }).from(discrepancies))[0]!.n),
      moves: Number((await t.db.select({ n: sql<number>`count(*)` }).from(officeCashMovements))[0]!.n),
      transfers: Number((await t.db.select({ n: sql<number>`count(*)` }).from(incomingTransfers))[0]!.n),
    });
    const before = await count();
    const again = await seedDemoM4Cash(t.db, now, { force: true });
    expect(again.deposits).toBe(0);
    expect(await count()).toEqual(before);
  });

  it("US-M4-02 KP-1 setoran sopir3 kemarin Diajukan: rincian per rit (2 tunai), transfer terpisah, BBM menunggu verifikasi; dapat diterima", async () => {
    const detail = await m4.getDepositDetail(finance(at(today, "08:00")), DEMO_M4.depositSopir3Yesterday);
    expect(detail.deposit).toMatchObject({ status: "submitted", businessDate: d1, sourceType: "driver" });
    expect(detail.figures.sameDayItems).toHaveLength(2);
    expect(detail.figures.pendingExpenses).toBe(1);
    expect(detail.sync.fullySynced).toBe(true);
    expect(detail.canReceive).toBe(true);
    const tr = (await t.db.select().from(incomingTransfers).where(eq(incomingTransfers.sourceKind, "trip_payment"))).find((x) => x.sourceUserId === detail.deposit.depositorUserId);
    expect(tr?.status).toBe("unmatched");
  });

  it("US-M4-03 KP-1 selisih sopir6 menunggu keputusan pemilik (persetujuan terbuka); selisih kecil sopir4 dapat dibuka kembali; ganti rugi sopir4 sebagian lunas", async () => {
    const list = await m4.listDiscrepancies(owner(at(today, "09:00")), { view: "all", from: d2, to: today });
    const big = list.rows.find((r) => r.id === DEMO_M4.discrepancySopir6)!;
    expect(big).toMatchObject({ status: "explained", requiresOwnerDecision: true, approvalStatus: "submitted" });
    expect(list.rows.find((r) => r.id === DEMO_M4.discrepancySopir4Small)).toMatchObject({ status: "done", canReopen: true });
    const [req] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, DEMO_M4.discrepancySopir6));
    expect(req).toMatchObject({ type: "cash_discrepancy", status: "submitted" });
    const balances = await m4.restitutionBalances(owner());
    const sopir4 = balances.find((b) => b.recorded === 80_000)!;
    expect(sopir4).toMatchObject({ settled: 30_000, outstanding: 50_000 });
    expect(await m4.getRestitutionActive(owner())).toBe(true);
  });

  it("US-M4-06 KP-1 tutup kas kemarin terhalang setoran sopir3, shift depot D02 & toko TK1 (demo M6/M7); H-2 sudah ditutup dengan kas kantor cocok", async () => {
    const screen = await m4.getCashDayScreen(finance(at(today, "08:00")), { date: d1 });
    const ids = screen.openBlockers.map((b) => b.depositId);
    expect(ids).toContain(DEMO_M4.depositSopir3Yesterday);
    const shiftDeposits = (await t.db.select({ id: deposits.id, shiftId: deposits.shiftId, date: deposits.businessDate }).from(deposits)).filter((d) => d.shiftId === DEMO_M6_SHIFT_ID || d.shiftId === DEMO_M7_SHIFT_ID);
    for (const d of shiftDeposits.filter((x) => x.date === d1)) expect(ids).toContain(d.id);
    expect(screen.openBlockers.map((b) => b.kind)).not.toContain("previous_day");
    const [closed] = await t.db.select().from(cashDays).where(eq(cashDays.businessDate, d2));
    expect(closed).toMatchObject({ status: "closed", officeCashDifference: 0, tenantId: EQUA_TENANT_ID });
    const office = await m4.getOfficeCash(finance(at(today, "08:00")), { date: d2 });
    expect(office.day.closing).toBe(closed!.officeCashSystem);
    const pos = await m4.getCashPosition(finance(at(today, "08:00")), { date: d1 });
    expect(pos.rows.some((r) => r.depositIds.includes(DEMO_M4.depositSopir3Yesterday))).toBe(true);
  });
});
