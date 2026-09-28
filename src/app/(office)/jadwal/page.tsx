import { CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ScheduleBoard } from "@/components/m2-orders/schedule-board";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { formatTanggal, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

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
    </div>
  );
}
