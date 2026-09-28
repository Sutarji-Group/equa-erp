import { CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ScheduleBoard } from "@/components/m2-orders/schedule-board";
import { FleetLiveMap } from "@/components/m12-fleet/fleet-live-map";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { formatTanggal, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "Papan jadwal" };

/**
 * Papan jadwal rit harian (US-M2-03, US-M2-10 KP-3, US-M2-11 KP-5): Dispatcher menugaskan & mengurutkan rit, lalu
 * menerbitkan ke aplikasi sopir; pemilik & Admin Keuangan membaca (ponsel pemilik: kolom bertumpuk).
 */
export default async function JadwalPage({ searchParams }: PageProps<"/jadwal">) {
  const { ctx } = await requirePermission("m2.schedule.read");
  const sp = await searchParams;
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) ? sp.tanggal : toBusinessDate(ctx.now);
  const board = await m2.getBoard(ctx, date);
  // US-M12-02 KP-4: peta armada real-time tersemat di papan jadwal (hanya pemilik & Dispatcher; hari ini).
  const fleet = can(ctx, "m12.position.read") && date === toBusinessDate(ctx.now) ? await m12.getFleetSnapshot(ctx, {}) : null;
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Papan jadwal"
        description={`${formatTanggal(date)} — seret rit ke truk (atau pilih truk di kartu), atur urutan, lalu Terbitkan ke aplikasi sopir.`}
        actions={
          <>
            <ExportButtons excelHref={`/api/export/m2.schedule?format=xlsx&date=${date}`} pdfHref={`/api/export/m2.schedule?format=pdf&date=${date}`} />
            {can(ctx, "m2.crew_assignment.read") ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/jadwal/kru?tanggal=${date}`}>
                  <CalendarRange aria-hidden />
                  Jadwal kru
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <ScheduleBoard board={board} />
      {fleet ? (
        <section aria-label="Peta truk real-time" className="grid gap-2">
          <h2 className="text-base font-semibold">Peta truk real-time</h2>
          <FleetLiveMap initial={fleet} compact />
        </section>
      ) : null}
    </div>
  );
}
