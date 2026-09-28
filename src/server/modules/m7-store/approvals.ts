/**
 * M7 — handler jenis persetujuan milik modul toko (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * | Jenis (objek)                       | Disetujui                                                  | Ditolak / dibatalkan             | Lewat tenggat                         |
 * |-------------------------------------|------------------------------------------------------------|----------------------------------|---------------------------------------|
 * | `store_discount` (pos_sale)         | transaksi menunggu → Sah (stok, kas, `pos_sale.recorded`)  | transaksi Ditolak                | `expire`: dianggap ditolak akhir shift |
 * | `store_credit_sale` (pos_sale)      | sama                                                        | transaksi Ditolak                | `expire`: dianggap ditolak akhir shift |
 * | `store_product` (product)           | barang Aktif + harga berlaku                               | barang Nonaktif, harga ditolak   | — (tanpa tenggat)                      |
 * | `store_product` (product_price)     | harga berlaku mulai tanggal berlaku (≥ tanggal keputusan)  | usulan harga ditolak             | —                                      |
 * | `supplier` (supplier)               | pemasok Aktif                                              | pemasok Nonaktif                 | —                                      |
 * | `correction` (purchase_receipt)     | nota retur/pembalik dibuat (stok & utang)                  | nota tetap                       | —                                      |
 * | `correction` (supplier_payment)     | pembalik pembayaran                                        | pembayaran tetap                 | —                                      |
 * | `correction` (store_return)         | retur pelanggan dicatat (stok kembali, `store_return.recorded`) | tidak berlaku                | —                                      |
 *
 * `pos_void` & `stock_adjustment` milik kerangka POS M6 (tidak didaftarkan ulang, B-05). `ctx` handler = penyetuju
 * (pemilik/Admin Keuangan) atau sistem — handler menulis langsung dengan `tx` + jejak audit.
 */
import "server-only";

import { registerApprovalHandler } from "@/server/core/approvals";

import { onStorePriceApproved, onStorePriceRejected, onStoreProductApproved, onStoreProductRejected, onSupplierApproved, onSupplierRejected } from "./service/catalog";
import { onPaymentReversalApproved } from "./service/payables";
import { onStoreSaleApproved, onStoreSaleRejected } from "./service/policy";
import { onPurchaseCorrectionApproved } from "./service/purchases";
import { onStoreReturnApproved } from "./service/returns";

export function registerApprovals(): void {
  for (const type of ["store_discount", "store_credit_sale"] as const) {
    registerApprovalHandler(type, {
      onApproved: ({ tx, request, ctx }) => onStoreSaleApproved(tx, request, ctx),
      onRejected: ({ tx, request, ctx }) => onStoreSaleRejected(tx, request, ctx, "rejected"),
      onExpired: ({ tx, request, ctx }) => onStoreSaleRejected(tx, request, ctx, "expired"),
      onCancelled: ({ tx, request, ctx }) => onStoreSaleRejected(tx, request, ctx, "cancelled"),
    });
  }
  registerApprovalHandler(
    "store_product",
    {
      onApproved: ({ tx, request, ctx }) => onStoreProductApproved(tx, request, ctx),
      onRejected: ({ tx, request, ctx }) => onStoreProductRejected(tx, request, ctx),
      onCancelled: ({ tx, request, ctx }) => onStoreProductRejected(tx, request, ctx),
    },
    { objectType: "product" },
  );
  registerApprovalHandler(
    "store_product",
    {
      onApproved: ({ tx, request, ctx }) => onStorePriceApproved(tx, request, ctx),
      onRejected: ({ tx, request, ctx }) => onStorePriceRejected(tx, request, ctx),
      onCancelled: ({ tx, request, ctx }) => onStorePriceRejected(tx, request, ctx),
    },
    { objectType: "product_price" },
  );
  registerApprovalHandler("supplier", {
    onApproved: ({ tx, request, ctx }) => onSupplierApproved(tx, request, ctx),
    onRejected: ({ tx, request, ctx }) => onSupplierRejected(tx, request, ctx),
    onCancelled: ({ tx, request, ctx }) => onSupplierRejected(tx, request, ctx),
  });
  // Koreksi lintas modul BR-38 (D-09 butir 3): handler per jenis objek.
  registerApprovalHandler("correction", { onApproved: ({ tx, request, ctx }) => onPurchaseCorrectionApproved(tx, request, ctx) }, { objectType: "purchase_receipt" });
  registerApprovalHandler("correction", { onApproved: ({ tx, request, ctx }) => onPaymentReversalApproved(tx, request, ctx) }, { objectType: "supplier_payment" });
  registerApprovalHandler("correction", { onApproved: ({ tx, request, ctx }) => onStoreReturnApproved(tx, request, ctx) }, { objectType: "store_return" });
}
