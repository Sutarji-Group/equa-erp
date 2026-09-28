import type { Metadata } from "next";

import { Field, FileField, M8ActionForm, SelectField, TextareaField } from "@/components/m8-production/office-form";
import { FilterForm, FilterSelect } from "@/components/m8-production/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";
import * as m8 from "@/server/modules/m8-production";

import { completeQualityActionAction, deactivateScheduleAction, recordQualityTestAction, upsertScheduleAction } from "../actions";

export const metadata: Metadata = { title: "Mutu air" };

type ResultLine = { parameter: string; value: string; unit?: string | null; limit?: string | null; passed: boolean };

/**
 * Catatan mutu air (US-M8-06): jadwal uji per lokasi (sumber, depot) dengan frekuensi pemilik/konsultan (PAR-70) +
 * pengingat H-7; hasil uji (tanggal, laboratorium, parameter & nilai, lulus/tidak, sertifikat) — tidak lulus → tindakan
 * wajib (deskripsi, penanggung jawab, tenggat) + notifikasi pemilik; riwayat per lokasi untuk audit & prospektus
 * kemitraan (Bab 9) + ekspor.
 */
export default async function MutuPage({ searchParams }: { searchParams: Promise<{ lokasi?: string }> }) {
  const { ctx } = await requirePermission("m8.quality_test.read");
  const sp = await searchParams;
  const locations = await m8.qualityLocations(ctx);
  const selected = locations.find((l) => l.id === sp.lokasi) ?? null;
  const { schedules, tests } = await m8.qualityOverview(ctx, { locationId: selected?.id ?? null });
  const rules = await m8.m8Rules(getDb(), ctxBusinessDate(ctx), ctx.tenantId);
  const owners = await m8.actionOwnerCandidates(getDb(), ctx.tenantId);
  const canSchedule = can(ctx, "m8.quality_schedule.update");
  const canRecord = can(ctx, "m8.quality_test.create");
  const locationOptions = locations.map((l) => ({ value: l.value, label: l.label }));
  const exportQs = selected ? `&locationId=${selected.id}` : "";

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Mutu air"
        description={`Jadwal uji laboratorium per sumber & depot, hasil & tindak lanjut. Pengingat ${rules.qualityReminderDaysBefore} hari sebelum jadwal ke pemilik & operator lokasi. ${rules.qualityFrequencyDays ? `Frekuensi bawaan ${rules.qualityFrequencyDays} hari (PAR-70).` : "Frekuensi belum ditetapkan (PAR-70) — isi per jadwal."}`}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <FilterForm action="/produksi/mutu">
              <FilterSelect label="Lokasi (riwayat)" name="lokasi" options={locations.map((l) => ({ value: l.id, label: l.label }))} defaultValue={selected?.id} allLabel="Semua lokasi" />
            </FilterForm>
            <ExportButtons excelHref={`/api/export/m8.quality_tests?format=xlsx${exportQs}`} pdfHref={`/api/export/m8.quality_tests?format=pdf${exportQs}`} />
          </div>
        }
      />

      <SectionCard title="Jadwal uji" description="Lokasi, frekuensi, dan tanggal uji berikutnya (diperbarui otomatis = tanggal uji + frekuensi)." flush>
        {schedules.length === 0 ? (
          <EmptyState title="Belum ada jadwal uji" description={canSchedule ? "Tambahkan jadwal di bawah." : "Pemilik menetapkan jadwal uji."} compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-jadwal-uji">
              <TableHeader>
                <TableRow>
                  <TableHead>Lokasi</TableHead>
                  <TableHead className="text-right">Frekuensi</TableHead>
                  <TableHead>Uji berikutnya</TableHead>
                  <TableHead>Laboratorium</TableHead>
                  <TableHead>Parameter</TableHead>
                  <TableHead>Status</TableHead>
                  {canSchedule ? <TableHead>Tindakan</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.id} className={s.isActive ? undefined : "text-muted-foreground"}>
                    <TableCell>{s.locationName}</TableCell>
                    <TableCell className="text-right">{s.frequencyDays ? `${s.frequencyDays} hari` : "—"}</TableCell>
                    <TableCell>
                      {s.nextDueDate ? formatTanggal(s.nextDueDate) : "—"} {s.overdue ? <ToneBadge tone="danger">Terlambat</ToneBadge> : s.dueSoon ? <ToneBadge tone="warning">Segera</ToneBadge> : null}
                    </TableCell>
                    <TableCell>{s.laboratory ?? "—"}</TableCell>
                    <TableCell className="max-w-64 text-sm">{s.parameters?.length ? s.parameters.join(", ") : "—"}</TableCell>
                    <TableCell>{s.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}</TableCell>
                    {canSchedule ? (
                      <TableCell className="min-w-56">
                        {s.isActive ? (
                          <div className="grid gap-1">
                            <details>
                              <summary className="cursor-pointer text-sm text-primary">Ubah…</summary>
                              <M8ActionForm action={upsertScheduleAction.bind(null, s.id)} submitLabel="Simpan jadwal" className="mt-2" resetOnSuccess={false}>
                                <input type="hidden" name="location" value={s.waterSourceId ? `water_source:${s.waterSourceId}` : `outlet:${s.outletId}`} />
                                <Field label="Frekuensi (hari)" name="frequencyDays" inputMode="numeric" defaultValue={s.frequencyDays} />
                                <Field label="Uji berikutnya" name="nextDueDate" type="date" defaultValue={s.nextDueDate} required />
                                <Field label="Laboratorium" name="laboratory" defaultValue={s.laboratory} />
                                <Field label="Parameter (pisahkan koma)" name="parameters" defaultValue={s.parameters?.join(", ")} />
                              </M8ActionForm>
                            </details>
                            <details>
                              <summary className="cursor-pointer text-sm text-primary">Nonaktifkan…</summary>
                              <M8ActionForm action={deactivateScheduleAction.bind(null, s.id)} submitLabel="Nonaktifkan" variant="destructive" className="mt-2">
                                <TextareaField label="Alasan" name="reason" required rows={2} />
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
        )}
      </SectionCard>

      {canSchedule ? (
        <SectionCard title="Jadwal uji baru" description="Frekuensi ditetapkan pemilik/konsultan (tidak ada bawaan di BRD). Kosongkan frekuensi untuk memakai PAR-70 bila sudah ditetapkan.">
          <M8ActionForm action={upsertScheduleAction.bind(null, null)} submitLabel="Tambah jadwal" testId="form-jadwal-uji" className="sm:grid-cols-2">
            <SelectField label="Lokasi" name="location" options={locationOptions} required placeholder="Pilih sumber / depot" />
            <Field label="Frekuensi (hari)" name="frequencyDays" inputMode="numeric" hint={rules.qualityFrequencyDays ? `Kosong = ${rules.qualityFrequencyDays} hari (PAR-70)` : "Wajib diisi (PAR-70 belum ditetapkan)"} />
            <Field label="Uji berikutnya" name="nextDueDate" type="date" required />
            <Field label="Laboratorium" name="laboratory" placeholder="Mis. Labkesda Cianjur" />
            <Field label="Parameter (pisahkan koma)" name="parameters" placeholder="E. coli, TDS, pH" />
          </M8ActionForm>
        </SectionCard>
      ) : null}

      {canRecord ? (
        <SectionCard title="Catat hasil uji" description="Satu parameter per baris: parameter; nilai; satuan; batas; lulus/tidak. Hasil keseluruhan tidak lulus bila ada parameter tidak lulus → tindakan wajib.">
          <M8ActionForm action={recordQualityTestAction} submitLabel="Simpan hasil uji" testId="form-hasil-uji">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Lokasi" name="location" options={locationOptions} required placeholder="Pilih sumber / depot" />
              <SelectField
                label="Jadwal (opsional)"
                name="scheduleId"
                options={schedules.filter((s) => s.isActive).map((s) => ({ value: s.id, label: `${s.locationName} · ${s.nextDueDate ? formatTanggal(s.nextDueDate) : "tanpa tanggal"}` }))}
                placeholder="Tanpa jadwal"
              />
              <Field label="Tanggal uji" name="testDate" type="date" required />
              <Field label="Laboratorium" name="laboratory" required />
            </div>
            <TextareaField label="Hasil per parameter" name="results" required rows={4} placeholder={"E. coli; 0; CFU/100 mL; 0; lulus\npH; 7,2; ; 6,5–8,5; lulus"} />
            <FileField label="Sertifikat (foto/PDF)" name="certificate" required />
            <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
              <legend className="px-1 text-sm font-medium">Tindakan (wajib bila tidak lulus)</legend>
              <TextareaField label="Tindakan" name="actionDescription" rows={2} />
              <SelectField label="Penanggung jawab" name="actionOwnerEmployeeId" options={owners.map((o) => ({ value: o.id, label: o.name }))} placeholder="Pilih" />
              <Field label="Tenggat" name="actionDueDate" type="date" />
            </fieldset>
            <TextareaField label="Catatan (opsional)" name="notes" rows={2} />
          </M8ActionForm>
        </SectionCard>
      ) : null}

      <SectionCard title={selected ? `Riwayat uji · ${selected.label}` : "Riwayat hasil uji"} description="Untuk audit mutu & prospektus kemitraan (Bab 9)." flush>
        {tests.length === 0 ? (
          <EmptyState title="Belum ada hasil uji" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-hasil-uji">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal uji</TableHead>
                  <TableHead>Lokasi</TableHead>
                  <TableHead>Laboratorium</TableHead>
                  <TableHead>Parameter</TableHead>
                  <TableHead>Hasil</TableHead>
                  <TableHead>Sertifikat</TableHead>
                  <TableHead>Tindakan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tests.map((t) => {
                  const results = (t.results ?? []) as unknown as ResultLine[];
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{formatTanggal(t.testDate)}</TableCell>
                      <TableCell>{t.locationName}</TableCell>
                      <TableCell>{t.laboratory ?? "—"}</TableCell>
                      <TableCell className="max-w-72 text-sm">
                        {results.map((r) => (
                          <span key={r.parameter} className={r.passed ? "block" : "block font-semibold text-destructive"}>
                            {r.parameter}: {r.value}
                            {r.unit ? ` ${r.unit}` : ""}
                            {r.limit ? ` (batas ${r.limit})` : ""}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell>{t.passed ? <ToneBadge tone="success">Lulus</ToneBadge> : <ToneBadge tone="danger">Tidak lulus</ToneBadge>}</TableCell>
                      <TableCell>
                        {t.certificateAttachmentId ? (
                          <a href={`/api/attachments/${t.certificateAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                            Lihat
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="max-w-80 text-sm">
                        {t.actionRequired ? (
                          <div className="grid gap-1">
                            <span>{t.actionRequired}</span>
                            <span className="text-xs text-muted-foreground">
                              {t.actionOwnerName ?? "—"} · tenggat {t.actionDueDate ? formatTanggal(t.actionDueDate) : "—"}
                            </span>
                            {t.actionDoneAt ? (
                              <ToneBadge tone="success">Selesai {formatTanggalJam(t.actionDoneAt)}</ToneBadge>
                            ) : canRecord || canSchedule ? (
                              <details>
                                <summary className="cursor-pointer text-primary">Tandai selesai…</summary>
                                <M8ActionForm action={completeQualityActionAction.bind(null, t.id)} submitLabel="Tandai selesai" className="mt-2">
                                  <TextareaField label="Hasil tindakan" name="note" required rows={2} />
                                </M8ActionForm>
                              </details>
                            ) : (
                              <ToneBadge tone="warning">Belum selesai</ToneBadge>
                            )}
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
