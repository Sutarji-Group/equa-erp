/**
 * Feature flag per global / tenant / outlet / truk (PRD 2.1 "fitur dapat dimatikan per unit"; D-02, D-03).
 *
 * - `isEnabled(tx, key, { tenantId?, outletId?, truckId? })` — lingkup paling spesifik menang: truk > outlet >
 *   tenant > global; tanpa baris di DB → nilai bawaan registri.
 * - `set(ctx, key, enabled, { scope, reason })` — hanya peran yang ditetapkan per flag (pemilik; beberapa flag teknis
 *   juga admin sistem), alasan wajib, berjejak audit.
 *
 * BERKAS BERSAMA — tambah flag baru di `FLAG_REGISTRY` (append).
 */
import "server-only";

import { and, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";

import { featureFlags } from "@/db/schema";
import { label, type RoleCode } from "@/lib/labels";

import { record as auditRecord } from "./audit";
import { isSystem, type ActorContext } from "./context";
import { isTransaction, runInTx, type Tx } from "./db";
import { DomainError, ForbiddenError, parseInput, ValidationError } from "./errors";
import { recordDenial } from "./rbac/authorize";

export type FlagScopeType = "global" | "tenant" | "outlet" | "truck";

export type FlagDef = {
  description: string;
  defaultEnabled: boolean;
  /** Lingkup yang diizinkan untuk flag ini. */
  scopes: readonly FlagScopeType[];
  /** Peran yang boleh mengubah. */
  setters: readonly RoleCode[];
  reference: string;
};

export const FLAG_REGISTRY = {
  "phase2.customer_app": {
    description: "Aplikasi pelanggan Tahap 2 (PRD Bab 8; gerbang TG-9).",
    defaultEnabled: false,
    scopes: ["global", "tenant"],
    setters: ["owner"],
    reference: "D-02, Bab 8.1",
  },
  "phase3.partner_portal": {
    description: "Portal kemitraan lengkap Tahap 3 (PRD Bab 9).",
    defaultEnabled: false,
    scopes: ["global", "tenant"],
    setters: ["owner"],
    reference: "D-02, Bab 9.1",
  },
  "approvals.delegation": {
    description: "Pendelegasian persetujuan (PTB-32; bawaan tanpa delegasi).",
    defaultEnabled: false,
    scopes: ["global", "tenant"],
    setters: ["owner"],
    reference: "PTB-32, US-M10-04 KP-5",
  },
  "partner.franchise_terms": {
    description: "Istilah \"waralaba\" di antarmuka (PTB-57; bawaan \"Mitra Depot EQUA\").",
    defaultEnabled: false,
    scopes: ["global"],
    setters: ["owner"],
    reference: "PTB-57",
  },
  "accounting.m11_active": {
    description: "Jurnal otomatis M11 aktif (R04: M11 dapat menyusul; jurnal dibangkitkan retroaktif, PTB-47).",
    defaultEnabled: true,
    scopes: ["global", "tenant"],
    setters: ["owner"],
    reference: "R04, PTB-47, US-M9-02 KP-5",
  },
  "fleet.offschedule_detection": {
    description: "Deteksi perjalanan di luar jadwal/jam per truk (US-M12-05; dimatikan per truk sampai perangkat GPS aktif).",
    defaultEnabled: true,
    scopes: ["global", "truck"],
    setters: ["owner", "system_admin"],
    reference: "US-M12-05, 7.12.6",
  },
  "cash.restitution_active": {
    description: "Ganti rugi karyawan aktif setelah Peraturan Perusahaan berlaku (BR-11, PTB-22).",
    defaultEnabled: false,
    scopes: ["global", "tenant"],
    setters: ["owner"],
    reference: "BR-11, PTB-22, US-M4-03 KP-4",
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAG_REGISTRY;

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_REGISTRY, key);
}

export type FlagScopeRef = { tenantId?: string | null; outletId?: string | null; truckId?: string | null };

function assertKnown(key: string): asserts key is FlagKey {
  if (!isFlagKey(key)) throw new DomainError("FLAG_UNKNOWN", `Feature flag tidak dikenal: ${key}.`);
}

const SPECIFICITY: Record<FlagScopeType, number> = { truck: 4, outlet: 3, tenant: 2, global: 1 };

/** Benar bila fitur aktif untuk lingkup tersebut. */
export async function isEnabled(tx: Tx, key: FlagKey, scope: FlagScopeRef = {}): Promise<boolean> {
  assertKnown(key);
  const rows = await tx
    .select({ scopeType: featureFlags.scopeType, scopeRefId: featureFlags.scopeRefId, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(eq(featureFlags.key, key));

  let best: { rank: number; enabled: boolean } | null = null;
  for (const row of rows) {
    const type = row.scopeType as FlagScopeType;
    const matches =
      (type === "global" && row.scopeRefId === null) ||
      (type === "tenant" && !!scope.tenantId && row.scopeRefId === scope.tenantId) ||
      (type === "outlet" && !!scope.outletId && row.scopeRefId === scope.outletId) ||
      (type === "truck" && !!scope.truckId && row.scopeRefId === scope.truckId);
    if (!matches) continue;
    const rank = SPECIFICITY[type];
    if (!best || rank > best.rank) best = { rank, enabled: row.enabled };
  }
  return best ? best.enabled : FLAG_REGISTRY[key].defaultEnabled;
}

export type SetFlagInput = {
  scope?: { type: FlagScopeType; refId?: string | null };
  reason: string;
};

/** Ubah flag (pemilik; flag teknis tertentu juga admin sistem). */
export async function set(ctx: ActorContext, key: FlagKey, enabled: boolean, input: SetFlagInput, opts: { tx?: Tx } = {}) {
  assertKnown(key);
  const def: FlagDef = FLAG_REGISTRY[key];
  const scopeType = input.scope?.type ?? "global";
  const refId = scopeType === "global" ? null : (input.scope?.refId ?? null);

  if (!isSystem(ctx) && !def.setters.some((r) => ctx.roles.includes(r))) {
    const err = new ForbiddenError(
      `Feature flag "${key}" hanya dapat diubah oleh ${def.setters.map((r) => label("role", r)).join(" atau ")}.`,
      { permission: "m10.feature_flag.update", rule: "FLAG-SETTER", objectType: "feature_flag", objectId: key },
    );
    if (!isTransaction(opts.tx)) await recordDenial(ctx, err);
    throw err;
  }
  if (!def.scopes.includes(scopeType)) {
    throw ValidationError.field("scope", `Feature flag "${key}" tidak dapat diatur per ${scopeType}.`);
  }
  if (scopeType !== "global" && !refId) throw ValidationError.field("scope", "Pilih unit yang diatur.");
  const reason = parseInput(z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }), input.reason);

  return runInTx(opts.tx, async (tx) => {
    const where: SQL[] = [eq(featureFlags.key, key), eq(featureFlags.scopeType, scopeType)];
    where.push(refId ? eq(featureFlags.scopeRefId, refId) : isNull(featureFlags.scopeRefId));
    const existing = await tx.select().from(featureFlags).where(and(...where)).limit(1);
    const before = existing[0] ? { enabled: existing[0].enabled } : { enabled: def.defaultEnabled, source: "default" };

    const [row] = existing[0]
      ? await tx
          .update(featureFlags)
          .set({ enabled, reason, updatedBy: ctx.userId })
          .where(eq(featureFlags.id, existing[0].id))
          .returning()
      : await tx
          .insert(featureFlags)
          .values({
            key,
            scopeType,
            scopeRefId: refId,
            enabled,
            description: def.description,
            reason,
            updatedBy: ctx.userId,
          })
          .returning();

    await auditRecord(tx, {
      ctx,
      objectType: "feature_flag",
      objectId: refId ? `${key}@${scopeType}:${refId}` : key,
      action: "set",
      before,
      after: { enabled, scopeType, scopeRefId: refId },
      reason,
    });
    return row!;
  });
}

/** Semua flag terdaftar + nilai global efektif (untuk halaman pengaturan). */
export async function listFlags(tx: Tx, scope: FlagScopeRef = {}) {
  const out: { key: FlagKey; description: string; enabled: boolean; scopes: readonly FlagScopeType[] }[] = [];
  for (const key of Object.keys(FLAG_REGISTRY) as FlagKey[]) {
    out.push({ key, description: FLAG_REGISTRY[key].description, enabled: await isEnabled(tx, key, scope), scopes: FLAG_REGISTRY[key].scopes });
  }
  return out;
}

/** Daftar flag aktif untuk lingkup (dipakai registri navigasi `enabledFlags`). */
export async function enabledFlags(tx: Tx, scope: FlagScopeRef = {}): Promise<FlagKey[]> {
  return (await listFlags(tx, scope)).filter((f) => f.enabled).map((f) => f.key);
}
