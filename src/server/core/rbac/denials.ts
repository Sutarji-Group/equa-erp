/**
 * Pencatatan penolakan akses (US-M10-03 KP-2): setiap percobaan tindakan yang ditolak (peran, lingkup, pemisahan
 * tugas) dicatat di log akses; lebih dari 3 percobaan sehari oleh pengguna yang sama diberitahukan ke pemilik.
 *
 * Pencatatan berjalan di transaksi TERPISAH (commit sendiri) agar tidak ikut rollback bersama transaksi yang gagal.
 * Karena itu `recordDenial` hanya boleh dipanggil saat TIDAK ada transaksi terbuka (PGlite satu koneksi) — `authorize`
 * dan `runService` mengurus hal ini; di dalam transaksi, lempar saja `ForbiddenError` dan biarkan lapisan luar
 * memanggil `logDenialIfNeeded`.
 */
import "server-only";

import { label } from "@/lib/labels";

import { countUserEventsOnDay, logAccess } from "../access-log";
import { isSystem, type ActorContext } from "../context";
import { withTx } from "../db";
import { ForbiddenError } from "../errors";
import { notify } from "../notifications/service";

/**
 * Ambang percobaan pelanggaran per pengguna per hari sebelum pemilik diberi tahu (US-M10-03 KP-2 "lebih dari 3").
 * Aturan tetap PRD tanpa parameter Lampiran B.
 */
export const DENIAL_ALERT_THRESHOLD_PER_DAY = 3;

/** Catat penolakan ke `access_logs` (+ notifikasi pemilik bila > 3/hari). Tidak pernah melempar galat. */
export async function recordDenial(ctx: ActorContext, error: ForbiddenError): Promise<void> {
  if (error.logged) return;
  error.logged = true;
  try {
    await withTx(async (tx) => {
      await logAccess(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        event: "action_denied",
        success: false,
        permission: error.permission ?? null,
        rule: error.rule ?? null,
        reason: error.message,
        objectType: error.objectType ?? null,
        objectId: error.objectId ?? null,
        details: { roles: ctx.roles, source: ctx.source },
        occurredAt: ctx.now,
      });
      if (!ctx.userId || isSystem(ctx)) return;
      const n = await countUserEventsOnDay(tx, ctx.userId, "action_denied", ctx.now);
      if (n === DENIAL_ALERT_THRESHOLD_PER_DAY + 1) {
        const roleText = ctx.roles.map((r) => label("role", r)).join(", ") || "tanpa peran";
        await notify(tx, {
          event: "access.repeated_denial",
          tenantId: ctx.tenantId,
          recipients: { roles: ["owner"] },
          excludeUserIds: [ctx.userId],
          title: "Percobaan tindakan terlarang berulang",
          body: `Pengguna (${roleText}) sudah ${n} kali hari ini mencoba tindakan yang ditolak aturan pemisahan tugas. Terakhir: ${error.message}`,
          objectType: "user",
          objectId: ctx.userId,
          groupKey: `access.repeated_denial:${ctx.userId}`,
          link: "/audit",
          now: ctx.now,
        });
      }
    });
  } catch (logError) {
    console.error("[equa] gagal mencatat penolakan akses:", logError);
  }
}

/** Catat bila galat adalah ForbiddenError yang belum dicatat. */
export async function logDenialIfNeeded(ctx: ActorContext, error: unknown): Promise<void> {
  if (error instanceof ForbiddenError && !error.logged) await recordDenial(ctx, error);
}
