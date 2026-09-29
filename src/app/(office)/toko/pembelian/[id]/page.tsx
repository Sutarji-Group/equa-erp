import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { FormInput, FormSelect, FormTextarea } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { JournalLink } from "@/components/shared/journal-link";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { acceptSubstituteAction, correctReceiptAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian nota pembelian" };

/**
 * Rincian nota pembelian: baris barang & harga beli, foto nota/barang, pembayaran teralokasi, retur/pembalik (nota
 * pembalik terpisah — nota asli tidak diubah), penerimaan nota pengganti oleh Admin Keuangan.
 */
export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m7.purchase_receipt.read");
  const { id } = await params;
  const d = await m7.getPurchaseReceipt(ctx, id);
  const r = d.receipt;
  const title = r.number ?? r.localNumber ?? "Nota pembelian";
  const canAccept = can(ctx, "m7.purchase_receipt.accept_substitute") && r.status === "pending_acceptance";
  const canCorrect = can(ctx, "m7.purchase_receipt.correct") && !r.reversalOfId && r.status !== "reversed";
  const returnable = new Map<string, number>();
  // Batas atas = jumlah diterima; sisa setelah retur sebelumnya divalidasi layanan.
  for (const l of d.lines) returnable.set(l.productId, (returnable.get(l.productId) ?? 0) + l.quantity);

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={title} />
      <PageHeader
        title={`Nota ${title}`}
        backHref="/toko/pembelian"
        backLabel="Nota pembelian"
        description={`${d.supplier?.name ?? "—"} · ${d.outlet.name} · ${formatTanggal(r.businessDate)}`}
        meta={
          <>
            {r.reversalOfId ? <ToneBadge tone="muted">Nota retur/pembalik</ToneBadge> : <StatusBadge enumName="purchase_receipt_status" value={r.status} />}
            {r.isSubstituteNote ? <ToneBadge tone="warning">Nota pengganti</ToneBadge> : null}
            {r.isOpeningPayable ? <ToneBadge tone="neutral">Saldo awal utang</ToneBadge> : null}
            {!r.reversalOfId && r.status === "received" ? <StatusBadge enumName="payable_status" value={r.paymentStatus} /> : null}
          </>
        }
        actions={<JournalLink ctx={ctx} sourceType="purchase_receipt" sourceId={r.id} />}
      />
      {d.pendingApprovals.length ? (
        <Alert role="status">
          <AlertDescription>
            Koreksi menunggu persetujuan pemilik: {d.pendingApprovals.map((a) => a.reason).join("; ")}.{" "}
            <Link href="/persetujuan" className="font-medium text-primary hover:underline">
              Kotak persetujuan
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {d.original ? (
        <p className="text-sm">
          Koreksi atas nota{" "}
          <Link href={`/toko/pembelian/${d.original.id}`} className="font-medium text-primary hover:underline">
            {d.original.number ?? d.original.supplierNoteNumber}
          </Link>
          {r.reversalReason ? ` — ${r.reversalReason}` : ""}
        </p>
      ) : null}
      <SectionCard title="Ringkasan">
        <KeyValueList
          columns={3}
          items={[
            { label: "Pemasok", value: d.supplier?.name },
            { label: "Nomor nota pemasok", value: r.supplierNoteNumber ?? (r.isSubstituteNote ? "Nota pengganti" : "—") },
            { label: "Tanggal nota", value: r.supplierNoteDate ? formatTanggal(r.supplierNoteDate) : "—" },
            { label: "Total", value: formatRupiah(r.totalAmount) },
            { label: "Dibayar", value: formatRupiah(d.balance.paid) },
            { label: "Retur/pembalik", value: d.balance.returned ? formatRupiah(d.balance.returned) : "—" },
            { label: "Sisa utang", value: formatRupiah(d.balance.outstanding) },
            { label: "Jatuh tempo", value: r.dueDate ? formatTanggal(r.dueDate) : "—" },
            { label: "Dibayar saat terima", value: r.paidOnReceiptMethod ? label("payment_method", r.paidOnReceiptMethod) : "—" },
            ...(r.substituteAcceptedAt ? [{ label: "Nota pengganti diterima", value: formatTanggalJam(r.substituteAcceptedAt) }] : []),
            { label: "Catatan", value: r.notes, full: true },
          ]}
        />
      </SectionCard>
      <SectionCard title="Barang" flush>
        {d.lines.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="baris-nota-kantor">
              <TableHeader>
                <TableRow>
                  <TableHead>Barang</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead className="text-right">Harga beli</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.name}
                      <span className="block text-xs text-muted-foreground">{l.code}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {l.quantity.toLocaleString("id-ID")} {l.unit}
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(l.unitCost)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(l.lineTotal)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title={r.isOpeningPayable ? "Saldo awal utang — tanpa baris barang" : "Tidak ada baris barang"} compact />
        )}
      </SectionCard>
      {d.attachments.length ? (
        <SectionCard title="Foto nota & barang">
          <div className="flex flex-wrap gap-3">
            {d.attachments.map((a) =>
              a.contentType.startsWith("image/") ? (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- lampiran privat lewat /api/attachments (bukan aset statis) */}
                  <img src={a.url} alt={a.id === r.substituteGoodsPhotoId ? "Foto barang" : "Foto nota"} className="h-40 w-auto rounded-md border object-cover" />
                </a>
              ) : (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                  Buka lampiran
                </a>
              ),
            )}
          </div>
        </SectionCard>
      ) : null}
      {d.allocations.length || d.corrections.length ? (
        <SectionCard title="Pembayaran & koreksi">
          <ul className="grid gap-2 text-sm">
            {d.allocations.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 rounded-md border p-2">
                <span>
                  {a.amount < 0 ? "Pembalik pembayaran" : "Pembayaran"} {label("payment_method", a.method)} · {formatTanggal(a.businessDate)}
                </span>
                <span className={a.amount < 0 ? "text-destructive" : undefined}>{formatRupiah(a.amount)}</span>
              </li>
            ))}
            {d.corrections.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 rounded-md border p-2">
                <Link href={`/toko/pembelian/${c.id}`} className="text-primary hover:underline">
                  {c.number} · {c.reversalReason ?? c.notes ?? "Koreksi"}
                </Link>
                <span className="text-destructive">{formatRupiah(c.totalAmount)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {canAccept ? (
        <SectionCard title="Terima nota pengganti" description="Nota pengganti dicatat kasir karena nota asli tidak ada. Setelah diterima, stok bertambah dan utang pemasok tercatat. Penerima barang tidak boleh menerima notanya sendiri.">
          <OutletActionForm action={acceptSubstituteAction.bind(null, r.id)} submitLabel="Terima sebagai nota" testId="form-terima-pengganti" className="max-w-xl">
            <FormInput label="Nomor nota susulan (bila ada)" name="supplierNoteNumber" />
            <FormTextarea label="Catatan pemeriksaan" name="note" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
      {canCorrect ? (
        <SectionCard
          title="Koreksi nota"
          description="Retur sebagian barang ke pemasok atau pembalik penuh (salah input / nota pengganti ditolak). Nota asli tidak diubah; dibuat nota pembalik. Nilai di atas batas PAR-21 perlu persetujuan pemilik."
        >
          <OutletActionForm action={correctReceiptAction.bind(null, r.id)} submitLabel="Simpan koreksi" variant="outline" testId="form-koreksi-nota" className="max-w-2xl">
            <FormSelect
              label="Jenis koreksi"
              name="kind"
              defaultValue={r.status === "pending_acceptance" ? "reversal" : "return"}
              options={
                r.status === "pending_acceptance"
                  ? [{ value: "reversal", label: "Pembalik penuh (tolak nota pengganti)" }]
                  : [
                      { value: "return", label: "Retur sebagian ke pemasok" },
                      { value: "reversal", label: "Pembalik penuh nota" },
                    ]
              }
            />
            {r.status === "received" && d.lines.length ? (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Jumlah retur per barang (untuk retur sebagian)</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[...returnable.entries()].map(([productId, qty]) => {
                    const line = d.lines.find((l) => l.productId === productId)!;
                    return <FormInput key={productId} label={`${line.name} (maks. ${qty})`} name={`qty_${productId}`} inputMode="numeric" />;
                  })}
                </div>
              </fieldset>
            ) : null}
            <FormTextarea label="Alasan" name="reason" required />
          </OutletActionForm>
        </SectionCard>
      ) : null}
      <p className="text-xs text-muted-foreground">Dicatat {formatTanggalJam(r.createdAt)}.</p>
    </div>
  );
}
