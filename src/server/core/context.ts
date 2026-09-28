/**
 * Konteks pelaku (docs/ARCHITECTURE.md §3). Setiap fungsi layanan menerima `ctx: ActorContext` sebagai argumen
 * pertama. Dibangun oleh lapisan autentikasi (F3c: sesi web / token perangkat) lewat `buildActorContext` di
 * `./actor.ts`, atau `systemContext()` untuk job terjadwal/aksi otomatis.
 *
 * Murni (tanpa DB, tanpa 'server-only'): aman diimpor dari kode server mana pun, termasuk skrip tsx.
 */
import { seedId } from "@/db/seed/ids";
import type { ActorSource, RoleCode } from "@/lib/labels";
import { toBusinessDate, type BusinessDate } from "@/lib/time";

import { DomainError } from "./errors";

export type ActorScope = {
  truckIds: string[];
  outletIds: string[];
  /** Sumber air (`water_sources.id`). */
  sourceIds: string[];
  tenantIds: string[];
};

export type ActorContext = {
  /** null hanya untuk 'system'. */
  userId: string | null;
  employeeId: string | null;
  /** Peran aktif. */
  roles: RoleCode[];
  scope: ActorScope;
  /** Tenant aktif (EQUA = tenant pertama). */
  tenantId: string;
  deviceId: string | null;
  source: ActorSource;
  /** Waktu server. */
  now: Date;
  /** Waktu perangkat (aksi lapangan). */
  deviceTime?: Date;
  /** YYYY-MM-DD WIB dari perangkat. */
  businessDate?: string;
};

/** ID tenant EQUA (deterministik, sama dengan seed `EQUA_TENANT_ID`). */
export const EQUA_TENANT_ID = seedId("tenant:EQUA");

export const EMPTY_SCOPE: ActorScope = Object.freeze({
  truckIds: [],
  outletIds: [],
  sourceIds: [],
  tenantIds: [],
}) as ActorScope;

export type SystemContextOptions = {
  tenantId?: string;
  now?: Date;
  businessDate?: string;
};

/**
 * Konteks "Sistem" untuk job terjadwal & tindakan otomatis (Ditahan otomatis, faktur bulanan, penyusutan, deteksi
 * GPS — US-M10-05 KP-5). `authorize` selalu mengizinkan sistem; jejak audit mencatat pelaku "Sistem" + aturan.
 */
export function systemContext(options: SystemContextOptions = {}): ActorContext {
  const tenantId = options.tenantId ?? EQUA_TENANT_ID;
  return {
    userId: null,
    employeeId: null,
    roles: [],
    scope: { truckIds: [], outletIds: [], sourceIds: [], tenantIds: [tenantId] },
    tenantId,
    deviceId: null,
    source: "system",
    now: options.now ?? new Date(),
    businessDate: options.businessDate,
  };
}

/** Benar bila konteks adalah sistem (bukan pengguna). */
export function isSystem(ctx: ActorContext): boolean {
  return ctx.source === "system" && ctx.userId === null;
}

/** Benar bila pelaku memegang peran tersebut (aktif). */
export function hasRole(ctx: ActorContext, ...roles: RoleCode[]): boolean {
  return roles.some((r) => ctx.roles.includes(r));
}

/**
 * Tanggal bisnis transaksi (Bab 5.3): tanggal WIB dari perangkat bila ada, bila tidak dari waktu perangkat, bila
 * tidak dari waktu server `ctx.now`.
 */
export function ctxBusinessDate(ctx: ActorContext): BusinessDate {
  if (ctx.businessDate) return ctx.businessDate;
  return toBusinessDate(ctx.deviceTime ?? ctx.now);
}

/** Salinan konteks dengan waktu server lain (mis. uji tenggat). */
export function withNow(ctx: ActorContext, now: Date): ActorContext {
  return { ...ctx, now };
}

/** Pengguna wajib ada (bukan sistem). Mengembalikan userId. */
export function requireUserId(ctx: ActorContext): string {
  if (!ctx.userId) {
    throw new DomainError("USER_REQUIRED", "Tindakan ini harus dilakukan oleh pengguna yang masuk, bukan oleh sistem.");
  }
  return ctx.userId;
}
