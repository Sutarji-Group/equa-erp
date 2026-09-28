import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { FormGrid, SelectField, TextField, type Option } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { createTruckAction, setTruckStatusAction, updateTruckAction } from "./actions";

export const metadata: Metadata = { title: "Armada & kru" };

function TruckFields({ opts, defaults }: { opts: Awaited<ReturnType<typeof m1.truckFormOptions>>; defaults?: Partial<Record<string, string | number | null>> }) {
  const d = (k: string) => (defaults?.[k] === null || defaults?.[k] === undefined ? "" : String(defaults[k]));
  const withCurrent = (options: Option[], current: string) => (current && !options.some((o) => o.value === current) ? [...options, { value: current, label: "(terpasang)" }] : options);
  return (
    <FormGrid>
      <TextField label="Kode truk" name="code" defaultValue={d("code")} required placeholder="T8" />
      <TextField label="Nomor polisi" name="plateNumber" defaultValue={d("plateNumber")} required placeholder="F 8208 NH" />
      <TextField label="Kapasitas (L)" name="capacityL" defaultValue={d("capacityL") || "5000"} inputMode="numeric" />
      <TextField label="Kapasitas rit/hari" name="dailyTripCapacity" defaultValue={d("dailyTripCapacity")} inputMode="numeric" hint="Kosong = PAR-33 (3 rit)." />
      <SelectField label="Sopir default" name="defaultDriverEmployeeId" defaultValue={d("defaultDriverEmployeeId")} options={withCurrent(opts.drivers, d("defaultDriverEmployeeId"))} placeholder="— Tidak ada —" />
      <SelectField label="Kernet default" name="defaultHelperEmployeeId" defaultValue={d("defaultHelperEmployeeId")} options={withCurrent(opts.helpers, d("defaultHelperEmployeeId"))} placeholder="— Tidak ada —" />
      <SelectField label="Perangkat GPS terpasang" name="gpsDeviceId" defaultValue={d("gpsDeviceId")} options={withCurrent(opts.gpsDevices, d("gpsDeviceId"))} placeholder="— Tidak ada —" hint="Perangkat didaftarkan admin sistem di Akses > Perangkat." />
      <SelectField label="Ponsel lapangan" name="fieldDeviceId" defaultValue={d("fieldDeviceId")} options={withCurrent(opts.fieldDevices, d("fieldDeviceId"))} placeholder="— Tidak ada —" />
      <SelectField label="Pool/garasi" name="poolLocationId" defaultValue={d("poolLocationId")} options={opts.pools} placeholder="— Tidak ada —" />
    </FormGrid>
  );
}

/**
 * Armada, kru default, perangkat (US-M1-03): status Aktif/Perbaikan/Nonaktif (rit Ditugaskan ditandai perlu dipindahkan,
 * KP-2), satu karyawan satu truk default (KP-3), GPS & ponsel terdaftar (KP-4), kapasitas rit (PAR-33).
 */
export default async function ArmadaPage() {
  const { ctx } = await requirePermission("m1.truck.read");
  const [trucks, opts] = await Promise.all([m1.listTrucks(ctx), m1.truckFormOptions(ctx)]);
  const canCreate = can(ctx, "m1.truck.create");
  const canUpdate = can(ctx, "m1.truck.update");
  const canDeactivate = can(ctx, "m1.truck.deactivate");

  return (
    <div className="grid gap-6">
      <PageHeader title="Armada & kru" description="Truk, kru default, perangkat GPS & ponsel lapangan." actions={<ExportButtons excelHref="/api/export/m1.trucks?format=xlsx" pdfHref="/api/export/m1.trucks?format=pdf" />} />
      <div className="grid gap-3 md:grid-cols-2">
        {trucks.map((t) => (
          <SectionCard
            key={t.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {t.code} · {t.plateNumber} <StatusBadge enumName="truck_status" value={t.status} tone={t.status === "active" ? "success" : t.status === "maintenance" ? "warning" : "muted"} />
              </span>
            }
            description={`${t.capacityL.toLocaleString("id-ID")} L · ${t.effectiveTripCapacity} rit/hari${t.statusReason ? ` · ${t.statusReason}` : ""}`}
          >
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Sopir default</dt>
              <dd>{t.driverName ?? "—"}</dd>
              <dt className="text-muted-foreground">Kernet default</dt>
              <dd>{t.helperName ?? "—"}</dd>
              <dt className="text-muted-foreground">GPS</dt>
              <dd>{t.gpsDeviceCode ?? "—"}</dd>
              <dt className="text-muted-foreground">Ponsel lapangan</dt>
              <dd>{t.fieldDeviceCode ?? "—"}</dd>
              <dt className="text-muted-foreground">Pool</dt>
              <dd>{t.poolName ?? "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              {canUpdate && t.status !== "maintenance" && t.status !== "inactive" ? (
                <ReasonActionButton label="Perbaikan" title={`Tandai ${t.code} Perbaikan?`} description="Truk tidak menerima rit; rit yang sudah ditugaskan ditandai untuk dipindahkan." action={setTruckStatusAction.bind(null, t.id, "maintenance")} />
              ) : null}
              {canUpdate && t.status !== "active" ? <ReasonActionButton label="Aktifkan" title={`Aktifkan ${t.code}?`} action={setTruckStatusAction.bind(null, t.id, "active")} /> : null}
              {canDeactivate && t.status !== "inactive" ? <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${t.code}?`} action={setTruckStatusAction.bind(null, t.id, "inactive")} destructive /> : null}
            </div>
            {canUpdate ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-primary">Ubah truk & kru default</summary>
                <div className="mt-3">
                  <ActionForm action={updateTruckAction.bind(null, t.id)} submitLabel="Simpan" resetOnSuccess={false}>
                    <TruckFields opts={opts} defaults={t as unknown as Record<string, string | number | null>} />
                  </ActionForm>
                </div>
              </details>
            ) : null}
          </SectionCard>
        ))}
      </div>
      {canCreate ? (
        <SectionCard title="Daftarkan truk" description="Kapasitas bawaan 5.000 L. Satu karyawan hanya menjadi kru default satu truk; pengecualian harian di jadwal kru.">
          <ActionForm action={createTruckAction} submitLabel="Daftarkan truk">
            <TruckFields opts={opts} />
          </ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
