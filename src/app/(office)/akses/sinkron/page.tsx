import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { Disclosure, FormRow, M10Badge, TableScroll, TextInput } from "@/components/m10-access/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { listIncidents, listSyncConflicts, listSyncHealth } from "@/server/modules/m10-access";

import { acknowledgeIncidentAction, resolveIncidentAction, setMinVersionAction } from "./actions";

export const metadata: Metadata = { title: "Perangkat & sinkron" };

function ago(minutes: number | null): string {
  if (minutes === null) return "belum pernah";
  if (minutes < 60) return `${minutes} menit lalu`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} jam lalu`;
  return `${Math.floor(minutes / 1440)} hari lalu`;
}

/**
 * Perangkat & sinkron (US-M10-07): kesehatan per perangkat untuk admin sistem, Dispatcher (perangkat truk), dan Admin
 * Keuangan (sebelum menerima setoran); insiden dengan waktu tanggap/pulih (NFR-31); konflik sinkron; versi minimal
 * aplikasi (NFR-32).
 */
export default async function SinkronPage() {
  const { ctx } = await requirePermission("m10.sync_health.read");
  const view = await listSyncHealth(ctx);
  const conflicts = can(ctx, "m10.sync_conflict.read") ? await listSyncConflicts(ctx) : [];
  const incidents = can(ctx, "m10.incident.read") ? await listIncidents(ctx, { limit: 50 }) : null;
  const canIncident = can(ctx, "m10.incident.update");
  const canVersion = can(ctx, "m10.app_version.update");

  return (
    <>
      <PageHeader
        title="Perangkat & sinkron"
        description={
          view.scope === "trucks"
            ? "Perangkat truk: pengguna terakhir, sinkron terakhir, antrean belum terkirim menurut perangkat, versi, baterai."
            : "Per perangkat: pengguna terakhir, sinkron terakhir, antrean belum terkirim menurut perangkat, versi aplikasi, baterai."
        }
        actions={<ExportButtons excelHref="/api/export/m10.sync_health?format=xlsx" pdfHref="/api/export/m10.sync_health?format=pdf" />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Perangkat" value={view.totals.devices} />
        <KpiTile label="Item belum terkirim" value={view.totals.pending} tone={view.totals.pending ? "warning" : undefined} />
        <KpiTile label={`Tertahan > ${view.syncMaxMinutes} menit`} value={view.totals.stale} tone={view.totals.stale ? "danger" : undefined} />
        <KpiTile label={`Di bawah versi ${view.minVersion}`} value={view.totals.belowMinVersion} tone={view.totals.belowMinVersion ? "warning" : undefined} />
      </div>

      <SectionCard title="Kesehatan perangkat" flush>
        <TableScroll>
          <Table data-testid="tabel-sinkron">
            <TableHeader>
              <TableRow>
                <TableHead>Perangkat</TableHead>
                <TableHead>Pengguna terakhir</TableHead>
                <TableHead>Sinkron terakhir</TableHead>
                <TableHead>Belum terkirim</TableHead>
                <TableHead>Versi</TableHead>
                <TableHead>Baterai</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((d) => (
                <TableRow key={d.id} className={d.stale ? "bg-destructive/5" : undefined}>
                  <TableCell className="whitespace-normal">
                    {can(ctx, "m10.device.read") ? (
                      <Link href={`/akses/perangkat/${d.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {d.deviceCode}
                      </Link>
                    ) : (
                      <span className="font-medium">{d.deviceCode}</span>
                    )}
                    <p className="text-xs text-muted-foreground">{d.unitLabel ?? d.name}</p>
                    {d.status !== "active" ? <M10Badge enumName="device_status" value={d.status} /> : null}
                  </TableCell>
                  <TableCell>{d.lastUserName ?? "—"}</TableCell>
                  <TableCell>
                    {d.lastSyncAt ? formatTanggalJam(d.lastSyncAt) : "—"}
                    <p className="text-xs text-muted-foreground">{ago(d.minutesSinceSync)}</p>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {d.reportedQueueCount ?? 0}
                    {d.stale ? (
                      <ToneBadge tone="danger" className="ml-1">
                        tertahan
                      </ToneBadge>
                    ) : null}
                    {d.queueByUser.length ? <p className="text-xs text-muted-foreground">{d.queueByUser.map((q) => `${q.name}: ${q.count}`).join(", ")}</p> : null}
                  </TableCell>
                  <TableCell>
                    {d.appVersion ?? "—"}
                    {d.belowMinVersion ? (
                      <ToneBadge tone="warning" className="ml-1">
                        perlu pembaruan
                      </ToneBadge>
                    ) : null}
                  </TableCell>
                  <TableCell>{d.batteryPct != null ? `${d.batteryPct}%` : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </SectionCard>

      {incidents ? (
        <SectionCard
          title="Insiden"
          description={`Target: ditanggapi ≤ ${incidents.targets.response_minutes} menit, pulih ≤ ${incidents.targets.recovery_hours} jam (NFR-31). Peringatan otomatis: sinkron gagal massal, layanan tidak dapat diakses, perangkat GPS mati.`}
          actions={<ExportButtons excelHref="/api/export/m10.incidents?format=xlsx" pdfHref="/api/export/m10.incidents?format=pdf" />}
          className="mt-6"
        >
          <div id="insiden" className="grid gap-3">
            {incidents.items.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada insiden.</p> : null}
            {incidents.items.map((i) => (
              <div key={i.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{i.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {label("incident_kind", i.kind)} · terdeteksi {formatTanggalJam(i.detectedAt)}
                      {i.responseMinutes !== null ? ` · ditanggapi ${i.responseMinutes} menit` : ""}
                      {i.recoveryMinutes !== null ? ` · pulih ${Math.round(i.recoveryMinutes / 6) / 10} jam` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <M10Badge enumName="incident_severity" value={i.severity} />
                    <M10Badge enumName="incident_status" value={i.status} />
                    {i.responseBreached ? <ToneBadge tone="danger">Tanggap lewat target</ToneBadge> : null}
                    {i.recoveryBreached ? <ToneBadge tone="danger">Pulih lewat target</ToneBadge> : null}
                  </div>
                </div>
                {i.description ? <p className="mt-1 text-xs">{i.description}</p> : null}
                {i.resolution ? <p className="mt-1 text-xs text-success">Pemulihan: {i.resolution}</p> : null}
                {canIncident && i.status !== "resolved" ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {i.status === "open" ? (
                      <ActionForm action={acknowledgeIncidentAction} submitLabel="Tanggapi" variant="outline">
                        <input type="hidden" name="incidentId" value={i.id} />
                      </ActionForm>
                    ) : null}
                    <Disclosure summary="Catat pulih">
                      <ActionForm action={resolveIncidentAction} submitLabel="Catat pulih">
                        <input type="hidden" name="incidentId" value={i.id} />
                        <FormRow label="Penyebab & pemulihan" htmlFor={`pulih-${i.id}`}>
                          <TextInput id={`pulih-${i.id}`} name="resolution" required />
                        </FormRow>
                      </ActionForm>
                    </Disclosure>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {conflicts.length ? (
        <SectionCard title="Konflik sinkron (14 hari)" description="Data lapangan tetap sah dan tidak ditimpa kantor; tinjau dan tindak lanjuti." className="mt-6">
          <ul className="grid gap-1 text-sm">
            {conflicts.map((c) => (
              <li key={c.id} className="border-b py-1">
                {formatTanggalJam(c.receivedAt)} · {c.type} · {c.userName ?? "—"}
                {c.message ? <span className="block text-xs text-muted-foreground">{c.message}</span> : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Versi aplikasi lapangan/POS" description={`Versi minimal yang didukung: ${view.minVersion}. Pengguna dengan versi di bawahnya diminta memperbarui sebelum melanjutkan (NFR-32).`} className="mt-6">
        {canVersion ? (
          <ActionForm action={setMinVersionAction} submitLabel="Tetapkan versi minimal" testId="form-versi-minimal">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormRow label="Versi minimal (X.Y.Z)" htmlFor="versi-minimal">
                <TextInput id="versi-minimal" name="version" required defaultValue={view.minVersion} pattern="\d+\.\d+\.\d+" />
              </FormRow>
              <FormRow label="Catatan rilis / alasan" htmlFor="versi-alasan">
                <TextInput id="versi-alasan" name="reason" required placeholder="mis. Rilis 0.2.0 memperbaiki kirim foto" />
              </FormRow>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted-foreground">Diatur admin sistem.</p>
        )}
      </SectionCard>
    </>
  );
}
