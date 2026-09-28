import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CashActionButton, CashReasonButton } from "@/components/m4-cash/action-buttons";
import { ContactLinks } from "@/components/m4-cash/fields";
import { ReceiveDepositForm } from "@/components/m4-cash/receive-form";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { normalizeWaNumber } from "@/server/core/wa";
import { requirePermission } from "@/server/core/auth/office";
import { isDomainError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { closeDepositAction, receiveDepositAction, reopenDepositAction, verifyExpenseAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian setoran" };

type Snapshot = {
  transfers?: { tripNumber: string; customerName: string; amount: number }[];
  credit?: { tripNumber: string; customerName: string; amount: number }[];
  underpayments?: { tripNumber: string; customerName: string; amount: number }[];
  note?: string | null;
};

const EXPENSE_TONE = { pending_verification: "warning", accepted: "success", rejected: "danger" } as const;
const EXPENSE_STATUS = { pending_verification: "Menunggu verifikasi", accepted: "Diterima", rejected: "Ditolak" } as const;

/**
 * Rincian setoran (US-M4-02 KP-1..KP-9): ringkasan seharusnya per rit/pelunasan (atau angka shift depot/toko) yang TIDAK
 * dapat diubah, pengeluaran rit menunggu verifikasi (terima/tolak satu per satu, PTB-20), status sinkron perangkat,
 * formulir terima (jumlah fisik + pecahan opsional, selisih dihitung langsung, alasan wajib), tutup, dan buka kembali.
 */
export default async function DepositDetailPage({ params }: PageProps<"/kas/setoran/[id]">) {
  const { ctx } = await requirePermission("m4.deposit.read");
  const { id } = await params;
  let d: m4.DepositDetail;
  try {
    d = await m4.getDepositDetail(ctx, id);
  } catch (error) {
    if (isDomainError(error)) notFound();
    throw error;
  }
  const dep = d.deposit;
  const f = d.figures;
  const snap = (d.snapshot ?? {}) as Snapshot;
  const canReceive = can(ctx, "m4.deposit.receive");
  const canReopen = can(ctx, "m4.deposit.reopen");
  const isDriver = dep.sourceType === "driver";
  const pending = f.expenses.filter((e) => e.status === "pending_verification");
  const wa = d.source.phone ? normalizeWaNumber(d.source.phone) : null;

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={dep.number} />
      <PageHeader
        backHref="/kas/setoran"
        backLabel="Daftar setoran"
        title={<span className="tabular-nums">{dep.number}</span>}
        description={`${d.source.label}${d.source.detail ? ` · ${d.source.detail}` : ""} · ${formatTanggal(dep.businessDate)}`}
        meta={
          <>
            <StatusBadge enumName="deposit_status" value={dep.status} />
            <span>{label("deposit_source_type", dep.sourceType)}</span>
            <span>{label("deposit_method", dep.method)}</span>
            {dep.isPartial ? <ToneBadge tone="info">Setor sebagian</ToneBadge> : null}
            {dep.submittedLate ? <ToneBadge tone="warning">Diajukan terlambat</ToneBadge> : null}
            {dep.receivedLate ? <ToneBadge tone="warning">Diterima terlambat</ToneBadge> : null}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {dep.status === "received" && canReceive ? <CashActionButton label="Tutup setoran" action={closeDepositAction.bind(null, dep.id)} testId="tutup-setoran" /> : null}
            {d.canReopen && canReopen ? (
              <CashReasonButton
                label="Buka kembali"
                title="Buka kembali setoran sopir"
                description="Setoran kembali Berjalan agar sopir dapat melanjutkan rit (mis. rit tambahan). Sopir menekan Setor lagi setelahnya."
                action={reopenDepositAction.bind(null, dep.id)}
              />
            ) : null}
          </div>
        }
      />

      {dep.status === "submitted" && d.blockReason ? (
        <Alert variant={d.sync.fullySynced ? "default" : "destructive"} data-testid="setoran-terhalang">
          <AlertTitle>{d.sync.fullySynced ? "Belum dapat diterima di sini" : "Menunggu sinkron"}</AlertTitle>
          <AlertDescription>{d.blockReason}</AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Penyetor & waktu">
        <KeyValueList
          columns={3}
          items={[
            { label: "Penyetor", value: d.source.label, hint: d.source.detail ?? undefined },
            { label: "Hubungi", value: <ContactLinks phone={d.source.phone} waNumber={wa} /> },
            { label: "Status sinkron perangkat", value: d.sync.fullySynced ? "Semua data tersinkron" : `Menunggu sinkron (${d.sync.missingCount})`, hint: d.sync.fullySynced ? undefined : d.sync.message },
            { label: "Diajukan", value: dep.submittedAt ? formatTanggalJam(dep.submittedAt) : "—", hint: dep.submittedLate ? "Setelah batas tutup kas" : undefined },
            { label: "Diterima", value: dep.receivedAt ? formatTanggalJam(dep.receivedAt) : "—", hint: d.receivedByName ? `oleh ${d.receivedByName}${dep.lateReason ? ` · terlambat: ${dep.lateReason}` : ""}` : undefined },
            { label: "Ditutup", value: dep.closedAt ? formatTanggalJam(dep.closedAt) : "—", hint: d.closedByName ? `oleh ${d.closedByName}` : undefined },
            ...(dep.depositorNote ? [{ label: "Keterangan penyetor", value: dep.depositorNote, full: true }] : []),
            ...(snap.note ? [{ label: "Catatan saat Setor", value: snap.note, full: true }] : []),
          ]}
        />
      </SectionCard>

      {isDriver ? (
        <SectionCard title="Seharusnya per rit & pelunasan tunai" description="Dihitung sistem dari data yang tersinkron — tidak dapat diubah (US-M4-02 KP-1)." flush>
          <div className="overflow-x-auto">
            <Table data-testid="rincian-seharusnya">
              <TableHeader>
                <TableRow>
                  <TableHead>Rincian</TableHead>
                  <TableHead>Tanggal</TableHead>
                  <TableHead className="text-right">Tunai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {f.sameDayItems.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell>{it.label}</TableCell>
                    <TableCell className="text-sm">{formatTanggal(it.businessDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{formatRupiah(it.amount)}</TableCell>
                  </TableRow>
                ))}
                {f.carryOverItems.map((it) => (
                  <TableRow key={it.id} className="bg-warning/10">
                    <TableCell>
                      {it.label}
                      <span className="block text-xs text-muted-foreground">Terlambat sinkron — dibawa ke setoran ini (Bab 5.3)</span>
                    </TableCell>
                    <TableCell className="text-sm">{formatTanggal(it.businessDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{formatRupiah(it.amount)}</TableCell>
                  </TableRow>
                ))}
                {!f.sameDayItems.length && !f.carryOverItems.length ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-sm text-muted-foreground">
                      Tanpa rincian per rit (angka ringkasan saat Setor): {formatRupiah(f.sameDayCash)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">
                    Tunai seharusnya
                  </TableCell>
                  <TableCell className="text-right font-semibold">{formatRupiah(f.expectedCash)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </SectionCard>
      ) : d.shift ? (
        <SectionCard
          title={`Shift ${d.shift.outletCode} — ${d.shift.outletName}`}
          description="Angka tutup shift dari POS (dihitung sistem). Rincian transaksi ada di halaman shift outlet."
          actions={
            <Link href={`/outlet/shift/${d.shift.id}`} className="text-sm font-medium text-primary hover:underline">
              Lihat transaksi shift
            </Link>
          }
        >
          <KeyValueList
            columns={3}
            items={[
              { label: "Dibuka", value: formatTanggalJam(d.shift.openedAt) },
              { label: "Ditutup", value: d.shift.closedAt ? formatTanggalJam(d.shift.closedAt) : "Masih terbuka" },
              { label: "Kas awal tetap", value: formatRupiah(d.shift.openingCashFixed) },
              { label: "Penjualan tunai", value: formatRupiah(d.shift.cashSales ?? 0) },
              { label: "QRIS (transfer masuk terpisah)", value: formatRupiah(d.shift.qrisSales ?? 0) },
              { label: "Tempo", value: formatRupiah(d.shift.creditSales ?? 0) },
              { label: "Void", value: `${d.shift.voidCount ?? 0} transaksi · ${formatRupiah(d.shift.voidAmount ?? 0)}` },
              { label: "Kas di laci seharusnya", value: formatRupiah(d.shift.expectedCash ?? 0) },
              { label: "Hitung fisik tutup shift", value: d.shift.closingCashCounted === null ? "—" : formatRupiah(d.shift.closingCashCounted) },
              {
                label: "Selisih tutup shift",
                value: d.shift.cashDifference ? formatRupiah(d.shift.cashDifference, { signed: true }) : "Tidak ada",
                hint: d.shift.cashDifferenceReason ?? undefined,
              },
              { label: "Setor sebagian (slip)", value: formatRupiah(d.shift.partialDepositTotal) },
              { label: "Seharusnya disetor", value: <strong>{formatRupiah(f.expectedCash)}</strong> },
            ]}
          />
        </SectionCard>
      ) : (
        <SectionCard title="Seharusnya">
          <p className="text-sm">{formatRupiah(f.expectedCash)}</p>
        </SectionCard>
      )}

      {isDriver ? (
        <SectionCard title="Pengeluaran rit" description="Terima atau tolak satu per satu (PTB-20). Pengeluaran dari kas yang diterima mengurangi seharusnya; uang pribadi yang diterima diganti dari kas kantor." flush>
          {f.expenses.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="pengeluaran-rit">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pengeluaran</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                    <TableHead>Sumber dana</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Bukti</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {f.expenses.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        {label("trip_expense_kind", e.kind)}
                        <span className="block text-xs text-muted-foreground">
                          {e.tripNumber ? `Rit ${e.tripNumber} · ` : ""}
                          {formatTanggal(e.businessDate, { weekday: false })}
                          {e.note ? ` · ${e.note}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(e.amount)}</TableCell>
                      <TableCell className="text-sm">{e.fundingSource === "personal" ? "Uang pribadi" : "Kas di tangan"}</TableCell>
                      <TableCell>
                        <ToneBadge tone={EXPENSE_TONE[e.status]}>{EXPENSE_STATUS[e.status]}</ToneBadge>
                        {e.rejectionReason ? <span className="block text-xs text-muted-foreground">{e.rejectionReason}</span> : null}
                        {e.reimbursed ? <span className="block text-xs text-muted-foreground">Diganti kas kantor</span> : null}
                      </TableCell>
                      <TableCell>
                        {e.receiptAttachmentId ? (
                          <a href={`/api/attachments/${e.receiptAttachmentId}`} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                            Foto nota
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {e.status === "pending_verification" && dep.status === "submitted" && canReceive ? (
                          <div className="flex flex-wrap gap-2">
                            <CashActionButton label="Terima" variant="outline" action={verifyExpenseAction.bind(null, dep.id, e.id, true, null)} />
                            <CashReasonButton label="Tolak" title="Tolak pengeluaran rit" description="Alasan penolakan tampil ke sopir; pengeluaran ditolak tidak mengurangi seharusnya." action={verifyExpenseAction.bind(null, dep.id, e.id, false)} destructive />
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada pengeluaran rit" compact />
          )}
        </SectionCard>
      ) : null}

      {isDriver && (snap.transfers?.length || snap.credit?.length || snap.underpayments?.length) ? (
        <SectionCard title="Bukan kas fisik (informasi)" description="Transfer dicocokkan di menu Transfer masuk; tempo & kurang bayar menjadi piutang (M5).">
          <KeyValueList
            columns={3}
            items={[
              { label: `Transfer (${snap.transfers?.length ?? 0})`, value: formatRupiah((snap.transfers ?? []).reduce((s, x) => s + x.amount, 0)) },
              { label: `Tempo (${snap.credit?.length ?? 0})`, value: formatRupiah((snap.credit ?? []).reduce((s, x) => s + x.amount, 0)) },
              { label: `Kurang bayar (${snap.underpayments?.length ?? 0})`, value: formatRupiah((snap.underpayments ?? []).reduce((s, x) => s + x.amount, 0)) },
            ]}
          />
        </SectionCard>
      ) : null}

      {dep.status === "submitted" && canReceive ? (
        <SectionCard title="Terima setoran" description="Masukkan uang fisik yang Anda hitung. Selisih dihitung sistem: diterima − (seharusnya − pengeluaran diterima).">
          {d.canReceive ? (
            <ReceiveDepositForm
              action={receiveDepositAction.bind(null, dep.id)}
              expectedCash={f.expectedCash}
              acceptedCashExpenses={f.acceptedCashExpenses}
              pendingExpenses={pending.map((e) => ({ id: e.id, label: `${label("trip_expense_kind", e.kind)}${e.tripNumber ? ` (${e.tripNumber})` : ""}`, amount: e.amount, fundingSource: e.fundingSource }))}
              late={d.late.afterCutoff}
              cutoff={d.late.cutoff}
              threshold={d.discrepancyThreshold}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{d.blockReason}</p>
          )}
        </SectionCard>
      ) : null}

      {dep.status === "received" || dep.status === "closed" ? (
        <SectionCard title="Hasil penerimaan">
          <KeyValueList
            columns={3}
            items={[
              { label: "Tunai seharusnya", value: formatRupiah(dep.expectedCash + dep.carryOverCash), hint: dep.carryOverCash ? `termasuk ${formatRupiah(dep.carryOverCash)} terlambat sinkron` : undefined },
              { label: "Pengeluaran diterima", value: formatRupiah(dep.acceptedExpenses) },
              { label: "Seharusnya disetor", value: formatRupiah(dep.expectedNet) },
              { label: "Diterima", value: <strong>{formatRupiah(dep.receivedAmount ?? 0)}</strong>, hint: dep.method === "bank_slip" ? "Lewat setor bank (mutasi cocok)" : undefined },
              {
                label: "Selisih",
                value: <span className={dep.discrepancyAmount ? "font-semibold text-destructive" : undefined}>{formatRupiah(dep.discrepancyAmount ?? 0, { signed: true })}</span>,
                hint: dep.discrepancyReason ? `${label("discrepancy_reason", dep.discrepancyReason)}${dep.discrepancyNote ? ` — ${dep.discrepancyNote}` : ""}` : undefined,
              },
              {
                label: "Rincian pecahan",
                value: dep.denominations
                  ? Object.entries(dep.denominations)
                      .sort((a, b) => Number(b[0]) - Number(a[0]))
                      .map(([v, n]) => `${formatRupiah(Number(v))} × ${n}`)
                      .join(", ")
                  : "—",
              },
            ]}
          />
        </SectionCard>
      ) : null}

      {d.discrepancies.length ? (
        <SectionCard title="Selisih" flush>
          <div className="overflow-x-auto">
            <Table data-testid="selisih-setoran">
              <TableHeader>
                <TableRow>
                  <TableHead>Terbentuk</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.discrepancies.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="text-sm">{formatTanggalJam(x.createdAt)}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(x.amount, { signed: true })}</TableCell>
                    <TableCell className="text-sm">{x.reason ? label("discrepancy_reason", x.reason) : "—"}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="discrepancy_status" value={x.status} />
                      {x.requiresOwnerDecision ? <span className="block text-xs text-muted-foreground">Keputusan pemilik</span> : null}
                    </TableCell>
                    <TableCell>
                      <Link href={`/kas/selisih?id=${x.id}`} className="text-sm font-medium text-primary hover:underline">
                        Buka
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
