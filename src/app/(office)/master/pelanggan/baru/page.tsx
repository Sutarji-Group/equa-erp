import type { Metadata } from "next";

import { CustomerCreateForm } from "@/components/m1-master/customer-forms";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { requirePermission } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { createCustomerAction } from "../actions";

export const metadata: Metadata = { title: "Pelanggan baru" };

/** Pelanggan baru (US-M1-01 KP-1/KP-2/KP-7). */
export default async function PelangganBaruPage() {
  const { ctx } = await requirePermission("m1.customer.create");
  const overview = await m1.getZoneOverview(ctx);
  return (
    <div className="grid gap-6">
      <PageHeader title="Pelanggan baru" backHref="/master/pelanggan" backLabel="Daftar pelanggan" description="Nama, segmen, nomor WA, dan minimal satu alamat kirim. Status kredit otomatis Tunai." />
      <SectionCard>
        <CustomerCreateForm action={createCustomerAction} zones={overview.zonesForSelect} />
      </SectionCard>
    </div>
  );
}
