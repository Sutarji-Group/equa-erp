/**
 * Pemisahan tugas dipaksakan (FR-M10-03, US-M10-03, PTB-31). Sistem MENOLAK, bukan memperingatkan.
 *
 * Fungsi `assert*` bersifat sinkron dan melempar `ForbiddenError` berpesan aturan (kode `SOD-xx`). Pencatatan
 * percobaan ke log akses + notifikasi pemilik bila > 3 percobaan/hari/pengguna dilakukan oleh `runService` (setelah
 * rollback) atau `recordViolation(ctx, err)` bila dipanggil di luar transaksi.
 *
 * ```ts
 * return runService(ctx, opts, async (tx) => {
 *   const req = await load(tx, id);
 *   sod.assertNotSelf(req.requesterUserId, ctx.userId, "permintaan persetujuan");   // SOD-01
 *   …
 * });
 * ```
 */
import "server-only";

import { label, type RoleCode } from "@/lib/labels";

import { isSystem, type ActorContext } from "../context";
import { ForbiddenError } from "../errors";
import { inOutletScope } from "./authorize";
import { recordDenial } from "./denials";
import { findForbiddenCombinations, SOD_RULES, type RoleCombinationViolation, type SodRuleCode } from "./sod-rules";

export { SOD_RULES, FORBIDDEN_ROLE_COMBINATIONS, findForbiddenCombinations } from "./sod-rules";
export type { RoleCombinationViolation, SodRuleCode } from "./sod-rules";

/** Catat percobaan pelanggaran (panggil di luar transaksi). */
export const recordViolation = recordDenial;

export function sodViolation(
  rule: SodRuleCode,
  message: string,
  opts: { objectType?: string; objectId?: string; permission?: string } = {},
): ForbiddenError {
  return new ForbiddenError(`${message} (${SOD_RULES[rule].title}; ${SOD_RULES[rule].ref})`, { rule, ...opts });
}

/**
 * SOD-01: pembuat transaksi/permintaan bukan penyetujunya — berlaku WALAU pelaku memegang peran penyetuju
 * (mis. pemilik yang mengajukan tidak dapat menyetujui permintaannya sendiri, FR-M10-03).
 */
export function assertNotSelf(
  creatorUserId: string | null | undefined,
  actorUserId: string | null | undefined,
  what = "transaksi",
  opts: { objectType?: string; objectId?: string } = {},
): void {
  if (creatorUserId && actorUserId && creatorUserId === actorUserId) {
    throw sodViolation("SOD-01", `Anda tidak dapat menyetujui atau mengoreksi ${what} yang Anda buat sendiri`, opts);
  }
}

/** SOD-02: penerima setoran bukan penyetornya. */
export function assertReceiverNotDepositor(
  depositorUserId: string | null | undefined,
  receiverUserId: string | null | undefined,
  opts: { objectType?: string; objectId?: string } = {},
): void {
  if (depositorUserId && receiverUserId && depositorUserId === receiverUserId) {
    throw sodViolation("SOD-02", "Anda tidak dapat menerima setoran Anda sendiri; minta Admin Keuangan lain menerimanya", opts);
  }
}

/** SOD-03: Admin Keuangan tidak membuat/mengubah pesanan & pengiriman (kecuali jalur "dicatat kantor"). */
export function assertNotFinanceAdminOnOrders(ctx: ActorContext): void {
  if (!isSystem(ctx) && ctx.roles.includes("finance_admin") && !ctx.roles.includes("dispatcher")) {
    throw sodViolation("SOD-03", "Admin Keuangan tidak dapat membuat atau mengubah pesanan dan pengiriman");
  }
}

/** SOD-04: Dispatcher tidak mengakses kas. */
export function assertDispatcherNoCash(ctx: ActorContext): void {
  if (!isSystem(ctx) && ctx.roles.includes("dispatcher") && !ctx.roles.includes("finance_admin") && !ctx.roles.includes("owner")) {
    throw sodViolation("SOD-04", "Dispatcher tidak dapat membuka atau mengubah data kas");
  }
}

/** SOD-05a: sopir hanya mengerjakan rit sendiri (pengemudi yang ditetapkan untuk truk & tanggal itu). */
export function assertOwnTrip(
  ctx: ActorContext,
  assignedDriverUserId: string | null | undefined,
  opts: { objectType?: string; objectId?: string } = {},
): void {
  if (isSystem(ctx)) return;
  if (!assignedDriverUserId || assignedDriverUserId !== ctx.userId) {
    throw sodViolation("SOD-05", "Rit ini bukan milik Anda hari ini; hubungi Dispatcher bila penugasan salah", {
      objectType: opts.objectType ?? "trip",
      objectId: opts.objectId,
    });
  }
}

/** SOD-05b: transaksi lapangan yang sudah terkirim/terkunci tidak dapat diubah pelakunya (koreksi lewat Admin Keuangan). */
export function assertNotLocked(
  locked: boolean,
  opts: { objectType?: string; objectId?: string; what?: string } = {},
): void {
  if (locked) {
    throw sodViolation(
      "SOD-05",
      `${opts.what ?? "Transaksi"} sudah terkirim dan terkunci; koreksi hanya oleh Admin Keuangan dengan alasan`,
      opts,
    );
  }
}

/** SOD-06: operator/kasir hanya outletnya (versi sinkron; gunakan `assertOutletScope` bila perlu cek tenant di DB). */
export function assertOwnOutlet(ctx: ActorContext, outletId: string): void {
  if (!inOutletScope(ctx, outletId)) {
    throw sodViolation("SOD-06", "Anda hanya dapat bertransaksi di outlet tempat Anda ditugaskan", {
      objectType: "outlet",
      objectId: outletId,
    });
  }
}

/** SOD-07: admin sistem tidak mengubah transaksi keuangan. */
export function assertSystemAdminNotFinance(ctx: ActorContext): void {
  if (!isSystem(ctx) && ctx.roles.includes("system_admin") && !ctx.roles.includes("finance_admin")) {
    throw sodViolation("SOD-07", "Admin sistem tidak dapat mengubah transaksi keuangan");
  }
}

/** SOD-08: pemilik tidak menginput transaksi harian (keputusan & persetujuan tetap boleh). */
export function assertOwnerNotDailyInput(ctx: ActorContext): void {
  if (!isSystem(ctx) && ctx.roles.includes("owner")) {
    throw sodViolation("SOD-08", "Pemilik tidak menginput transaksi harian; transaksi dicatat di sumbernya oleh pelakunya");
  }
}

export type RoleCombinationResult = { ok: boolean; violations: RoleCombinationViolation[] };

/** Periksa kombinasi peran satu orang terhadap PTB-31 (dipakai M10 sebelum mengajukan multi-peran). */
export function validateRoleCombination(roles: readonly RoleCode[]): RoleCombinationResult {
  const violations = findForbiddenCombinations(Array.from(new Set(roles)));
  return { ok: violations.length === 0, violations };
}

/** Lempar ForbiddenError bila kombinasi terlarang — permintaan TIDAK DAPAT diajukan sama sekali (US-M10-01 KP-4). */
export function assertRoleCombination(roles: readonly RoleCode[], opts: { objectType?: string; objectId?: string } = {}): void {
  const { violations } = validateRoleCombination(roles);
  if (violations.length) {
    throw new ForbiddenError(violations.map((v) => v.message).join(" "), {
      rule: "PTB-31",
      objectType: opts.objectType ?? "user",
      objectId: opts.objectId,
      details: { roles, pairs: violations.map((v) => v.roles.map((r) => label("role", r))) },
    });
  }
}
