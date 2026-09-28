"use client";

import { useState } from "react";
import { toast } from "sonner";

import { BigButton } from "@/components/field/big-button";
import { addToCart, cartItemCount, type CartLine, cartTotal, changeCartQuantity } from "@/components/pos/cart";
import { CartPanel } from "@/components/pos/cart-panel";
import { PaymentPanel } from "@/components/pos/payment-panel";
import { PosShell } from "@/components/pos/pos-shell";
import { ProductGrid } from "@/components/pos/product-grid";
import { formatRupiah } from "@/lib/money";

import { DEMO_PRODUCTS } from "./sample-data";

export function PosDemo() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [pending, setPending] = useState(0);
  const [openedAt] = useState(() => new Date(Date.now() - 3 * 3600_000));
  const total = cartTotal(lines);
  const quantities = Object.fromEntries(lines.map((l) => [l.productId, l.quantity]));

  return (
    <PosShell
      outletName="Depot EQUA Pacet"
      operatorName="Rina (Operator depot)"
      shift={{ status: "open", openedAt }}
      pendingCount={pending}
      onSyncNow={() => {
        setPending(0);
        toast.success("Transaksi terkirim.");
      }}
      onLock={() => toast("Layar dikunci (demo)")}
      aside={
        <>
          <CartPanel
            lines={lines}
            onIncrement={(id) => setLines((ls) => changeCartQuantity(ls, id, 1))}
            onDecrement={(id) => setLines((ls) => changeCartQuantity(ls, id, -1))}
            onClear={() => setLines([])}
          />
          <PaymentPanel
            total={total}
            onPay={async (payment) => {
              await new Promise((r) => setTimeout(r, 300));
              setPending((p) => p + 1);
              setLines([]);
              toast.success(
                payment.method === "cash"
                  ? `Tersimpan · tunai · kembalian ${formatRupiah(payment.change)}`
                  : `Tersimpan · QRIS${payment.reference ? ` (${payment.reference})` : ""}`,
              );
            }}
          />
        </>
      }
      mobileBar={
        <BigButton
          disabled={lines.length === 0}
          onClick={() => document.querySelector("[data-slot=payment-panel]")?.scrollIntoView({ behavior: "smooth" })}
        >
          Bayar {formatRupiah(total)} · {cartItemCount(lines)} barang
        </BigButton>
      }
    >
      <ProductGrid products={DEMO_PRODUCTS} quantities={quantities} onSelect={(p) => setLines((ls) => addToCart(ls, p))} />
    </PosShell>
  );
}
