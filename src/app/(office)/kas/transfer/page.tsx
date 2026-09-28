import type { Metadata } from "next";
import Link from "next/link";

import { CashActionForm } from "@/components/m4-cash/action-form";
import { DateFilterInput, Field, FileField, FilterForm, LinkTabs, MoneyField, SelectField, SelectFilterInput, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { confirmMatchesAction, importStatementAction, markStatementLineAction, matchTransferAction } from "../actions";

export const metadata: Metadata = { title: "Transfer masuk" };

type Search = { tampil?: string; status?: string; dari?: string; sampai?: string; asal?: string; id?: string };

const STATUS_FILTERS = [
  { value: "open", label: "Belum dicocokkan & tidak ditemukan" },
  { value: "unmatched", label: "Belum dicocokkan" },
  { value: "not_found", label: "Tidak ditemukan" },
  { value: "matched", label: "Cocok" },
  { value: "cancelled", label: "Dibatalkan" },
  { value: "all", label: "Semua" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

/**
 * Transfer masuk (US-M4-04): daftar transfer tercatat dari lapangan (pembayaran rit, pelunasan, QRIS per shift, setor
 * bank dengan slip, pelunasan mitra toko) dengan bukti, sumber, tanggal, status; pencocokan manual dengan referensi
 * mutasi (M); impor CSV/Excel mutasi dengan usulan pasangan (S) dan daftar tindak lanjut mutasi tanpa pasangan.
 */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m4.incoming_transfer.read");
  const sp = await searchParams;
  const view = sp.tampil === "mutasi" ? "mutasi" : "transfer";
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader title="Transfer masuk" description="Setiap transfer yang dicatat lapangan dicocokkan dengan mutasi bank. Tanpa mutasi lewat batas hari → Tidak ditemukan." />
      <LinkTabs
        label="Tampilan transfer"
        active={view}
        tabs={[
          { key: "transfer", label: "Transfer tercatat", href: "/kas/transfer" },
          { key: "mutasi", label: "Impor & mutasi bank", href: "/kas/transfer?tampil=mutasi" },
        ]}
      />
      {view === "mutasi" ? <StatementView ctx={ctx} /> : <TransferView ctx={ctx} sp={sp} />}
    </div>
  );
}

async function TransferView({ ctx, sp }: { ctx: ActorContext; sp: Search }) {
  const today = ctxBusinessDate(ctx);
  const status = (STATUS_FILTERS.find((s) => s.value === sp.status)?.value ?? "open") as StatusFilter;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : null;
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : null;
  const kinds = enumOptions("transfer_source_kind");
  const sourceKind = kinds.find((k) => k.value === sp.asal)?.value as EnumValue<"transfer_source_kind"> | undefined;
  const rows = await m4.listIncomingTransfers(ctx, { status, from, to, sourceKind: sourceKind ?? null, id: sp.id ?? null });
  const canMatch = can(ctx, "m4.incoming_transfer.match");
  const open = rows.filter((r) => r.status === "unmatched" || r.status === "not_found");
  const notFound = rows.filter((r) => r.status === "not_found");
  const exportFrom = from ?? addDays(today, -30);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Belum dicocokkan" value={<MoneyText value={open.reduce((s, r) => s + r.amount, 0)} />} hint={`${open.length} transfer`} />
        <KpiTile label="Tidak ditemukan" value={`${notFound.length} transfer`} tone={notFound.length ? "danger" : "success"} hint="Tindak lanjuti ke pelanggan/penyetor" />
        <KpiTile label="Ditampilkan" value={`${rows.length} transfer`} />
      </div>
      <FilterForm action="/kas/transfer">
        <SelectFilterInput name="status" value={status} label="Status" options={STATUS_FILTERS} />
        <SelectFilterInput name="asal" value={sourceKind ?? ""} label="Asal" options={[{ value: "", label: "Semua asal" }, ...kinds]} />
        <DateFilterInput name="dari" value={from} label="Dari" />
        <DateFilterInput name="sampai" value={to} label="Sampai" />
      </FilterForm>
      <SectionCard
        title="Transfer tercatat"
        description={sp.id ? <Link href="/kas/transfer" className="text-primary hover:underline">Tampilkan semua transfer terbuka</Link> : "Cocokkan dengan referensi mutasi internet banking (tanggal, jumlah, keterangan)."}
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m4.incoming_transfers", { format: "xlsx", status, from: exportFrom, to: to ?? today })}
            pdfHref={hrefWith("/api/export/m4.incoming_transfers", { format: "pdf", status, from: exportFrom, to: to ?? today })}
          />
        }
        flush
      >
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-transfer">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Asal & sumber</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Bukti</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="min-w-64">Cocokkan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => {
                  const slipDeposit = t.sourceKind === "bank_deposit_slip" && t.sourceObjectType === "deposit";
                  return (
                    <TableRow key={t.id} className={t.status === "not_found" ? "bg-destructive/5" : undefined}>
                      <TableCell className="text-sm">
                        {formatTanggal(t.transferDate, { weekday: false })}
                        <span className="block text-xs text-muted-foreground">{t.ageDays} hari</span>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-medium">{label("transfer_source_kind", t.sourceKind)}</span>
                        {t.customerName ? <span className="block">{t.customerName}</span> : null}
                        <span className="block text-xs text-muted-foreground">
                          {[t.sourceUserName ? `Dicatat ${t.sourceUserName}` : null, t.truckCode, t.outletLabel, t.reference, t.bankLabel].filter(Boolean).join(" · ")}
                        </span>
                        {slipDeposit && t.sourceObjectId ? (
                          <Link href={`/kas/setoran/${t.sourceObjectId}`} className="text-xs text-primary hover:underline">
                            Lihat setoran
                          </Link>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatRupiah(t.amount)}</TableCell>
                      <TableCell>
                        {t.proofAttachmentId ? (
                          <a href={`/api/attachments/${t.proofAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                            Foto bukti
                          </a>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.status === "cancelled" ? <ToneBadge tone="muted">Dibatalkan</ToneBadge> : <StatusBadge enumName="incoming_transfer_status" value={t.status} />}
                        {t.status === "matched" ? (
                          <span className="block text-xs text-muted-foreground">
                            {t.matchRefDate ? formatTanggal(t.matchRefDate, { weekday: false }) : ""} · {t.matchRefNote}
                            {t.matchedByName ? ` · ${t.matchedByName}` : ""}
                            {t.matchedAt ? ` · ${formatTanggalJam(t.matchedAt)}` : ""}
                          </span>
                        ) : null}
                        {t.status === "cancelled" && t.cancelReason ? <span className="block text-xs text-muted-foreground">{t.cancelReason}</span> : null}
                      </TableCell>
                      <TableCell>
                        {(t.status === "unmatched" || t.status === "not_found") && canMatch ? (
                          <details>
                            <summary className="cursor-pointer text-sm font-medium text-primary">Cocokkan manual</summary>
                            <CashActionForm action={matchTransferAction.bind(null, t.id)} submitLabel="Tandai cocok" className="mt-2">
                              <Field label="Tanggal mutasi" name="refDate" type="date" defaultValue={t.transferDate} required />
                              <MoneyField label="Jumlah mutasi (Rp)" name="refAmount" defaultValue={t.amount} required />
                              <Field label="Keterangan mutasi" name="refNote" required placeholder="mis. TRSF E-BANKING CR 2809" />
                              {slipDeposit ? (
                                <>
                                  <SelectField label="Alasan selisih (bila jumlah mutasi berbeda)" name="discrepancyReason" options={enumOptions("discrepancy_reason")} emptyLabel="Tidak ada selisih" />
                                  <Field label="Keterangan selisih" name="discrepancyNote" />
                                </>
                              ) : null}
                            </CashActionForm>
                          </details>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada transfer untuk filter ini" compact />
        )}
      </SectionCard>
    </>
  );
}

async function StatementView({ ctx }: { ctx: ActorContext }) {
  const today = ctxBusinessDate(ctx);
  const canImport = can(ctx, "m4.bank_statement.import");
  const canMatch = can(ctx, "m4.incoming_transfer.match");
  const accounts = can(ctx, "m4.office_cash.read") ? await m4.listBankAccounts(ctx) : [];
  const { proposals } = await m4.proposeStatementMatches(ctx);
  const lines = await m4.listStatementLines(ctx, { status: "open" });
  return (
    <>
      {canImport ? (
        <SectionCard title="Impor berkas mutasi" description="Unggah CSV atau Excel (.xlsx) hasil unduhan internet banking. Baris yang sudah pernah diimpor tidak digandakan.">
          {accounts.length ? (
            <CashActionForm action={importStatementAction} submitLabel="Impor mutasi" testId="form-impor-mutasi">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Rekening" name="bankAccountId" options={accounts.map((a) => ({ value: a.id, label: `${a.bankName} ${a.accountNumber}` }))} required />
                <FileField label="Berkas mutasi" name="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required hint="Kolom dikenali dari judul: Tanggal, Keterangan, Jumlah atau Kredit/Debit." />
              </div>
            </CashActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">
              Belum ada rekening bank PT. Tambahkan di{" "}
              <Link href="/kas/kantor" className="text-primary hover:underline">
                Kas kantor & setor bank
              </Link>
              .
            </p>
          )}
        </SectionCard>
      ) : null}
      <SectionCard title={`Usulan pasangan (${proposals.length})`} description="Jumlah sama dan tanggal berdekatan. Periksa lalu konfirmasi; usulan yang meragukan tidak dicentang." flush>
        {proposals.length ? (
          canMatch ? (
            <CashActionForm action={confirmMatchesAction} submitLabel="Konfirmasi pasangan terpilih" className="p-4" testId="form-usulan-pasangan">
              <ProposalTable proposals={proposals} selectable />
            </CashActionForm>
          ) : (
            <ProposalTable proposals={proposals} selectable={false} />
          )
        ) : (
          <EmptyState title="Tidak ada usulan pasangan" description="Impor mutasi terbaru untuk mendapatkan usulan." compact />
        )}
      </SectionCard>
      <SectionCard
        title={`Mutasi tanpa pasangan (${lines.length})`}
        description="Daftar tindak lanjut: mutasi masuk yang tidak cocok dengan transfer tercatat."
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.statement_lines", { format: "xlsx", status: "open" })} pdfHref={hrefWith("/api/export/m4.statement_lines", { format: "pdf", status: "open" })} />}
        flush
      >
        {lines.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="mutasi-tanpa-pasangan">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Rekening</TableHead>
                  <TableHead>Keterangan</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="min-w-56" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">{formatTanggal(l.lineDate, { weekday: false })}</TableCell>
                    <TableCell className="text-sm">{l.bankLabel}</TableCell>
                    <TableCell className="max-w-72 whitespace-normal text-sm">
                      {l.description ?? "—"}
                      {l.followUpNote ? <span className="block text-xs text-muted-foreground">Catatan: {l.followUpNote}</span> : null}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${l.amount < 0 ? "text-destructive" : ""}`}>{formatRupiah(l.amount, { signed: l.amount < 0 })}</TableCell>
                    <TableCell>
                      <ToneBadge tone={l.status === "follow_up" ? "warning" : "neutral"}>{label("bank_statement_line_status", l.status)}</ToneBadge>
                    </TableCell>
                    <TableCell>
                      {canMatch ? (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium text-primary">Tandai</summary>
                          <CashActionForm action={markStatementLineAction.bind(null, l.id)} submitLabel="Simpan" className="mt-2">
                            <SelectField
                              label="Tindakan"
                              name="status"
                              options={[
                                { value: "follow_up", label: "Tindak lanjut (hubungi pelanggan/bank)" },
                                { value: "ignored", label: "Abaikan (bunga, antar rekening, dll.)" },
                              ]}
                              required
                            />
                            <Field label="Catatan" name="note" required />
                          </CashActionForm>
                        </details>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Semua mutasi masuk sudah berpasangan" compact />
        )}
      </SectionCard>
      <SectionCard
        title="Hasil pencocokan harian"
        description="Masukan rekonsiliasi bank bulanan (M11): transfer yang dicocokkan per tanggal beserta referensi mutasinya."
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m4.daily_matching", { format: "xlsx", from: addDays(today, -6), to: today })}
            pdfHref={hrefWith("/api/export/m4.daily_matching", { format: "pdf", from: addDays(today, -6), to: today })}
          />
        }
      >
        <p className="text-sm text-muted-foreground">Unduh hasil 7 hari terakhir; rentang lain lewat laporan ekspor.</p>
      </SectionCard>
    </>
  );
}

function ProposalTable({ proposals, selectable }: { proposals: m4.MatchProposal[]; selectable: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid="usulan-pasangan">
        <TableHeader>
          <TableRow>
            {selectable ? <TableHead className="w-10">Pilih</TableHead> : null}
            <TableHead>Mutasi</TableHead>
            <TableHead>Transfer tercatat</TableHead>
            <TableHead className="text-right">Jumlah</TableHead>
            <TableHead>Selisih tanggal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proposals.map((p) => (
            <TableRow key={`${p.line.id}:${p.transfer.id}`}>
              {selectable ? (
                <TableCell>
                  <input type="checkbox" name="pair" value={`${p.line.id}:${p.transfer.id}`} defaultChecked={!p.ambiguous} aria-label="Pilih pasangan" />
                </TableCell>
              ) : null}
              <TableCell className="text-sm">
                {formatTanggal(p.line.lineDate, { weekday: false })}
                <span className="block text-xs text-muted-foreground">{p.line.description ?? "—"}</span>
              </TableCell>
              <TableCell className="text-sm">
                {label("transfer_source_kind", p.transfer.sourceKind)} · {formatTanggal(p.transfer.transferDate, { weekday: false })}
                {p.transfer.reference ? <span className="block text-xs text-muted-foreground">{p.transfer.reference}</span> : null}
              </TableCell>
              <TableCell className="text-right font-medium">{formatRupiah(p.line.amount)}</TableCell>
              <TableCell className="text-sm">
                {p.dateDiff === 0 ? "Tanggal sama" : `${p.dateDiff} hari`}
                {p.ambiguous ? <ToneBadge tone="warning">Lebih dari satu kandidat</ToneBadge> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
