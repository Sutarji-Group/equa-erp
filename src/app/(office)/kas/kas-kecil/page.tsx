import type { Metadata } from "next";

import { CashActionForm } from "@/components/m4-cash/action-form";
import { DateFilterInput, Field, FileField, FilterForm, MoneyField, SelectField, TextareaField, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { pettyCashAction, pettyCashCountAction } from "../actions";

export const metadata: Metadata = { title: "Kas kecil" };

const STATUS_TONE = { pending_approval: "warning", approved: "success", rejected: "muted" } as const;

/**
 * Kas kecil (US-M4-05 KP-2, S): pengisian dari kas kantor; pengeluaran berkategori + pusat laba + foto bukti; di atas
 * PAR-43 menunggu persetujuan pemilik (belum berlaku); rekonsiliasi fisik mingguan dengan selisih beralasan (→ Selisih).
 */
export default async function PettyCashPage({ searchParams }: { searchParams: Promise<{ dari?: string; sampai?: string }> }) {
  const { ctx } = await requirePermission("m4.petty_cash.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const data = await m4.getPettyCash(ctx, { from: sp.dari && isBusinessDate(sp.dari) ? sp.dari : null, to: sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : null });
  const canCreate = can(ctx, "m4.petty_cash.create");
  const canCount = can(ctx, "m4.petty_cash.count");
  const outlets = canCreate ? (await m4.pettyCashOutletOptions(ctx)).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })) : [];
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Kas kecil"
        description={`Pengisian & pengeluaran di atas ${formatRupiah(data.approvalAbove)} perlu persetujuan pemilik. Hitung fisik setiap ${data.countEveryDays} hari.`}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.petty_cash", { format: "xlsx", from: data.from, to: data.to })} pdfHref={hrefWith("/api/export/m4.petty_cash", { format: "pdf", from: data.from, to: data.to })} />}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Saldo kas kecil (sistem)" value={<MoneyText value={data.balance} />} />
        <KpiTile label="Menunggu persetujuan" value={`${data.pending.length} transaksi`} tone={data.pending.length ? "warning" : "success"} hint={data.pending.length ? formatRupiah(data.pending.reduce((s, p) => s + p.amount, 0)) : undefined} />
        <KpiTile
          label="Hitung fisik terakhir"
          value={data.lastCountText ?? "Belum pernah"}
          tone={data.countOverdue ? "warning" : "success"}
          hint={data.countOverdue ? "Rekonsiliasi mingguan terlewat — hitung fisik sekarang" : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {canCreate ? (
          <SectionCard title="Catat kas kecil" description="Pengisian mengurangi kas kantor. Pengeluaran wajib kategori, pusat laba, dan foto bukti.">
            <CashActionForm action={pettyCashAction} submitLabel="Simpan" testId="form-kas-kecil">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Jenis"
                  name="kind"
                  options={[
                    { value: "expense", label: "Pengeluaran" },
                    { value: "topup", label: "Pengisian dari kas kantor" },
                  ]}
                  required
                />
                <MoneyField label="Jumlah (Rp)" name="amount" required />
                <SelectField label="Kategori (pengeluaran)" name="category" options={enumOptions("petty_cash_category")} emptyLabel="—" />
                <SelectField label="Pusat laba (pengeluaran)" name="profitCenter" options={enumOptions("profit_center")} emptyLabel="—" />
                <SelectField label="Outlet (opsional)" name="outletId" options={outlets} emptyLabel="Tanpa outlet" />
                <Field label="Tanggal" name="businessDate" type="date" defaultValue={today} max={today} />
              </div>
              <TextareaField label="Uraian" name="description" required />
              <FileField label="Foto bukti (pengeluaran)" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf" />
            </CashActionForm>
          </SectionCard>
        ) : null}
        {canCount ? (
          <SectionCard title="Hitung fisik (rekonsiliasi mingguan)" description={`Saldo sistem saat ini ${formatRupiah(data.balance)}. Selisih wajib alasan dan masuk alur Selisih; saldo disesuaikan.`}>
            <CashActionForm action={pettyCashCountAction} submitLabel="Simpan hitung fisik" testId="form-hitung-kas-kecil">
              <MoneyField label="Uang fisik kas kecil (Rp)" name="physicalAmount" required />
              <TextareaField label="Alasan selisih (bila ada)" name="reason" />
            </CashActionForm>
          </SectionCard>
        ) : null}
      </div>

      <FilterForm action="/kas/kas-kecil">
        <DateFilterInput name="dari" value={data.from} label="Dari" />
        <DateFilterInput name="sampai" value={data.to} label="Sampai" />
      </FilterForm>
      <SectionCard title={`Transaksi kas kecil ${formatTanggal(data.from, { weekday: false })} – ${formatTanggal(data.to, { weekday: false })}`} flush>
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-kas-kecil">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Kategori & pusat laba</TableHead>
                  <TableHead>Uraian</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Bukti</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{formatTanggal(r.businessDate, { weekday: false })}</TableCell>
                    <TableCell className="text-sm">{label("petty_cash_kind", r.kind)}</TableCell>
                    <TableCell className="text-sm">
                      {r.category ? label("petty_cash_category", r.category) : "—"}
                      {r.profitCenter ? <span className="block text-xs text-muted-foreground">{label("profit_center", r.profitCenter)}</span> : null}
                    </TableCell>
                    <TableCell className="max-w-72 text-sm">{r.description ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(r.amount)}</TableCell>
                    <TableCell>
                      <ToneBadge tone={STATUS_TONE[r.status]}>{label("petty_cash_status", r.status)}</ToneBadge>
                    </TableCell>
                    <TableCell>
                      {r.receiptAttachmentId ? (
                        <a href={`/api/attachments/${r.receiptAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                          Foto bukti
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada transaksi kas kecil pada rentang ini" compact />
        )}
      </SectionCard>
      <SectionCard title="Riwayat hitung fisik" flush>
        {data.counts.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-hitung-kas-kecil">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead className="text-right">Saldo sistem</TableHead>
                  <TableHead className="text-right">Fisik</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Alasan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.counts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm">{formatTanggal(c.countDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{formatRupiah(c.systemBalance)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(c.physicalAmount)}</TableCell>
                    <TableCell className={`text-right ${c.difference ? "font-medium text-destructive" : ""}`}>{formatRupiah(c.difference, { signed: true })}</TableCell>
                    <TableCell className="text-sm">{c.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum pernah hitung fisik" compact />
        )}
      </SectionCard>
    </div>
  );
}
