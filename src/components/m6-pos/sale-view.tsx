"use client";

import { Printer, ShoppingBag } from "lucide-react";
import { useState } from "react";

import type { PosSaleRef } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { BigButton } from "@/components/field/big-button";
import { CartPanel } from "@/components/pos/cart-panel";
import { addToCart, cartTotal, changeCartQuantity, type CartLine } from "@/components/pos/cart";
import { PaymentPanel, type PosPayment } from "@/components/pos/payment-panel";
import { ProductGrid } from "@/components/pos/product-grid";

import { usePos } from "./pos-context";
import { Banner, ErrorText } from "./ui";

export type SaleDraft = { lines: CartLine[]; replacesSaleId: string | null };

/** Struk ringkas di layar (dapat dicetak lewat dialog cetak peramban; printer bluetooth = C, tidak dibangun). */
export function ReceiptView({ sale, onDone }: { sale: PosSaleRef; onDone: () => void }) {
  const { ref, productName } = usePos();
  return (
    <section aria-label="Struk" className="flex flex-col gap-4 rounded-2xl border-2 bg-card p-4" data-testid="struk">
      <div className="print-area flex flex-col gap-1 font-mono text-base">
        <p className="text-center text-lg font-bold">{ref?.companyName ?? "EQUA"}</p>
        <p className="text-center">{ref?.outlet?.name}</p>
        <p className="text-center text-sm">{formatTanggalJam(sale.soldAt)}</p>
        <p className="text-center text-sm" data-testid="nomor-transaksi">
          No. {sale.number ?? sale.localNumber}
        </p>
        <hr className="my-2 border-dashed" />
        {sale.lines.map((l, i) => (
          <p key={i} className="flex justify-between gap-2">
            <span>
              {productName(l.productId)} × {l.quantity}
            </span>
            <span className="tabular">{formatRupiah(l.lineTotal)}</span>
          </p>
        ))}
        <hr className="my-2 border-dashed" />
        <p className="flex justify-between text-lg font-bold">
          <span>Total</span>
          <span className="tabular">{formatRupiah(sale.total)}</span>
        </p>
        {sale.paymentMethod === "cash" ? (
          <>
            <p className="flex justify-between">
              <span>Tunai</span>
              <span className="tabular">{formatRupiah(sale.cashReceived ?? sale.total)}</span>
            </p>
            <p className="flex justify-between">
              <span>Kembalian</span>
              <span className="tabular">{formatRupiah(sale.changeAmount ?? 0)}</span>
            </p>
          </>
        ) : (
          <p className="flex justify-between">
            <span>QRIS</span>
            <span>{sale.qrisReference ?? "—"}</span>
          </p>
        )}
        <p className="mt-2 text-center text-sm">Terima kasih</p>
      </div>
      <p className="text-base text-muted-foreground">
        {sale.local ? "Tersimpan di perangkat — nomor resmi terbentuk saat terkirim." : "Terkirim."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 print:hidden">
        <BigButton variant="secondary" icon={<Printer aria-hidden />} onClick={() => window.print()}>
          Cetak struk
        </BigButton>
        <BigButton onClick={onDone}>Transaksi baru</BigButton>
      </div>
    </section>
  );
}

/** Layar jual: kisi produk (≤ 12), keranjang +/−, bayar tunai/QRIS. */
export function SaleView({ draft, setDraft, onSaved, blocked }: { draft: SaleDraft; setDraft: (d: SaleDraft) => void; onSaved: (sale: PosSaleRef) => void; blocked: string | null }) {
  const { grid, shift, ref, send, nextLocalNumber } = usePos();
  const [error, setError] = useState<string | null>(null);
  const quantities = Object.fromEntries(draft.lines.map((l) => [l.productId, l.quantity]));
  const total = cartTotal(draft.lines);
  const disabled = !!blocked || !shift;

  async function pay(payment: PosPayment) {
    if (!shift) return;
    setError(null);
    try {
      const { localNumber, deviceSeq } = await nextLocalNumber();
      const saleId = newId();
      const payload = {
        saleId,
        shiftId: shift.id,
        localNumber,
        deviceSeq,
        lines: draft.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })),
        paymentMethod: payment.method,
        cashReceived: payment.method === "cash" ? payment.received : null,
        qrisReference: payment.method === "qris" ? payment.reference : null,
        replacesSaleId: draft.replacesSaleId,
      };
      await send("m6.pos_sale.create", payload, `Transaksi ${localNumber} · ${formatRupiah(total)}`);
      onSaved({
        id: saleId,
        number: null,
        localNumber,
        soldAt: new Date().toISOString(),
        total,
        paymentMethod: payment.method,
        cashReceived: payment.method === "cash" ? payment.received : null,
        changeAmount: payment.method === "cash" ? payment.change : null,
        qrisReference: payment.method === "qris" ? payment.reference : null,
        status: "valid",
        voidReason: null,
        priceMismatch: false,
        isReversal: false,
        reversalReason: null,
        replacesSaleId: draft.replacesSaleId,
        lines: payload.lines.map((l) => ({ ...l, lineTotal: l.quantity * l.unitPrice, gallonSizeL: null })),
        local: true,
      });
      setDraft({ lines: [], replacesSaleId: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaksi gagal disimpan.");
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] md:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        {blocked ? <Banner tone="warning">{blocked}</Banner> : null}
        {draft.replacesSaleId ? <Banner tone="info">Transaksi pengganti untuk transaksi yang di-void.</Banner> : null}
        {grid.length === 0 ? (
          <Banner tone="info">Katalog produk belum terunduh. Sambungkan ke internet sebentar lalu tekan &quot;Kirim sekarang&quot;.</Banner>
        ) : (
          <ProductGrid products={grid} quantities={quantities} disabled={disabled} onSelect={(p) => setDraft({ ...draft, lines: addToCart(draft.lines, p) })} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4 md:sticky md:top-28">
        <CartPanel
          lines={draft.lines}
          disabled={disabled}
          onIncrement={(id) => setDraft({ ...draft, lines: changeCartQuantity(draft.lines, id, 1) })}
          onDecrement={(id) => setDraft({ ...draft, lines: changeCartQuantity(draft.lines, id, -1) })}
          onClear={() => setDraft({ lines: [], replacesSaleId: null })}
        />
        <PaymentPanel total={total} disabled={disabled || draft.lines.length === 0} methods={ref?.settings.qrisEnabled === false ? ["cash"] : ["cash", "qris"]} onPay={pay} />
        <ErrorText>{error}</ErrorText>
        {draft.lines.length === 0 ? (
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <ShoppingBag className="size-5" aria-hidden /> Ketuk produk untuk mulai transaksi.
          </p>
        ) : null}
      </div>
    </div>
  );
}
