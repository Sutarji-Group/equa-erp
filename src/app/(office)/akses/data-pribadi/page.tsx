import type { Metadata } from "next";

import { ActionForm } from "@/components/m10-access/action-form";
import { FormRow, M10Badge, NativeSelect, TableScroll, TextArea, TextInput } from "@/components/m10-access/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label, ROLE_CODES } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can, ROLE_CATALOG } from "@/server/core/rbac";
import { anonymizationCandidates, backupOverview, listAnonymizationRequests, retentionOverview, viewPolicy } from "@/server/modules/m10-access";

import { recordBackupAction, requestAnonymizationAction, resubmitAnonymizationAction } from "./actions";

export const metadata: Metadata = { title: "Data pribadi" };

/**
 * Data pribadi, retensi, dan pencadangan (US-M10-06): siapa melihat apa, permintaan anonimisasi (admin sistem →
 * pemilik → dijalankan; ditunda bila piutang terbuka), jadwal retensi otomatis, status cadangan & uji pemulihan.
 */
export default async function DataPribadiPage() {
  const { ctx } = await requirePermission("m10.personal_data.read");
  const canRequest = can(ctx, "m10.anonymization.request");
  const requests = await listAnonymizationRequests(ctx);
  const candidates = canRequest ? await anonymizationCandidates(ctx) : null;
  const retention = await retentionOverview(ctx);
  const backups = can(ctx, "m10.backup_status.read") ? await backupOverview(ctx) : null;
  const canBackup = can(ctx, "m10.backup_status.create");
  const phase1 = ROLE_CODES.filter((r) => ROLE_CATALOG[r].phase === 1);

  return (
    <>
      <PageHeader
        title="Data pribadi"
        description="Data pelanggan & karyawan hanya terlihat oleh yang membutuhkannya. Penghapusan data pribadi dilayani dengan anonimisasi; catatan keuangan tetap disimpan."
        actions={<ExportButtons excelHref="/api/export/m10.anonymization?format=xlsx" pdfHref="/api/export/m10.anonymization?format=pdf" />}
      />

      <SectionCard title="Siapa melihat data pribadi pelanggan" description="Peran lain melihat nama tanpa kontak (WA disamarkan, alamat hanya wilayah, tanpa koordinat)." className="mb-6">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {phase1.map((r) => {
            const p = viewPolicy({ roles: [r], source: "web", userId: "x" });
            const tripOnly = (r === "driver" || r === "helper") && viewPolicy({ roles: [r], source: "field", userId: "x" }, { ownTripToday: true }).customer === "full";
            return (
              <li key={r} className="flex flex-wrap items-center justify-between gap-2 border-b py-1">
                <span>{label("role", r)}</span>
                <ToneBadge tone={p.customer === "full" ? "success" : tripOnly ? "info" : "muted"}>
                  {p.customer === "full" ? "Lengkap" : tripOnly ? "Lengkap hanya rit hari itu" : "Nama tanpa kontak"}
                </ToneBadge>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">Data karyawan (PIN, riwayat selisih, ganti rugi): pemilik; admin sistem tanpa nilai selisih; dan karyawan yang bersangkutan.</p>
      </SectionCard>

      <SectionCard title="Permintaan anonimisasi (UU PDP)" className="mb-6">
        {canRequest && candidates ? (
          <div className="mb-4 rounded-md border p-3">
            <ActionForm action={requestAnonymizationAction} submitLabel="Catat permintaan" testId="form-anonimisasi">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormRow label="Subjek" htmlFor="anon-subjek" hint="Karyawan hanya setelah keluar. Pelanggan berpiutang ditunda sampai lunas.">
                  <NativeSelect id="anon-subjek" name="subject" required defaultValue="">
                    <option value="" disabled>
                      Pilih pelanggan / karyawan…
                    </option>
                    <optgroup label="Pelanggan">
                      {candidates.customers.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Karyawan yang sudah keluar">
                      {candidates.employees.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </optgroup>
                  </NativeSelect>
                </FormRow>
                <FormRow label="Dasar permintaan" htmlFor="anon-alasan">
                  <TextInput id="anon-alasan" name="reason" required placeholder="mis. Surat permintaan tanggal 12/09" />
                </FormRow>
              </div>
            </ActionForm>
          </div>
        ) : null}
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada permintaan.</p>
        ) : (
          <ul className="grid gap-2">
            {requests.map((r) => (
              <li key={r.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {label("anonymization_subject", r.subjectType)}: <span className="font-medium">{r.subjectName}</span>
                  </span>
                  <M10Badge enumName="anonymization_status" value={r.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Diajukan {formatTanggalJam(r.createdAt)} oleh {r.requestedByName ?? "—"} · {r.reason}
                  {r.executedAt ? ` · dijalankan ${formatTanggalJam(r.executedAt)}` : ""}
                </p>
                {r.blockedReason ? <p className="mt-1 text-xs text-warning-foreground">{r.blockedReason}</p> : null}
                {r.status === "deferred" && canRequest ? (
                  <div className="mt-2">
                    <ActionForm action={resubmitAnonymizationAction} submitLabel="Ajukan ulang (setelah lunas)" variant="outline">
                      <input type="hidden" name="requestId" value={r.id} />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Jadwal retensi otomatis" description="Dijalankan setiap malam di luar jam layanan. Jejak audit & catatan keuangan tidak pernah dihapus." className="mb-6">
        <ul className="mb-3 grid gap-1 text-sm sm:grid-cols-2">
          <li>Data akuntansi & transaksi: disimpan ≥ {retention.policy.accountingYears} tahun (tidak dihapus)</li>
          <li>Foto bukti kirim, meter, nota: diarsipkan setelah {retention.policy.photoYears} tahun, tetap dapat dibuka</li>
          <li>Log akses: {retention.policy.accessLogYears} tahun</li>
          <li>Posisi GPS mentah: {retention.policy.gpsMonths} bulan (dihapus modul Armada setelah ringkasan rit/hari terbentuk)</li>
        </ul>
        {retention.runs.length ? (
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {retention.runs.map((r) => (
              <li key={r.date}>
                {formatTanggalJam(r.at)}: log akses dihapus {r.result?.accessLogsPurged ?? 0}, foto diarsipkan {r.result?.photosArchived ?? 0}, kode OTP dihapus {r.result?.otpPurged ?? 0}, nomor ganti-nomor disamarkan {r.result?.phoneChangesMasked ?? 0}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Belum pernah dijalankan.</p>
        )}
      </SectionCard>

      {backups ? (
        <SectionCard
          title="Status cadangan & uji pemulihan"
          description={`Cadangan harian & salinan bulanan dijalankan tim IT. Uji pemulihan minimal ${backups.policy.restore_tests_per_year}×/tahun (NFR-14).`}
          actions={<ExportButtons excelHref="/api/export/m10.backup_status?format=xlsx" pdfHref="/api/export/m10.backup_status?format=pdf" />}
        >
          <div id="cadangan" className="mb-4 grid gap-3 sm:grid-cols-3">
            <KpiTile
              label="Cadangan harian terakhir"
              value={backups.lastDaily ? label("backup_status", backups.lastDaily.status) : "Belum ada"}
              hint={backups.lastDaily ? formatTanggalJam(backups.lastDaily.startedAt) : undefined}
              tone={backups.flags.dailyStale || backups.flags.lastDailyFailed ? "danger" : "success"}
            />
            <KpiTile
              label="Salinan bulanan terakhir"
              value={backups.lastMonthly ? label("backup_status", backups.lastMonthly.status) : "Belum ada"}
              hint={backups.lastMonthly ? formatTanggalJam(backups.lastMonthly.startedAt) : undefined}
              tone={backups.lastMonthly?.status === "failed" ? "danger" : backups.lastMonthly ? "success" : "warning"}
            />
            <KpiTile
              label="Uji pemulihan 12 bulan"
              value={`${backups.restoreTestsLast12Months}×`}
              hint={backups.lastRestoreTest ? `RPO ${backups.lastRestoreTest.rpoMinutes} mnt · RTO ${backups.lastRestoreTest.rtoMinutes} mnt` : undefined}
              tone={backups.flags.restoreTestsBelowTarget ? "warning" : "success"}
            />
          </div>
          {canBackup ? (
            <div className="mb-4 rounded-md border p-3">
              <ActionForm action={recordBackupAction} submitLabel="Catat hasil" testId="form-cadangan">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <FormRow label="Jenis" htmlFor="cadangan-jenis">
                    <NativeSelect id="cadangan-jenis" name="kind" defaultValue="daily">
                      <option value="daily">Harian</option>
                      <option value="monthly">Bulanan</option>
                      <option value="restore_test">Uji pemulihan</option>
                    </NativeSelect>
                  </FormRow>
                  <FormRow label="Hasil" htmlFor="cadangan-hasil">
                    <NativeSelect id="cadangan-hasil" name="status" defaultValue="success">
                      <option value="success">Berhasil</option>
                      <option value="failed">Gagal</option>
                    </NativeSelect>
                  </FormRow>
                  <FormRow label="Mulai (WIB)" htmlFor="cadangan-mulai">
                    <TextInput id="cadangan-mulai" name="startedAt" type="datetime-local" required />
                  </FormRow>
                  <FormRow label="Selesai (WIB)" htmlFor="cadangan-selesai">
                    <TextInput id="cadangan-selesai" name="finishedAt" type="datetime-local" />
                  </FormRow>
                  <FormRow label="RPO tercapai (menit, uji pemulihan)" htmlFor="cadangan-rpo">
                    <TextInput id="cadangan-rpo" name="rpoMinutes" type="number" min={0} />
                  </FormRow>
                  <FormRow label="RTO tercapai (menit, uji pemulihan)" htmlFor="cadangan-rto">
                    <TextInput id="cadangan-rto" name="rtoMinutes" type="number" min={0} />
                  </FormRow>
                  <FormRow label="Lokasi salinan" htmlFor="cadangan-lokasi">
                    <TextInput id="cadangan-lokasi" name="location" />
                  </FormRow>
                </div>
                <FormRow label="Catatan" htmlFor="cadangan-catatan">
                  <TextArea id="cadangan-catatan" name="notes" />
                </FormRow>
              </ActionForm>
            </div>
          ) : null}
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mulai</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Hasil</TableHead>
                  <TableHead>RPO/RTO</TableHead>
                  <TableHead>Dicatat oleh</TableHead>
                  <TableHead>Catatan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{formatTanggalJam(h.startedAt)}</TableCell>
                    <TableCell>{label("backup_kind", h.kind)}</TableCell>
                    <TableCell>
                      <M10Badge enumName="backup_status" value={h.status} />
                    </TableCell>
                    <TableCell>{h.rpoMinutes != null ? `${h.rpoMinutes}/${h.rtoMinutes} mnt` : "—"}</TableCell>
                    <TableCell>{h.recordedByName ?? "—"}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal text-xs">{h.notes ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </SectionCard>
      ) : null}
    </>
  );
}
