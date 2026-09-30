import type { Metadata } from "next";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { Amount, FilterForm, FilterSelect, FormInput, RecStatusBadge, exportHref, periodLabel, periodOptions } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { saveBankRecAction, saveCashRecAction } from "../actions";

export const metadata: Metadata = { title: "Rekonsiliasi bank & kas" };

type Search = Promise<{ periode?: string }>;

/**
 * Rekonsiliasi bank & kas (US-M11-06): per rekening per periode — saldo rekening koran vs buku dengan item penyesuai
 * otomatis dari pencocokan harian M4; kas kantor, kas awal tetap outlet, kas di tangan sopir, kas kecil. Selisih harus
 * nol untuk menutup periode; hasil tersimpan & tampil bagi akuntan.
 */
export default async function ReconciliationPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.reconciliation.read");
  const sp = await searchParams;
  const current = monthOf(ctxBusinessDate(ctx));
  const period = sp.periode || current;
  const periods = await m11.listPeriods(ctx);
  const row = periods.find((p) => p.period === period && p.id);
  const canEdit = can(ctx, "m11.reconciliation.create");
  const [view, history] = await Promise.all([row?.id ? m11.reconciliationOverview(ctx, { periodId: row.id }) : Promise.resolve(null), m11.reconciliationHistory(ctx)]);
  const editable = canEdit && view && (view.period.status === "open" || view.period.status === "reopened");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Rekonsiliasi bank & kas"
        description="Pencocokan harian di Kas & Setoran mengisi item penyesuai otomatis; hanya item tersisa yang dikerjakan saat tutup buku."
        actions={<ExportButtons excelHref={exportHref("m11.bank_reconciliations", "xlsx")} pdfHref={exportHref("m11.cash_reconciliations", "pdf")} />}
      />
      <SectionCard>
        <FilterForm action="/akuntansi/rekonsiliasi">
          <FilterSelect name="periode" value={period} label="Periode" options={periodOptions(current, 12)} />
        </FilterForm>
      </SectionCard>

      {!view ? (
        <EmptyState title={`Periode ${periodLabel(period)} belum dibuka`} description="Periode dibuat otomatis saat jurnal pertama terposting." />
      ) : (
        <>
          <SectionCard title={`Bank — ${periodLabel(period)}`} description={view.bankOk ? "Semua rekening yang wajib sudah nol selisih." : "Masih ada rekening yang belum nol selisih."}>
            <div className="grid gap-6">
              {view.bank.map((b) => {
                const autoSum = b.autoItems.reduce((s, i) => s + i.amount, 0);
                return (
                  <div key={b.bankAccountId} className="grid gap-3 rounded-md border p-3" data-testid={`rek-bank-${b.accountNumber}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">
                        {b.bankName} {b.accountNumber}
                        {b.sharedGl ? <span className="ml-2 text-xs text-muted-foreground">(akun buku dipakai bersama)</span> : null}
                      </p>
                      <span className="flex flex-wrap gap-1">
                        {b.required ? null : <ToneBadge tone="muted">Tidak wajib (tanpa mutasi)</ToneBadge>}
                        <RecStatusBadge status={b.saved?.status} />
                        {b.stale ? <span className="block text-xs text-destructive" data-testid="rekonsiliasi-basi">Perlu direkonsiliasi ulang — saldo buku berubah setelah disimpan</span> : null}
                      </span>
                    </div>
                    <p className="text-sm">
                      Saldo buku <strong>{formatRupiah(b.bookBalance)}</strong> · item otomatis {formatRupiah(autoSum)}
                      {b.suggestedStatementBalance !== null ? ` · saldo mutasi impor terakhir ${formatRupiah(b.suggestedStatementBalance)}` : ""}
                      {b.saved ? ` · tersimpan selisih ${formatRupiah(b.saved.difference)}${b.saved.completedAt ? `, nol selisih ${formatTanggalJam(b.saved.completedAt)}` : ""}` : ""}
                    </p>
                    {b.autoItems.length ? (
                      <ul className="grid gap-1 text-sm">
                        {b.autoItems.map((i, n) => (
                          <li key={n} className="flex flex-wrap justify-between gap-2">
                            <span>
                              {m11.ADJUSTING_LABELS[i.kind]} — {i.description}
                              {i.blocking ? <ToneBadge tone="danger" className="ml-2">Menghalangi</ToneBadge> : null}
                            </span>
                            <Amount value={i.amount} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {editable ? (
                      <M11ActionForm action={saveBankRecAction} submitLabel="Simpan rekonsiliasi bank" resetOnSuccess={false} testId={`simpan-bank-${b.accountNumber}`}>
                        <input type="hidden" name="periodId" value={view.period.id} />
                        <input type="hidden" name="bankAccountId" value={b.bankAccountId} />
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <FormInput label="Saldo rekening koran (Rp)" name="statementBalance" inputMode="numeric" required defaultValue={b.saved?.statementBalance ?? b.suggestedStatementBalance ?? ""} />
                          <FormInput label="Biaya bank (Rp, negatif)" name="item_bank_fee" inputMode="numeric" placeholder="-6500" hint="Dicatat juga sebagai jurnal manual biaya bank." />
                          <FormInput label="Bunga bank (Rp)" name="item_interest" inputMode="numeric" />
                          <FormInput label="Lainnya (Rp)" name="item_other" inputMode="numeric" />
                        </div>
                        <FormInput label="Catatan" name="notes" />
                      </M11ActionForm>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard title={`Kas — ${periodLabel(period)}`} description="Kas di tangan sopir harus nol setelah setoran diterima; selisih wajib beralasan dan diselesaikan lewat alur Selisih di Kas & Setoran." flush>
            <div className="overflow-x-auto">
              <Table data-testid="tabel-rek-kas">
                <TableHeader>
                  <TableRow>
                    <TableHead>Kas</TableHead>
                    <TableHead className="text-right">Saldo sistem</TableHead>
                    <TableHead className="text-right">Usulan fisik</TableHead>
                    <TableHead className="text-right">Fisik tersimpan</TableHead>
                    <TableHead>Status</TableHead>
                    {editable ? <TableHead>Simpan</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.cash
                    .filter((c) => c.required || c.saved)
                    .map((c) => (
                      <TableRow key={`${c.kind}-${c.outletId ?? ""}`}>
                        <TableCell>
                          {c.label}
                          <span className="block text-xs text-muted-foreground">{label("cash_reconciliation_kind", c.kind)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Amount value={c.systemBalance} />
                        </TableCell>
                        <TableCell className="text-right">{c.suggestedPhysical !== null ? formatRupiah(c.suggestedPhysical) : "—"}</TableCell>
                        <TableCell className="text-right">{c.saved ? formatRupiah(c.saved.physicalBalance) : "—"}</TableCell>
                        <TableCell>
                          <RecStatusBadge status={c.saved?.status} />
                          {c.stale ? <span className="block text-xs text-destructive">Perlu direkonsiliasi ulang — saldo sistem berubah setelah disimpan</span> : null}
                          {c.saved?.reason ? <span className="block text-xs text-muted-foreground">{c.saved.reason}</span> : null}
                        </TableCell>
                        {editable ? (
                          <TableCell>
                            <M11ActionForm action={saveCashRecAction} submitLabel="Simpan" variant="outline" resetOnSuccess={false} className="min-w-64">
                              <input type="hidden" name="periodId" value={view.period.id} />
                              <input type="hidden" name="kind" value={c.kind} />
                              {c.outletId ? <input type="hidden" name="outletId" value={c.outletId} /> : null}
                              <FormInput label="Saldo fisik (Rp)" name="physicalBalance" inputMode="numeric" required defaultValue={c.kind === "driver_cash" ? 0 : (c.saved?.physicalBalance ?? c.suggestedPhysical ?? c.systemBalance)} />
                              <FormInput label="Alasan selisih" name="reason" />
                            </M11ActionForm>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </>
      )}

      <SectionCard title="Riwayat rekonsiliasi" description="Tampil bagi akuntan: nol selisih, siapa, kapan, item penyesuai." flush>
        {history.bank.length || history.cash.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-rekonsiliasi">
              <TableHeader>
                <TableRow>
                  <TableHead>Periode</TableHead>
                  <TableHead>Rekening / kas</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Selesai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.bank.map((h) => (
                  <TableRow key={h.r.id}>
                    <TableCell>{h.period}</TableCell>
                    <TableCell>
                      {h.bankName} {h.accountNumber}
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(h.r.difference)}</TableCell>
                    <TableCell>
                      <RecStatusBadge status={h.r.status} />
                    </TableCell>
                    <TableCell>{h.r.completedAt ? formatTanggal(h.r.completedAt, { weekday: false }) : "—"}</TableCell>
                  </TableRow>
                ))}
                {history.cash.map((h) => (
                  <TableRow key={h.r.id}>
                    <TableCell>{h.period}</TableCell>
                    <TableCell>{label("cash_reconciliation_kind", h.r.kind)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(h.r.difference)}</TableCell>
                    <TableCell>
                      <RecStatusBadge status={h.r.status} />
                    </TableCell>
                    <TableCell>{h.r.completedAt ? formatTanggal(h.r.completedAt, { weekday: false }) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada rekonsiliasi tersimpan" compact />
        )}
      </SectionCard>
    </div>
  );
}
