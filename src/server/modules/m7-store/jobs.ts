/**
 * M7 — pekerjaan terjadwal toko (`/api/cron/tick`, idempoten per slot & per kunci notifikasi):
 * - `m7.stock_count.monthly_check` harian 07.05 — opname toko bulan lalu belum diajukan setelah tanggal
 *   `m7.store_rules.stock_count_deadline_day` (bawaan 5) → pemilik (US-M7-05 KP-4). Sekali per toko per bulan.
 * - `m7.payable.due_reminder` harian 07.10 — utang pemasok jatuh tempo ≤ H-N / lewat → Admin Keuangan (US-M7-08 KP-1).
 * - `m7.reorder.sweep` harian 06.40 — evaluasi ulang daftar pesan ulang (stok minimum master berubah, dll.).
 * Persetujuan diskon/tempo lewat tenggat ditangani job inti `core.approvals.expire_due` (handler `onExpired`).
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { outlets, products } from "@/db/schema";
import { inJobTx, registerJob } from "@/server/core/jobs";

import { runPayableReminders } from "./service/payables";
import { evaluateReorder } from "./service/reorder";
import { runStoreStockCountCheck } from "./service/stock-count";

export function registerJobs(): void {
  registerJob({
    key: "m7.stock_count.monthly_check",
    description: "Tandai toko yang belum opname bulan lalu setelah tanggal batas (US-M7-05 KP-4) ke pemilik.",
    schedule: { kind: "daily", at: "07:05" },
    run: ({ now, db }) => runStoreStockCountCheck(now, db),
  });
  registerJob({
    key: "m7.payable.due_reminder",
    description: "Pengingat utang pemasok jatuh tempo ≤ H-N atau lewat ke Admin Keuangan (US-M7-08 KP-1).",
    schedule: { kind: "daily", at: "07:10" },
    run: ({ now, db }) => runPayableReminders(now, db),
  });
  registerJob({
    key: "m7.reorder.sweep",
    description: "Evaluasi ulang daftar pesan ulang semua toko (stok ≤ minimum, US-M7-03 KP-1).",
    schedule: { kind: "daily", at: "06:40" },
    run: async ({ now, db }) => {
      const stores = await db.select().from(outlets).where(and(eq(outlets.kind, "store"), eq(outlets.isActive, true)));
      let created = 0;
      for (const s of stores) {
        const ids = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.tenantId, s.tenantId), eq(products.line, "store"), eq(products.status, "active")));
        // D-12 butir 8: satu toko = satu unit kerja (baris pesan ulang + notifikasi kasir atomik).
        created += (await inJobTx(db, (tx) => evaluateReorder(tx, { tenantId: s.tenantId, outletId: s.id, productIds: ids.map((i) => i.id), now }))).length;
      }
      return { stores: stores.length, created };
    },
  });
}
