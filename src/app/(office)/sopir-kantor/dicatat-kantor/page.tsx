import type { Metadata } from "next";
import Link from "next/link";

import { Field, M3ActionForm, SelectField, TextAreaField } from "@/components/m3-driver/office-form";
import { EmptyState } from "@/components/shared/empty-state";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions } from "@/lib/labels";
import { formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m3 from "@/server/modules/m3-driver";

import { officeCompleteAction, officeFailAction } from "../actions";

export const metadata: Metadata = { title: "Dicatat kantor" };

const OPEN_STATUSES = new Set(["assigned", "departed", "arrived"]);

const PAYMENT_OPTIONS = [
  { value: "cash", label: "Tunai" },
  { value: "transfer", label: "Transfer" },
  { value: "credit", label: "Tempo" },
] as const;

/**
 * Pencatatan darurat "dicatat kantor" (Bab 6.1; US-M3-09 KP-5): Admin Keuangan mencatat Selesai/Gagal atas nama sopir
 * bila perangkat rusak/hilang — alasan wajib, bukti opsional, pemilik diberi tahu. Juga memantau kesehatan perangkat
 * truk & status sinkron setoran (bahan tutup kas M4).
 */
export default async function DicatatKantorPage({ searchParams }: PageProps<"/sopir-kantor/dicatat-kantor">) {
  const { ctx } = await requirePermission("m3.office_entry.create");
  const sp = await searchParams;
  const today = toBusinessDate(ctx.now);
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) ? sp.tanggal : today;
  const board = await m3.officeEntryBoard(ctx, { date });
  const canReport = can(ctx, "m3.office_entry.read");
  const open = board.trips.filter((t) => OPEN_STATUSES.has(t.status));
  const done = board.trips.filter((t) => !OPEN_STATUSES.has(t.status));

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Dicatat kantor"
        description={`Pencatatan darurat atas nama sopir bila HP truk rusak/hilang — ${formatTanggal(date)}. Setiap pencatatan wajib beralasan, ditandai "dicatat kantor", dan pemilik diberi tahu.`}
        actions={
          <>
            <form method="get" className="flex items-center gap-2">
              <input type="date" name="tanggal" defaultValue={date} aria-label="Tanggal" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
              <Button type="submit" variant="outline" size="sm">
                Buka
              </Button>
            </form>
            {canReport ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/sopir-kantor/laporan">Laporan dicatat kantor</Link>
              </Button>
            ) : null}
          </>
        }
      />

      <SectionCard title="Rit belum selesai" description="Pilih rit yang sudah terjadi di lapangan tetapi tidak dapat dicatat sopir. Jam kejadian diisi sesuai keterangan sopir (WIB).">
        {open.length === 0 ? (
          <EmptyState compact title="Tidak ada rit terbuka" description="Semua rit terbit tanggal ini sudah Selesai atau Gagal." />
        ) : (
          <div className="grid gap-3">
            {open.map((t) => (
              <details key={t.id} className="rounded-lg border p-3" data-testid={`office-trip-${t.number}`}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold">{t.number}</span>
                  <span>{t.customerName}</span>
                  <span className="text-muted-foreground">
                    · {t.truckCode ?? "—"} · {t.driverName ?? "tanpa sopir"} · {t.plannedVolumeL.toLocaleString("id-ID")} L ·
                  </span>
                  <MoneyText value={t.price} />
                  <StatusBadge enumName="trip_status" value={t.status} />
                  {t.isInternal ? <ToneBadge tone="info">Internal</ToneBadge> : null}
                </summary>
                <div className="mt-3 grid gap-6 lg:grid-cols-2">
                  <div className="grid content-start gap-2">
                    <h3 className="text-sm font-semibold">Catat Selesai</h3>
                    <M3ActionForm action={officeCompleteAction.bind(null, t.id)} submitLabel="Catat Selesai" testId={`office-complete-${t.number}`}>
                      <TextAreaField label="Alasan dicatat kantor" name="reason" required hint="Mis. HP truk jatuh ke air, sopir melapor lewat telepon pukul 10.15." />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Jam kejadian (WIB)" name="occurredTime" type="time" required />
                        <Field label="Nama penerima" name="recipientName" required />
                        <Field label="Volume terkirim (liter)" name="deliveredVolumeL" inputMode="numeric" defaultValue={t.plannedVolumeL} required />
                        <SelectField label="Alasan volume kurang" name="partialVolumeReason" options={enumOptions("partial_volume_reason")} />
                      </div>
                      <Field label="Keterangan volume" name="partialVolumeNote" />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <SelectField
                          label="Pembayaran"
                          name="method"
                          required
                          defaultValue={t.isInternal ? "internal" : t.paymentMethod === "credit" ? "credit" : t.paymentMethod === "transfer" ? "transfer" : "cash"}
                          options={t.isInternal ? [{ value: "internal", label: "Internal (tanpa bayar)" }] : PAYMENT_OPTIONS}
                        />
                        <Field label="Jumlah diterima (Rp)" name="amount" inputMode="numeric" defaultValue={t.isInternal ? 0 : t.price} hint="Tempo: diisi tunai yang diterima bila tempo ditolak." />
                        <SelectField label="Alasan kurang bayar" name="underpaymentReason" options={enumOptions("underpayment_reason")} />
                        <Field label="Keterangan kurang bayar" name="underpaymentNote" />
                      </div>
                      <label className="grid gap-1 text-sm font-medium">
                        Bukti (opsional)
                        <input name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" />
                        <span className="text-xs font-normal text-muted-foreground">Foto nota/tanda terima dari sopir, maks. 4 MB (foto dikompres otomatis).</span>
                      </label>
                    </M3ActionForm>
                  </div>
                  <div className="grid content-start gap-2">
                    <h3 className="text-sm font-semibold">Catat Gagal</h3>
                    <M3ActionForm action={officeFailAction.bind(null, t.id)} submitLabel="Catat Gagal" variant="destructive" testId={`office-fail-${t.number}`}>
                      <TextAreaField label="Alasan dicatat kantor" name="reason" required />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Jam kejadian (WIB)" name="occurredTime" type="time" required />
                        <SelectField label="Alasan gagal" name="failReason" required options={enumOptions("trip_fail_reason")} />
                        <SelectField label="Air termuat" name="loadedWaterDisposition" required options={enumOptions("loaded_water_disposition")} />
                        <Field label="Keterangan" name="note" />
                      </div>
                      <label className="grid gap-1 text-sm font-medium">
                        Bukti (opsional)
                        <input name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" />
                      </label>
                    </M3ActionForm>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Rit tercatat" description="Rit Selesai/Gagal tanggal ini. Tanda sumber: dicatat kantor, sinkron terlambat, atau tabrakan sinkron.">
        {done.length === 0 ? (
          <EmptyState compact title="Belum ada rit tercatat" />
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rit</TableHead>
                  <TableHead>Truk</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Sopir</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tanda</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {done.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.number}</TableCell>
                    <TableCell>{t.truckCode ?? "—"}</TableCell>
                    <TableCell>{t.customerName}</TableCell>
                    <TableCell>{t.driverName ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="trip_status" value={t.status} />
                    </TableCell>
                    <TableCell className="space-x-1">
                      {t.recordedByOffice ? <ToneBadge tone="warning">Dicatat kantor</ToneBadge> : null}
                      {t.lateSync ? <ToneBadge tone="info">Sinkron terlambat</ToneBadge> : null}
                      {t.syncConflict ? <ToneBadge tone="danger">Tabrakan sinkron</ToneBadge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Perangkat truk" description="Antrean terakhir yang dilaporkan HP. Antrean > 0 lama = kemungkinan HP rusak/hilang; gunakan pencatatan di atas.">
          {board.devices.length === 0 ? (
            <EmptyState compact title="Belum ada perangkat truk" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Perangkat</TableHead>
                  <TableHead>Truk</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sinkron terakhir</TableHead>
                  <TableHead className="text-right">Antrean</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.devices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="font-medium">{d.code}</span>
                      {d.lastUserName ? <span className="block text-xs text-muted-foreground">{d.lastUserName}</span> : null}
                    </TableCell>
                    <TableCell>{d.truckCode ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="device_status" value={d.status} />
                    </TableCell>
                    <TableCell>{d.lastSyncAt ? formatTanggalJam(d.lastSyncAt) : "Belum pernah"}</TableCell>
                    <TableCell className="text-right">{d.reportedQueueCount ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard title="Status sinkron setoran sopir" description="Setoran hanya dapat ditutup bila semua data hari itu sudah tersinkron (US-M3-10 KP-4).">
          {board.deposits.length === 0 ? (
            <EmptyState compact title="Belum ada setoran sopir tanggal ini" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sopir</TableHead>
                  <TableHead className="text-right">Wajib setor</TableHead>
                  <TableHead>Sinkron</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.deposits.map((d) => (
                  <TableRow key={d.deposit?.id ?? d.name ?? ""}>
                    <TableCell>{d.name ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={d.expectedNet} />
                    </TableCell>
                    <TableCell>{d.fullySynced ? <ToneBadge tone="success">Lengkap</ToneBadge> : <ToneBadge tone="warning">Belum lengkap</ToneBadge>}
                      <span className="block text-xs text-muted-foreground">{d.message}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
