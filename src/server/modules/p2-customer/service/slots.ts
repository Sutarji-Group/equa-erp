/**
 * P2 — slot pengiriman (US-P2-02 KP-2, PTB-51, PAR-73). Slot yang ditawarkan berasal dari kapasitas rit harian M2
 * (US-M2-10: kapasitas truk operasi per hari, `m2.getWeekRoster`) dikurangi rit yang sudah terjadwal/terpesan pada
 * tanggal itu; slot penuh tidak dapat dipilih; pemesanan H+0 setelah batas PAR-05 (BR-20) tidak tersedia.
 *
 * Kapasitas per slot = kapasitas harian × porsi durasi slot (PAR-73), dibatasi sisa kapasitas harian. Rit tanpa slot
 * dihitung ke slot menurut jam diminta; tanpa jam → hanya mengurangi sisa harian.
 */
import "server-only";

import { and, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";

import { orders, trips } from "@/db/schema";
import { addDays, formatTanggal, parseHourMinute, toWibParts, type BusinessDate } from "@/lib/time";

import type { Tx } from "@/server/core/db";
import { DomainError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import * as m2 from "@/server/modules/m2-orders";

import { appRules, sysCtx } from "./common";

export type SlotDef = { key: string; start: string; end: string };

export type SlotAvailability = {
  key: string;
  label: string;
  start: string;
  end: string;
  capacity: number;
  used: number;
  remaining: number;
  available: boolean;
  /** Alasan tidak tersedia (bahasa pelanggan). */
  reason: string | null;
};

export type DayAvailability = {
  date: BusinessDate;
  dateLabel: string;
  capacity: number;
  used: number;
  remaining: number;
  slots: SlotAvailability[];
  /** Pesan hari (mis. batas H+0 lewat). */
  note: string | null;
};

const SLOT_LABELS: Record<string, string> = { morning: "Pagi", midday: "Siang", afternoon: "Sore" };

export function slotLabel(slot: SlotDef): string {
  return `${SLOT_LABELS[slot.key] ?? slot.key} ${slot.start.replace(":", ".")}–${slot.end.replace(":", ".")}`;
}

export async function slotDefs(tx: Tx, date: BusinessDate): Promise<SlotDef[]> {
  return (await params.get(tx, "PAR-73", date)).slots;
}

/** Hitungan rit terpesan per tanggal (tidak ditarik, bukan Gagal, pesanan tidak Dibatalkan) + per slot. */
async function usage(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate) {
  return tx
    .select({ date: trips.scheduledDate, slot: orders.slot, requestedTime: orders.requestedTime, n: sql<number>`count(*)::int` })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(
      and(
        eq(trips.tenantId, tenantId),
        gte(trips.scheduledDate, from),
        lte(trips.scheduledDate, to),
        isNull(trips.withdrawnAt),
        ne(trips.status, "failed"),
        ne(orders.status, "cancelled"),
      ),
    )
    .groupBy(trips.scheduledDate, orders.slot, orders.requestedTime);
}

function slotOfTime(slots: SlotDef[], time: string | null): string | null {
  if (!time) return null;
  const m = parseHourMinute(time.slice(0, 5));
  return slots.find((s) => m >= parseHourMinute(s.start) && m < parseHourMinute(s.end))?.key ?? null;
}

/**
 * Ketersediaan slot `days` hari mulai `from` untuk `tankCount` tangki (US-P2-02 KP-2). `now` menentukan batas H+0.
 */
export async function slotAvailability(tx: Tx, input: { tenantId: string; now: Date; from?: BusinessDate; days?: number; tankCount?: number }): Promise<DayAvailability[]> {
  const nowParts = toWibParts(input.now);
  const today = nowParts.businessDate;
  const rules = await appRules(tx, today, input.tenantId);
  const from = input.from && input.from >= today ? input.from : today;
  const days = Math.min(input.days ?? rules.order_horizon_days, rules.order_horizon_days);
  const lastDate = addDays(today, rules.order_horizon_days - 1);
  const to = addDays(from, days - 1) > lastDate ? lastDate : addDays(from, days - 1);
  const tankCount = Math.max(1, input.tankCount ?? 1);
  const cutoff = (await params.get(tx, "PAR-05", today)).time;
  if (to < from) return [];
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const roster = await m2.getWeekRoster(sysCtx(input.tenantId, input.now), from, { tx, days: span });
  const counts = await usage(tx, input.tenantId, from, to);
  const out: DayAvailability[] = [];
  for (let i = 0; i < span; i++) {
    const date = addDays(from, i);
    const slots = await slotDefs(tx, date);
    const totalMinutes = slots.reduce((s, x) => s + (parseHourMinute(x.end) - parseHourMinute(x.start)), 0) || 1;
    const capacity = roster.totals.find((t) => t.date === date)?.capacity ?? 0;
    const dayCounts = counts.filter((c) => c.date === date);
    const used = dayCounts.reduce((s, c) => s + Number(c.n), 0);
    const remaining = Math.max(0, capacity - used);
    const afterCutoff = date === today && nowParts.time >= cutoff;
    const slotRows: SlotAvailability[] = slots.map((s) => {
      const share = (parseHourMinute(s.end) - parseHourMinute(s.start)) / totalMinutes;
      const slotCap = Math.floor(capacity * share);
      const slotUsed = dayCounts.filter((c) => (c.slot ?? slotOfTime(slots, c.requestedTime)) === s.key).reduce((sum, c) => sum + Number(c.n), 0);
      const slotRemaining = Math.max(0, Math.min(slotCap - slotUsed, remaining));
      let reason: string | null = null;
      if (afterCutoff) reason = `Pesanan hari ini ditutup pukul ${cutoff.replace(":", ".")}. Pilih besok atau telepon kantor.`;
      else if (date === today && nowParts.time >= s.start) reason = "Slot ini sudah lewat.";
      else if (capacity <= 0) reason = "Tidak ada truk beroperasi.";
      else if (slotRemaining < tankCount) reason = "Penuh";
      return {
        key: s.key,
        label: slotLabel(s),
        start: s.start,
        end: s.end,
        capacity: slotCap,
        used: slotUsed,
        remaining: slotRemaining,
        available: reason === null,
        reason,
      };
    });
    out.push({
      date,
      dateLabel: formatTanggal(date),
      capacity,
      used,
      remaining,
      slots: slotRows,
      note: afterCutoff ? `Pemesanan untuk hari ini sudah ditutup (batas pukul ${cutoff.replace(":", ".")}).` : null,
    });
  }
  return out;
}

/** Periksa satu slot (dipakai saat kirim pesanan; memakai data terbaru di transaksi yang sama). */
export async function assertSlotAvailable(tx: Tx, input: { tenantId: string; now: Date; date: BusinessDate; slot: string; tankCount: number }): Promise<SlotAvailability> {
  const [day] = await slotAvailability(tx, { tenantId: input.tenantId, now: input.now, from: input.date, days: 1, tankCount: input.tankCount });
  const today = toWibParts(input.now).businessDate;
  if (!day || day.date !== input.date) {
    throw new SlotError(input.date < today ? "Tanggal kirim sudah lewat. Pilih tanggal lain." : "Tanggal kirim di luar jangkauan pemesanan aplikasi. Pilih tanggal yang lebih dekat atau telepon kantor.");
  }
  const slot = day.slots.find((s) => s.key === input.slot);
  if (!slot) throw new SlotError("Slot tidak dikenal. Pilih pagi, siang, atau sore.");
  if (!slot.available) throw new SlotError(slot.reason === "Penuh" ? `Slot ${slot.label} ${day.dateLabel} penuh. Pilih slot atau tanggal lain.` : (slot.reason ?? "Slot tidak tersedia."));
  return slot;
}

export class SlotError extends DomainError {
  constructor(message: string) {
    super("SLOT_UNAVAILABLE", message);
  }
}
