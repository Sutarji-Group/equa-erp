import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FilterForm, FilterInput, Liter, M8Badge, Pct } from "@/components/m8-production/office-ui";
import { Field, FileField, M8ActionForm, SelectField, TextareaField } from "@/components/m8-production/office-form";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { addDays, formatJam, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { NotFoundError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m8 from "@/server/modules/m8-production";

import {
  acceptInvestigationAction,
  correctReadingAction,
  linkFillAction,
  returnInvestigationAction,
  reverseFillAction,
  verifyNegativeAction,
  verifyProductionAction,
} from "../../actions";

export const metadata: Metadata = { title: "Rincian neraca air" };

const START_FROM: Record<string, string> = { morning: "pagi", previous_evening: "malam kemarin" };
const END_FROM: Record<string, string> = { evening: "malam", next_morning: "pagi besok" };

function href(sourceId: string, date: string): string {
  return `/produksi/neraca-air/rincian?sumber=${sourceId}&tanggal=${date}`;
}

/**
 * Rincian satu sumber satu hari: produksi per meter (awal/akhir, gabungan, putaran, estimasi), pembacaan + foto,
 * pengisian + rit + selisih rit, pasokan depot tiga angka, neraca & investigasi, level tandon, penyesuaian meter.
 * Tindakan: Admin Keuangan (verifikasi produksi PAR-68, koreksi pembacaan beralasan + foto, pembalik/tautkan pengisian,
 * verifikasi susut negatif); pemilik (terima/kembalikan penjelasan susut).
 */
export default async function RincianNeracaPage({ searchParams }: { searchParams: Promise<{ sumber?: string; tanggal?: string }> }) {
  const { ctx } = await requirePermission("m8.water_balance.read");
  const sp = await searchParams;
  const sources = await m8.sourceOptions(ctx);
  const sourceId = sp.sumber ?? sources[0]?.id;
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : ctxBusinessDate(ctx);
  if (!sourceId) notFound();
  let d: m8.SourceDayDetail;
  try {
    d = await m8.sourceDayDetail(ctx, { sourceId, date });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const schedule = can(ctx, "m8.truck_fill.correct") ? await m8.fillsVsSchedule(ctx, { date, sourceId }) : [];
  const canVerify = can(ctx, "m8.meter_reading.verify");
  const canCorrect = can(ctx, "m8.meter_reading.correct");
  const canFix = can(ctx, "m8.truck_fill.correct");
  const canAccept = can(ctx, "m8.loss_investigation.accept");
  const canVerifyNegative = can(ctx, "m8.water_balance.verify");
  const b = d.balance;
  const p = d.production;
  const todayReadings = d.readings.filter((r) => r.businessDate === date);
  const otherReadings = d.readings.filter((r) => r.businessDate !== date);

  return (
    <div className="grid gap-6">
      <PageHeader
        backHref="/produksi/neraca-air"
        backLabel="Neraca air"
        meta={<span>{d.source.code}</span>}
        title={`${d.source.name} · ${formatTanggal(date)}`}
        description={`Kapasitas ${d.source.dailyCapacityL.toLocaleString("id-ID")} L/hari · batas susut ${d.rules.lossMaxPct}% (PAR-18) · penyimpangan produksi ${d.rules.deviationPct}% dari rata-rata ${d.rules.deviationWindowDays} hari (PAR-68).`}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Link className="rounded-md border px-3 py-2 text-sm" href={href(sourceId, addDays(date, -1))}>
              ← Hari sebelumnya
            </Link>
            <Link className="rounded-md border px-3 py-2 text-sm" href={href(sourceId, addDays(date, 1))}>
              Hari berikutnya →
            </Link>
            <FilterForm action="/produksi/neraca-air/rincian" hidden={{ sumber: sourceId }}>
              <FilterInput label="Tanggal" name="tanggal" defaultValue={date} />
            </FilterForm>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Produksi" value={<Liter value={p?.producedL ?? null} />} hint={p ? label("production_status", p.status) : "Belum ada pembacaan"} tone={p?.flaggedForVerification ? "warning" : undefined} />
        <KpiTile label="Σ pengisian (bersih)" value={<Liter value={b?.filledTotalL ?? null} />} hint={b ? `Pelanggan ${b.filledCustomerL.toLocaleString("id-ID")} L · depot ${b.filledDepotL.toLocaleString("id-ID")} L` : undefined} />
        <KpiTile
          label="Susut"
          value={<Liter value={b?.lossL ?? null} />}
          hint={b?.lossPct !== null && b?.lossPct !== undefined ? `${b.lossPct.toLocaleString("id-ID")}% produksi · rata-rata 7 hari ${b.avgLoss7dPct?.toLocaleString("id-ID") ?? "—"}%` : undefined}
          tone={b && (b.status === "over_threshold" || b.status === "negative_anomaly") ? "danger" : undefined}
        />
        <KpiTile label="Status neraca" value={b ? <M8Badge enumName="water_balance_status" value={b.status} /> : "—"} hint={b?.isIncomplete ? "Produksi belum lengkap" : undefined} />
      </div>

      <SectionCard title="Produksi per meter" description={p?.incompleteReason ?? "Produksi = Σ (akhir − awal) per meter aktif."}>
        {d.productionDetail.length === 0 ? (
          <EmptyState title="Belum ada pembacaan" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-produksi-meter">
              <TableHeader>
                <TableRow>
                  <TableHead>Meter</TableHead>
                  <TableHead className="text-right">Awal</TableHead>
                  <TableHead className="text-right">Akhir</TableHead>
                  <TableHead className="text-right">Putaran</TableHead>
                  <TableHead className="text-right">Produksi</TableHead>
                  <TableHead>Keterangan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.productionDetail.map((m) => (
                  <TableRow key={m.meterId}>
                    <TableCell>{m.meterCode}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={m.startL} />
                      {m.startFrom ? <span className="block text-xs text-muted-foreground">{START_FROM[m.startFrom]}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={m.endL} />
                      {m.endFrom ? <span className="block text-xs text-muted-foreground">{END_FROM[m.endFrom]}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{m.rolloverAtL ? <Liter value={m.rolloverAtL} /> : "—"}</TableCell>
                    <TableCell className="text-right font-medium">
                      <Liter value={m.producedL} />
                    </TableCell>
                    <TableCell className="text-sm">{m.missing.length ? `Belum ada pembacaan ${m.missing.map((x) => (x === "morning" ? "pagi" : "malam")).join(" & ")}` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {p?.flaggedForVerification ? (
          <div className="mt-4 grid gap-2 rounded-md border border-warning p-3" data-testid="verifikasi-produksi">
            <p className="text-sm">
              Produksi menyimpang <Pct value={p.deviationPct} danger /> dari rata-rata {d.rules.deviationWindowDays} hari — bandingkan foto meter di bawah.
            </p>
            {canVerify ? (
              <M8ActionForm action={verifyProductionAction.bind(null, p.id)} submitLabel="Verifikasi produksi">
                <TextareaField label="Hasil pembandingan foto meter" name="note" required rows={2} />
              </M8ActionForm>
            ) : (
              <p className="text-xs text-muted-foreground">Menunggu verifikasi Admin Keuangan.</p>
            )}
          </div>
        ) : p?.verifiedAt ? (
          <p className="mt-2 text-sm text-success">Diverifikasi {formatTanggalJam(p.verifiedAt)}.</p>
        ) : null}
      </SectionCard>

      <SectionCard title="Pembacaan meter" description="Pembacaan tidak dapat diubah operator setelah tersinkron; koreksi Admin Keuangan membuat baris baru (alasan + foto pembanding), baris lama berstatus Dikoreksi." flush>
        <div className="overflow-x-auto">
          <Table data-testid="tabel-pembacaan">
            <TableHeader>
              <TableRow>
                <TableHead>Tanggal</TableHead>
                <TableHead>Pembacaan</TableHead>
                <TableHead>Meter</TableHead>
                <TableHead className="text-right">Angka</TableHead>
                <TableHead>Waktu perangkat</TableHead>
                <TableHead>Pencatat</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Foto</TableHead>
                <TableHead>Keterangan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...todayReadings, ...otherReadings].map((r) => (
                <TableRow key={r.id} className={r.businessDate === date ? undefined : "text-muted-foreground"}>
                  <TableCell>{formatTanggal(r.businessDate)}</TableCell>
                  <TableCell>{label("meter_phase", r.phase)}</TableCell>
                  <TableCell>{r.meterCode}</TableCell>
                  <TableCell className="text-right">
                    <Liter value={r.readingL} />
                  </TableCell>
                  <TableCell>
                    {formatJam(r.readAt)}
                    {r.lateSync ? <span className="block text-xs text-warning-foreground">sinkron terlambat</span> : null}
                  </TableCell>
                  <TableCell>{r.recordedByName ?? "—"}</TableCell>
                  <TableCell>
                    <M8Badge enumName="meter_reading_status" value={r.status} />
                  </TableCell>
                  <TableCell>
                    {r.photoAttachmentId ? (
                      <a href={`/api/attachments/${r.photoAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                        Lihat foto
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="max-w-72 text-sm">
                    {[r.lateReason ? `Terlambat: ${r.lateReason}` : null, r.correctionReason ? `Koreksi: ${r.correctionReason}` : null, r.adjustmentKind ? label("meter_adjustment_kind", r.adjustmentKind) : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                    {canCorrect && r.businessDate === date && r.status !== "superseded" ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-primary">Koreksi…</summary>
                        <M8ActionForm action={correctReadingAction.bind(null, r.id)} submitLabel="Simpan koreksi" className="mt-2">
                          <Field label="Angka yang benar (L)" name="readingL" inputMode="numeric" required />
                          <TextareaField label="Alasan koreksi" name="reason" required rows={2} />
                          <FileField label="Foto pembanding" name="photo" accept="image/*" required />
                        </M8ActionForm>
                      </details>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {d.readings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    Belum ada pembacaan.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Pengisian truk" description="Satu pengisian satu rit (PTB-09). Volume terkirim < volume isi = selisih rit (masuk neraca)." flush>
        <div className="overflow-x-auto">
          <Table data-testid="tabel-pengisian-rincian">
            <TableHeader>
              <TableRow>
                <TableHead>Waktu</TableHead>
                <TableHead>Truk</TableHead>
                <TableHead>Rit</TableHead>
                <TableHead>Tujuan</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Terkirim</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Tindakan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.fills.map((f) => {
                const truckTrips = schedule.find((s) => s.truckId === f.truckId)?.trips.filter((t) => !t.fill && t.status !== "failed") ?? [];
                const live = !f.reversalOfId && !f.reversedAt;
                return (
                  <TableRow key={f.id} className={live ? undefined : "text-muted-foreground"}>
                    <TableCell>
                      {formatJam(f.filledAt)}
                      {f.deviceSpare ? <span className="block text-xs text-warning-foreground">ponsel cadangan</span> : null}
                    </TableCell>
                    <TableCell>{f.truckCode}</TableCell>
                    <TableCell>{f.tripNumber ?? "—"}</TableCell>
                    <TableCell>{f.destinationName ?? f.customerName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={f.volumeL} className={f.volumeL < 0 ? "text-destructive" : undefined} />
                      {f.volumeReason ? <span className="block text-xs text-muted-foreground">{f.volumeReason}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={f.deliveredVolumeL} />
                      {f.deliveredVolumeL !== null && f.volumeL > f.deliveredVolumeL ? <span className="block text-xs text-warning-foreground">selisih {(f.volumeL - f.deliveredVolumeL).toLocaleString("id-ID")} L</span> : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <M8Badge enumName="truck_fill_status" value={f.status} />
                        {f.isDepotSupply ? <ToneBadge tone="info">Pasokan depot</ToneBadge> : null}
                        {f.unplannedTruck ? <ToneBadge tone="warning">Di luar rencana</ToneBadge> : null}
                        {f.geofenceMismatch && f.status !== "geofence_mismatch" ? <ToneBadge tone="danger">Tidak cocok geofence</ToneBadge> : null}
                        {f.reversalOfId ? <ToneBadge tone="danger">Pembalik</ToneBadge> : null}
                        {f.reversedAt ? <ToneBadge tone="muted">Dibalik</ToneBadge> : null}
                      </div>
                      {f.syncConflictNote ? <span className="block text-xs text-warning-foreground">{f.syncConflictNote}</span> : null}
                    </TableCell>
                    <TableCell className="min-w-56">
                      {canFix && live ? (
                        <div className="grid gap-1">
                          {!f.tripId && truckTrips.length ? (
                            <details>
                              <summary className="cursor-pointer text-sm text-primary">Tautkan ke rit…</summary>
                              <M8ActionForm action={linkFillAction.bind(null, f.id)} submitLabel="Tautkan" className="mt-2">
                                <SelectField label="Rit" name="tripId" required placeholder="Pilih rit" options={truckTrips.map((t) => ({ value: t.id, label: `${t.number} · ${t.customerName}` }))} />
                                <TextareaField label="Alasan" name="reason" required rows={2} />
                              </M8ActionForm>
                            </details>
                          ) : null}
                          <details>
                            <summary className="cursor-pointer text-sm text-primary">Balik pengisian…</summary>
                            <M8ActionForm action={reverseFillAction.bind(null, f.id)} submitLabel="Buat pembalik" variant="destructive" className="mt-2">
                              <TextareaField label="Alasan pembalik" name="reason" required rows={2} placeholder="Mis. pengisian ganda" />
                            </M8ActionForm>
                          </details>
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {d.fills.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Belum ada pengisian.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {d.supplies.length ? (
        <SectionCard title="Pasokan depot (tiga angka)" description={`Selisih diisi − diterima di luar ${d.rules.supplyTolerancePct}% (PAR-69) ditandai ke Dispatcher & pemilik.`} flush>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rit</TableHead>
                  <TableHead>Depot</TableHead>
                  <TableHead className="text-right">Diisi</TableHead>
                  <TableHead className="text-right">Diserahkan</TableHead>
                  <TableHead className="text-right">Diterima</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.supplies.map((s) => (
                  <TableRow key={s.tripId}>
                    <TableCell>{s.tripNumber}</TableCell>
                    <TableCell>{s.outletName}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.filledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.deliveredL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.receivedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.differenceL} className={s.outOfTolerance ? "font-semibold text-destructive" : undefined} /> (<Pct value={s.differencePct} danger={s.outOfTolerance} />)
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Neraca & investigasi susut">
        {!b ? (
          <EmptyState title="Neraca belum terbentuk" description="Neraca dihitung otomatis setelah pembacaan malam atau cek malam." compact />
        ) : (
          <div className="grid gap-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-2">
                <dt>Produksi</dt>
                <dd>
                  <Liter value={b.producedL} />
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Pengisian pelanggan</dt>
                <dd>
                  <Liter value={b.filledCustomerL} />
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Pasokan depot</dt>
                <dd>
                  <Liter value={b.filledDepotL} />
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Air rit gagal kembali ke sumber</dt>
                <dd>
                  <Liter value={b.returnedL} />
                </dd>
              </div>
              <div className="flex justify-between gap-2 font-semibold">
                <dt>Susut</dt>
                <dd>
                  <Liter value={b.lossL} /> (<Pct value={b.lossPct} danger={(b.lossPct ?? 0) > d.rules.lossMaxPct || (b.lossPct ?? 0) < 0} />)
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Rata-rata susut 7 hari (informasi)</dt>
                <dd>
                  <Pct value={b.avgLoss7dPct} />
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Utilisasi kapasitas</dt>
                <dd>
                  <Pct value={b.utilizationPct} />
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Level tandon (informasi)</dt>
                <dd>
                  {d.tankLevels.length
                    ? d.tankLevels.map((t) => `${formatJam(t.readAt)} ${t.levelPct !== null ? `${t.levelPct}%` : `${(t.levelL ?? 0).toLocaleString("id-ID")} L`}`).join(" · ")
                    : "—"}
                </dd>
              </div>
            </dl>
            {b.investigationReason ? (
              <div className="grid gap-1 rounded-md border p-3 text-sm" data-testid="penjelasan-susut">
                <p>
                  <strong>Penjelasan operator:</strong> {label("loss_reason", b.investigationReason)}
                  {b.investigationNote ? ` — ${b.investigationNote}` : ""}
                  {b.investigatedAt ? <span className="text-muted-foreground"> ({formatTanggalJam(b.investigatedAt)})</span> : null}
                </p>
                {b.investigationPhotoId ? (
                  <a href={`/api/attachments/${b.investigationPhotoId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Lihat foto bukti
                  </a>
                ) : null}
                {b.reviewNote ? <p>Catatan pemilik: {b.reviewNote}</p> : null}
              </div>
            ) : null}
            {b.status === "investigating" && canAccept ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <M8ActionForm action={acceptInvestigationAction.bind(null, b.id)} submitLabel="Terima penjelasan" testId="form-terima-susut">
                  <TextareaField label="Catatan (opsional)" name="note" rows={2} />
                </M8ActionForm>
                <M8ActionForm action={returnInvestigationAction.bind(null, b.id)} submitLabel="Kembalikan ke operator" variant="outline">
                  <TextareaField label="Yang perlu dilengkapi" name="note" required rows={2} />
                </M8ActionForm>
              </div>
            ) : null}
            {b.status === "over_threshold" ? <p className="text-sm text-warning-foreground">Menunggu penjelasan operator produksi (alasan dari daftar + foto) dari aplikasi.</p> : null}
            {b.status === "negative_anomaly" ? (
              canVerifyNegative ? (
                <M8ActionForm action={verifyNegativeAction.bind(null, b.id)} submitLabel="Verifikasi susut negatif" testId="form-verifikasi-negatif">
                  <TextareaField label="Hasil verifikasi" name="note" required rows={2} placeholder="Mis. pengisian ganda sudah dibalik" />
                </M8ActionForm>
              ) : (
                <p className="text-sm text-destructive">Susut negatif — menunggu verifikasi Admin Keuangan.</p>
              )
            ) : null}
            {b.verificationNote ? <p className="text-sm">Verifikasi Admin Keuangan: {b.verificationNote}</p> : null}
          </div>
        )}
      </SectionCard>

      {d.adjustments.length ? (
        <SectionCard title="Putaran / penggantian meter hari ini">
          <ul className="grid gap-1 text-sm">
            {d.adjustments.map((a) => (
              <li key={a.id}>
                <M8Badge enumName="meter_adjustment_kind" value={a.kind} /> {a.reason}
                {a.rolloverAtL ? ` · putaran di ${a.rolloverAtL.toLocaleString("id-ID")} L` : ""}
                {a.finalReadingL !== null ? ` · angka akhir meter lama ${a.finalReadingL.toLocaleString("id-ID")} L` : ""}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
