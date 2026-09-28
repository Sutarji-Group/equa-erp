import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m2-orders/action-form";
import { FormGrid, SelectField, TextField } from "@/components/m2-orders/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate, weekdayOf } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

import { rosterAction, setDriverAction, truckDayAction } from "./actions";

export const metadata: Metadata = { title: "Jadwal kru" };

/** Senin minggu tanggal ini. */
function mondayOf(date: string): string {
  const d = weekdayOf(date);
  return addDays(date, d === 0 ? -6 : 1 - d);
}

/**
 * Jadwal kru & ketersediaan truk: pengemudi hari itu per truk (US-M2-11, M) dan jadwal mingguan sopir/kernet/libur +
 * status truk per hari + kapasitas vs terjadwal (US-M2-10, S).
 */
export default async function JadwalKruPage({ searchParams }: PageProps<"/jadwal/kru">) {
  const { ctx } = await requirePermission("m2.crew_assignment.read");
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) ? sp.tanggal : today;
  const canEdit = can(ctx, "m2.crew_assignment.update");
  const board = await m2.getBoard(ctx, date);
  const week = await m2.getWeekRoster(ctx, mondayOf(date));
  const history = await m2.listCrewAssignments(ctx, { from: date, to: date });
  const candidates = canEdit && date >= today ? await Promise.all(board.lanes.map(async (l) => [l.truck.id, await m2.driverCandidates(ctx, l.truck.id, date)] as const)) : [];

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Jadwal kru"
        backHref={`/jadwal?tanggal=${date}`}
        backLabel="Papan jadwal"
        description={`Pengemudi hari itu & ketersediaan truk — ${formatTanggal(date)}.`}
        actions={
          <form method="get" className="flex items-center gap-2">
            <input type="date" name="tanggal" defaultValue={date} aria-label="Tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
            <Button type="submit" variant="outline" size="sm">
              Buka
            </Button>
          </form>
        }
      />

      <SectionCard
        title="Pengemudi hari itu (US-M2-11)"
        description="Sopir default, kernet truk itu, atau sopir lain yang tidak bertugas. Berlaku sampai akhir hari kas; ubah wajib alasan. Pengemudi yang setoran hari sebelumnya belum Ditutup tidak dapat ditetapkan (BR-10)."
        actions={<ExportButtons excelHref={`/api/export/m2.crew_assignments?format=xlsx&from=${date}&to=${date}`} />}
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {board.lanes.map((lane) => {
            const list = candidates.find(([id]) => id === lane.truck.id)?.[1] ?? [];
            return (
              <div key={lane.truck.id} className="grid content-start gap-2 rounded-lg border p-3" aria-label={`Pengemudi truk ${lane.truck.code}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">
                    {lane.truck.code} <span className="text-xs font-normal text-muted-foreground">{lane.truck.plateNumber}</span>
                  </p>
                  {lane.crew.substitute ? <ToneBadge tone="info">Pengganti</ToneBadge> : lane.crew.driverSource ? <ToneBadge tone="neutral">{lane.crew.driverSource === "roster" ? "Jadwal mingguan" : lane.crew.driverSource === "assignment" ? "Ditetapkan" : "Sopir default"}</ToneBadge> : null}
                </div>
                <p className="text-sm">
                  {lane.crew.driverName ? <span className="font-medium">{lane.crew.driverName}</span> : <span className="text-destructive">Tanpa sopir</span>}
                  {lane.crew.assignmentSource ? <span className="text-muted-foreground"> · {label("crew_assignment_source", lane.crew.assignmentSource)}</span> : null}
                </p>
                {lane.crew.reason ? <p className="text-xs text-muted-foreground">Alasan: {lane.crew.reason}</p> : null}
                {lane.crew.lock ? (
                  <p className="flex items-start gap-1 text-xs text-destructive">
                    <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {lane.crew.lockMessage}
                  </p>
                ) : null}
                {canEdit && date >= today ? (
                  <ActionForm action={setDriverAction.bind(null, lane.truck.id, date)} submitLabel="Tetapkan" size="sm" aria-label={`Tetapkan pengemudi ${lane.truck.code}`}>
                    <SelectField
                      label="Pengemudi"
                      name="employeeId"
                      id={`drv-${lane.truck.id}`}
                      required
                      placeholder="Pilih pengemudi…"
                      options={list.map((c) => ({ value: c.employeeId, label: `${c.name} — ${label("crew_assignment_source", c.source)}${c.available ? "" : ` (${c.note})`}` }))}
                    />
                    <TextField label="Alasan" name="reason" id={`rsn-${lane.truck.id}`} placeholder="Wajib bila pengganti / mengganti" />
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </div>
        {history.length ? (
          <div className="mt-4 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <p className="mb-2 text-sm font-medium">Riwayat penetapan tanggal ini (berjejak)</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead>Pengemudi</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Oleh</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{h.truckCode}</TableCell>
                    <TableCell>{h.driverName}</TableCell>
                    <TableCell>{label("crew_assignment_source", h.source)}</TableCell>
                    <TableCell>{h.reason ?? "—"}</TableCell>
                    <TableCell>
                      {h.assignedByName ?? "—"}
                      <span className="block text-xs text-muted-foreground">{formatTanggalJam(h.assignedAt)}</span>
                    </TableCell>
                    <TableCell>{h.active ? <ToneBadge tone="success">Berlaku</ToneBadge> : <ToneBadge tone="muted">Diganti {h.supersededByName ? `oleh ${h.supersededByName}` : ""}</ToneBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Jadwal kru mingguan & kapasitas (US-M2-10)"
        description="Per truk per hari: sopir, kernet, status truk; kapasitas = Σ truk beroperasi (PAR-33, dapat diatur per truk/hari). Melebihi kapasitas diperingatkan, tidak diblokir."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/jadwal/kru?tanggal=${addDays(week.from, -7)}`}>Minggu lalu</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/jadwal/kru?tanggal=${addDays(week.from, 7)}`}>Minggu depan</Link>
            </Button>
            <ExportButtons excelHref={`/api/export/m2.crew_roster?format=xlsx&from=${week.from}`} pdfHref={`/api/export/m2.crew_roster?format=pdf&from=${week.from}`} />
          </div>
        }
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Truk</TableHead>
                {week.dates.map((d) => (
                  <TableHead key={d} className={cn(d === date && "bg-primary/5")}>
                    {formatTanggal(d, { weekday: true }).replace(/ \d{4}$/, "")}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {week.trucks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.code}</TableCell>
                  {week.dates.map((d) => {
                    const c = week.cells.find((x) => x.truckId === t.id && x.date === d)!;
                    return (
                      <TableCell key={d} className={cn("align-top text-xs", d === date && "bg-primary/5", c.dayStatus === "maintenance" && "bg-destructive/5")}>
                        {c.dayStatus === "maintenance" ? <ToneBadge tone="danger">Perbaikan</ToneBadge> : null}
                        <div>{c.crew.driverName ?? <span className="text-destructive">tanpa sopir</span>}</div>
                        {c.crew.helperName ? <div className="text-muted-foreground">+ {c.crew.helperName}</div> : null}
                        <div className={cn(c.scheduledTrips > c.tripCapacity ? "font-medium text-warning-foreground" : "text-muted-foreground")}>
                          {c.scheduledTrips}/{c.tripCapacity} rit
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Libur</TableCell>
                {week.dates.map((d) => (
                  <TableCell key={d} className="align-top text-xs text-muted-foreground">
                    {(week.offByDate[d] ?? []).map((o) => o.name).join(", ") || "—"}
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Total</TableCell>
                {week.totals.map((x) => (
                  <TableCell key={x.date} className={cn("text-xs", x.scheduled > x.capacity && "font-semibold text-warning-foreground")}>
                    {x.scheduled}/{x.capacity} rit
                    <span className="block text-muted-foreground">
                      {x.customer} plg · {x.internal} int
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
        {canEdit ? (
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium">Atur jadwal kru</p>
              <ActionForm action={rosterAction} submitLabel="Simpan jadwal kru" aria-label="Atur jadwal kru">
                <FormGrid>
                  <SelectField label="Karyawan" name="employeeId" required placeholder="Pilih…" options={week.people.map((p) => ({ value: p.employeeId, label: `${p.name}${p.isDriver ? " (sopir)" : ""}` }))} />
                  <TextField label="Tanggal" name="date" type="date" required min={today} defaultValue={date < today ? today : date} />
                  <SelectField label="Status" name="status" options={enumOptions("crew_roster_status")} />
                  <SelectField label="Truk" name="truckId" placeholder="—" options={week.trucks.map((t) => ({ value: t.id, label: t.code }))} />
                  <SelectField label="Peran" name="role" options={enumOptions("crew_role")} />
                  <TextField label="Catatan" name="notes" placeholder="Mis. libur bergantian" />
                </FormGrid>
              </ActionForm>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Status truk per hari</p>
              <ActionForm action={truckDayAction} submitLabel="Simpan status truk" aria-label="Status truk per hari">
                <FormGrid>
                  <SelectField label="Truk" name="truckId" required placeholder="Pilih…" options={week.trucks.map((t) => ({ value: t.id, label: `${t.code} — ${t.plateNumber}` }))} />
                  <TextField label="Tanggal" name="date" type="date" required min={today} defaultValue={date < today ? today : date} />
                  <SelectField label="Status" name="status" options={enumOptions("truck_day_status")} />
                  <TextField label="Kapasitas rit hari itu" name="tripCapacity" type="number" min={0} placeholder="Kosong = PAR-33 / per truk" />
                  <TextField label="Alasan" name="reason" className="sm:col-span-2" placeholder="Wajib bila Perbaikan" />
                </FormGrid>
              </ActionForm>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
