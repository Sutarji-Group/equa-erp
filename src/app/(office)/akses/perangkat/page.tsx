import { Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { FormRow, M10Badge, NativeSelect, TableScroll, TextInput } from "@/components/m10-access/fields";
import { HolderSelect, UnitSelect } from "@/components/m10-access/unit-select";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label, type DeviceStatus } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { listDevices, listScopeOptions } from "@/server/modules/m10-access";

import { registerDeviceAction } from "./actions";

export const metadata: Metadata = { title: "Perangkat" };

/**
 * Perangkat terdaftar (US-M10-02 KP-1/KP-2/KP-6/KP-7): aplikasi lapangan & POS hanya login di perangkat yang didaftarkan
 * admin sistem; tetapkan ke truk/outlet/sumber & pemegang; perangkat cadangan; blokir & hapus jarak jauh di rinciannya.
 */
export default async function PerangkatPage({ searchParams }: PageProps<"/akses/perangkat">) {
  const { ctx } = await requirePermission("m10.device.read");
  const sp = await searchParams;
  const status = typeof sp.status === "string" && sp.status ? (sp.status as DeviceStatus) : undefined;
  const q = typeof sp.q === "string" ? sp.q : "";
  const rows = await listDevices(ctx, { status, q });
  const canRegister = can(ctx, "m10.device.register");
  const options = canRegister ? await listScopeOptions(ctx) : null;

  return (
    <>
      <PageHeader
        title="Perangkat"
        description="Ponsel & tablet lapangan/POS terdaftar serta perangkat GPS truk. Perangkat tidak terdaftar ditolak dan dicatat."
        actions={<ExportButtons excelHref="/api/export/m10.devices?format=xlsx" pdfHref="/api/export/m10.devices?format=pdf" />}
      />
      <SectionCard className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <FormRow label="Cari kode / nama" htmlFor="cari-perangkat">
            <TextInput id="cari-perangkat" name="q" defaultValue={q} placeholder="mis. HP-T1" />
          </FormRow>
          <FormRow label="Status" htmlFor="status-perangkat">
            <NativeSelect id="status-perangkat" name="status" defaultValue={status ?? ""}>
              <option value="">Semua</option>
              {enumOptions("device_status").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </FormRow>
          <Button type="submit" variant="outline">
            Tampilkan
          </Button>
        </form>
      </SectionCard>

      {rows.length === 0 ? (
        <EmptyState icon={Smartphone} title="Tidak ada perangkat" description="Ubah pencarian atau daftarkan perangkat baru." />
      ) : (
        <SectionCard title={`${rows.length} perangkat`} flush>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Perangkat</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="hidden md:table-cell">Pemegang</TableHead>
                  <TableHead className="hidden sm:table-cell">Pengguna terakhir</TableHead>
                  <TableHead className="hidden lg:table-cell">Sinkron terakhir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/akses/perangkat/${d.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {d.deviceCode}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {d.name} · {label("device_kind", d.kind)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <M10Badge enumName="device_status" value={d.status} />
                        {d.isSpare ? <ToneBadge tone="info">Cadangan</ToneBadge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal text-sm">{d.unitLabel ?? "—"}</TableCell>
                    <TableCell className="hidden md:table-cell">{d.holderName ?? "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell">{d.lastUserName ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">{d.lastSyncAt ? formatTanggalJam(d.lastSyncAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </SectionCard>
      )}

      {canRegister && options ? (
        <SectionCard title="Daftarkan perangkat" description="Kode aktivasi 8 karakter berlaku 24 jam dan hanya ditampilkan sekali." className="mt-6">
          <ActionForm action={registerDeviceAction} submitLabel="Daftarkan & buat kode aktivasi" testId="form-daftar-perangkat">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FormRow label="Kode perangkat (label aset/IMEI)" htmlFor="perangkat-kode">
                <TextInput id="perangkat-kode" name="deviceCode" required placeholder="mis. HP-T8" />
              </FormRow>
              <FormRow label="Nama" htmlFor="perangkat-nama">
                <TextInput id="perangkat-nama" name="name" required placeholder="mis. Ponsel truk T8" />
              </FormRow>
              <FormRow label="Jenis" htmlFor="perangkat-jenis">
                <NativeSelect id="perangkat-jenis" name="kind" defaultValue="phone">
                  <option value="phone">Ponsel</option>
                  <option value="tablet">Tablet (POS)</option>
                </NativeSelect>
              </FormRow>
              <FormRow label="Unit" htmlFor="perangkat-unit">
                <UnitSelect id="perangkat-unit" options={options} />
              </FormRow>
              <FormRow label="Pemegang" htmlFor="perangkat-pemegang">
                <HolderSelect id="perangkat-pemegang" options={options} />
              </FormRow>
              <FormRow label="Catatan" htmlFor="perangkat-catatan">
                <TextInput id="perangkat-catatan" name="notes" />
              </FormRow>
            </div>
            <label className="flex items-center gap-2 text-sm" htmlFor="perangkat-cadangan">
              <input type="checkbox" id="perangkat-cadangan" name="isSpare" className="size-4" />
              Perangkat cadangan (boleh dipakai selain pemegang terdaftar; pemegang aktual tercatat per sesi)
            </label>
          </ActionForm>
        </SectionCard>
      ) : null}
    </>
  );
}
