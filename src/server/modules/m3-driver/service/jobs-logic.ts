/**
 * M3 — logika pekerjaan terjadwal (idempoten per hari lewat `groupKey` notifikasi):
 * - Pengingat setor PAR-06 (US-M3-07 KP-5): sopir yang bekerja hari ini tetapi setorannya belum Diajukan →
 *   pengingat ke sopir (tampil di aplikasi) + pemberitahuan Admin Keuangan (`deposit.not_submitted`).
 * - Keterangan perjalanan belum diisi saat tutup kas (BR-25, 6.3) → pemilik (`travel_explanation.missing`).
 */
import "server-only";

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { customerPayments, deposits, employees, fleetEvents, notifications, tripExpenses, trips, trucks, users } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { toBusinessDate } from "@/lib/time";

import type { Db } from "@/server/core/db";
import { withTx } from "@/server/core/db";
import { notify, type NotifyInput } from "@/server/core/notifications";

import { dayFigures } from "./deposits";

type JobTx = Parameters<Parameters<typeof withTx>[0]>[0];

/** Notifikasi sekali per `groupKey` (job dapat dijalankan ulang tanpa menggandakan pemberitahuan). */
async function notifyOnce(tx: JobTx, input: NotifyInput & { groupKey: string }): Promise<void> {
  const exists = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.event, input.event), eq(notifications.groupKey, input.groupKey)))
    .limit(1);
  if (exists[0]) return;
  await notify(tx, input);
}

/** Pengguna yang bekerja sebagai pengemudi pada tanggal (rit, pelunasan, pengeluaran) per tenant. */
async function driversActiveOn(tx: JobTx, date: string): Promise<{ userId: string; tenantId: string }[]> {
  const a = await tx
    .select({ userId: trips.driverUserId, tenantId: trips.tenantId })
    .from(trips)
    .where(or(eq(trips.completionBusinessDate, date), and(eq(trips.scheduledDate, date), inArray(trips.status, ["departed", "arrived"])))!);
  const b = await tx.select({ userId: customerPayments.driverUserId, tenantId: customerPayments.tenantId }).from(customerPayments).where(and(eq(customerPayments.channel, "driver"), eq(customerPayments.businessDate, date)));
  const c = await tx.select({ userId: tripExpenses.driverUserId, tenantId: tripExpenses.tenantId }).from(tripExpenses).where(eq(tripExpenses.businessDate, date));
  const seen = new Map<string, string>();
  for (const r of [...a, ...b, ...c]) if (r.userId) seen.set(r.userId, r.tenantId);
  return [...seen.entries()].map(([userId, tenantId]) => ({ userId, tenantId }));
}

export async function runDepositReminder(now: Date, db?: Db): Promise<{ reminded: string[] }> {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const reminded: string[] = [];
      for (const d of await driversActiveOn(tx, today)) {
        const dep = (await tx.select().from(deposits).where(and(eq(deposits.sourceType, "driver"), eq(deposits.depositorUserId, d.userId), eq(deposits.businessDate, today))).limit(1))[0];
        if (dep && dep.status !== "running") continue;
        const fig = await dayFigures(tx, d.userId, today);
        const name = (await tx.select({ name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.id, d.userId)).limit(1))[0]?.name ?? "Sopir";
        reminded.push(d.userId);
        await notifyOnce(tx, {
          event: "deposit.driver_reminder",
          tenantId: d.tenantId,
          recipients: { userIds: [d.userId] },
          title: "Setoran hari ini belum diajukan",
          body: `Kas di tangan ${formatRupiah(fig.cashOnHand)}. Tekan "Setor" di aplikasi setelah rit terakhir — setoran tetap dapat diajukan dengan penanda terlambat.`,
          objectType: "deposit",
          objectId: dep?.id ?? d.userId,
          groupKey: `deposit.driver_reminder:${d.userId}:${today}`,
          now,
        });
        await notifyOnce(tx, {
          event: "deposit.not_submitted",
          tenantId: d.tenantId,
          title: `Setoran ${name} belum diajukan (${today})`,
          body: `Kas di tangan menurut sistem ${formatRupiah(fig.cashOnHand)}; ${fig.completedTrips} rit Selesai, ${fig.activeTrips} rit masih berjalan. Ingatkan sopir menekan "Setor" (PAR-06).`,
          objectType: "deposit",
          objectId: dep?.id ?? d.userId,
          valueAmount: fig.cashOnHand,
          link: "/kas/setoran",
          groupKey: `deposit.not_submitted:${d.userId}:${today}`,
          now,
        });
      }
      return { reminded };
    },
    { db },
  );
}

export async function runTravelExplanationCheck(now: Date, db?: Db): Promise<{ missing: number }> {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const rows = await tx
        .select({ id: fleetEvents.id, tenantId: fleetEvents.tenantId, kind: fleetEvents.kind, truckCode: trucks.code })
        .from(fleetEvents)
        .leftJoin(trucks, eq(trucks.id, fleetEvents.truckId))
        .where(and(eq(fleetEvents.requiresExplanation, true), isNull(fleetEvents.explanation), eq(fleetEvents.businessDate, today)));
      const byTenant = new Map<string, typeof rows>();
      for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
      for (const [tenantId, list] of byTenant) {
        await notifyOnce(tx, {
          event: "travel_explanation.missing",
          tenantId,
          title: `${list.length} keterangan perjalanan belum diisi sopir (${today})`,
          body: `Truk: ${[...new Set(list.map((l) => l.truckCode ?? "?"))].join(", ")}. Tinjau dan minta keterangan (BR-25).`,
          objectType: "fleet_event",
          objectId: list[0]!.id,
          valueText: `${list.length} kejadian`,
          link: "/armada/kejadian",
          groupKey: `travel_explanation.missing:${today}`,
          now,
        });
      }
      return { missing: rows.length };
    },
    { db },
  );
}
