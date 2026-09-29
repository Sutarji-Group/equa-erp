import type { Metadata } from "next";
import Link from "next/link";

import { Amount, FilterForm, FilterSelect, StatementStatusBadge, exportHref, hrefWith, periodLabel, periodOptions } from "@/components/m11-accounting/ui";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label, type ProfitCenter } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam, monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import * as m11 from "@/server/modules/m11-accounting";

export const metadata: Metadata = { title: "Laporan keuangan" };

type Search = Promise<{ periode?: string; dasar?: string; tab?: string }>;

const CENTERS: ProfitCenter[] = ["L1", "L2", "L3", "L4", "L5", "SHARED"];
const TABS = [
  { key: "laba-rugi", label: "Laba rugi per lini" },
  { key: "neraca-saldo", label: "Neraca saldo" },
  { key: "neraca", label: "Neraca" },
  { key: "arus-kas", label: "Arus kas" },
  { key: "biaya-ti", label: "Biaya komunikasi & cloud" },
] as const;

/**
 * Laporan keuangan (US-M11-04): neraca saldo, laba rugi per lini L1–L5 (alokasi L1 & biaya bersama terpisah) dan
 * konsolidasi (eliminasi transfer internal), neraca, arus kas metode langsung — per periode & kumulatif tahun berjalan.
 * "Sementara" pada periode terbuka, "Final" setelah dikunci (versi tersimpan identik).
 */
export default async function StatementsPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.financial_report.read");
  const sp = await searchParams;
  const current = monthOf(ctxBusinessDate(ctx));
  const period = sp.periode || current;
  const basis = sp.dasar === "ytd" ? "ytd" : "period";
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "laba-rugi";
  const s = await m11.getStatements(ctx, { period, basis });
  const f = { period, basis };
  const reportKey = { "laba-rugi": "m11.profit_loss", "neraca-saldo": "m11.trial_balance", neraca: "m11.balance_sheet", "arus-kas": "m11.cash_flow", "biaya-ti": "m11.it_costs" }[tab];
  const itCosts = tab === "biaya-ti" ? await m11.itCostReport(ctx, { period }) : null;
  const pl = s.profitLoss;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Laporan keuangan"
        meta={<StatementStatusBadge status={s.status} revision={s.revision} retroactive={s.retroactive} />}
        description={`${periodLabel(period)} · ${basis === "ytd" ? "kumulatif tahun berjalan" : "per periode"} · dihitung ${formatTanggalJam(new Date(s.generatedAt))}. Setiap angka dapat diturunkan ke buku besar, jurnal, dan transaksi sumber.`}
        actions={<ExportButtons excelHref={exportHref(reportKey, "xlsx", f)} pdfHref={exportHref(reportKey, "pdf", f)} />}
      />
      <SectionCard>
        <FilterForm action="/akuntansi/laporan" testId="filter-laporan">
          <input type="hidden" name="tab" value={tab} />
          <FilterSelect name="periode" value={period} label="Periode" options={periodOptions(current, 24)} />
          <FilterSelect
            name="dasar"
            value={basis}
            label="Dasar"
            options={[
              { value: "period", label: "Per periode" },
              { value: "ytd", label: "Kumulatif tahun berjalan" },
            ]}
          />
        </FilterForm>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Pendapatan konsolidasi" value={<MoneyText value={pl.consolidated.revenue} />} hint={`Eliminasi transfer internal ${formatRupiah(pl.consolidated.eliminatedRevenue)}`} />
        <KpiTile label="Laba (rugi) konsolidasi" value={<MoneyText value={pl.consolidated.net} />} tone={pl.consolidated.net < 0 ? "danger" : "success"} />
        <KpiTile label="Neraca saldo" value={s.trialBalance.balanced ? "Seimbang" : "TIDAK seimbang"} tone={s.trialBalance.balanced ? "success" : "danger"} />
        <KpiTile label="Kas & bank akhir" value={<MoneyText value={s.cashFlow.closingCash} />} hint={`Awal ${formatRupiah(s.cashFlow.openingCash)}`} />
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Jenis laporan">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={hrefWith("/akuntansi/laporan", { tab: t.key, periode: period, dasar: basis === "ytd" ? "ytd" : null })}
            className={`rounded-md border px-3 py-1.5 text-sm ${tab === t.key ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"}`}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "laba-rugi" ? (
        <SectionCard title="Laba rugi per lini & konsolidasi" description="Alokasi biaya L1 (volume pengisian, PAR-65) dan biaya bersama (kunci pemilik) tampil terpisah; transfer internal dieliminasi pada konsolidasi." flush>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-laba-rugi">
              <TableHeader>
                <TableRow>
                  <TableHead>Akun</TableHead>
                  {CENTERS.map((c) => (
                    <TableHead key={c} className="text-right">
                      {c === "SHARED" ? "Bersama" : c}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Eliminasi</TableHead>
                  <TableHead className="text-right">Konsolidasi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pl.rows.map((r) => (
                  <TableRow key={r.accountId}>
                    <TableCell className="text-sm">
                      <Link href={`/akuntansi/buku-besar?akun=${r.accountId}&dari=${basis === "ytd" ? `${period.slice(0, 4)}-01` : period}&sampai=${period}`} className="font-mono text-primary hover:underline">
                        {r.code}
                      </Link>{" "}
                      {r.name}
                      <span className="block text-xs text-muted-foreground">{r.section}</span>
                    </TableCell>
                    {CENTERS.map((c) => (
                      <TableCell key={c} className="text-right">
                        <Amount value={r.kind === "expense" ? -r.byCenter[c] : r.byCenter[c]} />
                      </TableCell>
                    ))}
                    <TableCell className="text-right">
                      <Amount value={r.kind === "expense" ? -r.elimination : r.elimination} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.kind === "expense" ? -r.consolidated : r.consolidated} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Laba sebelum alokasi</TableCell>
                  {CENTERS.map((c) => (
                    <TableCell key={c} className="text-right">
                      <Amount value={pl.centers[c].beforeAllocation} />
                    </TableCell>
                  ))}
                  <TableCell />
                  <TableCell />
                </TableRow>
                <TableRow>
                  <TableCell>Alokasi L1</TableCell>
                  {CENTERS.map((c) => (
                    <TableCell key={c} className="text-right">
                      <Amount value={pl.centers[c].allocationL1} />
                    </TableCell>
                  ))}
                  <TableCell />
                  <TableCell />
                </TableRow>
                <TableRow>
                  <TableCell>Alokasi biaya bersama</TableCell>
                  {CENTERS.map((c) => (
                    <TableCell key={c} className="text-right">
                      <Amount value={pl.centers[c].allocationShared} />
                    </TableCell>
                  ))}
                  <TableCell />
                  <TableCell />
                </TableRow>
                {pl.consolidated.markupRealized || pl.consolidated.markupUnrealized ? (
                  <TableRow data-testid="eliminasi-markup">
                    <TableCell>
                      Eliminasi markup harga mitra (transfer toko → depot)
                      <span className="block text-xs text-muted-foreground">Masih di persediaan depot: {formatRupiah(pl.consolidated.markupUnrealized)} (dieliminasi di neraca)</span>
                    </TableCell>
                    {CENTERS.map((c) => (
                      <TableCell key={c} />
                    ))}
                    <TableCell />
                    <TableCell className="text-right">
                      <Amount value={pl.consolidated.markupRealized} />
                    </TableCell>
                  </TableRow>
                ) : null}
                <TableRow>
                  <TableCell className="font-semibold">Laba (rugi) bersih</TableCell>
                  {CENTERS.map((c) => (
                    <TableCell key={c} className="text-right">
                      <Amount value={pl.centers[c].net} strong />
                    </TableCell>
                  ))}
                  <TableCell />
                  <TableCell className="text-right">
                    <Amount value={pl.consolidated.net} strong />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {tab === "neraca-saldo" ? (
        <SectionCard title="Neraca saldo" description={s.trialBalance.balanced ? "Debit = kredit." : "Debit ≠ kredit — periksa jurnal."} flush>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-neraca-saldo">
              <TableHeader>
                <TableRow>
                  <TableHead>Akun</TableHead>
                  <TableHead className="text-right">Saldo awal D</TableHead>
                  <TableHead className="text-right">Saldo awal K</TableHead>
                  <TableHead className="text-right">Mutasi D</TableHead>
                  <TableHead className="text-right">Mutasi K</TableHead>
                  <TableHead className="text-right">Saldo akhir D</TableHead>
                  <TableHead className="text-right">Saldo akhir K</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.trialBalance.rows.map((r) => (
                  <TableRow key={r.accountId}>
                    <TableCell className="text-sm">
                      <span className="font-mono">{r.code}</span> {r.name}
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.openingDebit} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.openingCredit} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.debit} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.credit} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.closingDebit} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.closingCredit} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Jumlah</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right">{formatRupiah(s.trialBalance.totals.debit)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(s.trialBalance.totals.credit)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(s.trialBalance.totals.closingDebit)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(s.trialBalance.totals.closingCredit)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {tab === "neraca" ? (
        <div className="grid gap-6 lg:grid-cols-2" data-testid="neraca">
          {(["asset", "liability", "equity"] as const).map((section) => (
            <SectionCard key={section} title={label("account_type", section)} flush className={section === "asset" ? "lg:row-span-2" : undefined}>
              <Table>
                <TableBody>
                  {s.balanceSheet.rows
                    .filter((r) => r.section === section)
                    .map((r) => (
                      <TableRow key={`${r.code}-${r.name}`}>
                        <TableCell className="text-sm">
                          <span className="font-mono">{r.code}</span> {r.name}
                        </TableCell>
                        <TableCell className="text-right">
                          <Amount value={r.amount} />
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Jumlah {label("account_type", section).toLowerCase()}</TableCell>
                    <TableCell className="text-right font-semibold">{formatRupiah(section === "asset" ? s.balanceSheet.assets : section === "liability" ? s.balanceSheet.liabilities : s.balanceSheet.equity)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </SectionCard>
          ))}
          <p className="text-sm text-muted-foreground lg:col-span-2">{s.balanceSheet.balanced ? "Aset = liabilitas + ekuitas." : "Neraca TIDAK seimbang — periksa saldo awal dan jurnal."}</p>
        </div>
      ) : null}

      {tab === "arus-kas" ? (
        <SectionCard title="Arus kas — metode langsung" description="Dari mutasi akun kas & bank, dikelompokkan menurut akun lawan (PTB-45)." flush>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-arus-kas">
              <TableHeader>
                <TableRow>
                  <TableHead>Kelompok</TableHead>
                  <TableHead className="text-right">Masuk</TableHead>
                  <TableHead className="text-right">Keluar</TableHead>
                  <TableHead className="text-right">Bersih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.cashFlow.categories.map((c) => (
                  <TableRow key={c.key}>
                    <TableCell>{c.label}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={c.inflow} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={c.outflow} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={c.net} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Kas & bank awal</TableCell>
                  <TableCell colSpan={3} className="text-right">
                    {formatRupiah(s.cashFlow.openingCash)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Kenaikan (penurunan) — operasi {formatRupiah(s.cashFlow.operating)}, investasi {formatRupiah(s.cashFlow.investing)}, pendanaan {formatRupiah(s.cashFlow.financing)}</TableCell>
                  <TableCell colSpan={3} className="text-right">
                    {formatRupiah(s.cashFlow.netChange)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-semibold">Kas & bank akhir</TableCell>
                  <TableCell colSpan={3} className="text-right font-semibold">
                    {formatRupiah(s.cashFlow.closingCash)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </SectionCard>
      ) : null}

      {itCosts ? (
        <SectionCard
          title="Biaya komunikasi, cloud & WhatsApp (NFR-29)"
          description={`Beban terjurnal pada akun ${itCosts.accountCodes.join(", ")} (langganan cloud, peta, GPS, aplikasi — jurnal manual bulanan) dibandingkan anggaran, dan pemakaian WhatsApp Business API dari catatan per pesan tertagih.`}
          flush
        >
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <KpiTile label="Beban terjurnal" value={<MoneyText value={itCosts.journaledTotal} />} />
            <KpiTile label="Pemakaian WhatsApp" value={<MoneyText value={itCosts.whatsapp.totalCost} />} hint={`${itCosts.whatsapp.billableMessages.toLocaleString("id-ID")} pesan tertagih`} />
            <KpiTile
              label="Anggaran bulanan"
              value={itCosts.budget > 0 ? <MoneyText value={itCosts.budget} /> : "Belum ditetapkan"}
              hint={itCosts.budgetUsedPct !== null ? `Terpakai ${itCosts.budgetUsedPct.toLocaleString("id-ID")}%` : "Atur di parameter m11.it_cost_report"}
              tone={itCosts.overBudget ? "danger" : itCosts.budget > 0 ? "success" : "neutral"}
            />
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-biaya-ti">
              <TableHeader>
                <TableRow>
                  <TableHead>Kelompok</TableHead>
                  <TableHead>Rincian</TableHead>
                  <TableHead className="text-right">Pesan</TableHead>
                  <TableHead className="text-right">Biaya</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itCosts.journaled.map((j) => (
                  <TableRow key={j.accountId}>
                    <TableCell className="text-sm">Terjurnal</TableCell>
                    <TableCell className="text-sm">
                      <Link href={hrefWith("/akuntansi/buku-besar", { akun: j.accountId, dari: period, sampai: period })} className="text-primary hover:underline">
                        {j.code} {j.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">—</TableCell>
                    <TableCell className="text-right">
                      <Amount value={j.amount} />
                    </TableCell>
                  </TableRow>
                ))}
                {itCosts.whatsapp.byCategory.map((c) => (
                  <TableRow key={c.category}>
                    <TableCell className="text-sm">WhatsApp Business API</TableCell>
                    <TableCell className="text-sm">Kategori {c.category}</TableCell>
                    <TableCell className="text-right">{c.count.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={c.amount} />
                    </TableCell>
                  </TableRow>
                ))}
                {!itCosts.journaled.length && !itCosts.whatsapp.byCategory.length ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      Belum ada biaya komunikasi/cloud terjurnal maupun pesan WhatsApp tertagih pada periode ini.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
