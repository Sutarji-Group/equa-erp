import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { DateInput, FormInput, FormSelect, FormTextarea, hrefWith, SelectInput, StoreFilter } from "@/components/m7-store/office";
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
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { reversePaymentAction, supplierPaymentAction } from "../actions";

export const metadata: Metadata = { title: "Utang pemasok" };

const BUCKETS = ["not_due", "d1_7", "d8_30", "over_30"] as const;

/**
 * Utang pemasok (US-M7-08): per pemasok & umur utang, jatuh tempo per nota; pembayaran Admin Keuangan (kas kantor /
 * transfer + bukti) dialokasikan ke nota; pembalik pembayaran keliru beralasan.
 */
export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ pemasok?: string; per?: string }> }) {
  const { ctx } = await requirePermission("m7.supplier_payable.read");
  const sp = await searchParams;
  const supplierId = sp.pemasok ?? null;
  const data = await m7.listPayables(ctx, { supplierId, asOf: sp.per ?? null });
  const all = supplierId ? await m7.listPayables(ctx, { asOf: sp.per ?? null }) : data;
  const suppliers = await m7.listSuppliers(ctx, { includeInactive: true });
  const payments = await m7.listSupplierPayments(ctx, { supplierId, limit: 50 });
  const canPay = can(ctx, "m7.supplier_payment.create");
  const canReverse = can(ctx, "m7.supplier_payment.reverse");
  const today = ctxBusinessDate(ctx);
  const selected = supplierId ? suppliers.find((s) => s.id === supplierId) : null;
  const overdue = all.rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s + r.outstanding, 0);
  const dueSoon = all.rows.filter((r) => r.dueDate && r.daysOverdue === 0 && r.dueDate <= today).reduce((s, r) => s + r.outstanding, 0);
  const exportQuery = { supplierId, asOf: data.asOf };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Utang pemasok"
        description={`Posisi per ${formatTanggal(data.asOf)}. Pengingat jatuh tempo dikirim ke Admin Keuangan beberapa hari sebelumnya.`}
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m7.payables_aging", { format: "xlsx", ...exportQuery })}
            pdfHref={hrefWith("/api/export/m7.payables_aging", { format: "pdf", ...exportQuery })}
            disabled={!data.rows.length}
          />
        }
      />
      <StoreFilter action="/toko/utang" stores={[]} storeId={null}>
        <SelectInput name="pemasok" value={supplierId} label="Pemasok" emptyLabel="Semua pemasok" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <DateInput name="per" value={data.asOf} label="Posisi per" />
      </StoreFilter>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Total utang" value={<MoneyText value={all.total} />} hint={`${all.rows.length} nota terbuka`} />
        <KpiTile label="Lewat jatuh tempo" value={<MoneyText value={overdue} />} tone={overdue ? "danger" : undefined} />
        <KpiTile label="Jatuh tempo hari ini" value={<MoneyText value={dueSoon} />} tone={dueSoon ? "warning" : undefined} />
      </div>
      <SectionCard title="Umur utang per pemasok" flush>
        {all.bySupplier.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="umur-utang">
              <TableHeader>
                <TableRow>
                  <TableHead>Pemasok</TableHead>
                  {BUCKETS.map((b) => (
                    <TableHead key={b} className="text-right">
                      {m7.AGING_LABELS[b]}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                  {canPay ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {all.bySupplier.map((s) => (
                  <TableRow key={s.supplierId} data-state={s.supplierId === supplierId ? "selected" : undefined}>
                    <TableCell>
                      <Link href={hrefWith("/toko/utang", { pemasok: s.supplierId })} className="font-medium text-primary hover:underline">
                        {s.supplierName}
                      </Link>
                    </TableCell>
                    {BUCKETS.map((b) => (
                      <TableCell key={b} className={`text-right ${b !== "not_due" && s[b] ? "text-destructive" : ""}`}>
                        {s[b] ? formatRupiah(s[b]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="text-right font-medium">{formatRupiah(s.total)}</TableCell>
                    {canPay ? (
                      <TableCell>
                        <Link href={hrefWith("/toko/utang", { pemasok: s.supplierId })} className="text-sm font-medium text-primary hover:underline">
                          Bayar
                        </Link>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada utang terbuka" compact />
        )}
      </SectionCard>
      <SectionCard title={selected ? `Nota terbuka — ${selected.name}` : "Nota terbuka"} flush>
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="nota-utang">
              <TableHeader>
                <TableRow>
                  <TableHead>Nota</TableHead>
                  <TableHead>Pemasok</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Dibayar</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Umur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.receiptId}>
                    <TableCell>
                      <Link href={`/toko/pembelian/${r.receiptId}`} className="font-medium text-primary hover:underline">
                        {r.supplierNoteNumber ?? r.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {r.number}
                        {r.isOpeningPayable ? " · saldo awal" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{r.supplierName}</TableCell>
                    <TableCell>{r.dueDate ? formatTanggal(r.dueDate) : "—"}</TableCell>
                    <TableCell className="text-right">{formatRupiah(r.total)}</TableCell>
                    <TableCell className="text-right">{r.paid ? formatRupiah(r.paid) : "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(r.outstanding)}</TableCell>
                    <TableCell>
                      <ToneBadge tone={r.bucket === "not_due" ? "success" : r.bucket === "d1_7" ? "warning" : "danger"}>{r.bucketLabel}</ToneBadge>
                      {r.daysOverdue ? <span className="block text-xs text-destructive">{r.daysOverdue} hari lewat</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada nota terbuka" compact />
        )}
      </SectionCard>
      {canPay ? (
        <SectionCard
          title="Catat pembayaran pemasok"
          description={
            selected
              ? "Isi alokasi per nota, atau kosongkan agar dialokasikan otomatis ke nota jatuh tempo paling awal. Transfer wajib melampirkan bukti."
              : "Pilih pemasok di tabel umur utang untuk mengisi alokasi per nota; tanpa alokasi, pembayaran otomatis ke nota tertua."
          }
        >
          <OutletActionForm action={supplierPaymentAction} submitLabel="Simpan pembayaran" testId="form-bayar-pemasok" className="max-w-2xl">
            {selected ? (
              <input type="hidden" name="supplierId" value={selected.id} />
            ) : (
              <FormSelect label="Pemasok" name="supplierId" required emptyLabel="— pilih pemasok —" options={all.bySupplier.map((s) => ({ value: s.supplierId, label: `${s.supplierName} (${formatRupiah(s.total)})` }))} />
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <FormInput label="Jumlah bayar (Rp)" name="amount" inputMode="numeric" required />
              <FormSelect
                label="Cara bayar"
                name="method"
                defaultValue="transfer"
                options={[
                  { value: "transfer", label: "Transfer bank" },
                  { value: "cash", label: "Kas kantor" },
                ]}
              />
              <FormInput label="Tanggal bayar" name="businessDate" type="date" defaultValue={today} max={today} />
            </div>
            <FormInput label="Bukti transfer" name="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hint="Wajib untuk transfer." />
            {selected && data.rows.length ? (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Alokasi per nota (opsional; jumlahnya harus sama dengan jumlah bayar)</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {data.rows.map((r) => (
                    <FormInput key={r.receiptId} label={`${r.supplierNoteNumber ?? r.number} — sisa ${formatRupiah(r.outstanding)}`} name={`alloc_${r.receiptId}`} inputMode="numeric" />
                  ))}
                </div>
              </fieldset>
            ) : null}
            <FormTextarea label="Catatan" name="notes" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
      <SectionCard
        title="Riwayat pembayaran"
        actions={<ExportButtons excelHref={hrefWith("/api/export/m7.supplier_payments", { format: "xlsx", supplierId })} pdfHref={hrefWith("/api/export/m7.supplier_payments", { format: "pdf", supplierId })} disabled={!payments.length} />}
        flush
      >
        {payments.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-bayar">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Pemasok</TableHead>
                  <TableHead>Cara</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead>Nota</TableHead>
                  {canReverse ? <TableHead>Pembalik</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id} className="align-top">
                    <TableCell className="whitespace-nowrap">{formatTanggal(p.businessDate)}</TableCell>
                    <TableCell className="text-sm">
                      {p.supplierName}
                      {p.notes ? <span className="block text-xs text-muted-foreground">{p.notes}</span> : null}
                    </TableCell>
                    <TableCell>{label("payment_method", p.method)}</TableCell>
                    <TableCell className={`text-right ${p.amount < 0 ? "text-destructive" : ""}`}>{formatRupiah(p.amount)}</TableCell>
                    <TableCell className="text-xs">{p.allocations.map((a) => `${a.note ?? "—"} (${formatRupiah(a.amount)})`).join(", ")}</TableCell>
                    {canReverse ? (
                      <TableCell className="min-w-56">
                        {p.reversalOfId ? (
                          <ToneBadge tone="muted">Pembalik</ToneBadge>
                        ) : p.reversed ? (
                          <ToneBadge tone="muted">Sudah dibalik</ToneBadge>
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-sm font-medium text-primary">Balik pembayaran</summary>
                            <OutletActionForm action={reversePaymentAction.bind(null, p.id)} submitLabel="Balik" variant="destructive" className="mt-2">
                              <FormInput label="Alasan" name="reason" required />
                            </OutletActionForm>
                          </details>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada pembayaran" compact />
        )}
      </SectionCard>
    </div>
  );
}
