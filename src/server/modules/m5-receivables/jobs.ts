/**
 * M5 — pekerjaan terjadwal Piutang (`/api/cron/tick`, idempoten per slot; semua dalam konteks Sistem):
 * - `m5.credit_hold.daily` harian PAR-55 (22.30, setelah tutup kas) — umur faktur, Ditahan otomatis > PAR-09 / lepas
 *   otomatis (US-M5-03 KP-1/KP-3). Juga dipicu event `cash_day.closed`. Sekaligus menyelaraskan sisa faktur dengan
 *   alokasi (penjaga bila handler `collection.recorded` pernah gagal).
 * - `m5.reminders.daily` harian awal jam layanan (PAR-07) — pengingat H-3/H+1 (PAR-13) Dijadwalkan + notifikasi Admin
 *   Keuangan; kirim otomatis bila WhatsApp Cloud API aktif (US-M5-05).
 * - `m5.monthly_invoices` harian awal jam layanan — pada tanggal terbit PAR-12 terbitkan faktur bulanan periode lalu (US-M5-06 KP-2).
 * - `m5.weekly_aging` mingguan PAR-40 (Senin 07.00) — ringkasan umur piutang ke pemilik (US-M5-04 KP-1).
 */
import "server-only";

import { sql } from "drizzle-orm";

import { invoices, paymentAllocations } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { systemContext } from "@/server/core/context";
import { withTx, type Tx } from "@/server/core/db";
import { registerJob } from "@/server/core/jobs";

import { sendWeeklyAgingSummary, tenantsWithReceivables } from "./service/aging";
import { evaluateCreditHolds } from "./service/credit-hold";
import { recomputeInvoice } from "./service/ledger";
import { issueMonthlyInvoices, monthlyPeriod } from "./service/monthly";
import { generateReminders } from "./service/reminders";
import { sweepUninvoicedStoreSales } from "./service/sources";

/** Faktur yang `paid_amount`-nya tidak sama dengan Σ alokasi (penyelarasan malam). */
async function reconcileInvoices(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from ${invoices} i
    where i.tenant_id = ${tenantId}
      and i.paid_amount <> coalesce((select sum(pa.amount) from ${paymentAllocations} pa where pa.invoice_id = i.id and pa.credit_note_id is null), 0)`);
  const ctx = systemContext({ tenantId, now });
  for (const r of rows.rows) await recomputeInvoice(tx, ctx, r.id);
  return rows.rows.length;
}

export function registerJobs(): void {
  registerJob({
    key: "m5.credit_hold.daily",
    description: "Umur faktur & status Ditahan otomatis setelah tutup kas (US-M5-03 KP-1/KP-3, PAR-09, PAR-55).",
    schedule: { kind: "daily", atParam: { key: "PAR-55", field: "time" } },
    run: async ({ now, db }) => {
      const date = toBusinessDate(now);
      const out: Record<string, unknown> = {};
      for (const tenantId of await tenantsWithReceivables(db)) {
        out[tenantId] = await withTx(
          async (tx) => {
            const reconciled = await reconcileInvoices(tx, tenantId, now);
            const storeInvoiced = await sweepUninvoicedStoreSales(tx, systemContext({ tenantId, now, businessDate: date }), tenantId);
            const res = await evaluateCreditHolds(tx, systemContext({ tenantId, now, businessDate: date }), tenantId, date);
            return { reconciled, storeInvoiced, held: res.held.length, released: res.released.length, deferred: res.deferred.length };
          },
          { db },
        );
      }
      return out;
    },
  });

  registerJob({
    key: "m5.reminders.daily",
    description: "Daftar pengingat jatuh tempo H-3/H+1 (PAR-13) + notifikasi Admin Keuangan; kirim otomatis bila Cloud API aktif (US-M5-05).",
    schedule: { kind: "daily", atParam: { key: "PAR-07", field: "start" } },
    run: async ({ now, db }) => {
      const date = toBusinessDate(now);
      const out: Record<string, unknown> = {};
      for (const tenantId of await tenantsWithReceivables(db)) {
        out[tenantId] = await withTx((tx) => generateReminders(tx, systemContext({ tenantId, now, businessDate: date }), tenantId, date), { db });
      }
      return out;
    },
  });

  registerJob({
    key: "m5.monthly_invoices",
    description: "Faktur bulanan terbit otomatis mulai tanggal PAR-12 untuk periode layanan sebelumnya; job terlewat/gagal disusul otomatis hari berikutnya (US-M5-06 KP-2).",
    schedule: { kind: "daily", atParam: { key: "PAR-07", field: "start" } },
    run: async ({ now, db }) => {
      const date = toBusinessDate(now);
      const period = await monthlyPeriod(db, date);
      // Susulan otomatis: setiap hari ≥ tanggal terbit PAR-12 (idempoten per pelanggan & bulan) — cron terlewat atau
      // jalan gagal pada tanggal 1 tidak membuat faktur bulan itu tidak pernah terbit (tanggal faktur = tanggal jalan).
      if (date < period.issueDate) return { skipped: "sebelum tanggal terbit PAR-12", date };
      const out: Record<string, unknown> = {};
      for (const tenantId of await tenantsWithReceivables(db)) {
        out[tenantId] = await withTx((tx) => issueMonthlyInvoices(tx, systemContext({ tenantId, now, businessDate: date }), tenantId, date), { db });
      }
      return out;
    },
  });

  registerJob({
    key: "m5.weekly_aging",
    description: "Ringkasan umur piutang mingguan ke pemilik (US-M5-04 KP-1, PAR-40, KPI-04).",
    schedule: { kind: "weekly", param: { key: "PAR-40", weekdayField: "iso_weekday", timeField: "time" } },
    run: async ({ now, db }) => {
      const date = toBusinessDate(now);
      const out: Record<string, unknown> = {};
      for (const tenantId of await tenantsWithReceivables(db)) {
        out[tenantId] = await withTx((tx) => sendWeeklyAgingSummary(tx, systemContext({ tenantId, now, businessDate: date }), tenantId, date), { db });
      }
      return out;
    },
  });
}
