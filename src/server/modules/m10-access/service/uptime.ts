/**
 * M10 — gangguan layanan & laporan uptime bulanan (NFR-02, NFR-28, NFR-01/PAR-86, US-M10-07 KP-2).
 *
 * - Pemantau EKSTERNAL (`.github/workflows/cron.yml` → `scripts/uptime-monitor.sh`) memeriksa web kantor (`/masuk`) dan
 *   API sinkron (`/api/health/sync`) tiap 5 menit dari luar Vercel: gagal → peringatan langsung ke tim IT (webhook /
 *   e-mail) walau layanan mati; pulih → `POST /api/monitor/outage` → `recordServiceOutage` (mulai & pulih tercatat).
 * - Denyut job `m10.monitor.health` (layanan `app`): jeda > `monitoring.service_down` → gangguan tercatat saat tick
 *   sukses pertama (mulai = denyut sukses terakhir).
 * - Gangguan yang seluruhnya di dalam jendela pemeliharaan PAR-86 ditandai `inMaintenanceWindow` (log pemeliharaan) dan
 *   tidak membuka insiden. Laporan uptime = ketersediaan pada jam layanan PAR-07 vs target
 *   `monitoring.availability_target`.
 */
import "server-only";

import { and, asc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";

import { devices, serviceOutages } from "@/db/schema";
import { addDays, formatJam, formatTanggalJam, lastDayOfMonth, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { parseInput, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";

import { raiseIncident } from "./monitoring";

export const MONITORED_SERVICES = {
  app: "Layanan inti (pekerjaan terjadwal)",
  web: "Web kantor",
  sync: "API sinkron lapangan/POS",
} as const;
export type MonitoredService = keyof typeof MONITORED_SERVICES;
export type ServiceOutageRow = typeof serviceOutages.$inferSelect;

function overlapMinutes(a1: Date, a2: Date, b1: Date, b2: Date): number {
  const start = Math.max(a1.getTime(), b1.getTime());
  const end = Math.min(a2.getTime(), b2.getTime());
  return end > start ? (end - start) / 60_000 : 0;
}

/** Jendela harian WIB `start`–`end` untuk tanggal `date` (dapat melewati tengah malam) → interval UTC. */
function dailyWindow(date: BusinessDate, start: string, end: string): [Date, Date] {
  return [wibToUtc(date, start), end > start ? wibToUtc(date, end) : wibToUtc(addDays(date, 1), end)];
}

/** Benar bila seluruh interval berada di dalam jendela pemeliharaan PAR-86 (hari itu atau yang dimulai kemarin). */
export async function withinMaintenanceWindow(tx: Tx | Db, startedAt: Date, endedAt: Date): Promise<boolean> {
  const date = toBusinessDate(startedAt);
  const maint = await params.get(tx, "PAR-86", date);
  for (const d of [addDays(date, -1), date]) {
    const [ws, we] = dailyWindow(d, maint.start, maint.end);
    if (startedAt >= ws && endedAt <= we) return true;
  }
  return false;
}

const recordSchema = z
  .object({
    service: z.enum(["app", "web", "sync"], { error: "Layanan tidak dikenal." }),
    source: z.enum(["heartbeat", "external_monitor"]).default("external_monitor"),
    startedAt: z.coerce.date({ error: "Waktu mulai tidak valid." }),
    endedAt: z.coerce.date({ error: "Waktu pulih tidak valid." }),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

/**
 * Catat satu gangguan layanan (idempoten per layanan + waktu mulai). Di luar jendela pemeliharaan dan lebih lama dari
 * `monitoring.service_down` → insiden `service_down` (tim IT, `incident.opened`) dengan durasinya.
 */
export async function recordServiceOutage(
  input: z.input<typeof recordSchema>,
  opts: { tx?: Tx; db?: Db; raiseIncidents?: boolean } = {},
): Promise<{ outage: ServiceOutageRow; created: boolean }> {
  const data = parseInput(recordSchema, input, { service: "Layanan", startedAt: "Mulai", endedAt: "Pulih" });
  if (data.endedAt <= data.startedAt) throw ValidationError.field("endedAt", "Waktu pulih harus sesudah waktu mulai.");
  const run = async (tx: Tx) => {
    const durationMinutes = Math.max(1, Math.round((data.endedAt.getTime() - data.startedAt.getTime()) / 60_000));
    const maintenance = await withinMaintenanceWindow(tx, data.startedAt, data.endedAt);
    const [row] = await tx
      .insert(serviceOutages)
      .values({ service: data.service, source: data.source, startedAt: data.startedAt, endedAt: data.endedAt, durationMinutes, inMaintenanceWindow: maintenance, note: data.note ?? null, createdAt: data.endedAt })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [existing] = await tx.select().from(serviceOutages).where(and(eq(serviceOutages.service, data.service), eq(serviceOutages.startedAt, data.startedAt))).limit(1);
      return { outage: existing!, created: false };
    }
    if (opts.raiseIncidents !== false && !maintenance) {
      const down = await params.get(tx, "monitoring.service_down", toBusinessDate(data.startedAt));
      if (durationMinutes > down.minutes_gt) {
        const tenants = await tx.selectDistinct({ tenantId: devices.tenantId }).from(devices);
        for (const { tenantId } of tenants) {
          await raiseIncident(tx, {
            tenantId,
            kind: "service_down",
            title: `${MONITORED_SERVICES[data.service]} tidak dapat diakses ±${durationMinutes} menit`,
            description: `Gangguan ${formatTanggalJam(data.startedAt)} sampai ${formatJam(data.endedAt)} (tercatat otomatis oleh pemantau ${data.source === "heartbeat" ? "denyut" : "eksternal"}). Catat penyebab & pemulihannya.`,
            objectType: "monitor",
            objectId: `service_down:${data.service}:${data.startedAt.toISOString()}`,
            alsoNotify: "sync.mass_failure",
            detectedAt: data.startedAt,
            now: data.endedAt,
          });
        }
      }
    }
    return { outage: row, created: true };
  };
  return opts.tx ? run(opts.tx) : withTx(run, opts.db ? { db: opts.db } : {});
}

export type UptimeRow = {
  service: MonitoredService;
  label: string;
  outages: number;
  serviceMinutes: number;
  downtimeMinutes: number;
  maintenanceMinutes: number;
  availabilityPct: number;
  targetPct: number;
  meetsTarget: boolean;
};

/** Laporan uptime bulanan per layanan pada jam layanan PAR-07 (NFR-02; laporan ke komite pengarah). */
export async function uptimeReport(ctx: ActorContext, input: { month?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<{ month: string; rows: UptimeRow[]; outages: ServiceOutageRow[] }> {
  await authorize(ctx, "m10.incident.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const month = input.month ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw ValidationError.field("month", "Bulan harus berformat YYYY-MM.");
  const first = `${month}-01` as BusinessDate;
  const last = lastDayOfMonth(first);
  const hours = await params.get(tx, "PAR-07", last);
  const maint = await params.get(tx, "PAR-86", last);
  const { pct: targetPct } = await params.get(tx, "monitoring.availability_target", last);
  const from = wibToUtc(addDays(first, -1), "00:00");
  const to = wibToUtc(addDays(last, 1), "12:00");
  const outages = await tx.select().from(serviceOutages).where(and(lt(serviceOutages.startedAt, to), gt(serviceOutages.endedAt, from))).orderBy(asc(serviceOutages.startedAt));
  const days: BusinessDate[] = [];
  for (let d = first; d <= last && d <= today; d = addDays(d, 1)) days.push(d);
  const rows = (Object.keys(MONITORED_SERVICES) as MonitoredService[]).map((service) => {
    const own = outages.filter((o) => o.service === service);
    let serviceMinutes = 0;
    let downtime = 0;
    let maintenance = 0;
    for (const d of days) {
      const [ss, se] = dailyWindow(d, hours.start, hours.end);
      const [ms, me] = dailyWindow(d, maint.start, maint.end);
      serviceMinutes += (se.getTime() - ss.getTime()) / 60_000;
      for (const o of own) {
        downtime += overlapMinutes(o.startedAt, o.endedAt, ss, se);
        maintenance += overlapMinutes(o.startedAt, o.endedAt, ms, me);
      }
    }
    const availabilityPct = serviceMinutes > 0 ? Math.round((1 - downtime / serviceMinutes) * 10_000) / 100 : 100;
    return {
      service,
      label: MONITORED_SERVICES[service],
      outages: own.length,
      serviceMinutes: Math.round(serviceMinutes),
      downtimeMinutes: Math.round(downtime),
      maintenanceMinutes: Math.round(maintenance),
      availabilityPct,
      targetPct,
      meetsTarget: availabilityPct >= targetPct,
    };
  });
  return { month, rows, outages };
}
