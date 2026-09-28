import type { Metadata } from "next";
import Link from "next/link";

import { CashReasonButton } from "@/components/m4-cash/action-buttons";
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
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { bankDepositAction, createBankAccountAction, deactivateBankAccountAction, openingBalanceAction, reverseBankDepositAction } from "../actions";

export const metadata: Metadata = { title: "Kas kantor & setor bank" };

/**
 * Kas kantor & setor bank (US-M4-01 KP-3, US-M4-05 KP-1/KP-3): saldo = saldo awal + setoran diterima − setor ke bank −
 * pengisian kas kecil − penggantian pengeluaran rit (± lainnya); setor ke bank dengan foto slip (mengurangi kas kantor,
 * dicocokkan dengan mutasi); rekening bank PT; saldo awal cut-over; pembalik setor bank beralasan (BR-38).
 */
export default async function OfficeCashPage({ searchParams }: { searchParams: Promise<{ tanggal?: string }> }) {
  const { ctx } = await requirePermission("m4.office_cash.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const date = sp.tanggal && isBusinessDate(sp.tanggal) && sp.tanggal <= today ? sp.tanggal : today;
  const data = await m4.getOfficeCash(ctx, { date });
  const movements = await m4.listOfficeCashMovements(ctx, { from: date, to: date });
  const d = data.day;
  const canBank = can(ctx, "m4.bank_deposit.create");
  const canReverse = can(ctx, "m4.bank_deposit.reverse");
  const canAccounts = can(ctx, "m4.bank_account.update");
  const canOpening = can(ctx, "m4.office_cash.count");
  const activeAccounts = data.accounts.filter((a) => a.isActive);
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Kas kantor & setor bank"
        description={`${formatTanggal(date)} — saldo sistem dibandingkan dengan hitung fisik saat tutup kas.`}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.office_cash", { format: "xlsx", from: date, to: date })} pdfHref={hrefWith("/api/export/m4.office_cash", { format: "pdf", from: date, to: date })} />}
      />
      <FilterForm action="/kas/kantor">
        <DateFilterInput name="tanggal" value={date} label="Tanggal" />
      </FilterForm>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Saldo awal" value={<MoneyText value={d.opening} />} />
        <KpiTile label="+ Setoran diterima" value={<MoneyText value={d.depositsReceived} />} />
        <KpiTile label="− Setor ke bank" value={<MoneyText value={d.bankDeposits} />} />
        <KpiTile label="− Kas kecil & penggantian rit" value={<MoneyText value={d.pettyCashTopups + d.expenseReimbursements} />} hint={`Kas kecil ${formatRupiah(d.pettyCashTopups)} · penggantian ${formatRupiah(d.expenseReimbursements)}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <KpiTile label="± Lainnya" value={<MoneyText value={d.otherIn - d.otherOut} signed />} hint={`Masuk ${formatRupiah(d.otherIn)} · keluar ${formatRupiah(d.otherOut)} (pemasok, ganti rugi, koreksi)`} />
        <KpiTile label="Saldo kas kantor (sistem)" value={<MoneyText value={d.closing} />} href="/kas/tutup" hrefLabel="Bandingkan saat tutup kas" />
      </div>

      <SectionCard title="Mutasi kas kantor" flush>
        {movements.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="mutasi-kas-kantor">
              <TableHeader>
                <TableRow>
                  <TableHead>Jam</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Uraian</TableHead>
                  <TableHead className="text-right">Masuk</TableHead>
                  <TableHead className="text-right">Keluar</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-sm">{formatJam(m.createdAt)}</TableCell>
                    <TableCell className="text-sm">{m.kindLabel}</TableCell>
                    <TableCell className="max-w-80 whitespace-normal text-sm">{m.description ?? "—"}</TableCell>
                    <TableCell className="text-right">{m.direction === "in" ? formatRupiah(m.amount) : "—"}</TableCell>
                    <TableCell className="text-right">{m.direction === "out" ? formatRupiah(m.amount) : "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(m.balanceAfter)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada mutasi kas kantor pada tanggal ini" compact />
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {canBank ? (
          <SectionCard title="Setor ke bank" description="Jumlah, tanggal, rekening PT, dan foto slip wajib. Mengurangi kas kantor; dicocokkan dengan mutasi di Transfer masuk.">
            {activeAccounts.length ? (
              <CashActionForm action={bankDepositAction} submitLabel="Catat setor ke bank" testId="form-setor-bank">
                <SelectField label="Rekening PT" name="bankAccountId" options={activeAccounts.map((a) => ({ value: a.id, label: `${a.bankName} ${a.accountNumber} — ${a.accountName}` }))} required />
                <div className="grid gap-3 sm:grid-cols-2">
                  <MoneyField label="Jumlah (Rp)" name="amount" required />
                  <Field label="Tanggal setor" name="businessDate" type="date" defaultValue={today} max={today} />
                </div>
                <FileField label="Foto slip setoran" name="slip" accept="image/jpeg,image/png,image/webp,application/pdf" required />
                <Field label="Catatan" name="notes" />
              </CashActionForm>
            ) : (
              <p className="text-sm text-muted-foreground">Tambahkan rekening bank PT terlebih dahulu.</p>
            )}
          </SectionCard>
        ) : null}

        <SectionCard title="Rekening bank PT" flush>
          {data.accounts.length ? (
            <Table data-testid="rekening-bank">
              <TableHeader>
                <TableRow>
                  <TableHead>Rekening</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm">
                      <span className="font-medium">
                        {a.bankName} {a.accountNumber}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {a.accountName}
                        {a.branch ? ` · ${a.branch}` : ""}
                        {a.isCustomerFacing ? " · ditampilkan ke pelanggan" : ""}
                      </span>
                    </TableCell>
                    <TableCell>{a.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}</TableCell>
                    <TableCell>
                      {a.isActive && canAccounts ? (
                        <CashReasonButton label="Nonaktifkan" title={`Nonaktifkan rekening ${a.bankName} ${a.accountNumber}`} description="Rekening tidak dihapus; transfer lama tetap merujuknya." action={deactivateBankAccountAction.bind(null, a.id)} destructive />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="Belum ada rekening bank PT" compact />
          )}
          {canAccounts ? (
            <details className="border-t p-4">
              <summary className="cursor-pointer text-sm font-medium text-primary">Tambah rekening</summary>
              <CashActionForm action={createBankAccountAction} submitLabel="Tambah rekening" className="mt-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nama bank" name="bankName" required />
                  <Field label="Nomor rekening" name="accountNumber" required inputMode="numeric" />
                  <Field label="Nama pemilik rekening" name="accountName" required />
                  <Field label="Cabang" name="branch" />
                </div>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isCustomerFacing" /> Ditampilkan ke pelanggan (struk, pengingat tagihan)
                </label>
              </CashActionForm>
            </details>
          ) : null}
        </SectionCard>
      </div>

      <SectionCard
        title="Setor ke bank 30 hari terakhir"
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.bank_deposits", { format: "xlsx", date })} pdfHref={hrefWith("/api/export/m4.bank_deposits", { format: "pdf", date })} />}
        flush
      >
        {data.bankDeposits.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-setor-bank">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Rekening</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Slip</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bankDeposits.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="text-sm">{formatTanggal(b.businessDate, { weekday: false })}</TableCell>
                    <TableCell className="text-sm">
                      {b.bankLabel}
                      {b.notes ? <span className="block text-xs text-muted-foreground">{b.notes}</span> : null}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${b.amount < 0 ? "text-destructive" : ""}`}>{formatRupiah(b.amount, { signed: b.amount < 0 })}</TableCell>
                    <TableCell>
                      {b.slipAttachmentId ? (
                        <a href={`/api/attachments/${b.slipAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                          Foto slip
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {b.reversalOfId ? <ToneBadge tone="muted">Pembalik</ToneBadge> : b.reversed ? <ToneBadge tone="muted">Dibalik</ToneBadge> : <ToneBadge tone={b.status === "matched" ? "success" : "warning"}>{label("bank_deposit_status", b.status)}</ToneBadge>}
                    </TableCell>
                    <TableCell>
                      {!b.reversalOfId && !b.reversed && b.status !== "matched" && canReverse ? (
                        <CashReasonButton
                          label="Balik"
                          title="Balik setor ke bank"
                          description="Koreksi = transaksi pembalik beralasan; kas kantor dikembalikan. Di atas batas koreksi perlu persetujuan pemilik (BR-38)."
                          action={reverseBankDepositAction.bind(null, b.id)}
                          destructive
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada setor ke bank" compact />
        )}
      </SectionCard>

      {!data.hasOpeningBalance && canOpening ? (
        <SectionCard title="Saldo awal kas kantor (cut-over)" description="Dicatat sekali dari hasil hitung fisik saat mulai memakai sistem. Koreksi berikutnya lewat selisih kas saat tutup kas.">
          <CashActionForm action={openingBalanceAction} submitLabel="Catat saldo awal" testId="form-saldo-awal">
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField label="Saldo awal (Rp)" name="amount" required />
              <Field label="Tanggal" name="businessDate" type="date" defaultValue={today} max={today} />
            </div>
            <TextareaField label="Keterangan" name="note" required hint="mis. Hitung fisik laci kantor bersama pemilik" />
          </CashActionForm>
        </SectionCard>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Setoran fisik yang diterima di{" "}
        <Link href="/kas/setoran" className="text-primary hover:underline">
          Setoran
        </Link>{" "}
        menambah kas kantor otomatis; pengeluaran kas kecil dicatat di{" "}
        <Link href="/kas/kas-kecil" className="text-primary hover:underline">
          Kas kecil
        </Link>
        .
      </p>
    </div>
  );
}
