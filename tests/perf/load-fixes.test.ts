/**
 * Uji perbaikan hambatan uji beban (NFR-05, docs/qa/uji-beban.md §4): setiap kueri yang diganti demi kinerja harus
 * memberi hasil yang SAMA dengan versi lamanya (atau implementasi acuan yang setara) — tanpa perubahan perilaku.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accountingPeriods, accounts, gpsPositions, journalLines, journals, shifts } from "@/db/schema";
import { EQUA_TENANT_ID, truckId } from "@/db/seed";
import { addDays, toBusinessDate } from "@/lib/time";
import type { Tx } from "@/server/core/db";
import * as m2 from "@/server/modules/m2-orders";
import * as m6 from "@/server/modules/m6-pos";
import * as m11 from "@/server/modules/m11-accounting";
import {
  cashMovementsByCounterAccount,
  computeBalanceSheet,
  computeCashFlow,
  computeProfitLoss,
  computeStatements,
  computeTrialBalance,
  StatementAggregates,
} from "@/server/modules/m11-accounting/service/statements";
import * as m12 from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, TODAY, acc, accountant, emitEvent, finance, manualJournal, pair, setPeriod, shiftMonth, tripPayload } from "../m11-accounting/helpers";
import { expectApplied, galonBaru, isi, openShiftVia, posFor, sellVia } from "../m6-pos/helpers";

const PREV = shiftMonth(THIS_PERIOD, -1);

describe("Perbaikan hambatan uji beban (NFR-05)", () => {
  const t = useTestDb({ seed: true });
  const db = () => t.db as unknown as Tx;
  beforeAll(() => bootstrapForTests());

  it("NFR-05 indeks uji beban tersedia: jurnal per event sumber (cek duplikat jurnal otomatis), penjualan & baris POS per tenant × tanggal", async () => {
    const res = await t.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where indexname in ('journals_source_event_idx', 'pos_sales_tenant_date_idx', 'pos_sale_lines_tenant_date_idx') order by indexname`,
    );
    expect(res.rows.map((r) => r.indexname)).toEqual(["journals_source_event_idx", "pos_sale_lines_tenant_date_idx", "pos_sales_tenant_date_idx"]);
  });

  it("NFR-05 US-M6-02 KP-2 BR-08 angka kas shift lewat satu agregat (computeShiftCashTotals) = computeShiftFigures — tunai, QRIS, void, void menunggu persetujuan, semua shift", async () => {
    const pos = await posFor("D04");
    const { shiftId } = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [isi(2)])).res);
    expectApplied((await sellVia(pos, shiftId, [galonBaru(1)], { method: "qris", qrisReference: "QR-UJI-BEBAN-1" })).res);
    const voided = await sellVia(pos, shiftId, [isi(1)]);
    expectApplied(voided.res);
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: voided.saleId, reason: "wrong_quantity" }));
    const big = await sellVia(pos, shiftId, [galonBaru(3)]); // > PAR-04 → void menunggu persetujuan, tetap dihitung
    expectApplied(big.res);
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: big.saleId, reason: "customer_cancelled" }));

    const all = await t.db.select().from(shifts);
    const totals = await m6.computeShiftCashTotals(db(), all);
    expect(totals.size).toBe(all.length);
    for (const s of all) {
      const f = await m6.computeShiftFigures(db(), s);
      expect(totals.get(s.id), `shift ${s.id}`).toEqual({ cashSales: f.cashSales, qrisSales: f.qrisSales, expectedCash: f.expectedCash, expectedDrawer: f.expectedDrawer, depositAmount: f.depositAmount });
    }
    const mine = all.find((s) => s.id === shiftId)!;
    expect(totals.get(shiftId)).toMatchObject({ cashSales: 10_000 + 135_000, qrisSales: 45_000, expectedDrawer: mine.openingCashFixed + 145_000 - mine.partialDepositTotal });
    expect(await m6.computeShiftCashTotals(db(), [])).toEqual(new Map());
  });

  it("NFR-05 US-M9-01 KP-1 agregat penjualan tanpa galon (omzet H+0) = agregat lengkap dengan galon 0", async () => {
    const range = { from: addDays(TODAY, -60), to: TODAY };
    const full = await m6.salesAggregates(db(), EQUA_TENANT_ID, range);
    const lite = await m6.salesAggregates(db(), EQUA_TENANT_ID, { ...range, withGallons: false });
    expect(full.length).toBeGreaterThan(0);
    expect(lite).toEqual(full.map((r) => ({ ...r, gallons: 0, gallonLiters: 0 })));
  });

  it("NFR-05 US-M12-01 KP-1 US-M2-03 KP-1 posisi valid terakhir per truk (LATERAL) = DISTINCT ON acuan — posisi tidak valid diabaikan, batas waktu acuan dihormati", async () => {
    const now = new Date();
    const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
    const [t1, t2, t3] = [truckId("T1"), truckId("T2"), truckId("T3")];
    const point = (truck: string, at: Date, isValid: boolean, lat: number) => ({ tenantId: EQUA_TENANT_ID, truckId: truck, source: "gps_device" as const, deviceTime: at, lat, lng: 107.14, isValid });
    await t.db
      .insert(gpsPositions)
      .values([point(t1, minutes(-30), true, -6.81), point(t1, minutes(-10), false, -6.82), point(t1, minutes(5), true, -6.83), point(t2, minutes(-3), false, -6.84), point(t3, minutes(-60), true, -6.85), point(t3, minutes(-5), true, -6.86)]);
    const ids = [t1, t2, t3];
    const reference = async (before: Date | null) => {
      const res = await t.db.execute<{ truck_id: string; device_time: Date | string }>(sql`
        select distinct on (truck_id) truck_id, device_time from gps_positions
        where truck_id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) and is_valid ${before ? sql`and device_time <= ${before}` : sql``}
        order by truck_id, device_time desc`);
      return new Map(res.rows.map((r) => [r.truck_id, new Date(r.device_time).getTime()]));
    };
    const asMap = (rows: { truckId: string; at: Date }[]) => new Map(rows.map((r) => [r.truckId, r.at.getTime()]));

    const upToNow = await m12.latestTruckPositions(db(), ids, { before: now });
    expect(asMap(upToNow)).toEqual(await reference(now));
    expect(asMap(upToNow).get(t1)).toBe(minutes(-30).getTime()); // yang lebih baru tidak valid / setelah waktu acuan
    expect(asMap(upToNow).get(t3)).toBe(minutes(-5).getTime());
    const unbounded = await m12.latestTruckPositions(db(), ids);
    expect(asMap(unbounded)).toEqual(await reference(null));
    expect(asMap(unbounded).get(t1)).toBe(minutes(5).getTime());
    expect(await m12.latestTruckPositions(db(), [])).toEqual([]);

    // Papan jadwal M2 memakai posisi valid terakhir (tanpa batas waktu) yang sama.
    const board = await m2.getBoard(seededContext("dispatcher1"), toBusinessDate(now));
    const ref = await reference(null);
    for (const lane of board.lanes) {
      const expected = ref.get(lane.truck.id);
      if (expected !== undefined) expect(lane.lastPosition?.at.getTime(), lane.truck.code).toBe(expected);
    }
    expect(board.lanes.find((l) => l.truck.id === t1)?.lastPosition?.lat).toBeCloseTo(-6.83);
  });

  describe("M11 laporan & buku besar", () => {
    beforeAll(async () => {
      await setPeriod(t.db, PREV, "open");
      await setPeriod(t.db, THIS_PERIOD, "open");
      await emitEvent("trip.completed", tripPayload({ cashReceived: 250_000 }));
      await emitEvent("trip.completed", tripPayload({ paymentMethod: "credit", cashReceived: 0, creditAmount: 300_000 }));
      for (let i = 1; i <= 7; i++) {
        await manualJournal(finance(), { date: TODAY, description: `Sewa gudang cicilan ${i}`, template: "rent", lines: pair("6-1201", "1-1201", 10_000 * i) });
      }
      await manualJournal(finance(), { date: `${PREV}-20`, description: "Listrik kantor bulan lalu", template: "electricity", lines: pair("6-1301", "1-1201", 150_000) });
      // Dua baris lawan bernilai sama (seri) → akun lawan = nomor baris terkecil.
      await manualJournal(finance(), {
        date: TODAY,
        description: "Bayar listrik & sewa sekaligus",
        template: "rent",
        lines: [
          { accountId: acc("6-1301"), profitCenter: "SHARED", outletId: null, debit: 40_000, credit: 0 },
          { accountId: acc("6-1201"), profitCenter: "SHARED", outletId: null, debit: 40_000, credit: 0 },
          { accountId: acc("1-1201"), profitCenter: "SHARED", outletId: null, debit: 0, credit: 80_000 },
        ],
      });
    });

    it("NFR-05 US-M11-04 KP-1 buku besar dipaginasi server: halaman berurutan = seluruh baris, saldo berjalan diteruskan antarhalaman, mutasi & saldo akhir atas seluruh rentang", async () => {
      const ac = accountant();
      const account = acc("6-1201");
      const full = await m11.getLedger(ac, { accountId: account, fromPeriod: THIS_PERIOD });
      expect(full.page).toEqual({ offset: 0, limit: m11.LEDGER_MAX_ROWS, total: full.lines.length });
      expect(full.lines.length).toBeGreaterThanOrEqual(8);
      expect(full.debit).toBe(full.lines.reduce((s, l) => s + l.debit, 0));
      expect(full.closing).toBe(full.opening + full.debit - full.credit);
      expect(full.lines.at(-1)!.balance).toBe(full.closing);

      const size = 3;
      const pages: (typeof full)[] = [];
      for (let offset = 0; offset < full.page.total; offset += size) pages.push(await m11.getLedger(ac, { accountId: account, fromPeriod: THIS_PERIOD, offset, limit: size }));
      expect(pages.flatMap((p) => p.lines)).toEqual(full.lines);
      pages.forEach((p, i) => {
        expect(p.page).toEqual({ offset: i * size, limit: size, total: full.page.total });
        expect(p.pageOpening).toBe(i === 0 ? full.opening : pages[i - 1]!.lines.at(-1)!.balance);
        expect({ opening: p.opening, debit: p.debit, credit: p.credit, closing: p.closing }).toEqual({ opening: full.opening, debit: full.debit, credit: full.credit, closing: full.closing });
      });
      // Offset di luar jumlah baris → halaman terakhir yang ada; batas di atas LEDGER_MAX_ROWS dipotong.
      const beyond = await m11.getLedger(ac, { accountId: account, fromPeriod: THIS_PERIOD, offset: 10_000, limit: size });
      expect(beyond.page.offset).toBe(full.page.total - 1);
      expect((await m11.getLedger(ac, { accountId: account, fromPeriod: THIS_PERIOD, limit: 1_000_000 })).page.limit).toBe(m11.LEDGER_MAX_ROWS);
    });

    it("NFR-05 US-M11-04 KP-2 paket laporan dengan agregat bersegmen (StatementAggregates) identik dengan hitung langsung per laporan — per periode & kumulatif tahun berjalan", async () => {
      const now = new Date();
      for (const basis of ["period", "ytd"] as const) {
        const pack = await computeStatements(db(), EQUA_TENANT_ID, THIS_PERIOD, basis, now);
        expect(pack.trialBalance).toEqual(await computeTrialBalance(db(), EQUA_TENANT_ID, THIS_PERIOD, basis));
        expect(pack.profitLoss).toEqual(await computeProfitLoss(db(), EQUA_TENANT_ID, THIS_PERIOD, basis));
        expect(pack.balanceSheet).toEqual(await computeBalanceSheet(db(), EQUA_TENANT_ID, THIS_PERIOD));
        expect(pack.cashFlow).toEqual(await computeCashFlow(db(), EQUA_TENANT_ID, THIS_PERIOD, basis));
        expect(pack.trialBalance.balanced).toBe(true);
      }
      // Rentang yang disusun dari beberapa segmen = rentang yang sama dihitung sebagai satu segmen.
      const sorted = (rows: { accountId: string; profitCenter: string; internalSource: boolean }[]) =>
        [...rows].sort((a, b) => `${a.accountId}|${a.profitCenter}|${a.internalSource}`.localeCompare(`${b.accountId}|${b.profitCenter}|${b.internalSource}`));
      const split = new StatementAggregates(db(), EQUA_TENANT_ID, [PREV, THIS_PERIOD], THIS_PERIOD);
      const whole = new StatementAggregates(db(), EQUA_TENANT_ID, [PREV], THIS_PERIOD);
      const single = new StatementAggregates(db(), EQUA_TENANT_ID, [], THIS_PERIOD);
      expect(sorted(await split.range({ fromPeriod: PREV, toPeriod: THIS_PERIOD }))).toEqual(sorted(await whole.range({ fromPeriod: PREV, toPeriod: THIS_PERIOD })));
      expect(sorted(await split.range({ toPeriod: THIS_PERIOD }))).toEqual(sorted(await single.range({ toPeriod: THIS_PERIOD })));
      expect(await split.range({ fromPeriod: THIS_PERIOD, toPeriod: PREV })).toEqual([]);
      // Rentang di luar titik potong → kueri langsung (hasil tetap benar).
      const early = shiftMonth(PREV, -1);
      const direct = new StatementAggregates(db(), EQUA_TENANT_ID, [early], PREV);
      expect(sorted(await split.range({ fromPeriod: early, toPeriod: PREV }))).toEqual(sorted(await direct.range({ fromPeriod: early, toPeriod: PREV })));
    });

    it("NFR-05 US-M11-04 KP-1 arus kas metode langsung dihitung di SQL = algoritme acuan per jurnal (kas bersih, akun lawan terbesar, seri → baris terkecil)", async () => {
      const cashIds = (await t.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, EQUA_TENANT_ID), eq(accounts.isCash, true)))).map((a) => a.id);
      expect(cashIds.length).toBeGreaterThan(0);
      const cashSet = new Set(cashIds);
      for (const [from, to] of [
        [THIS_PERIOD, THIS_PERIOD],
        [PREV, THIS_PERIOD],
      ] as const) {
        const lines = await t.db
          .select({ journalId: journalLines.journalId, accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit })
          .from(journalLines)
          .innerJoin(journals, eq(journals.id, journalLines.journalId))
          .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
          .where(and(eq(journals.tenantId, EQUA_TENANT_ID), eq(journals.status, "posted"), gte(accountingPeriods.period, from), lte(accountingPeriods.period, to)))
          .orderBy(asc(journalLines.journalId), asc(journalLines.lineNo));
        const byJournal = new Map<string, typeof lines>();
        for (const l of lines) byJournal.set(l.journalId, [...(byJournal.get(l.journalId) ?? []), l]);
        const expected = new Map<string, { inflow: number; outflow: number }>();
        for (const jl of byJournal.values()) {
          if (!jl.some((l) => cashSet.has(l.accountId))) continue;
          const net = jl.filter((l) => cashSet.has(l.accountId)).reduce((s, l) => s + l.debit - l.credit, 0);
          if (net === 0) continue;
          const others = jl.filter((l) => !cashSet.has(l.accountId)).sort((a, b) => b.debit + b.credit - (a.debit + a.credit)); // stabil: urut nomor baris
          const key = others[0]?.accountId ?? "-";
          const cur = expected.get(key) ?? { inflow: 0, outflow: 0 };
          if (net > 0) cur.inflow += net;
          else cur.outflow += -net;
          expected.set(key, cur);
        }
        const got = await cashMovementsByCounterAccount(db(), EQUA_TENANT_ID, cashIds, from, to);
        expect(new Map(got.map((r) => [r.counterAccountId ?? "-", { inflow: r.inflow, outflow: r.outflow }]))).toEqual(expected);
      }
      // Jurnal seri: akun lawan = baris pertama (6-1301), bukan 6-1201.
      const got = await cashMovementsByCounterAccount(db(), EQUA_TENANT_ID, cashIds, THIS_PERIOD, THIS_PERIOD);
      expect(got.find((r) => r.counterAccountId === acc("6-1301"))?.outflow).toBeGreaterThanOrEqual(80_000);
    });
  });
});
