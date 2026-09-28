"use server";

/**
 * Server Action papan jadwal (M2, US-M2-03). Tipis: sesi kantor → layanan modul → revalidate.
 */
import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m2-orders/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m2 from "@/server/modules/m2-orders";

import { attempt } from "../pesanan/_lib/form";

function refresh() {
  revalidatePath("/jadwal");
  revalidatePath("/pesanan");
}

export async function assignTripAction(input: { tripId: string; truckId: string; date: string; position?: number | null }): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.assignTrip(ctx, input);
    return { message: "Rit ditugaskan.", warnings: r.warnings };
  });
  refresh();
  return res;
}

export async function unassignTripAction(tripId: string, reason?: string | null): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.unassignTrip(ctx, { tripId, reason: reason ?? null });
  }, "Rit dikembalikan ke kolom Belum terjadwal.");
  refresh();
  return res;
}

export async function moveTripAction(tripId: string, direction: "up" | "down"): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.moveTripInLane(ctx, { tripId, direction });
  });
  refresh();
  return res;
}

export async function reorderLaneAction(input: { truckId: string; date: string; tripIds: string[] }): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.reorderTrips(ctx, input);
  }, "Urutan rit disimpan.");
  refresh();
  return res;
}

export async function suggestOrderAction(truckId: string, date: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.applySuggestedOrder(ctx, { truckId, date });
  }, "Urutan usulan BR-21 diterapkan.");
  refresh();
  return res;
}

export async function publishAction(truckId: string, date: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.publishSchedule(ctx, { truckId, date });
    return { message: r.revision === 0 ? `Jadwal ${r.truckCode} terbit ke aplikasi sopir.` : `Perubahan jadwal ${r.truckCode} terbit (revisi ${r.revision}).`, warnings: r.warnings };
  });
  refresh();
  return res;
}

export async function publishAllAction(date: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.publishAllSchedules(ctx, date);
    return {
      message: r.published.length ? `${r.published.length} jadwal truk terbit (${r.published.map((p) => p.truckCode).join(", ")}).` : undefined,
      warnings: [...r.published.flatMap((p) => p.warnings), ...r.failed.map((f) => `${f.truckCode}: ${f.message}`)],
    };
  });
  refresh();
  return res;
}

export async function resolveConflictAction(tripId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.resolveTripConflict(ctx, { tripId, note: reason });
  }, "Konflik ditandai sudah ditindaklanjuti.");
  refresh();
  return res;
}
