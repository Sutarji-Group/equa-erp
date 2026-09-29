import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { journals } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { addDays, firstDayOfMonth, lastDayOfMonth } from "@/lib/time";
import { runJobNow } from "@/server/core/jobs";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { TODAY, at, finance, linesOf, manualJournal, pair } from "./helpers";

/**
 * Regresi skenario P-07 (docs/qa/skenario-uji.md): job M11 dijalankan RUNNER (`/api/cron/tick` → `runDueJobs`/`runJobNow`)
 * yang meneruskan koneksi biasa — bukan transaksi. Sebelumnya `runAccrualReversals(now, { db })` menulis kepala jurnal
 * terposting dalam perintah ter-COMMIT sendiri sehingga pemeriksaan seimbang saat COMMIT (EQ004) menolak jurnal tanpa
 * baris dan pembalik akrual tanggal 1 tidak pernah terbentuk. Uji modul lama memanggil fungsi tanpa `db` (jalur `withTx`)
 * sehingga tidak menangkapnya.
 */
describe("M11 job terjadwal lewat runner cron (koneksi bukan transaksi)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M11-03 KP-6 job m11.accrual.reverse lewat runner cron memposting pembalik akrual seimbang tanggal 1 periode berikutnya", async () => {
    const fa = finance();
    const accrual = await manualJournal(fa, { date: lastDayOfMonth(TODAY), description: "Akrual sewa gudang belum ditagih (regresi P-07)", isAccrual: true, lines: pair("6-1201", "2-1401", 750_000) });
    expect(accrual.submitted.status).toBe("posted");
    const nextFirst = firstDayOfMonth(addDays(lastDayOfMonth(TODAY), 1));

    const run = await runJobNow("m11.accrual.reverse", at(nextFirst, "00:30"), { db: t.db, runKey: `regresi:${nextFirst}` });
    expect(run.error).toBeUndefined();
    expect(run).toMatchObject({ status: "succeeded", result: 1 });

    const [rev] = await t.db.select().from(journals).where(and(eq(journals.reversalOfId, accrual.draft.id), eq(journals.tenantId, EQUA_TENANT_ID)));
    expect(rev).toMatchObject({ kind: "accrual_reversal", journalDate: nextFirst, status: "posted", totalDebit: 750_000, totalCredit: 750_000 });
    expect((await linesOf(t.db, rev!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["6-1201", 0, 750_000],
      ["2-1401", 750_000, 0],
    ]);
    // Idempoten: slot berikutnya tidak membalik dua kali.
    expect(await runJobNow("m11.accrual.reverse", at(nextFirst, "00:31"), { db: t.db, runKey: `regresi:${nextFirst}:2` })).toMatchObject({ status: "succeeded", result: 0 });
  });

  it("US-M11-02 KP-3 US-M11-05 KP-2 job M11 lain (penyusutan, proses ulang antrean, draf berulang) berjalan lewat runner cron tanpa galat", async () => {
    const nextFirst = firstDayOfMonth(addDays(lastDayOfMonth(TODAY), 1));
    for (const [key, time] of [
      ["m11.depreciation.monthly", "01:30"],
      ["m11.queue.retry", "05:00"],
      ["m11.recurring.drafts", "06:00"],
      ["m11.pkp.monitor", "06:40"],
      ["m11.period.reminders", "07:15"],
      ["m11.payable.reminders", "07:20"],
    ] as const) {
      const run = await runJobNow(key, at(nextFirst, time), { db: t.db, runKey: `regresi:${key}` });
      expect(run.error, key).toBeUndefined();
      expect(run.status, key).toBe("succeeded");
    }
  });
});
