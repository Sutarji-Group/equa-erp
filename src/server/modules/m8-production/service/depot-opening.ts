/**
 * M8 — stok air AWAL depot untuk cut-over (backlog B-10; US-M6-05 KP-3 "stok air = stok awal + diterima − terjual").
 *
 * Admin Keuangan mencatat sekali per depot jumlah air di toren depot pada tanggal cut-over. Dicatat sebagai mutasi buku
 * air outlet jenis `opening` lewat API publik M6 (`postWaterMovement`, buku append-only). Salah catat TIDAK diubah di
 * sini: koreksi lewat penyesuaian stok air depot M6 (BR-27/BR-38) — sistem menolak stok awal kedua.
 */
import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { outletWaterLedger, outlets } from "@/db/schema";
import { newId } from "@/lib/ids";
import { isBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { authorize, inOutletScope, runService } from "@/server/core/rbac";
import { postWaterMovement, waterBalance } from "@/server/modules/m6-pos";

import { liter } from "./common";

const openingSchema = z
  .object({
    outletId: z.uuid({ error: "Pilih depot." }),
    volumeL: z.number({ error: "Isi jumlah air (liter)." }).int({ error: "Jumlah air dalam liter bulat." }).min(0, { error: "Jumlah air tidak boleh negatif." }).max(1_000_000),
    businessDate: z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." }).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Tulis dasar angka stok awal (minimal 5 huruf), mis. hasil ukur toren saat cut-over." }).max(300),
  })
  .strict();

export type DepotOpeningInput = z.input<typeof openingSchema>;

export type DepotOpeningRow = {
  outletId: string;
  outletCode: string;
  outletName: string;
  storageCapacityL: number | null;
  opening: { ledgerId: string; volumeL: number; businessDate: BusinessDate; recordedAt: Date } | null;
  /** Saldo buku air depot saat ini (Σ mutasi M6). */
  currentBalanceL: number;
};

/** Catat stok air awal satu depot (sekali). */
export async function recordDepotOpeningWater(ctx: ActorContext, input: DepotOpeningInput, opts: { tx?: Tx } = {}): Promise<{ ledgerId: string; balanceAfterL: number }> {
  await authorize(ctx, "m8.depot_water_opening.create", { tx: opts.tx, objectType: "outlet", objectId: input.outletId });
  const data = parseInput(openingSchema, input, { outletId: "Depot", volumeL: "Jumlah air", businessDate: "Tanggal cut-over", reason: "Dasar angka" });
  return runService(ctx, opts, async (tx) => {
    const [outlet] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
    if (!outlet || outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Depot tidak ditemukan.");
    if (outlet.kind !== "depot") throw new DomainError("NOT_A_DEPOT", `${outlet.name} bukan depot air — stok air awal hanya untuk depot.`);
    if (!inOutletScope(ctx, outlet.id, outlet.tenantId)) throw new NotFoundError("Depot tidak ditemukan.");
    const [existing] = await tx
      .select()
      .from(outletWaterLedger)
      .where(and(eq(outletWaterLedger.outletId, outlet.id), eq(outletWaterLedger.kind, "opening"), isNull(outletWaterLedger.reversalOfId)))
      .for("update")
      .limit(1);
    if (existing) {
      throw new DomainError(
        "DEPOT_OPENING_EXISTS",
        `Stok air awal ${outlet.name} sudah dicatat (${liter(existing.volumeL)} pada ${existing.businessDate}). Koreksi lewat penyesuaian stok air depot di menu Outlet.`,
      );
    }
    if (outlet.storageCapacityL !== null && data.volumeL > outlet.storageCapacityL) {
      throw new DomainError("DEPOT_OPENING_OVER_CAPACITY", `Stok awal ${liter(data.volumeL)} melebihi kapasitas toren ${outlet.name} (${liter(outlet.storageCapacityL)}). Periksa angkanya.`);
    }
    const date = data.businessDate ?? ctxBusinessDate(ctx);
    const refId = newId();
    const res = await postWaterMovement(tx, {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      kind: "opening",
      volumeL: data.volumeL,
      businessDate: date,
      occurredAt: ctx.now,
      source: { type: "depot_water_opening", id: refId },
    });
    await auditRecord(tx, {
      ctx,
      objectType: "depot_water_opening",
      objectId: res.id,
      action: "create",
      after: { outlet: outlet.code, kind: "opening", volumeL: data.volumeL, businessDate: date, balanceAfterL: res.balanceAfterL },
      reason: data.reason,
      rule: "B-10 (US-M6-05 KP-3)",
      businessDate: date,
    });
    return { ledgerId: res.id, balanceAfterL: res.balanceAfterL };
  });
}

/** Daftar depot + stok awal (bila sudah) + saldo buku air saat ini (`/produksi/pengisian`, tab stok awal). */
export async function depotWaterOpenings(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<DepotOpeningRow[]> {
  await authorize(ctx, "m8.truck_fill.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const depots = (await tx.select().from(outlets).where(and(eq(outlets.tenantId, ctx.tenantId), eq(outlets.kind, "depot"), eq(outlets.isActive, true))).orderBy(asc(outlets.code))).filter((o) =>
    inOutletScope(ctx, o.id, o.tenantId),
  );
  if (depots.length === 0) return [];
  const openings = await tx
    .select()
    .from(outletWaterLedger)
    .where(
      and(
        inArray(
          outletWaterLedger.outletId,
          depots.map((d) => d.id),
        ),
        eq(outletWaterLedger.kind, "opening"),
        isNull(outletWaterLedger.reversalOfId),
      ),
    );
  const out: DepotOpeningRow[] = [];
  for (const d of depots) {
    const o = openings.find((x) => x.outletId === d.id);
    out.push({
      outletId: d.id,
      outletCode: d.code,
      outletName: d.name,
      storageCapacityL: d.storageCapacityL,
      opening: o ? { ledgerId: o.id, volumeL: o.volumeL, businessDate: o.businessDate, recordedAt: o.createdAt } : null,
      currentBalanceL: await waterBalance(tx, d.id),
    });
  }
  return out;
}
