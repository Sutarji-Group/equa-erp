/**
 * RBAC & pemisahan tugas — API publik.
 *
 * ```ts
 * import { authorize, assertOutletScope, runService, sod } from "@/server/core/rbac";
 * await authorize(ctx, "m6.pos_sale.void", { tx: opts.tx });       // SEBELUM transaksi (atau teruskan tx pemanggil)
 * return runService(ctx, opts, async (tx) => {
 *   await assertOutletScope(tx, ctx, outletId);                   // SELALU tx — JANGAN getDb() di dalam transaksi
 *   sod.assertNotSelf(req.requesterUserId, ctx.userId);
 * });
 * ```
 * Di dalam transaksi, `authorize(ctx, perm)` WAJIB diberi `{ tx }`; `getDb()` di dalam `withTx` melempar galat jelas
 * di dev/uji (PGlite satu koneksi → sebelumnya deadlock).
 */
import "server-only";

export * from "./authorize";
export * from "./matrix";
export * from "./permissions";
export * from "./roles";
export * as sod from "./sod";
