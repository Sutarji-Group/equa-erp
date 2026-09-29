import type { Metadata } from "next";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { createPaymentAction } from "../actions";

export const metadata: Metadata = { title: "Tagihan" };

/**
 * Tagihan (US-P2-04 KP-2/KP-3/KP-5): faktur terbuka (jatuh tempo & sisa), kartu piutang 90 hari, faktur bulanan PDF,
 * keterangan Ditahan + cara melunasi, pembayaran digital QRIS/VA (verifikasi ulang OTP).
 */
export default async function TagihanPage() {
  const cctx = await requireCustomer({ next: "/app/tagihan" });
  const [b, unread] = await Promise.all([p2.myBilling(cctx), p2.unreadNotificationCount(cctx)]);
  return (
    <CustomerShell title="Tagihan" active="billing" unread={unread}>
      <CustomerCard title="Ringkasan" testId="billing-summary">
        <p className="text-sm">
          Status kredit: <strong>{b.creditStatusLabel}</strong>
        </p>
        <p className="mt-1 text-xl font-semibold">Sisa tagihan {formatRupiah(b.totalOutstanding)}</p>
        {b.onHold ? (
          <p className="mt-2 rounded-md border border-warning bg-warning/10 p-2 text-sm" data-testid="hold-message">
            {b.holdMessage}
          </p>
        ) : null}
        {b.digitalPaymentAvailable && b.totalOutstanding > 0 ? (
          <P2ActionForm action={createPaymentAction} submitLabel="Bayar semua tagihan" className="mt-3" resetOnSuccess={false} testId="pay-all">
            <input type="hidden" name="target" value="all_invoices" />
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="method" value="qris_dynamic" defaultChecked /> QRIS
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="method" value="virtual_account" /> Virtual account bank
            </label>
          </P2ActionForm>
        ) : null}
      </CustomerCard>

      <CustomerCard title="Faktur terbuka" testId="open-invoices">
        {b.openInvoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tidak ada tagihan terbuka. Terima kasih!</p>
        ) : (
          <ul className="grid gap-2">
            {b.openInvoices.map((i) => (
              <li key={i.id} className="rounded-lg border p-3 text-sm">
                <p className="flex items-center justify-between">
                  <span className="font-medium">{i.number}</span>
                  <span className="font-semibold">{formatRupiah(i.outstanding)}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {i.kindLabel} · jatuh tempo {formatTanggal(i.dueDate)}
                  {i.overdueDays > 0 ? <span className="text-destructive"> · lewat {i.overdueDays} hari</span> : null}
                  {i.disputed ? " · sedang disengketakan" : ""}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <a href={`/api/customer/faktur/${i.id}`} className="text-xs text-primary underline" download>
                    Unduh PDF
                  </a>
                  {b.digitalPaymentAvailable && !i.disputed ? (
                    <P2ActionForm action={createPaymentAction} submitLabel="Bayar (QRIS)" size="sm" variant="outline" resetOnSuccess={false}>
                      <input type="hidden" name="target" value="invoice" />
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <input type="hidden" name="method" value="qris_dynamic" />
                    </P2ActionForm>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>

      {b.monthlyInvoices.length ? (
        <CustomerCard title="Faktur bulanan">
          <ul className="divide-y text-sm">
            {b.monthlyInvoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span>
                  {i.number} {i.periodMonth ? `· ${i.periodMonth.slice(0, 7)}` : ""}
                  <span className="block text-xs text-muted-foreground">{formatRupiah(i.amount)} · sisa {formatRupiah(i.outstanding)}</span>
                </span>
                <a href={`/api/customer/faktur/${i.id}`} className="text-xs text-primary underline" download>
                  PDF
                </a>
              </li>
            ))}
          </ul>
        </CustomerCard>
      ) : null}

      {b.bankAccounts.length ? (
        <CustomerCard title="Transfer ke rekening EQUA">
          <ul className="text-sm">
            {b.bankAccounts.map((a) => (
              <li key={a.accountNumber}>
                {a.bankName} <strong className="tabular">{a.accountNumber}</strong> a.n. {a.accountName}
              </li>
            ))}
          </ul>
        </CustomerCard>
      ) : null}

      <CustomerCard title={`Kartu piutang (${formatTanggal(b.statement.from)} – ${formatTanggal(b.statement.to)})`}>
        <p className="mb-2 text-xs text-muted-foreground">
          Saldo awal {formatRupiah(b.statement.openingBalance)} · saldo akhir {formatRupiah(b.statement.closingBalance)}
          {b.statement.openAdvance > 0 ? ` · uang muka ${formatRupiah(b.statement.openAdvance)}` : ""}
        </p>
        {b.statement.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada mutasi.</p>
        ) : (
          <ul className="divide-y text-xs">
            {b.statement.entries.map((e, i) => (
              <li key={`${e.reference}-${i}`} className="flex justify-between gap-2 py-1.5">
                <span>
                  {formatTanggal(e.date)} · {e.description}
                </span>
                <span className="tabular shrink-0">{e.debit ? `+${formatRupiah(e.debit)}` : `−${formatRupiah(e.credit)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
