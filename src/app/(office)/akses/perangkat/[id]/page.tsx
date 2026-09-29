import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m10-access/action-form";
import { Disclosure, FormRow, M10Badge, TableScroll, TextInput } from "@/components/m10-access/fields";
import { HolderSelect, UnitSelect } from "@/components/m10-access/unit-select";
import { GpsHealthCard } from "@/components/m12-fleet/gps-health-card";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { getDeviceDetail, listScopeOptions } from "@/server/modules/m10-access";
import { getGpsDeviceHealth, type GpsDeviceHealth } from "@/server/modules/m12-fleet";

import { blockDeviceAction, newActivationCodeAction, updateDeviceAction, wipeDeviceAction } from "../actions";

export const metadata: Metadata = { title: "Rincian perangkat" };

const USAGE_LABELS: Record<string, string> = {
  login: "Masuk",
  logout: "Keluar",
  activated: "Diaktifkan",
  blocked: "Diblokir",
  wipe_requested: "Perintah hapus data",
  wiped: "Data terhapus",
  health_report: "Laporan kesehatan",
  sync: "Sinkron",
  ping: "Kirim data uji",
  pin_failed: "PIN salah",
  pin_locked: "PIN terkunci",
  lock: "Layar dikunci",
  unlock: "Layar dibuka",
};

/** Rincian perangkat: penetapan, blokir/hapus jarak jauh, riwayat pemakaian, login gagal, pemegang aktual per sesi. */
export default async function PerangkatDetailPage({ params }: PageProps<"/akses/perangkat/[id]">) {
  const { ctx } = await requirePermission("m10.device.read");
  const { id } = await params;
  const d = await getDeviceDetail(ctx, id);
  const dev = d.device;
  const canUpdate = can(ctx, "m10.device.update");
  const canBlock = can(ctx, "m10.device.block") && !["blocked", "wipe_pending", "wiped"].includes(dev.status);
  const canWipe = can(ctx, "m10.device.wipe") && !["wipe_pending", "wiped"].includes(dev.status);
  const canCode = can(ctx, "m10.device.register") && dev.kind !== "gps" && dev.status !== "wipe_pending";
  const options = canUpdate ? await listScopeOptions(ctx) : null;
  const unitValue = dev.truckId ? `truck:${dev.truckId}` : dev.outletId ? `outlet:${dev.outletId}` : dev.waterSourceId ? `water_source:${dev.waterSourceId}` : "";
  // B-42 (US-M12-08 KP-4): perangkat GPS menampilkan kesehatan dari M12 (daya, versi, status GPS, kejadian terbuka).
  let gpsHealth: GpsDeviceHealth | null = null;
  if (dev.kind === "gps" && can(ctx, "m12.fleet_event.read")) {
    gpsHealth = await getGpsDeviceHealth(ctx, dev.id).catch(() => null);
  }

  return (
    <>
      <OfficeBreadcrumbLabel label={dev.deviceCode} />
      <PageHeader
        title={`${dev.deviceCode} — ${dev.name}`}
        description={`${label("device_kind", dev.kind)}${dev.unitLabel ? ` · ${dev.unitLabel}` : ""}`}
        backHref="/akses/perangkat"
        meta={
          <>
            <M10Badge enumName="device_status" value={dev.status} />
            {dev.isSpare ? <ToneBadge tone="info">Cadangan</ToneBadge> : null}
          </>
        }
        actions={<ExportButtons excelHref={`/api/export/m10.device_usage?format=xlsx&deviceId=${dev.id}`} pdfHref={`/api/export/m10.device_usage?format=pdf&deviceId=${dev.id}`} />}
      />

      <SectionCard className="mb-6">
        <KeyValueList
          columns={3}
          items={[
            { label: "Pemegang terdaftar", value: dev.holderName ?? "—" },
            { label: "Pengguna terakhir", value: dev.lastUserName ?? "—" },
            { label: "Sinkron terakhir", value: dev.lastSyncAt ? formatTanggalJam(dev.lastSyncAt) : "—" },
            { label: "Terakhir terhubung", value: dev.lastSeenAt ? formatTanggalJam(dev.lastSeenAt) : "—" },
            { label: "Versi aplikasi", value: dev.appVersion ?? "—" },
            { label: "Antrean belum terkirim", value: dev.reportedQueueCount ?? "—" },
            { label: "Baterai", value: dev.batteryPct != null ? `${dev.batteryPct}%` : "—" },
            { label: "Diaktifkan", value: dev.activatedAt ? formatTanggalJam(dev.activatedAt) : "—" },
            { label: "Alasan blokir/hapus", value: dev.blockedReason ?? "—" },
          ]}
        />
      </SectionCard>

      {gpsHealth ? (
        <div className="mb-6" data-testid="kesehatan-gps">
          <GpsHealthCard health={gpsHealth} title={gpsHealth.truckCode ? `Kesehatan perangkat GPS truk ${gpsHealth.truckCode}` : "Kesehatan perangkat GPS"} />
        </div>
      ) : null}

      {canUpdate || canBlock || canWipe || canCode ? (
        <SectionCard title="Tindakan admin sistem" className="mb-6">
          <div className="grid gap-3">
            {canUpdate && options ? (
              <Disclosure summary="Tetapkan unit, pemegang, cadangan">
                <ActionForm action={updateDeviceAction} submitLabel="Simpan penetapan">
                  <input type="hidden" name="deviceId" value={dev.id} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormRow label="Nama" htmlFor="ubah-nama">
                      <TextInput id="ubah-nama" name="name" defaultValue={dev.name} />
                    </FormRow>
                    <FormRow label="Unit" htmlFor="ubah-unit">
                      <UnitSelect id="ubah-unit" options={options} defaultValue={unitValue} />
                    </FormRow>
                    <FormRow label="Pemegang" htmlFor="ubah-pemegang">
                      <HolderSelect id="ubah-pemegang" options={options} defaultValue={dev.holderEmployeeId} />
                    </FormRow>
                    <FormRow label="Catatan" htmlFor="ubah-catatan">
                      <TextInput id="ubah-catatan" name="notes" defaultValue={dev.notes ?? ""} />
                    </FormRow>
                  </div>
                  <label className="flex items-center gap-2 text-sm" htmlFor="ubah-cadangan">
                    <input type="checkbox" id="ubah-cadangan" name="isSpare" defaultChecked={dev.isSpare} className="size-4" />
                    Perangkat cadangan
                  </label>
                  <FormRow label="Alasan perubahan" htmlFor="ubah-alasan">
                    <TextInput id="ubah-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canBlock ? (
              <Disclosure summary="Blokir seketika (hilang/rusak/dicuri)">
                <ActionForm action={blockDeviceAction} submitLabel="Blokir perangkat" variant="destructive" confirmText="Blokir perangkat ini sekarang?">
                  <input type="hidden" name="deviceId" value={dev.id} />
                  <FormRow label="Alasan" htmlFor="blokir-alasan">
                    <TextInput id="blokir-alasan" name="reason" required placeholder="mis. Ponsel hilang di jalan" />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canWipe ? (
              <Disclosure summary="Hapus data jarak jauh">
                <p className="mb-2 text-sm text-muted-foreground">Data aplikasi dihapus saat perangkat menghubungi server berikutnya. Antrean yang ikut hilang dicatat sebagai insiden dan dilaporkan ke pemilik.</p>
                <ActionForm action={wipeDeviceAction} submitLabel="Perintahkan hapus data" variant="destructive" confirmText="Perintahkan hapus data perangkat ini?">
                  <input type="hidden" name="deviceId" value={dev.id} />
                  <FormRow label="Alasan" htmlFor="hapus-alasan">
                    <TextInput id="hapus-alasan" name="reason" required />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
            {canCode ? (
              <Disclosure summary="Terbitkan kode aktivasi baru (pasang ulang/perangkat ditemukan)">
                <ActionForm action={newActivationCodeAction} submitLabel="Terbitkan kode">
                  <input type="hidden" name="deviceId" value={dev.id} />
                  <FormRow label="Alasan" htmlFor="kode-alasan">
                    <TextInput id="kode-alasan" name="reason" required placeholder="mis. Aplikasi dipasang ulang" />
                  </FormRow>
                </ActionForm>
              </Disclosure>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Sesi (pemegang aktual)" description="Setiap sesi PIN mencatat siapa yang memakai perangkat.">
          {d.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada sesi.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {d.sessions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-1">
                  <span>
                    <Link href={`/akses/pengguna/${s.userId}`} className="text-primary underline-offset-4 hover:underline">
                      {s.userName}
                    </Link>{" "}
                    · {formatTanggalJam(s.createdAt)}
                    {s.isHolder ? "" : dev.isSpare ? " · pemakai cadangan" : ""}
                  </span>
                  <span className="text-muted-foreground">{s.revokedAt ? `berakhir (${s.revokeReason ?? "-"})` : "aktif"}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Login gagal & penolakan">
          {d.failedLogins.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {d.failedLogins.map((f) => (
                <li key={f.id} className="border-b py-1">
                  {formatTanggalJam(f.occurredAt)} · {label("access_event", f.event)} · {f.userName ?? f.usernameAttempted ?? "—"}
                  {f.reason ? <span className="block text-xs text-muted-foreground">{f.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Riwayat pemakaian" className="mt-6" flush>
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Waktu</TableHead>
                <TableHead>Kejadian</TableHead>
                <TableHead>Pengguna</TableHead>
                <TableHead>Versi</TableHead>
                <TableHead>Antrean</TableHead>
                <TableHead>Baterai</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.usage.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{formatTanggalJam(u.occurredAt)}</TableCell>
                  <TableCell>{USAGE_LABELS[u.event] ?? u.event}</TableCell>
                  <TableCell>{u.userName ?? "—"}</TableCell>
                  <TableCell>{u.appVersion ?? "—"}</TableCell>
                  <TableCell>{u.queueCount ?? "—"}</TableCell>
                  <TableCell>{u.batteryPct != null ? `${u.batteryPct}%` : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </SectionCard>

      {d.incidents.length ? (
        <SectionCard title="Insiden terkait" className="mt-6">
          <ul className="grid gap-1 text-sm">
            {d.incidents.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {formatTanggalJam(i.detectedAt)} · {i.title}
                </span>
                <M10Badge enumName="incident_status" value={i.status} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}
