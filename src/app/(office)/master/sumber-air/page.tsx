import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { CoordinatePicker } from "@/components/m1-master/coordinate-picker";
import { FormGrid, SelectField, TextField } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { addMeterAction, createSourceAction, deactivateMeterAction, setSourceActiveAction, updateSourceAction } from "./actions";

export const metadata: Metadata = { title: "Sumber air" };

type Source = Awaited<ReturnType<typeof m1.listWaterSources>>[number];

function SourceFields({ s }: { s?: Source }) {
  return (
    <div className="grid gap-3">
      <FormGrid>
        <TextField label="Kode" name="code" defaultValue={s?.code ?? ""} required readOnly={!!s} placeholder="SA3" />
        <TextField label="Nama" name="name" defaultValue={s?.name ?? ""} required />
        <TextField label="Kapasitas harian (L)" name="dailyCapacityL" defaultValue={String(s?.dailyCapacityL ?? 50000)} inputMode="numeric" />
        <TextField label="Radius geofence (m)" name="geofenceRadiusM" defaultValue={s?.geofenceRadiusM?.toString() ?? ""} inputMode="numeric" hint="Kosong = PAR-54 (100 m)." />
        <TextField label="Alamat / lokasi" name="address" defaultValue={s?.address ?? ""} className="sm:col-span-2" />
      </FormGrid>
      <CoordinatePicker defaultValue={s ? { lat: s.lat, lng: s.lng } : null} radiusM={s?.geofenceRadiusM ?? 100} />
    </div>
  );
}

/** Sumber air & meter (US-M1-04 KP-2): kapasitas harian 50.000 L, geofence, meter dengan angka awal cut-over & foto. */
export default async function SumberAirPage() {
  const { ctx } = await requirePermission("m1.water_source.read");
  const sources = await m1.listWaterSources(ctx);
  const canCreate = can(ctx, "m1.water_source.create");
  const canUpdate = can(ctx, "m1.water_source.update");

  return (
    <div className="grid gap-6">
      <PageHeader title="Sumber air" description="Sumber air EQUA, geofence, dan meter produksi." actions={<ExportButtons excelHref="/api/export/m1.water_sources?format=xlsx" pdfHref="/api/export/m1.water_sources?format=pdf" />} />
      {sources.map((s) => (
        <SectionCard
          key={s.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {s.code} · {s.name} {s.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
            </span>
          }
          description={`${s.address ?? ""} · kapasitas ${s.dailyCapacityL.toLocaleString("id-ID")} L/hari · geofence ${s.geofenceRadiusM ?? "PAR-54"} m`}
          actions={
            canUpdate ? (
              s.isActive ? (
                <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${s.name}?`} action={setSourceActiveAction.bind(null, s.id, false)} destructive />
              ) : (
                <ReasonActionButton label="Aktifkan" title={`Aktifkan ${s.name}?`} action={setSourceActiveAction.bind(null, s.id, true)} />
              )
            ) : null
          }
        >
          <div className="grid gap-3">
            <p className="text-sm font-medium">Meter</p>
            {s.meters.length ? (
              <ul className="grid gap-2 text-sm">
                {s.meters.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                    <span>
                      <span className="font-medium">{m.code}</span> <StatusBadge enumName="meter_status" value={m.status} tone={m.status === "active" ? "success" : "muted"} /> · angka awal {m.initialReadingL.toLocaleString("id-ID")} L
                      {m.installedAt ? ` · dipasang ${formatTanggal(m.installedAt, { weekday: false })}` : ""}
                      {m.initialPhotoAttachmentId ? (
                        <>
                          {" · "}
                          <a href={`/api/attachments/${m.initialPhotoAttachmentId}`} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                            foto angka awal
                          </a>
                        </>
                      ) : null}
                    </span>
                    {canUpdate && m.status === "active" ? <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan meter ${m.code}?`} action={deactivateMeterAction.bind(null, m.id)} /> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Belum ada meter.</p>
            )}
            {canUpdate ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">Tambah meter / ubah sumber</summary>
                <div className="mt-3 grid gap-6 lg:grid-cols-2">
                  <ActionForm action={addMeterAction.bind(null, s.id)} submitLabel="Tambah meter">
                    <FormGrid>
                      <TextField label="Pengenal meter" name="code" required placeholder="MTR-SA1-02" />
                      <TextField label="Nama" name="name" />
                      <SelectField
                        label="Satuan"
                        name="unit"
                        options={[
                          { value: "liter", label: "Liter" },
                          { value: "cubic_meter", label: "Meter kubik" },
                        ]}
                      />
                      <TextField label="Angka awal cut-over (L)" name="initialReadingL" inputMode="numeric" required />
                      <TextField label="Tanggal pasang" name="installedAt" type="date" />
                      <div className="grid gap-1.5">
                        <Label htmlFor={`photo-${s.id}`}>Foto angka awal</Label>
                        <Input id={`photo-${s.id}`} name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" />
                      </div>
                    </FormGrid>
                  </ActionForm>
                  <ActionForm action={updateSourceAction.bind(null, s.id)} submitLabel="Simpan sumber air" resetOnSuccess={false}>
                    <SourceFields s={s} />
                  </ActionForm>
                </div>
              </details>
            ) : null}
          </div>
        </SectionCard>
      ))}
      {canCreate ? (
        <SectionCard title="Sumber air baru">
          <ActionForm action={createSourceAction} submitLabel="Buat sumber air">
            <SourceFields />
          </ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
