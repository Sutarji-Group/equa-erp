import type { Metadata } from "next";
import Link from "next/link";

import { Amount, FilterForm, FilterSelect, JournalLink, PROFIT_CENTER_OPTIONS, exportHref, hrefWith, periodOptions } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import * as m11 from "@/server/modules/m11-accounting";

export const metadata: Metadata = { title: "Buku besar" };

type Search = Promise<{ akun?: string; lini?: string; dari?: string; sampai?: string; hal?: string }>;

/**
 * Buku besar per akun & pusat laba (US-M11-04 KP-1/KP-3): saldo awal, mutasi, saldo berjalan; setiap baris menurun ke
 * jurnal dan transaksi sumbernya. Baris dipaginasi di server (`?hal=`, `m11.LEDGER_PAGE_SIZE` baris) — mutasi & saldo
 * akhir tetap atas seluruh rentang (uji beban NFR-05: akun kas depot 50 ribu baris/bulan).
 */
export default async function LedgerPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.ledger.read");
  const sp = await searchParams;
  const current = monthOf(ctxBusinessDate(ctx));
  const accounts = await m11.accountOptions(ctx);
  const from = sp.dari || current;
  const to = sp.sampai || from;
  const pageNo = Math.max(1, Math.trunc(Number(sp.hal) || 1));
  const ledger = sp.akun
    ? await m11.getLedger(ctx, { accountId: sp.akun, profitCenter: (sp.lini as never) ?? null, fromPeriod: from, toPeriod: to, offset: (pageNo - 1) * m11.LEDGER_PAGE_SIZE, limit: m11.LEDGER_PAGE_SIZE })
    : null;
  const shownFrom = ledger && ledger.lines.length ? ledger.page.offset + 1 : 0;
  const shownTo = ledger ? ledger.page.offset + ledger.lines.length : 0;
  const currentPage = ledger ? Math.floor(ledger.page.offset / m11.LEDGER_PAGE_SIZE) + 1 : 1;
  const lastPage = ledger ? Math.max(1, Math.ceil(ledger.page.total / m11.LEDGER_PAGE_SIZE)) : 1;
  const pageHref = (n: number) => hrefWith("/akuntansi/buku-besar", { akun: sp.akun, lini: sp.lini, dari: from, sampai: to, hal: n > 1 ? n : null });
  const periods = periodOptions(current, 24, 1);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Buku besar"
        description="Pilih akun untuk melihat mutasi per periode posting. Klik nomor jurnal untuk menelusuri ke transaksi sumber."
        actions={sp.akun ? <ExportButtons excelHref={exportHref("m11.ledger", "xlsx", { accountId: sp.akun, from, to, profitCenter: sp.lini })} pdfHref={exportHref("m11.ledger", "pdf", { accountId: sp.akun, from, to, profitCenter: sp.lini })} /> : null}
      />
      <SectionCard>
        <FilterForm action="/akuntansi/buku-besar" testId="filter-buku-besar">
          <FilterSelect name="akun" value={sp.akun} label="Akun" options={accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} emptyLabel="Pilih akun" />
          <FilterSelect name="lini" value={sp.lini} label="Pusat laba" options={PROFIT_CENTER_OPTIONS} emptyLabel="Semua" />
          <FilterSelect name="dari" value={from} label="Dari periode" options={periods} />
          <FilterSelect name="sampai" value={to} label="Sampai periode" options={periods} />
        </FilterForm>
      </SectionCard>
      {ledger ? (
        <SectionCard title={`${ledger.account.code} ${ledger.account.name}`} description={`Saldo awal ${formatRupiah(ledger.opening)} · saldo akhir ${formatRupiah(ledger.closing)}`} flush>
          {ledger.lines.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="tabel-buku-besar">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Jurnal</TableHead>
                    <TableHead>Keterangan</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead>Pusat laba</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Kredit</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={7} className="text-sm text-muted-foreground">
                      {ledger.page.offset > 0 ? `Saldo sebelum baris ${shownFrom.toLocaleString("id-ID")}` : "Saldo awal"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={ledger.pageOpening} />
                    </TableCell>
                  </TableRow>
                  {ledger.lines.map((l, i) => (
                    <TableRow key={`${l.journalId}-${i}`}>
                      <TableCell className="text-sm">{formatTanggal(l.date, { weekday: false })}</TableCell>
                      <TableCell>
                        <JournalLink id={l.journalId} number={l.number} />
                      </TableCell>
                      <TableCell className="max-w-80 text-sm">
                        {l.description}
                        {l.memo ? <span className="block text-xs text-muted-foreground">{l.memo}</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.sourceObjectType && l.sourceObjectId ? (
                          <Link href={`/akuntansi/jurnal?sumberTipe=${l.sourceObjectType}&sumberId=${l.sourceObjectId}`} className="text-primary hover:underline">
                            {l.sourceLabel}
                          </Link>
                        ) : (
                          (l.sourceLabel ?? "—")
                        )}
                      </TableCell>
                      <TableCell>{l.profitCenter}</TableCell>
                      <TableCell className="text-right">
                        <Amount value={l.debit} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount value={l.credit} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount value={l.balance} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={5}>{lastPage > 1 ? "Mutasi seluruh rentang" : "Mutasi"}</TableCell>
                    <TableCell className="text-right">{formatRupiah(ledger.debit)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(ledger.credit)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatRupiah(ledger.closing)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
              {lastPage > 1 ? (
                <nav className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm" aria-label="Halaman buku besar" data-testid="halaman-buku-besar">
                  <span className="text-muted-foreground">
                    Menampilkan baris {shownFrom.toLocaleString("id-ID")}–{shownTo.toLocaleString("id-ID")} dari {ledger.page.total.toLocaleString("id-ID")} · halaman {currentPage} dari {lastPage}
                  </span>
                  <span className="flex gap-2">
                    {currentPage > 1 ? (
                      <Link href={pageHref(currentPage - 1)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-accent">
                        Sebelumnya
                      </Link>
                    ) : null}
                    {currentPage < lastPage ? (
                      <Link href={pageHref(currentPage + 1)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-accent">
                        Berikutnya
                      </Link>
                    ) : null}
                  </span>
                </nav>
              ) : null}
            </div>
          ) : (
            <EmptyState title="Tidak ada mutasi pada rentang ini" compact />
          )}
        </SectionCard>
      ) : (
        <EmptyState title="Pilih akun" description="Buku besar ditampilkan per akun, dapat disaring per pusat laba." />
      )}
    </div>
  );
}
