import type { Metadata } from "next";

import { OrderForm } from "@/components/m2-orders/order-form";
import { PageHeader } from "@/components/shared/page-header";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

export const metadata: Metadata = { title: "Pesanan baru" };

/**
 * Pesanan baru satu layar (US-M2-01..05, US-M2-08 KP-1): target < 60 detik untuk pelanggan yang sudah ada.
 */
export default async function PesananBaruPage() {
  const { ctx } = await requirePermission("m2.order.create");
  const [defaults, options] = await Promise.all([m2.orderFormDefaults(ctx), m2.orderFormOptions(ctx)]);
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pesanan baru"
        backHref="/pesanan"
        backLabel="Daftar pesanan"
        description={
          defaults.afterCutoff
            ? `Sudah lewat pukul ${defaults.sameDayCutoff.replace(":", ".")}: tanggal bawaan besok (${formatTanggal(defaults.defaultDate)}).`
            : `Tanggal bawaan hari ini (${formatTanggal(defaults.defaultDate)}); batas pesanan hari ini pukul ${defaults.sameDayCutoff.replace(":", ".")}.`
        }
      />
      <OrderForm
        defaults={defaults}
        internalTargets={options.internalTargets}
        zones={options.zones}
        canCreateCustomer={can(ctx, "m1.customer.create")}
        canSendWa={can(ctx, "m2.order.send_wa")}
        canCreateRecurring={can(ctx, "m2.recurring_order.create")}
      />
    </div>
  );
}
