import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { CoordinatePicker } from "@/components/m1-master/coordinate-picker";
import { FormGrid, TextField } from "@/components/m1-master/fields";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { createPoolAction, setPoolActiveAction, updatePoolAction } from "./actions";

export const metadata: Metadata = { title: "Pool/garasi" };

type Pool = Awaited<ReturnType<typeof m1.listPools>>[number];

function PoolFields({ p }: { p?: Pool }) {
  return (
    <div className="grid gap-3">
      <FormGrid>
        <TextField label="Kode" name="code" defaultValue={p?.code ?? ""} required readOnly={!!p} placeholder="PL2" />
        <TextField label="Nama" name="name" defaultValue={p?.name ?? ""} required />
        <TextField label="Alamat" name="address" defaultValue={p?.address ?? ""} />
        <TextField label="Radius geofence (m)" name="geofenceRadiusM" defaultValue={p?.geofenceRadiusM?.toString() ?? ""} inputMode="numeric" hint="Kosong = PAR-54." />
      </FormGrid>
      <CoordinatePicker defaultValue={p ? { lat: p.lat, lng: p.lng } : null} radiusM={p?.geofenceRadiusM ?? 100} />
    </div>
  );
}

/** Pool/garasi truk (PTB-34): lokasi sah untuk deteksi perjalanan M12; ditetapkan pemilik. */
export default async function PoolPage() {
  const { ctx } = await requirePermission("m1.pool_location.read");
  const pools = await m1.listPools(ctx);
  const canUpdate = can(ctx, "m1.pool_location.update");
  return (
    <div className="grid gap-6">
      <PageHeader title="Pool/garasi" description="Lokasi parkir truk yang sah (deteksi perjalanan di luar jadwal, M12)." />
      <div className="grid gap-3 md:grid-cols-2">
        {pools.map((p) => (
          <SectionCard
            key={p.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {p.code} · {p.name} {p.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
              </span>
            }
            description={`${p.address ?? ""} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · geofence ${p.geofenceRadiusM ?? "PAR-54"} m`}
            actions={
              canUpdate ? (
                p.isActive ? (
                  <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${p.name}?`} action={setPoolActiveAction.bind(null, p.id, false)} destructive />
                ) : (
                  <ReasonActionButton label="Aktifkan" title={`Aktifkan ${p.name}?`} action={setPoolActiveAction.bind(null, p.id, true)} />
                )
              ) : null
            }
          >
            {canUpdate ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-primary">Ubah pool</summary>
                <div className="mt-3">
                  <ActionForm action={updatePoolAction.bind(null, p.id)} submitLabel="Simpan" resetOnSuccess={false}>
                    <PoolFields p={p} />
                  </ActionForm>
                </div>
              </details>
            ) : (
              <p className="text-sm text-muted-foreground">Ditetapkan pemilik.</p>
            )}
          </SectionCard>
        ))}
      </div>
      {canUpdate ? (
        <SectionCard title="Pool/garasi baru">
          <ActionForm action={createPoolAction} submitLabel="Buat pool">
            <PoolFields />
          </ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
