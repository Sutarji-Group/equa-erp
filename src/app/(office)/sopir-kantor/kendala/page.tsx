import type { Metadata } from "next";

import { M3ActionForm, TextAreaField } from "@/components/m3-driver/office-form";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/labels";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m3 from "@/server/modules/m3-driver";

import { confirmIncidentAction } from "../actions";

export const metadata: Metadata = { title: "Kendala sopir" };

/**
 * Kendala perjalanan & rit gagal dari aplikasi sopir (US-M3-06). Dispatcher mengonfirmasi; kendala "Truk rusak" yang
 * dikonfirmasi dapat mengubah status truk menjadi Perbaikan (KP-3).
 */
export default async function KendalaPage({ searchParams }: PageProps<"/sopir-kantor/kendala">) {
  const { ctx } = await requirePermission("m3.trip_incident.read");
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const to = typeof sp.sampai === "string" && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = typeof sp.dari === "string" && isBusinessDate(sp.dari) && sp.dari <= to ? sp.dari : addDays(to, -6);
  const canConfirm = can(ctx, "m3.trip_incident.confirm");
  const rows = await m3.listIncidents(ctx, { from, to });
  const pending = rows.filter((r) => !r.acknowledgedAt);
  const confirmed = rows.filter((r) => r.acknowledgedAt);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Kendala sopir"
        description={`Kendala perjalanan & rit gagal ${formatTanggal(from)} – ${formatTanggal(to)}.`}
        actions={
          <>
            <form method="get" className="flex flex-wrap items-center gap-2">
              <input type="date" name="dari" defaultValue={from} aria-label="Dari tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
              <input type="date" name="sampai" defaultValue={to} aria-label="Sampai tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
              <Button type="submit" variant="outline" size="sm">
                Tampilkan
              </Button>
            </form>
            <ExportButtons excelHref={`/api/export/m3.incidents?format=xlsx&from=${from}&to=${to}`} />
          </>
        }
      />

      <SectionCard title={`Menunggu konfirmasi (${pending.length})`} description={canConfirm ? "Konfirmasi setelah menghubungi sopir. Untuk \"Truk rusak\", centang Perbaikan agar truk tidak dijadwalkan." : undefined}>
        {pending.length === 0 ? (
          <EmptyState compact title="Tidak ada kendala menunggu" />
        ) : (
          <ul className="grid gap-3">
            {pending.map((r) => (
              <li key={r.id} className="grid gap-2 rounded-lg border p-3" data-testid={`incident-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <ToneBadge tone={r.kind === "truck_broken" || r.kind === "accident" ? "danger" : "warning"}>{label("trip_incident_kind", r.kind)}</ToneBadge>
                  <span className="font-medium">{r.truckCode ?? "—"}</span>
                  {r.tripNumber ? <span className="text-muted-foreground">· Rit {r.tripNumber}</span> : null}
                  <span className="text-muted-foreground">· {formatTanggalJam(r.occurredAt)}</span>
                  <span className="text-muted-foreground">· {r.reporterName ?? "—"}</span>
                  {r.recordedByOffice ? <ToneBadge tone="warning">Dicatat kantor</ToneBadge> : null}
                  {r.lateSync ? <ToneBadge tone="info">Sinkron terlambat</ToneBadge> : null}
                </div>
                {r.description ? <p className="text-sm">{r.description}</p> : null}
                {r.lat !== null && r.lng !== null ? (
                  <a className="text-xs text-primary underline" href={`https://www.google.com/maps?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer">
                    Lihat lokasi di peta
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground">Lokasi tidak terekam.</p>
                )}
                {canConfirm ? (
                  <M3ActionForm action={confirmIncidentAction.bind(null, r.id)} submitLabel="Konfirmasi" testId={`confirm-${r.id}`}>
                    <TextAreaField label="Catatan konfirmasi" name="note" required placeholder="Mis. sudah ditelepon, truk ditarik ke bengkel." />
                    {r.kind === "truck_broken" ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="setTruckMaintenance" defaultChecked className="size-4" />
                        Ubah status truk menjadi Perbaikan
                      </label>
                    ) : null}
                  </M3ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={`Sudah dikonfirmasi (${confirmed.length})`}>
        {confirmed.length === 0 ? (
          <EmptyState compact title="Belum ada" />
        ) : (
          <ul className="grid gap-2 text-sm">
            {confirmed.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-b-0">
                <ToneBadge tone="neutral">{label("trip_incident_kind", r.kind)}</ToneBadge>
                <span className="font-medium">{r.truckCode ?? "—"}</span>
                {r.tripNumber ? <span className="text-muted-foreground">Rit {r.tripNumber}</span> : null}
                <span className="text-muted-foreground">{formatTanggalJam(r.occurredAt)}</span>
                {r.description ? <span>— {r.description}</span> : null}
                {r.truckStatusChanged ? <ToneBadge tone="warning">Truk → Perbaikan</ToneBadge> : null}
                <span className="text-xs text-muted-foreground">dikonfirmasi {formatTanggalJam(r.acknowledgedAt!)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
