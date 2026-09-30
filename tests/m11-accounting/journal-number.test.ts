/**
 * D-14 butir 1 / B-87 (v1.0.1): nomor jurnal `J-YYMM-NNNNNN` (6 digit, 999.999/bulan/tenant). Nomor 5 digit yang sudah
 * terbit tidak diubah; penghitung bulan berjalan dilanjutkan, dan urutan tampilan (buku besar) tetap urutan terbit.
 * Penghitung disetel langsung di `document_sequences` (tanpa membuat 100 rb baris).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { documentSequences, journalLines, journals } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { sequenceScopeKey } from "@/server/core/numbering";
import * as m11 from "@/server/modules/m11-accounting";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  THIS_PERIOD,
  TODAY,
  acc,
  accountant,
  emitEvent,
  finance,
  journalOfEvent,
  manualJournal,
  pair,
  queueOfEvent,
  setPeriod,
  shiftMonth,
  tripPayload,
} from "./helpers";

const PREV = shiftMonth(THIS_PERIOD, -1);
const yymm = (period: string) => `${period.slice(2, 4)}${period.slice(5, 7)}`;

describe("D-14 B-87 nomor jurnal 6 digit (M11)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(async () => {
    bootstrapForTests();
    await setPeriod(t.db, PREV, "open");
    await setPeriod(t.db, THIS_PERIOD, "open");
  });

  async function setJournalCounter(date: string, value: number) {
    const scopeKey = sequenceScopeKey("journal", date);
    await t.db
      .insert(documentSequences)
      .values({ tenantId: EQUA_TENANT_ID, kind: "journal", scopeKey, lastValue: value })
      .onConflictDoUpdate({
        target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
        set: { lastValue: value },
      });
  }

  it("US-M11-02 KP-1 D-14 jurnal otomatis ke-100.000 dalam sebulan terposting J-YYMM-100000 (tidak masuk antrean SEQUENCE_EXHAUSTED)", async () => {
    await setJournalCounter(TODAY, 99_999);
    const ev = await emitEvent("trip.completed", tripPayload());
    const j = await journalOfEvent(t.db, ev.id);
    expect(await queueOfEvent(t.db, ev.id)).toBeNull();
    expect(j).toMatchObject({ status: "posted", number: `J-${yymm(THIS_PERIOD)}-100000` });
    expect(j!.number).toMatch(/^J-\d{4}-\d{6}$/);
  });

  it("US-M11-04 KP-1 D-14 bulan peralihan: nomor 5 digit lama tetap, nomor baru melanjutkan urutan 6 digit, buku besar urut terbit (bukan urut teks)", async () => {
    const date = `${PREV}-15`;
    const period = await setPeriod(t.db, PREV, "open");
    // Keadaan v1.0: dua jurnal 5 digit sudah terbit pada tanggal yang sama (penghitung = 9.999).
    const old = [`J-${yymm(PREV)}-09998`, `J-${yymm(PREV)}-09999`];
    for (const number of old) {
      await t.db.transaction(async (tx) => {
        const [j] = await tx
          .insert(journals)
          .values({
            tenantId: EQUA_TENANT_ID,
            number,
            kind: "manual",
            status: "posted",
            journalDate: date,
            periodId: period.id,
            description: `Jurnal v1.0 ${number}`,
            totalDebit: 5_000,
            totalCredit: 5_000,
            postedAt: new Date(),
          })
          .returning({ id: journals.id });
        await tx.insert(journalLines).values([
          { journalId: j!.id, lineNo: 1, accountId: acc("6-1201"), profitCenter: "SHARED", debit: 5_000, credit: 0 },
          { journalId: j!.id, lineNo: 2, accountId: acc("1-1201"), profitCenter: "SHARED", debit: 0, credit: 5_000 },
        ]);
      });
    }
    await setJournalCounter(date, 9_999);
    const { submitted } = await manualJournal(finance(), { date, description: "Sewa gudang sesudah v1.0.1", template: "rent", lines: pair("6-1201", "1-1201", 7_000) });
    expect(submitted.status).toBe("posted");
    const [created] = await t.db
      .select({ number: journals.number })
      .from(journals)
      .where(eq(journals.description, "Sewa gudang sesudah v1.0.1"));
    expect(created!.number).toBe(`J-${yymm(PREV)}-010000`);
    // Nomor lama tidak diubah.
    const numbers = (await t.db.select({ number: journals.number }).from(journals)).map((r) => r.number);
    expect(numbers).toEqual(expect.arrayContaining(old));

    // Urutan teks biasa menaruh "…-010000" sebelum "…-09998"; buku besar memakai urutan alami (docNumberOrder).
    const ledger = await m11.getLedger(accountant(), { accountId: acc("6-1201"), fromPeriod: PREV, toPeriod: PREV });
    const sameDay = ledger.lines.filter((l) => l.date === date).map((l) => l.number);
    expect(sameDay).toEqual([...old, `J-${yymm(PREV)}-010000`]);
    expect(ledger.lines.at(-1)!.balance).toBe(ledger.closing);
  });
});
