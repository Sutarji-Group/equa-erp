import type { ActorContext } from "@/server/core/context";
import { can } from "@/server/core/rbac";

import type { OfficeTab } from "@/components/p2-customer/office-tabs";

/** Tab layar kantor aplikasi pelanggan sesuai izin pelaku. */
export function p2Tabs(ctx: ActorContext): OfficeTab[] {
  return [
    { href: "/keluhan", label: "Kotak keluhan", show: can(ctx, "p2.complaint.read") },
    { href: "/keluhan/pesanan-aplikasi", label: "Pesanan aplikasi", show: can(ctx, "p2.app_order.read") },
    { href: "/keluhan/penilaian", label: "Penilaian", show: can(ctx, "p2.rating.read") },
    { href: "/keluhan/pembayaran", label: "Pembayaran & WA", show: can(ctx, "p2.payment_intent.read") || can(ctx, "p2.wa_cost.read") },
    { href: "/keluhan/laporan", label: "Laporan", show: can(ctx, "p2.adoption.read") },
    { href: "/keluhan/akun", label: "Akun pelanggan", show: can(ctx, "p2.customer_account.read") },
  ];
}
