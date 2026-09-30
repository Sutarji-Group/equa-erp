/**
 * Parameter Lampiran B (docs/ARCHITECTURE.md §5; PRD 6.2b, US-M10-04 KP-6).
 *
 * - `get(tx, "PAR-01", tanggal?, lingkup?)` → nilai bertipe yang BERLAKU pada tanggal bisnis itu (riwayat per
 *   `effective_from`). Lingkup paling spesifik menang: outlet > tenant > global. Tanpa baris di DB → nilai bawaan
 *   seed Lampiran B (atau `fallback` registri).
 * - `set(ctx, key, value, effectiveFrom, reason)` → hanya PEMILIK (izin `m10.parameter.update`); tanggal berlaku
 *   tidak boleh surut; berjejak audit; notifikasi Admin Keuangan + peran terdampak (6.2b).
 * - `history(tx, key)` → riwayat nilai (terbaru dulu). `listCurrent(tx)` → semua parameter + nilai berlaku.
 *
 * ATURAN: modul TIDAK menanam angka aturan; baca lewat `get`. Contoh:
 * ```ts
 * const { amount } = await params.get(tx, "PAR-01", businessDate);   // ambang selisih → pemilik
 * ```
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { parameters } from "@/db/schema";
import { formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "./audit";
import { ctxBusinessDate, type ActorContext } from "./context";
import { runInTx, type Tx } from "./db";
import { parseInput, ValidationError } from "./errors";
import { notify } from "./notifications/service";
import { invalidateParamCaches, resolve, schemaOf, type ParamScopeRef } from "./params-read";
import { isParamKey, paramMeta, type ParamKey, type ParamScopeLevel, type ParamValue } from "./params-registry";
import { authorize } from "./rbac/authorize";

export * from "./params-read";
export { PARAM_KEYS, PARAM_REGISTRY, isParamKey, paramMeta } from "./params-registry";
export type { ParamKey, ParamValue, ParamMeta, ParamScopeLevel } from "./params-registry";

export type SetParamOptions = ParamScopeRef & { tx?: Tx };

const reasonSchema = z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." });

/**
 * Tetapkan nilai parameter mulai `effectiveFrom` (hanya pemilik, 6.2b). Baris dengan kunci+lingkup+tanggal yang sama
 * (jadwal ke depan) diperbarui; selain itu baris baru ditambahkan — riwayat tidak pernah dihapus.
 */
export async function set<K extends ParamKey>(
  ctx: ActorContext,
  key: K,
  value: ParamValue<K>,
  effectiveFrom: BusinessDate,
  reason: string,
  opts: SetParamOptions = {},
) {
  await authorize(ctx, "m10.parameter.update", { tx: opts.tx, objectType: "parameter", objectId: key });
  if (!isParamKey(key)) throw ValidationError.field("key", `Parameter tidak dikenal: ${String(key)}.`);
  const meta = paramMeta(key);

  const level: ParamScopeLevel = opts.outletId ? "outlet" : opts.tenantId ? "tenant" : "global";
  if (!meta.scopes.includes(level)) {
    throw ValidationError.field("scope", `Parameter ${key} tidak dapat diatur per ${level === "outlet" ? "outlet" : "tenant"}.`);
  }
  if (!isBusinessDate(effectiveFrom)) {
    throw ValidationError.field("effectiveFrom", "Tanggal berlaku tidak valid. Gunakan format YYYY-MM-DD.");
  }
  const today = ctxBusinessDate(ctx);
  if (effectiveFrom < today) {
    throw ValidationError.field("effectiveFrom", "Tanggal berlaku tidak boleh sebelum hari ini (parameter tidak berlaku surut).");
  }
  const cleanReason = parseInput(reasonSchema, reason, { "": "Alasan" });
  const parsed = parseInput(schemaOf(key), value) as ParamValue<K>;

  return runInTx(opts.tx, async (tx) => {
    const scope: ParamScopeRef = { tenantId: opts.tenantId ?? null, outletId: opts.outletId ?? null };
    const previous = await resolve(tx, key, effectiveFrom, scope);

    const sameRow = await tx
      .select({ id: parameters.id })
      .from(parameters)
      .where(
        and(
          eq(parameters.key, key),
          eq(parameters.effectiveFrom, effectiveFrom),
          scope.outletId ? eq(parameters.outletId, scope.outletId) : isNull(parameters.outletId),
          scope.tenantId && !scope.outletId ? eq(parameters.tenantId, scope.tenantId) : isNull(parameters.tenantId),
        ),
      )
      .limit(1);

    const [row] = sameRow[0]
      ? await tx
          .update(parameters)
          .set({ value: parsed, reason: cleanReason, createdBy: ctx.userId })
          .where(eq(parameters.id, sameRow[0].id))
          .returning()
      : await tx
          .insert(parameters)
          .values({
            key,
            name: meta.name,
            value: parsed,
            unit: meta.unit,
            reference: meta.reference,
            description: meta.description ?? null,
            effectiveFrom,
            tenantId: scope.outletId ? null : scope.tenantId,
            outletId: scope.outletId,
            reason: cleanReason,
            createdBy: ctx.userId,
          })
          .returning();
    // Tambahan v1.0.1: cache pembacaan (`cached(tx)`) di lingkup yang sama tidak boleh memakai nilai lama.
    invalidateParamCaches();

    await auditRecord(tx, {
      ctx,
      objectType: "parameter",
      objectId: key,
      action: "set",
      before: { value: previous.value, effectiveFrom: previous.effectiveFrom, source: previous.source },
      after: { value: parsed, effectiveFrom, scope: level, tenantId: scope.tenantId, outletId: scope.outletId },
      reason: cleanReason,
      rule: "6.2b",
    });

    await notify(tx, {
      event: "parameter.changed",
      tenantId: ctx.tenantId,
      recipients: { roles: Array.from(new Set(["finance_admin" as const, ...meta.affectedRoles])) },
      excludeUserIds: ctx.userId ? [ctx.userId] : [],
      title: `Parameter ${key} diubah pemilik`,
      body: `${meta.name} — berlaku mulai ${formatTanggal(effectiveFrom)}. Alasan: ${cleanReason}`,
      objectType: "parameter",
      objectId: key,
      link: "/pengaturan/parameter",
      now: ctx.now,
    });

    return row!;
  });
}

