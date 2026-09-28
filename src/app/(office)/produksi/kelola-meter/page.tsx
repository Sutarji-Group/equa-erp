import type { Metadata } from "next";
import Link from "next/link";

import { Field, FileField, M8ActionForm, TextareaField } from "@/components/m8-production/office-form";
import { Liter, M8Badge } from "@/components/m8-production/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m8 from "@/server/modules/m8-production";

import { recordReplacementAction, recordRolloverAction } from "../actions";

export const metadata: Metadata = { title: "Meter sumber air" };

/**
 * Meter sumber air (US-M8-01 KP-2, 7.8.6): pembacaan terakhir per meter, putaran meter tercatat (angka kembali ke nol →
 * pembacaan lebih kecil diterima sekali, produksi tetap benar), penggantian meter (meter lama ditutup, meter baru dengan
 * angka awal, produksi hari itu diestimasi rata-rata 7 hari & ditandai). Dicatat admin sistem / Admin Keuangan dengan
 * alasan (+ foto opsional). Master meter (tambah/nonaktifkan) ada di Data master › Sumber air.
 */
export default async function KelolaMeterPage() {
  const { ctx } = await requirePermission(["m8.production.read", "m1.water_meter.update"]);
  const meters = await m8.listMetersOverview(ctx);
  const canAdjust = can(ctx, "m1.water_meter.update");
  const today = ctxBusinessDate(ctx);
  const bySource = new Map<string, m8.MeterOverviewRow[]>();
  for (const m of meters) bySource.set(m.sourceName, [...(bySource.get(m.sourceName) ?? []), m]);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Meter sumber air"
        description="Putaran & penggantian meter dicatat dengan alasan agar produksi harian tetap benar. Pembacaan operator tidak diubah di sini (koreksi pembacaan: Neraca air › rincian)."
        actions={
          <Link href="/master/sumber-air" className="rounded-md border px-3 py-2 text-sm">
            Data master sumber air
          </Link>
        }
      />
      {meters.length === 0 ? <EmptyState title="Belum ada meter" description="Tambahkan meter di Data master › Sumber air." /> : null}
      {[...bySource.entries()].map(([sourceName, rows]) => (
        <SectionCard key={sourceName} title={sourceName} flush>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-meter">
              <TableHeader>
                <TableRow>
                  <TableHead>Meter</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Angka awal</TableHead>
                  <TableHead>Pembacaan terakhir</TableHead>
                  <TableHead>Riwayat penyesuaian</TableHead>
                  {canAdjust ? <TableHead>Tindakan</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <span className="font-medium">{m.code}</span>
                      {m.name ? <span className="block text-xs text-muted-foreground">{m.name}</span> : null}
                    </TableCell>
                    <TableCell>
                      <M8Badge enumName="meter_status" value={m.status} />
                      {m.pendingRollover ? (
                        <span className="mt-1 block">
                          <ToneBadge tone="info">Putaran menunggu pembacaan</ToneBadge>
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={m.initialReadingL} />
                      {m.installedAt ? <span className="block text-xs text-muted-foreground">terpasang {formatTanggal(m.installedAt)}</span> : null}
                    </TableCell>
                    <TableCell>
                      {m.lastReading ? (
                        <span>
                          <Liter value={m.lastReading.readingL} /> · {label("meter_phase", m.lastReading.phase)} {formatTanggal(m.lastReading.businessDate)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="max-w-80 text-sm">
                      {m.adjustments.length
                        ? m.adjustments.map((a) => (
                            <span key={a.id} className="block">
                              {label("meter_adjustment_kind", a.kind)} {formatTanggal(a.businessDate)} — {a.reason}
                              <span className="text-xs text-muted-foreground"> ({formatTanggalJam(a.createdAt)})</span>
                            </span>
                          ))
                        : "—"}
                    </TableCell>
                    {canAdjust ? (
                      <TableCell className="min-w-64">
                        {m.status === "active" ? (
                          <div className="grid gap-1">
                            <details>
                              <summary className="cursor-pointer text-sm text-primary">Catat putaran meter…</summary>
                              <M8ActionForm action={recordRolloverAction.bind(null, m.id)} submitLabel="Simpan putaran" className="mt-2" testId={`form-putaran-${m.code}`}>
                                <Field label="Angka maksimum meter (kembali ke nol setelah angka ini), L" name="rolloverAtL" inputMode="numeric" required />
                                <Field label="Tanggal" name="businessDate" type="date" defaultValue={today} />
                                <TextareaField label="Alasan" name="reason" required rows={2} />
                                <FileField label="Foto meter (opsional)" name="photo" accept="image/*" />
                              </M8ActionForm>
                            </details>
                            <details>
                              <summary className="cursor-pointer text-sm text-primary">Catat penggantian meter…</summary>
                              <M8ActionForm action={recordReplacementAction.bind(null, m.id)} submitLabel="Simpan penggantian" className="mt-2" testId={`form-ganti-${m.code}`}>
                                <Field label="Angka akhir meter lama (L)" name="finalReadingL" inputMode="numeric" required />
                                <Field label="Pengenal meter baru" name="newMeterCode" required />
                                <Field label="Nama meter baru (opsional)" name="newMeterName" />
                                <Field label="Angka awal meter baru (L)" name="newInitialReadingL" inputMode="numeric" required />
                                <Field label="Tanggal penggantian" name="businessDate" type="date" defaultValue={today} />
                                <TextareaField label="Alasan" name="reason" required rows={2} placeholder="Mis. meter rusak, diganti vendor" />
                                <FileField label="Foto meter baru (opsional)" name="photo" accept="image/*" />
                              </M8ActionForm>
                            </details>
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ))}
    </div>
  );
}
