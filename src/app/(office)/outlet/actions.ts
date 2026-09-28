"use server";

import { revalidatePath } from "next/cache";

import type { OutletActionState } from "@/components/m6-pos/office-action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as m6 from "@/server/modules/m6-pos";

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function num(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(/[^0-9.,-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function attempt(fn: () => Promise<unknown>, message: string, paths: string[]): Promise<OutletActionState> {
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Admin Keuangan: pembalik transaksi pada shift yang sudah ditutup (void disetujui setelah tutup / koreksi ≤ PAR-21). */
export async function reverseSaleAction(saleId: string, shiftId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m6.reverseSaleAfterClose(ctx, { saleId, reason: str(fd, "reason") ?? "" }), "Transaksi pembalik dibuat.", [`/outlet/shift/${shiftId}`, "/outlet"]);
}

/** Admin Keuangan: tandai konflik shift sudah ditinjau. */
export async function resolveConflictAction(shiftId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m6.resolveShiftConflict(ctx, { shiftId, note: str(fd, "note") ?? "" }), "Konflik shift ditandai sudah ditinjau.", [`/outlet/shift/${shiftId}`, "/outlet"]);
}

/** Pemilik: pengaturan POS outlet (kas awal tetap, QRIS, printer). */
export async function updateSettingsAction(outletId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      m6.updateOutletPosSettings(ctx, {
        outletId,
        fixedOpeningCash: num(fd, "fixedOpeningCash"),
        qrisEnabled: fd.get("qrisEnabled") === "on",
        printerEnabled: fd.get("printerEnabled") === "on",
        reason: str(fd, "reason") ?? "",
      }),
    "Pengaturan POS outlet disimpan.",
    [`/outlet/${outletId}`],
  );
}

/** Pemilik: ambang per outlet (PAR-02/03/04/57/58/59) dengan tanggal berlaku. */
export async function setThresholdAction(outletId: string, _prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      m6.setOutletThreshold(ctx, {
        outletId,
        key: (str(fd, "key") ?? "PAR-04") as m6.OutletThresholdKey,
        value: num(fd, "value") ?? -1,
        effectiveFrom: str(fd, "effectiveFrom") ?? "",
        reason: str(fd, "reason") ?? "",
      }),
    "Ambang outlet ditetapkan.",
    [`/outlet/${outletId}`],
  );
}

/** Admin sistem: tenant mitra baru + salinan katalog standar EQUA. */
export async function createTenantAction(_prev: OutletActionState, fd: FormData): Promise<OutletActionState> {
  const { ctx } = await requireOfficeSession();
  let summary = "";
  const res = await attempt(
    async () => {
      const r = await m6.createPartnerTenant(ctx, {
        code: str(fd, "code") ?? "",
        name: str(fd, "name") ?? "",
        outlets: [{ code: str(fd, "outletCode") ?? "", name: str(fd, "outletName") ?? "", address: str(fd, "outletAddress"), storageCapacityL: num(fd, "storageCapacityL") }],
        copyStandardCatalog: fd.get("copyStandardCatalog") === "on",
        reason: str(fd, "reason") ?? "",
      });
      summary = ` Katalog standar disalin: ${r.copied.products} produk, ${r.copied.prices} harga, ${r.copied.recipes} resep.`;
    },
    "Tenant mitra dibuat.",
    ["/outlet/tenant"],
  );
  return res.ok ? { ...res, message: `${res.message}${summary}` } : res;
}
