import type { Metadata } from "next";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ActionButton } from "@/components/m11-accounting/action-buttons";
import { Amount, BatchStatusBadge, FormInput, FormTextarea, JournalLink, JournalLinesInput, JournalStatusBadge, exportHref } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { attestOpeningAction, postOpeningAction, requestAdjustmentAction, saveOpeningBatchAction, setCutoverAction, signOpeningBatchAction } from "../actions";

export const metadata: Metadata = { title: "Saldo awal" };

/**
 * Saldo awal & cut-over akuntansi (US-M11-09): cut-over hanya tanggal 1 (pemilik); jurnal saldo awal per kelompok
 * (kas & bank, piutang per faktur, utang per nota, persediaan, aset tetap, ekuitas penyeimbang) — ditandatangani pemilik
 * per kelompok, disahkan akuntan, lalu diposting; penyesuaian ≤ PAR-62 bulan lewat persetujuan pemilik + catatan akuntan.
 */
export default async function OpeningBalancePage() {
  const { ctx } = await requirePermission("m11.opening_balance.read");
  const [ov, options] = await Promise.all([m11.openingOverview(ctx), m11.formOptions(ctx)]);
  const canEdit = can(ctx, "m11.opening_balance.create");
  const canSign = can(ctx, "m11.opening_balance.sign");
  const canAttest = can(ctx, "m11.opening_balance.attest");
  const prefills = canEdit && ov.cutover ? await Promise.all(m11.OPENING_GROUPS.map((g) => m11.prefillOpeningGroup(ctx, { group: g }))) : [];
  const anyPosted = ov.groups.some((g) => g.batch?.status === "posted");
  const allSigned = ov.groups.filter((g) => g.batch).every((g) => g.batch!.status !== "draft");
  const pendingAttest = ov.groups.some((g) => g.batch?.status === "signed" && !g.batch.accountantApprovedAt);
  const readyToPost = ov.groups.some((g) => g.batch?.status === "signed" && g.batch.accountantApprovedAt);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Saldo awal"
        description="Neraca awal dari akuntan masuk pada tanggal cut-over (tanggal 1). Transaksi operasional sebelum tanggal itu tidak dimigrasi; jurnal bertanggal sebelum cut-over ditolak kecuali jurnal saldo awal."
        actions={<ExportButtons excelHref={exportHref("m11.opening_balances", "xlsx")} pdfHref={exportHref("m11.opening_balances", "pdf")} />}
      />

      <SectionCard title="Tanggal cut-over akuntansi">
        {ov.cutover ? (
          <p className="text-sm" data-testid="tanggal-cutover">
            Cut-over <strong>{formatTanggal(ov.cutover)}</strong>. Penyesuaian saldo awal dapat diajukan sampai {ov.adjustmentDeadline ? formatTanggal(ov.adjustmentDeadline) : "—"} (PAR-62).
          </p>
        ) : (
          <Alert>
            <AlertDescription>Tanggal cut-over belum ditetapkan pemilik. Saldo awal baru dapat diisi setelah cut-over ditetapkan.</AlertDescription>
          </Alert>
        )}
        {canSign && !anyPosted ? (
          <M11ActionForm action={setCutoverAction} submitLabel="Tetapkan cut-over" className="mt-3" testId="form-cutover">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormInput label="Tanggal (harus tanggal 1)" name="date" type="date" required defaultValue={ov.cutover ?? ""} />
              <FormInput label="Alasan" name="reason" required />
            </div>
          </M11ActionForm>
        ) : null}
      </SectionCard>

      <div className="grid gap-6">
        {ov.groups.map((g, gi) => {
          const prefill = prefills[gi]?.lines ?? [];
          const defaults = g.batch && g.lines.length ? g.lines.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId, debit: l.debit, credit: l.credit, memo: l.description })) : prefill.map((l) => ({ accountId: l.accountId, profitCenter: l.profitCenter, outletId: l.outletId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0, memo: l.description ?? null }));
          return (
            <SectionCard
              key={g.group}
              title={g.label}
              description={g.batch ? `Debit ${formatRupiah(g.debit)} · kredit ${formatRupiah(g.credit)} · selisih diseimbangkan ke ekuitas penyeimbang saat diposting.` : "Belum diisi."}
              actions={
                <span className="flex flex-wrap items-center gap-2">
                  {g.batch ? <BatchStatusBadge status={g.batch.status} /> : <ToneBadge tone="neutral">Belum ada</ToneBadge>}
                  {g.batch?.accountantApprovedAt ? <ToneBadge tone="success">Disahkan akuntan</ToneBadge> : null}
                  {g.batch?.status === "draft" && canSign ? <M11ActionButton label="Tandatangani" variant="default" action={signOpeningBatchAction.bind(null, g.batch.id)} testId={`tandatangani-${g.group}`} /> : null}
                  {g.batch?.journalId ? <span className="text-xs">Jurnal terposting</span> : null}
                </span>
              }
            >
              {g.lines.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Keterangan</TableHead>
                        <TableHead>Pusat laba</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Kredit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="text-sm">{l.description ?? options.accounts.find((a) => a.id === l.accountId)?.name ?? "—"}</TableCell>
                          <TableCell>{l.profitCenter}</TableCell>
                          <TableCell className="text-right">
                            <Amount value={l.debit} />
                          </TableCell>
                          <TableCell className="text-right">
                            <Amount value={l.credit} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              {canEdit && ov.cutover && g.batch?.status !== "posted" ? (
                <details className="mt-3 rounded-md border p-3" open={!g.batch}>
                  <summary className="cursor-pointer text-sm font-medium">{g.batch ? "Revisi draf (wajib ditandatangani ulang)" : prefill.length ? `Isi dari data modul (${prefill.length} baris usulan)` : "Isi saldo awal"}</summary>
                  <M11ActionForm action={saveOpeningBatchAction} submitLabel="Simpan draf" className="mt-3" testId={`form-saldo-${g.group}`}>
                    <input type="hidden" name="group" value={g.group} />
                    <JournalLinesInput accounts={options.accounts} outlets={options.outlets} rows={Math.min(60, Math.max(4, defaults.length + 2))} defaults={defaults} />
                    <FormInput label="Catatan" name="notes" />
                  </M11ActionForm>
                </details>
              ) : null}
            </SectionCard>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {canAttest ? (
          <SectionCard title="Pengesahan akuntan" description={allSigned ? "Semua kelompok sudah ditandatangani pemilik." : "Masih ada kelompok yang belum ditandatangani pemilik."}>
            <M11ActionForm action={attestOpeningAction} submitLabel="Sahkan saldo awal" testId="sahkan-saldo-awal">
              <FormTextarea label="Catatan pengesahan" name="note" required />
            </M11ActionForm>
          </SectionCard>
        ) : null}
        {canEdit ? (
          <SectionCard title="Posting saldo awal" description={readyToPost ? "Kelompok bertanda tangan & disahkan akuntan siap diposting." : pendingAttest ? "Menunggu pengesahan akuntan." : "Belum ada kelompok yang siap diposting."}>
            <M11ActionButton label="Posting jurnal saldo awal" variant="default" action={postOpeningAction} disabled={!readyToPost} testId="posting-saldo-awal" />
          </SectionCard>
        ) : null}
      </div>

      <SectionCard title="Penyesuaian saldo awal" description="Hanya lewat jurnal 'penyesuaian saldo awal' dengan persetujuan pemilik dan catatan akuntan, paling lama 3 bulan setelah cut-over (PTB-44)." flush={!canEdit}>
        {ov.adjustments.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="penyesuaian-saldo-awal">
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Keterangan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dibuat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ov.adjustments.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <JournalLink id={j.id} number={j.number} />
                    </TableCell>
                    <TableCell className="text-sm">{j.description}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={j.totalDebit} />
                    </TableCell>
                    <TableCell>
                      <JournalStatusBadge status={j.status} />
                    </TableCell>
                    <TableCell className="text-sm">{formatTanggalJam(j.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada penyesuaian saldo awal" compact />
        )}
        {canEdit && ov.cutover ? (
          <M11ActionForm action={requestAdjustmentAction} submitLabel="Ajukan penyesuaian" className="mt-3" testId="ajukan-penyesuaian">
            <JournalLinesInput accounts={options.accounts} outlets={options.outlets} rows={3} />
            <div className="grid gap-3 sm:grid-cols-3">
              <FormInput label="Alasan" name="reason" required />
              <FormInput label="Catatan akuntan (wajib)" name="accountantNote" required />
              <FormInput label="Lampiran" name="evidence" type="file" accept="image/jpeg,image/png,application/pdf" />
            </div>
          </M11ActionForm>
        ) : null}
      </SectionCard>
    </div>
  );
}
