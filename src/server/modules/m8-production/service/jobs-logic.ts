/**
 * M8 — logika pekerjaan terjadwal (dipanggil `jobs.ts`; idempoten).
 *
 * - Cek pembacaan meter (US-M8-01 KP-3): pada jam batas pagi (08.00) / malam (23.00) `m8.production_rules`, meter aktif
 *   yang belum dibaca → pengingat ke operator sumber itu + notifikasi pemilik "produksi belum tercatat" (sekali per
 *   sumber/tanggal/fase); produksi hari itu berstatus "Belum lengkap". Cek malam juga membentuk neraca hari itu
 *   (belum lengkap bila pembacaan malam belum ada) sehingga utilisasi & H+0 tetap terisi.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { waterSources } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { systemContext } from "@/server/core/context";
import { withTx, type Db } from "@/server/core/db";

import { PHASE_LABEL } from "@/client/m8-production/contract";

import { refreshSourceDay } from "./balance";
import { m8Rules, notifyOnce } from "./common";
import { computeDailyProduction, liveReadings, metersForDate } from "./production";

export type ReadingCheckResult = { checked: number; missing: { sourceId: string; meters: string[] }[] };

export async function runReadingCheck(now: Date, phase: "morning" | "evening", db?: Db): Promise<ReadingCheckResult> {
  return withTx(
    async (tx) => {
      const date = toBusinessDate(now);
      const sources = await tx.select().from(waterSources).where(eq(waterSources.isActive, true));
      const result: ReadingCheckResult = { checked: 0, missing: [] };
      for (const source of sources) {
        const ctx = systemContext({ tenantId: source.tenantId, now });
        const meters = (await metersForDate(tx, source.id, date)).filter((m) => m.status === "active");
        if (meters.length === 0) continue;
        result.checked++;
        const readings = await liveReadings(
          tx,
          meters.map((m) => m.id),
          date,
          date,
        );
        const missing = meters.filter((m) => !readings.some((r) => r.waterMeterId === m.id && r.phase === phase));
        if (phase === "evening") await refreshSourceDay(tx, ctx, source.id, date, { createBalance: true });
        else await computeDailyProduction(tx, ctx, source.id, date);
        if (missing.length === 0) continue;
        result.missing.push({ sourceId: source.id, meters: missing.map((m) => m.code) });
        const rules = await m8Rules(tx, date, source.tenantId);
        const deadline = (phase === "morning" ? rules.morningDeadline : rules.eveningDeadline).replace(":", ".");
        const what = `Pembacaan ${PHASE_LABEL[phase].toLowerCase()} ${missing.map((m) => m.code).join(", ")}`;
        await notifyOnce(tx, {
          event: "production.reading_reminder",
          tenantId: source.tenantId,
          groupKey: `reading_reminder:${source.id}:${date}:${phase}`,
          recipients: { roles: ["production_operator"], scope: { sourceId: source.id } },
          title: `${what} belum dicatat (${source.name})`,
          body: `Sudah lewat ${deadline}. Catat angka meter + foto sekarang; aplikasi meminta alasan keterlambatan.`,
          objectType: "water_source",
          objectId: source.id,
          now,
        });
        await notifyOnce(tx, {
          event: "production.missing_or_negative",
          tenantId: source.tenantId,
          groupKey: `production_missing:${source.id}:${date}:${phase}`,
          title: `Produksi belum tercatat: ${source.name} ${date}`,
          body: `${what} belum ada pada ${deadline}. Produksi hari ini berstatus "Belum lengkap" sampai dilengkapi dengan alasan.`,
          objectType: "water_source",
          objectId: source.id,
          link: `/produksi/neraca-air/rincian?sumber=${source.id}&tanggal=${date}`,
          now,
        });
      }
      return result;
    },
    db ? { db } : {},
  );
}
