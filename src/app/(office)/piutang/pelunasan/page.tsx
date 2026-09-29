import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { AdvanceBadge, FilterDate, FilterForm, FilterSelect, FormInput, FormSelect, FormTextarea, PiiExportForm, hrefWith } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, isEnumValue, label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { applyAdvanceAction, reclassifyTripCashAction, recordPaymentAction, requestRefundAction } from "../actions";

export const metadata: Metadata = { title: "Pelunasan piutang" };

type Search = { pelanggan?: string; dari?: string; sampai?: string; kanal?: string };

/**
 * Pelunasan (US-M5-02): catat pelunasan kantor (tunai kantor → kas kantor M4; transfer + bukti → pencocokan M4),
 * alokasi bawaan tertua dulu (dapat diubah per faktur), kelebihan → uang muka; pelunasan lewat sopir masuk otomatis
 * (hanya dilihat); uang muka dialokasikan/dikembalikan (persetujuan pemilik); reklasifikasi tunai rit (7.5.6).
 */
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m5.customer_payment.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const customerId = sp.pelanggan || null;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : null;
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : null;
  const channel = sp.kanal && isEnumValue("payment_channel", sp.kanal) ? (sp.kanal as EnumValue<"payment_channel">) : null;
  const canCreate = can(ctx, "m5.customer_payment.create");
  const canReallocate = can(ctx, "m5.customer_payment.reallocate");
  const canRefund = can(ctx, "m5.customer_advance.refund_request");
  const canInvoices = can(ctx, "m5.invoice.read");
  const [customers, withOpen, payments, advances, openInvoices, candidates] = await Promise.all([
    m5.customerOptions(ctx),
    m5.customerOptions(ctx, { withOpenOnly: true }),
    m5.listPayments(ctx, { customerId, from, to, channel, limit: 100 }),
    m5.listAdvances(ctx, { customerId, openOnly: true }),
    canInvoices ? m5.listInvoices(ctx, { status: "unpaid", customerId, limit: 1000 }) : Promise.resolve([]),
    canReallocate ? m5.reclassCandidates(ctx, { customerId }) : Promise.resolve([]),
  ]);
  const openIds = new Set(withOpen.map((c) => c.id));
  const selected = customerId ? customers.find((c) => c.id === customerId) ?? null : null;
  const selectedInvoices = selected ? openInvoices.filter((i) => i.customerId === selected.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)) : [];
  const selectedOutstanding = selectedInvoices.reduce((s, i) => s + i.outstandingAmount, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pelunasan"
        description="Pelunasan kantor dicatat Admin Keuangan; pelunasan lewat sopir masuk otomatis dari aplikasi sopir beserta alokasinya (tidak dicatat ulang)."
      />

      <FilterForm action="/piutang/pelunasan" testId="pilih-pelanggan">
        <FilterSelect
          name="pelanggan"
          value={customerId}
          label="Pelanggan"
          emptyLabel="Semua pelanggan"
          options={customers.map((c) => ({ value: c.id, label: `${c.name}${c.code ? ` (${c.code})` : ""}${openIds.has(c.id) ? " • ada faktur terbuka" : ""}` }))}
        />
        <FilterDate name="dari" value={from} label="Dari" />
        <FilterDate name="sampai" value={to} label="Sampai" />
        <FilterSelect name="kanal" value={channel} label="Kanal" emptyLabel="Semua kanal" options={enumOptions("payment_channel")} />
      </FilterForm>

      {canCreate ? (
        <SectionCard
          title={selected ? `Catat pelunasan kantor — ${selected.name}` : "Catat pelunasan kantor"}
          description={
            selected
              ? `Sisa faktur terbuka ${formatRupiah(selectedOutstanding)}. Kosongkan alokasi agar dialokasikan otomatis ke faktur tertua; kelebihan bayar menjadi uang muka pelanggan.`
              : "Pilih pelanggan di atas untuk melihat faktur terbuka dan mengisi alokasi per faktur."
          }
        >
          {selected ? (
            <M5ActionForm action={recordPaymentAction} submitLabel="Simpan pelunasan" testId="form-pelunasan" className="max-w-3xl">
              <input type="hidden" name="customerId" value={selected.id} />
              <div className="grid gap-3 sm:grid-cols-3">
                <FormInput label="Tanggal" name="businessDate" type="date" defaultValue={today} max={today} required />
                <FormInput label="Jumlah (Rp)" name="amount" inputMode="numeric" required />
                <FormSelect
                  label="Cara bayar"
                  name="method"
                  defaultValue="transfer"
                  options={[
                    { value: "transfer", label: "Transfer bank" },
                    { value: "cash", label: "Tunai kantor" },
                  ]}
                />
              </div>
              <FormInput label="Bukti transfer" name="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hint="Wajib untuk transfer (JPEG/PNG/PDF, maks. 4 MB; foto dikompres otomatis)." />
              {selectedInvoices.length ? (
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">Alokasi per faktur (opsional; bawaan tertua dulu)</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {selectedInvoices.map((i) => (
                      <FormInput
                        key={i.id}
                        label={`${i.number} — jatuh tempo ${formatTanggal(i.dueDate, { weekday: false })}, sisa ${formatRupiah(i.outstandingAmount)}${i.disputeStatus === "disputed" ? " (bersengketa)" : ""}`}
                        name={`alloc_${i.id}`}
                        inputMode="numeric"
                      />
                    ))}
                  </div>
                </fieldset>
              ) : (
                <p className="text-sm text-muted-foreground">Pelanggan ini tidak punya faktur terbuka — seluruh pelunasan menjadi uang muka.</p>
              )}
              <FormTextarea label="Catatan" name="notes" hint="Mis. nomor referensi transfer / keterangan dari pelanggan." />
            </M5ActionForm>
          ) : (
            <EmptyState title="Pilih pelanggan terlebih dahulu" compact />
          )}
        </SectionCard>
      ) : null}

      <SectionCard
        title="Riwayat pelunasan"
        actions={<PiiExportForm reportKey="m5.payments" filters={{ customerId: customerId ?? undefined, from: from ?? undefined, to: to ?? undefined, channel: channel ?? undefined }} testId="ekspor-pelunasan" />}
        flush
      >
        {payments.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-pelunasan">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Kanal · cara</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Faktur</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id} className="align-top">
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/piutang/pelunasan/${p.id}`} className="font-medium text-primary hover:underline">
                        {formatTanggal(p.businessDate, { weekday: false })}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{p.customerName}</TableCell>
                    <TableCell className="text-sm">
                      {label("payment_channel", p.channel)} · {label("payment_method", p.method)}
                    </TableCell>
                    <TableCell className={`text-right ${p.amount < 0 ? "text-destructive" : ""}`}>
                      {formatRupiah(p.amount)}
                      {p.advanceAmount > 0 ? <span className="block text-xs text-muted-foreground">uang muka {formatRupiah(p.advanceAmount)}</span> : null}
                    </TableCell>
                    <TableCell className="text-xs">{p.allocations.map((a) => `${a.number} (${formatRupiah(a.amount)})`).join(", ") || "—"}</TableCell>
                    <TableCell>
                      {p.reversalOfId ? <ToneBadge tone="muted">Pembalik</ToneBadge> : p.reversed ? <ToneBadge tone="muted">Sudah dibalik</ToneBadge> : <ToneBadge tone="success">Berlaku</ToneBadge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada pelunasan untuk saringan ini" compact />
        )}
      </SectionCard>

      <section id="uang-muka">
        <SectionCard
          title="Uang muka pelanggan tersedia"
          description="Kelebihan bayar dialokasikan otomatis ke faktur berikutnya; pengembalian ke pelanggan hanya dengan persetujuan pemilik."
          actions={<ExportButtons excelHref={hrefWith("/api/export/m5.advances", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.advances", { format: "pdf" })} disabled={!advances.length} />}
          flush
        >
          {advances.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="daftar-uang-muka">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Sisa</TableHead>
                    <TableHead>Status</TableHead>
                    {canReallocate || canRefund ? <TableHead>Tindakan</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {advances.map((a) => {
                    const invs = openInvoices.filter((i) => i.customerId === a.customerId && i.disputeStatus !== "disputed");
                    return (
                      <TableRow key={a.id} className="align-top">
                        <TableCell className="text-sm">
                          {a.customerName}
                          <span className="block text-xs text-muted-foreground">{a.notes}</span>
                        </TableCell>
                        <TableCell className="text-right">{formatRupiah(a.remainingAmount)}</TableCell>
                        <TableCell>
                          <AdvanceBadge status={a.status} />
                          {a.refundPending ? <span className="block text-xs text-warning-foreground">Pengembalian menunggu pemilik</span> : null}
                        </TableCell>
                        {canReallocate || canRefund ? (
                          <TableCell className="min-w-64">
                            {canReallocate && invs.length && !a.refundPending ? (
                              <details>
                                <summary className="cursor-pointer text-sm font-medium text-primary">Alokasikan ke faktur</summary>
                                <M5ActionForm action={applyAdvanceAction.bind(null, a.id)} submitLabel="Alokasikan" className="mt-2">
                                  <FormSelect label="Faktur" name="invoiceId" required emptyLabel="— pilih faktur —" options={invs.map((i) => ({ value: i.id, label: `${i.number} (sisa ${formatRupiah(i.outstandingAmount)})` }))} />
                                  <FormInput label="Jumlah (kosong = semaksimal mungkin)" name="amount" inputMode="numeric" />
                                </M5ActionForm>
                              </details>
                            ) : null}
                            {canRefund && !a.refundPending ? (
                              <details>
                                <summary className="cursor-pointer text-sm font-medium text-primary">Ajukan pengembalian</summary>
                                <M5ActionForm action={requestRefundAction.bind(null, a.id)} submitLabel="Ajukan ke pemilik" variant="outline" className="mt-2">
                                  <FormInput label="Jumlah (Rp)" name="amount" inputMode="numeric" defaultValue={a.remainingAmount} required />
                                  <FormSelect
                                    label="Cara pengembalian"
                                    name="method"
                                    options={[
                                      { value: "transfer", label: "Transfer bank" },
                                      { value: "cash", label: "Tunai kantor" },
                                    ]}
                                  />
                                  <FormTextarea label="Alasan" name="reason" required />
                                </M5ActionForm>
                              </details>
                            ) : null}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada uang muka tersedia" compact />
          )}
        </SectionCard>
      </section>

      {canReallocate ? (
        <SectionCard
          title="Tunai rit yang sebenarnya pelunasan (7.5.6)"
          description="Pelanggan membayar faktur lama lewat sopir tetapi tercatat sebagai tunai rit: rit menjadi faktur kirim dan uangnya menjadi pelunasan faktur lama. Kas tidak berubah; di atas batas koreksi (PAR-21) perlu persetujuan pemilik."
          flush
        >
          {candidates.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="kandidat-reklasifikasi">
                <TableHeader>
                  <TableRow>
                    <TableHead>Rit</TableHead>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Tunai rit</TableHead>
                    <TableHead className="text-right">Faktur terbuka</TableHead>
                    <TableHead>Reklasifikasi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.map((c) => (
                    <TableRow key={c.tripPaymentId} className="align-top">
                      <TableCell>
                        <span className="font-medium">{c.tripNumber}</span>
                        <span className="block text-xs text-muted-foreground">{formatTanggal(c.businessDate, { weekday: false })}</span>
                      </TableCell>
                      <TableCell className="text-sm">{c.customerName}</TableCell>
                      <TableCell className="text-right">{formatRupiah(c.amount)}</TableCell>
                      <TableCell className="text-right">{formatRupiah(c.otherOutstanding)}</TableCell>
                      <TableCell className="min-w-64">
                        <details>
                          <summary className="cursor-pointer text-sm font-medium text-primary">Alihkan menjadi pelunasan</summary>
                          <M5ActionForm action={reclassifyTripCashAction} submitLabel="Alihkan" className="mt-2">
                            <input type="hidden" name="tripId" value={c.tripId} />
                            <FormInput label="Jumlah (Rp)" name="amount" inputMode="numeric" defaultValue={c.amount} />
                            <FormTextarea label="Alasan" name="reason" required />
                          </M5ActionForm>
                        </details>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada tunai rit yang dapat dialihkan" description="Hanya pembayaran rit tunai pelanggan yang masih memiliki faktur terbuka." compact />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
