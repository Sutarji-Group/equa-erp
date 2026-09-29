import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { CheckField, Field, FileField, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../../_data";
import { contractFromProspectAction, overrideRadiusAction, recordSurveyAction, submitProspectAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian calon mitra" };

const km = (m: number | null) => (m === null ? "—" : `${(m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} km`);

/**
 * Rincian calon mitra (US-P3-01 KP-1..KP-4): penilaian otomatis, survei pembina, pengesampingan radius oleh pemilik
 * (beralasan), pengajuan ke pemilik, lalu kontrak berparameter oleh Admin Keuangan (tenant + outlet + pelanggan mitra).
 */
export default async function ProspectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission(["p3.partner_prospect.create", "p3.partner.read"]);
  if (!(await phase3Enabled())) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Rincian calon mitra" backHref="/kemitraan/calon" backLabel="Calon mitra" />
        <Phase3Disabled what="Penilaian calon mitra" />
      </div>
    );
  }
  const { prospect: p, surveys, approvals, assessment: a, contracts } = await p3.getProspect(ctx, id);
  const decided = ["approved", "contracted", "onboarding", "active"].includes(p.status);
  const radiusBlocked = !!a && a.radiusConflicts.length > 0 && !p.radiusOverrideReason;

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={p.name} />
      <PageHeader title={p.name} backHref="/kemitraan/calon" backLabel="Calon mitra" description={p.proposedAddress} meta={<StatusBadge enumName="prospect_status" value={p.status} />} />
      <SectionCard title="Data pendaftaran">
        <KeyValueList
          columns={3}
          items={[
            { label: "Nomor WA", value: p.waPhone },
            { label: "Badan usaha", value: p.businessEntity ?? "—" },
            { label: "Modal", value: p.capitalAmount !== null ? <MoneyText value={p.capitalAmount} /> : "—" },
            { label: "Titik lokasi", value: p.proposedLat !== null && p.proposedLng !== null ? `${p.proposedLat.toFixed(5)}, ${p.proposedLng.toFixed(5)}` : "—" },
            { label: "Dicatat", value: formatTanggalJam(p.createdAt) },
            { label: "Catatan", value: p.notes ?? "—" },
          ]}
        />
      </SectionCard>
      <SectionCard title="Penilaian otomatis" description="Zona tarif & jarak rute dari sumber air acuan (M1), radius eksklusif (PAR-35), kapasitas pasokan (PAR-81).">
        {!a ? (
          <p className="text-sm text-muted-foreground">Titik lokasi belum tersedia.</p>
        ) : (
          <div className="grid gap-3">
            <KeyValueList
              columns={3}
              items={[
                { label: "Hasil", value: <StatusBadge enumName="prospect_status" value={a.status} /> },
                { label: "Sumber air acuan", value: a.referenceWaterSourceName ?? "—" },
                { label: "Jarak rute", value: `${km(a.routeDistanceM)}${a.distanceMethod ? ` (${a.distanceMethod})` : ""}` },
                { label: "Zona tarif", value: a.zoneCode ?? (a.outOfReach ? <ToneBadge tone="danger">di luar jangkauan</ToneBadge> : "—") },
                { label: "Kapasitas", value: a.capacity.available ? <ToneBadge tone="success">tersedia</ToneBadge> : <ToneBadge tone="warning">penuh — daftar tunggu</ToneBadge> },
                { label: "Mitra aktif / maks.", value: `${a.capacity.activePartners} / ${a.capacity.maxPartners}` },
              ]}
            />
            {a.reason ? <p className="text-sm">{a.reason}</p> : null}
            {a.radiusConflicts.length ? (
              <ul className="grid gap-1 text-sm">
                {a.radiusConflicts.map((c, i) => (
                  <li key={i}>
                    <ToneBadge tone={p.radiusOverrideReason ? "muted" : "danger"}>radius</ToneBadge> {c.kind === "equa_outlet" ? "Depot EQUA" : "Wilayah eksklusif mitra"} {c.name}: {c.distanceM.toLocaleString("id-ID")} m &lt; {c.radiusM.toLocaleString("id-ID")} m
                  </li>
                ))}
              </ul>
            ) : null}
            {p.radiusOverrideReason ? <p className="text-sm text-muted-foreground">Dikesampingkan pemilik: {p.radiusOverrideReason}</p> : null}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Survei lokasi">
        {surveys.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada survei.</p>
        ) : (
          <ul className="grid gap-3">
            {surveys.map((s) => (
              <li key={s.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">{formatTanggalJam(s.surveyedAt)}</div>
                {s.distanceNotes ? <div>Jarak: {s.distanceNotes}</div> : null}
                {s.densityNotes ? <div>Kepadatan: {s.densityNotes}</div> : null}
                {s.competitorNotes ? <div>Pesaing: {s.competitorNotes}</div> : null}
                {s.layoutNotes ? <div>Tata letak: {s.layoutNotes}</div> : null}
                {s.recommendation ? <div className="mt-1">Rekomendasi: {s.recommendation}</div> : null}
              </li>
            ))}
          </ul>
        )}
        {!decided && can(ctx, "p3.partner_survey.create") ? (
          <P3ActionForm action={recordSurveyAction.bind(null, p.id)} submitLabel="Simpan survei" testId="form-survei" className="mt-4 max-w-3xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextAreaField label="Jarak & akses truk" name="distanceNotes" rows={2} />
              <TextAreaField label="Kepadatan penduduk" name="densityNotes" rows={2} />
              <TextAreaField label="Pesaing sekitar" name="competitorNotes" rows={2} />
              <TextAreaField label="Tata letak bangunan" name="layoutNotes" rows={2} />
            </div>
            <TextAreaField label="Rekomendasi pembina" name="recommendation" required rows={2} />
            <FileField label="Foto lokasi" name="photo" />
          </P3ActionForm>
        ) : null}
      </SectionCard>
      {radiusBlocked && can(ctx, "p3.partner_prospect.waive_radius") ? (
        <SectionCard title="Kesampingkan pelanggaran radius" description="Hanya pemilik, dengan alasan tertulis; tercatat di jejak audit.">
          <P3ActionForm action={overrideRadiusAction.bind(null, p.id)} submitLabel="Kesampingkan" variant="destructive" className="max-w-2xl">
            <TextAreaField label="Alasan" name="reason" required rows={2} />
          </P3ActionForm>
        </SectionCard>
      ) : null}
      {!decided && can(ctx, "p3.partner_prospect.update") ? (
        <SectionCard title="Ajukan ke pemilik" description="Calon mitra yang layak (atau radius sudah dikesampingkan) diajukan untuk persetujuan pemilik.">
          <P3ActionForm action={submitProspectAction.bind(null, p.id)} submitLabel="Ajukan" testId="form-ajukan-calon" className="max-w-2xl">
            <TextAreaField label="Ringkasan untuk pemilik" name="reason" required rows={2} />
          </P3ActionForm>
        </SectionCard>
      ) : null}
      {approvals.length ? (
        <SectionCard title="Persetujuan">
          <ul className="grid gap-1 text-sm">
            {approvals.map((ap) => (
              <li key={ap.id}>
                {ap.number} · <StatusBadge enumName="approval_status" value={ap.status} /> {ap.decisionReason ? `· ${ap.decisionReason}` : ""}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {contracts.length ? (
        <SectionCard title="Kontrak">
          <ul className="grid gap-1 text-sm">
            {contracts.map((c) => (
              <li key={c.id}>
                <Link href={`/kemitraan/kontrak?id=${c.id}`} className="text-primary hover:underline">
                  {c.number}
                </Link>{" "}
                · <StatusBadge enumName="partner_contract_status" value={c.status} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {p.status === "approved" && can(ctx, "p3.partner_contract.create") ? (
        <SectionCard title="Buat kontrak berparameter" description="Membuat tenant & outlet mitra (belum Aktif sampai onboarding lengkap) serta pelanggan mitra di M1; kontrak berlaku setelah disetujui pemilik.">
          <P3ActionForm action={contractFromProspectAction.bind(null, p.id)} submitLabel="Buat & ajukan kontrak" testId="form-kontrak-calon" className="max-w-3xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kode tenant" name="tenantCode" required placeholder="MTR02" />
              <Field label="Nama tenant" name="tenantName" defaultValue={p.businessEntity ?? p.name} />
              <Field label="Kode outlet" name="outletCode" required placeholder="M02" />
              <Field label="Nama outlet" name="outletName" required defaultValue={`Depot ${p.name}`} />
              <SelectField label="Opsi" name="option" required defaultValue="option_b" options={[{ value: "option_b", label: label("partner_option", "option_b") }, { value: "option_a", label: label("partner_option", "option_a") }]} />
              <Field label="Tanggal mulai" name="startDate" type="date" required />
              <Field label="Langganan per outlet (Rp)" name="subscriptionFeePerOutlet" inputMode="numeric" hint="Kosong = PAR-35" />
              <Field label="Fee awal (Rp)" name="initialFee" inputMode="numeric" />
              <Field label="Royalti (%) — Opsi A" name="royaltyPercent" inputMode="decimal" />
              <Field label="Diskon air (%) — Opsi A" name="waterDiscountPercent" inputMode="decimal" />
              <Field label="Batas kredit air (Rp)" name="creditLimit" inputMode="numeric" />
            </div>
            <CheckField label="Tagihan air tempo digabung bulanan (BR-05)" name="monthlyBilling" />
            <FileField label="Dokumen perjanjian (wajib)" name="agreement" required />
            <TextAreaField label="Dasar perjanjian" name="reason" required rows={2} />
          </P3ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
