import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { CoordinatePicker } from "@/components/m1-master/coordinate-picker";
import { FormGrid, SelectField, TextField, type Option } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { createOutletAction, setOutletActiveAction, updateOutletAction } from "./actions";

export const metadata: Metadata = { title: "Depot & toko" };

type OutletRow = Awaited<ReturnType<typeof m1.listOutlets>>[number];

function OutletFields({ operators, o }: { operators: Option[]; o?: OutletRow }) {
  return (
    <div className="grid gap-3">
      <FormGrid>
        <TextField label="Kode" name="code" defaultValue={o?.code ?? ""} required readOnly={!!o} placeholder="D11" hint={o ? "Kode dipakai nomor transaksi POS — tidak dapat diubah." : undefined} />
        <TextField label="Nama" name="name" defaultValue={o?.name ?? ""} required />
        <SelectField
          label="Jenis"
          name="kind"
          defaultValue={o?.kind ?? "depot"}
          disabled={!!o}
          options={[
            { value: "depot", label: "Depot" },
            { value: "store", label: "Toko" },
          ]}
        />
        <TextField label="Telepon" name="phone" defaultValue={o?.phone ?? ""} inputMode="tel" />
        <TextField label="Radius geofence (m)" name="geofenceRadiusM" defaultValue={o?.geofenceRadiusM?.toString() ?? ""} inputMode="numeric" hint="Kosong = PAR-54 (100 m)." />
        <TextField label="Kapasitas simpan (L)" name="storageCapacityL" defaultValue={o?.storageCapacityL?.toString() ?? ""} inputMode="numeric" />
        <SelectField label="Operator default" name="defaultOperatorEmployeeId" defaultValue={o?.defaultOperatorEmployeeId ?? ""} options={operators} placeholder="— Tidak ada —" />
        <TextField label="Alamat" name="address" defaultValue={o?.address ?? ""} />
      </FormGrid>
      {o ? <input type="hidden" name="kind" value={o.kind} /> : null}
      <CoordinatePicker defaultValue={o && o.lat !== null && o.lng !== null ? { lat: o.lat, lng: o.lng } : null} radiusM={o?.geofenceRadiusM ?? 100} />
    </div>
  );
}

/** Depot & toko (US-M1-04 KP-1): kode, nama, tenant, koordinat & geofence, operator default, kapasitas simpan, status. */
export default async function DepotPage() {
  const { ctx } = await requirePermission("m1.outlet.read");
  const outlets = await m1.listOutlets(ctx);
  const canCreate = can(ctx, "m1.outlet.create");
  const canUpdate = can(ctx, "m1.outlet.update");
  const canDeactivate = can(ctx, "m1.outlet.deactivate");
  const operators: Option[] = can(ctx, "m1.employee.read") ? (await m1.listEmployees(ctx)).filter((e) => e.isActive).map((e) => ({ value: e.id, label: `${e.fullName} (${e.employeeNo})` })) : [];

  return (
    <div className="grid gap-6">
      <PageHeader title="Depot & toko" description="Outlet tenant EQUA (dan mitra kelak). Dinonaktifkan, bukan dihapus." actions={<ExportButtons excelHref="/api/export/m1.outlets?format=xlsx" pdfHref="/api/export/m1.outlets?format=pdf" />} />
      <div className="grid gap-3 md:grid-cols-2">
        {outlets.map((o) => (
          <SectionCard
            key={o.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {o.code} · {o.name} <StatusBadge enumName="outlet_kind" value={o.kind} dot={false} />
                {o.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
              </span>
            }
            description={`${o.tenantName} · ${o.address ?? "alamat belum diisi"}`}
          >
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Operator default</dt>
              <dd>{o.operatorName ?? "—"}</dd>
              <dt className="text-muted-foreground">Kapasitas simpan</dt>
              <dd>{o.storageCapacityL ? `${o.storageCapacityL.toLocaleString("id-ID")} L` : "—"}</dd>
              <dt className="text-muted-foreground">Geofence</dt>
              <dd>{o.geofenceRadiusM ? `${o.geofenceRadiusM} m` : "PAR-54"}</dd>
              <dt className="text-muted-foreground">Koordinat</dt>
              <dd>{o.lat !== null && o.lng !== null ? `${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}` : "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              {canDeactivate ? (
                o.isActive ? (
                  <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${o.name}?`} action={setOutletActiveAction.bind(null, o.id, false)} destructive />
                ) : (
                  <ReasonActionButton label="Aktifkan" title={`Aktifkan ${o.name}?`} action={setOutletActiveAction.bind(null, o.id, true)} />
                )
              ) : null}
            </div>
            {canUpdate ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-primary">Ubah data outlet</summary>
                <div className="mt-3">
                  <ActionForm action={updateOutletAction.bind(null, o.id)} submitLabel="Simpan" resetOnSuccess={false}>
                    <OutletFields operators={operators} o={o} />
                  </ActionForm>
                </div>
              </details>
            ) : null}
          </SectionCard>
        ))}
      </div>
      {canCreate ? (
        <SectionCard title="Outlet baru" description="Depot baru otomatis mendapat pelanggan internal untuk pesanan pasokan air (PTB-01).">
          <ActionForm action={createOutletAction} submitLabel="Buat outlet">
            <OutletFields operators={operators} />
          </ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
