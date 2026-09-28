/**
 * M10 — kebijakan tampilan data pribadi (US-M10-06 KP-1; NFR-12; BR-39). MURNI (tanpa DB) — dipakai modul lain lewat
 * `index.ts` saat menyajikan data pelanggan/karyawan.
 *
 * Pelanggan (nama, WA, alamat, koordinat): tampil penuh untuk peran yang memerlukannya untuk tugasnya — Dispatcher
 * (M1/M2), Admin Keuangan (piutang), Pemilik, dan Sopir/Kernet HANYA untuk rit hari itu; peran lain melihat nama tanpa
 * kontak.
 *
 * Karyawan (PIN, riwayat selisih, ganti rugi): pemilik; admin sistem TANPA nilai selisih/ganti rugi; yang bersangkutan
 * (datanya sendiri). Peran lain tidak melihat.
 */
import type { RoleCode } from "@/lib/labels";
import type { ActorContext } from "@/server/core/context";

export type CustomerPiiLevel = "full" | "name_only";

export type ViewPolicy = {
  /** Tingkat data pribadi pelanggan untuk pelaku ini. */
  customer: CustomerPiiLevel;
  /** Boleh melihat data karyawan sensitif orang lain (tanpa memperhitungkan data dirinya sendiri). */
  employeeSensitive: "full" | "without_values" | "none";
  /** Boleh mengekspor data pribadi pelanggan (BR-39: dengan tujuan tercatat). */
  exportPii: boolean;
};

const CUSTOMER_FULL: readonly RoleCode[] = ["owner", "dispatcher", "finance_admin"];
const FIELD_TRIP_ROLES: readonly RoleCode[] = ["driver", "helper"];

/**
 * Kebijakan tampilan untuk pelaku. `ownTripToday` = data yang diminta adalah pelanggan rit milik pelaku hari itu
 * (diperiksa modul pemanggil, mis. M3 lewat jadwal kru).
 */
export function viewPolicy(ctx: Pick<ActorContext, "roles" | "source" | "userId">, opts: { ownTripToday?: boolean } = {}): ViewPolicy {
  const system = ctx.source === "system" && ctx.userId === null;
  const roles = ctx.roles;
  let customer: CustomerPiiLevel = "name_only";
  if (system || roles.some((r) => CUSTOMER_FULL.includes(r))) customer = "full";
  else if (opts.ownTripToday && roles.some((r) => FIELD_TRIP_ROLES.includes(r))) customer = "full";
  const employeeSensitive = system || roles.includes("owner") ? "full" : roles.includes("system_admin") ? "without_values" : "none";
  return { customer, employeeSensitive, exportPii: system || roles.includes("owner") || roles.includes("finance_admin") };
}

/** Samarkan nomor telepon/WA: `6281234567890` → `62•••••••7890`. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\s+/g, "");
  if (digits.length <= 6) return "•".repeat(digits.length);
  return `${digits.slice(0, 2)}${"•".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/** Pangkas alamat ke wilayah (bagian setelah koma terakhir) — sama dengan aturan ekspor BR-39. */
export function regionOnly(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : null;
}

export type CustomerPiiFields = {
  name?: string | null;
  contactName?: string | null;
  waPhone?: string | null;
  phone?: string | null;
  addressText?: string | null;
  address?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  proposedLat?: number | string | null;
  proposedLng?: number | string | null;
};

/**
 * Terapkan kebijakan ke baris pelanggan/alamat: peran tanpa kebutuhan tugas melihat NAMA TANPA KONTAK — WA/telepon
 * disamarkan, alamat dipangkas ke wilayah, koordinat dikosongkan, nama kontak dikosongkan.
 */
export function maskCustomerPii<T extends CustomerPiiFields>(ctx: Pick<ActorContext, "roles" | "source" | "userId">, row: T, opts: { ownTripToday?: boolean } = {}): T {
  if (viewPolicy(ctx, opts).customer === "full") return row;
  const out: T = { ...row };
  if ("waPhone" in out) out.waPhone = maskPhone(out.waPhone);
  if ("phone" in out) out.phone = maskPhone(out.phone);
  if ("contactName" in out) out.contactName = null;
  if ("addressText" in out) out.addressText = regionOnly(out.addressText);
  if ("address" in out) out.address = regionOnly(out.address);
  for (const k of ["lat", "lng", "proposedLat", "proposedLng"] as const) if (k in out) out[k] = null;
  return out;
}

export type EmployeeDataKind = "pin" | "discrepancy_history" | "restitution" | "contact";

/**
 * Akses data karyawan sensitif (US-M10-06 KP-1): `full` / `without_values` (admin sistem: tanpa nilai selisih & ganti
 * rugi) / `none`. Yang bersangkutan selalu melihat datanya sendiri (kecuali hash PIN yang tidak pernah ditampilkan).
 */
export function employeeDataAccess(
  ctx: Pick<ActorContext, "roles" | "source" | "userId" | "employeeId">,
  employeeId: string,
  kind: EmployeeDataKind,
): "full" | "without_values" | "none" {
  if (kind === "pin") {
    // PIN tidak pernah dapat dibaca siapa pun (hash); hanya status "sudah/ belum ditetapkan" untuk admin sistem & pemilik.
    return ctx.roles.includes("owner") || ctx.roles.includes("system_admin") || ctx.employeeId === employeeId ? "without_values" : "none";
  }
  if (ctx.employeeId && ctx.employeeId === employeeId) return "full";
  const policy = viewPolicy(ctx).employeeSensitive;
  if (policy === "without_values" && kind === "contact") return "full";
  return policy;
}

/** Hilangkan nilai rupiah dari catatan karyawan untuk tingkat `without_values`. */
export function redactEmployeeValues<T extends Record<string, unknown>>(row: T, access: "full" | "without_values" | "none", valueKeys: readonly (keyof T)[] = ["amount"]): T | null {
  if (access === "none") return null;
  if (access === "full") return row;
  const out = { ...row };
  for (const k of valueKeys) if (k in out) (out as Record<string, unknown>)[k as string] = null;
  return out;
}
