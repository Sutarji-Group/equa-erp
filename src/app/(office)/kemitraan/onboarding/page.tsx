import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, SelectField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";
import { completeOnboardingAction } from "../actions";

export const metadata: Metadata = { title: "Onboarding mitra" };

/**
 * Daftar periksa onboarding per outlet mitra (US-P3-01 KP-4): pelatihan, SOP diterima (tanda tangan digital di portal),
 * pesanan peralatan awal (penjualan toko harga mitra), pesanan air pertama, perangkat POS terdaftar, uji air awal.
 * Outlet menjadi Aktif otomatis saat semua butir lengkap.
 */
export default async function OnboardingPage() {
  const { ctx } = await requirePermission(["p3.onboarding.update", "p3.partner_contract.read"]);
  if (!(await phase3Enabled())) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Onboarding mitra" />
        <Phase3Disabled what="Daftar periksa onboarding" />
      </div>
    );
  }
  const board = await p3.onboardingBoard(ctx);
  const canUpdate = can(ctx, "p3.onboarding.update");
  const pending = board.filter((v) => !v.activatedOn);
  const candidates = canUpdate ? await Promise.all(pending.map(async (v) => [`${v.contract.id}:${v.outletId}`, await p3.onboardingCandidates(ctx, { contractId: v.contract.id, outletId: v.outletId })] as const)) : [];
  const candMap = new Map(candidates);

  return (
    <div className="grid gap-6">
      <PageHeader title="Onboarding mitra" description="Outlet mitra baru belum Aktif sampai semua butir lengkap. Butir bukti merujuk transaksi nyata (pesanan, penjualan harga mitra, perangkat, uji air)." />
      {board.length === 0 ? <EmptyState title="Belum ada outlet dalam onboarding" description="Daftar periksa dibuat otomatis saat kontrak dari calon mitra disetujui pemilik." /> : null}
      {board.map((v) => {
        const cand = candMap.get(`${v.contract.id}:${v.outletId}`);
        return (
          <SectionCard
            key={`${v.contract.id}:${v.outletId}`}
            title={`${v.outletName} — kontrak ${v.contract.number}`}
            description={v.activatedOn ? `Aktif sejak ${formatTanggal(v.activatedOn)}` : `${v.done} dari ${v.total} butir lengkap`}
            actions={v.activatedOn ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="warning">Onboarding</ToneBadge>}
          >
            <ul className="grid gap-3" data-testid="daftar-onboarding">
              {v.items.map((it) => (
                <li key={it.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{label("onboarding_item", it.item)}</span>
                    {it.completedAt ? <ToneBadge tone="success">Selesai {formatTanggalJam(it.completedAt)}</ToneBadge> : <ToneBadge tone="muted">Belum</ToneBadge>}
                  </div>
                  {it.notes ? <div className="mt-1 text-muted-foreground">{it.notes}</div> : null}
                  {!it.completedAt && canUpdate && cand ? (
                    it.item === "sop_signed" ? (
                      <p className="mt-1 text-muted-foreground">Menunggu tanda tangan digital pemilik mitra di portal (menu Onboarding).</p>
                    ) : (
                      <P3ActionForm action={completeOnboardingAction.bind(null, v.contract.id, v.outletId, it.item)} submitLabel="Centang" className="mt-2 max-w-2xl" testId={`form-onboarding-${it.item}`}>
                        {it.item === "training" ? (
                          <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="Tanggal pelatihan" name="trainingDate" type="date" required />
                            <Field label="Sampai (opsional)" name="trainingEndDate" type="date" />
                            <Field label="Peserta" name="participants" required />
                          </div>
                        ) : it.item === "equipment_order" ? (
                          <SelectField label="Penjualan peralatan (harga mitra)" name="referenceId" required options={cand.sales.map((s) => ({ value: s.id, label: `${s.number ?? s.id.slice(0, 8)} · ${formatTanggal(s.businessDate)} · ${formatRupiah(s.total)}` }))} hint={cand.sales.length ? undefined : "Belum ada penjualan toko harga mitra ke pelanggan mitra ini."} />
                        ) : it.item === "first_water_order" ? (
                          <SelectField label="Pesanan air" name="referenceId" required options={cand.orders.map((o) => ({ value: o.id, label: `${o.number} · ${formatTanggal(o.requestedDate)} · ${label("order_status", o.status)}` }))} hint={cand.orders.length ? undefined : "Belum ada pesanan air pelanggan mitra ini."} />
                        ) : it.item === "pos_device_registered" ? (
                          <SelectField label="Perangkat POS" name="referenceId" required options={cand.devices.map((d) => ({ value: d.id, label: `${d.deviceCode} — ${d.name} (${label("device_status", d.status)})` }))} hint={cand.devices.length ? undefined : "Daftarkan tablet POS di halaman rincian mitra."} />
                        ) : it.item === "initial_water_test" ? (
                          <SelectField label="Uji air" name="referenceId" required options={cand.tests.map((t) => ({ value: t.id, label: `${formatTanggal(t.testDate)} · ${t.laboratory ?? "-"} · ${t.passed ? "lulus" : "tidak lulus"}` }))} hint={cand.tests.length ? undefined : "Catat hasil uji air outlet di menu Mutu & audit mitra."} />
                        ) : null}
                        <Field label="Catatan (opsional)" name="notes" />
                      </P3ActionForm>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm">
              <Link href={`/kemitraan/mitra/${v.contract.tenantId}`} className="text-primary hover:underline">
                Rincian mitra
              </Link>
            </p>
          </SectionCard>
        );
      })}
    </div>
  );
}
