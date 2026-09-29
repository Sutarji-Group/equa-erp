import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/shared/empty-state";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { formatTanggal } from "@/lib/time";
import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";
import { settingsAction } from "../../actions";

export const metadata: Metadata = { title: "Pengaturan POS" };

/**
 * Pengaturan POS oleh mitra dalam batas EQUA (Tahap 3 US-P3-02 KP-1, PTB-56): harga jual per produk (harga anjuran EQUA
 * tampil; rentang minimal–maksimal), kas awal tetap, ambang void. Berlaku mulai besok; setiap perubahan berjejak.
 */
export default async function PortalSettingsPage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const sp = await searchParams;
  const { ctx, tenant } = await requirePortalSession();
  if (!(await p3.portalEnabled(getDb(), tenant.id))) {
    return (
      <>
        <PageHeader title="Pengaturan POS" />
        <Phase3Disabled what="Pengaturan harga jual & POS oleh mitra" />
      </>
    );
  }
  const home = await p3.portalHome(ctx);
  const outlets = home.outlets;
  if (!outlets.length) {
    return (
      <>
        <PageHeader title="Pengaturan POS" />
        <EmptyState title="Belum ada outlet" />
      </>
    );
  }
  const outletId = outlets.some((o) => o.id === sp.outlet) ? sp.outlet! : outlets[0]!.id;
  const view = await p3.partnerSettingsView(ctx, { outletId });

  return (
    <>
      <PageHeader title="Pengaturan POS" description="Harga jual ditetapkan mitra; harga anjuran EQUA tampil sebagai pembanding. Perubahan berlaku mulai besok." />
      {outlets.length > 1 ? (
        <nav className="flex flex-wrap gap-2" aria-label="Pilih outlet">
          {outlets.map((o) => (
            <Link key={o.id} href={`/mitra/pengaturan?outlet=${o.id}`} className={`rounded-full border px-3 py-1 text-sm ${o.id === outletId ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
              {o.code} — {o.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {view.readOnly ? (
        <Alert variant="destructive">
          <AlertDescription>Tenant dalam mode baca-saja karena tunggakan tagihan. Pengaturan tidak dapat diubah sampai tunggakan lunas.</AlertDescription>
        </Alert>
      ) : null}
      <SectionCard title={`Harga jual & batas — ${view.outlet.name}`}>
        <P3ActionForm action={settingsAction.bind(null, outletId)} submitLabel="Simpan pengaturan" testId="form-pengaturan-pos" resetOnSuccess={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left">
                <tr className="border-b">
                  <th className="py-2 font-medium">Produk</th>
                  <th className="py-2 text-right font-medium">Harga sekarang</th>
                  <th className="py-2 text-right font-medium">Anjuran EQUA</th>
                  <th className="py-2 text-right font-medium">Rentang</th>
                  <th className="py-2 text-right font-medium">Harga baru</th>
                </tr>
              </thead>
              <tbody>
                {view.prices.map((p) => (
                  <tr key={p.productId} className="border-b">
                    <td className="py-2">
                      {p.name}
                      {p.pendingPrice !== null ? (
                        <div className="text-xs text-muted-foreground">
                          terjadwal <MoneyText value={p.pendingPrice} /> mulai {p.pendingFrom ? formatTanggal(p.pendingFrom) : "-"}
                        </div>
                      ) : null}
                      <input type="hidden" name="priceProductId" value={p.productId} />
                    </td>
                    <td className="py-2 text-right">{p.price === null ? "—" : <MoneyText value={p.price} />}</td>
                    <td className="py-2 text-right">{p.recommendedPrice === null ? "—" : <MoneyText value={p.recommendedPrice} />}</td>
                    <td className="py-2 text-right text-xs">
                      {p.min !== null && p.max !== null ? (
                        <>
                          <MoneyText value={p.min} /> – <MoneyText value={p.max} />
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <input name="price" inputMode="numeric" placeholder="tetap" aria-label={`Harga baru ${p.name}`} className="h-9 w-28 rounded-md border border-input bg-background px-2 text-right text-base" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kas awal tetap (Rp)" name="fixedOpeningCash" inputMode="numeric" defaultValue={view.outlet.fixedOpeningCash} hint={`Maksimal ${view.limits.openingCashMax.toLocaleString("id-ID")} (batas EQUA).`} />
            <Field label="Ambang void perlu persetujuan (Rp)" name="voidThreshold" inputMode="numeric" defaultValue={view.voidThreshold} hint={`Antara ${view.limits.voidMin.toLocaleString("id-ID")} dan ${view.limits.voidMax.toLocaleString("id-ID")}.`} />
          </div>
          <TextAreaField label="Alasan perubahan" name="reason" required rows={2} />
        </P3ActionForm>
      </SectionCard>
    </>
  );
}
