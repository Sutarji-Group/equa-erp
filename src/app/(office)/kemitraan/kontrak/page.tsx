import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { CheckField, Field, FileField, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";
import { createContractAction, proposeTermsAction, recordEvaluationAction } from "../actions";

export const metadata: Metadata = { title: "Kontrak mitra" };

const bpPct = (bp: number) => `${(bp / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;

/**
 * Kontrak mitra (US-P3-09 KP-2, US-P3-04 KP-5, US-P3-01 KP-5): input Admin Keuangan (tarif langganan per outlet,
 * tanggal mulai, dokumen perjanjian) → persetujuan pemilik; perubahan parameter berlaku bulan berikutnya; evaluasi
 * berkala (Tahap 3, PAR-77). Tidak ada hapus — kontrak berakhir/diputus berjejak.
 */
export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission("p3.partner_contract.read");
  const [rows, phase3] = await Promise.all([p3.listContracts(ctx), phase3Enabled(ctx.tenantId)]);
  const canCreate = can(ctx, "p3.partner_contract.create");
  const canUpdate = can(ctx, "p3.partner_contract.update");
  const options = canCreate ? await p3.partnerFormOptions(ctx) : null;
  const detail = sp.id ? await p3.getContract(ctx, sp.id) : null;
  const partnerCustomers = options?.customers.filter((c) => c.isEquaPartner && c.partnerTenantId) ?? [];

  return (
    <div className="grid gap-6">
      <PageHeader title="Kontrak mitra" description="Kontrak dan parameternya berlaku setelah disetujui pemilik. Perubahan parameter berlaku mulai periode tagihan berikutnya." actions={<ExportButtons excelHref="/api/export/p3.contracts?format=xlsx" pdfHref="/api/export/p3.contracts?format=pdf" />} />
      <SectionCard title="Daftar kontrak">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada kontrak" description="Tautkan pelanggan mitra di halaman Mitra depot, lalu input kontrak di bawah." compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-kontrak">
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Mitra</TableHead>
                  <TableHead>Opsi</TableHead>
                  <TableHead>Masa</TableHead>
                  <TableHead className="text-right">Langganan/outlet</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Persetujuan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id} className={c.id === sp.id ? "bg-muted/60" : undefined}>
                    <TableCell>
                      <Link href={`/kemitraan/kontrak?id=${c.id}`} className="font-medium text-primary hover:underline">
                        {c.number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/kemitraan/mitra/${c.tenantId}`} className="hover:underline">
                        {c.tenantName}
                      </Link>
                      <div className="text-xs text-muted-foreground">{c.customerName}</div>
                    </TableCell>
                    <TableCell>{label("partner_option", c.option)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatTanggal(c.startDate)} – {formatTanggal(c.endDate)}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={c.termsNow.subscriptionFeePerOutlet} />
                      {c.pendingTermsEffectiveFrom ? <div className="text-xs text-muted-foreground">perubahan mulai {formatTanggal(c.pendingTermsEffectiveFrom)}</div> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="partner_contract_status" value={c.status} />
                    </TableCell>
                    <TableCell>{c.approvalStatus ? <StatusBadge enumName="approval_status" value={c.approvalStatus}>{`${c.approvalNumber ?? ""} ${label("approval_status", c.approvalStatus)}`}</StatusBadge> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {detail ? (
        <SectionCard title={`Kontrak ${detail.contract.number}`} actions={<Link href="/kemitraan/kontrak" className="text-sm text-primary hover:underline">Tutup</Link>}>
          <KeyValueList
            columns={3}
            items={[
              { label: "Status", value: <StatusBadge enumName="partner_contract_status" value={detail.contract.status} /> },
              { label: "Opsi", value: label("partner_option", detail.contract.option) },
              { label: "Masa", value: `${formatTanggal(detail.contract.startDate)} – ${formatTanggal(detail.contract.endDate)} (${detail.contract.termMonths} bulan)` },
              { label: "Langganan/outlet/bulan", value: <MoneyText value={detail.termsNow.subscriptionFeePerOutlet} /> },
              { label: "Fee awal", value: <MoneyText value={detail.contract.initialFee} /> },
              { label: "Royalti", value: bpPct(detail.termsNow.royaltyBp) },
              { label: "Diskon air", value: bpPct(detail.termsNow.waterDiscountBp) },
              { label: "Batas kredit", value: <MoneyText value={detail.termsNow.creditLimit} /> },
              { label: "Tagihan air bulanan (BR-05)", value: detail.contract.monthlyBilling ? "Ya — digabung faktur langganan" : "Tidak" },
              { label: "Radius eksklusif", value: detail.contract.exclusiveRadiusM ? `${detail.contract.exclusiveRadiusM.toLocaleString("id-ID")} m` : "—" },
              { label: "Evaluasi berikutnya", value: detail.contract.nextEvaluationDate ? formatTanggal(detail.contract.nextEvaluationDate) : "—" },
              { label: "Dokumen perjanjian", value: detail.contract.agreementAttachmentId ? <a className="text-primary hover:underline" href={`/api/attachments/${detail.contract.agreementAttachmentId}`}>Buka</a> : "—" },
            ]}
          />
          {detail.contract.pendingTerms && detail.contract.pendingTermsEffectiveFrom ? (
            <p className="mt-3 text-sm">
              <ToneBadge tone="info">Perubahan disetujui</ToneBadge> berlaku mulai {formatTanggal(detail.contract.pendingTermsEffectiveFrom)}.
            </p>
          ) : null}
          {detail.contract.terminationReason ? <p className="mt-3 text-sm text-destructive">Diputus: {detail.contract.terminationReason}</p> : null}
          {detail.territories.length ? <p className="mt-3 text-sm text-muted-foreground">Wilayah eksklusif: {detail.territories.length} titik tercatat.</p> : null}
          {detail.approvals.length ? (
            <div className="mt-4">
              <div className="text-sm font-medium">Riwayat persetujuan</div>
              <ul className="mt-1 grid gap-1 text-sm">
                {detail.approvals.map((a) => (
                  <li key={a.id}>
                    {a.number} · {formatTanggalJam(a.createdAt ?? new Date())} · <StatusBadge enumName="approval_status" value={a.status} /> {a.reason ? `· ${a.reason}` : ""} {a.decisionReason ? `· keputusan: ${a.decisionReason}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canUpdate && (detail.contract.status === "active" || detail.contract.status === "extended") ? (
            <div className="mt-6 border-t pt-4">
              <div className="mb-2 text-sm font-medium">Usulkan perubahan parameter (berlaku bulan berikutnya setelah disetujui pemilik)</div>
              <P3ActionForm action={proposeTermsAction.bind(null, detail.contract.id)} submitLabel="Ajukan perubahan" testId="form-ubah-kontrak" className="max-w-3xl">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Langganan per outlet (Rp)" name="subscriptionFeePerOutlet" inputMode="numeric" placeholder={String(detail.termsNow.subscriptionFeePerOutlet)} />
                  <Field label="Batas kredit (Rp)" name="creditLimit" inputMode="numeric" placeholder={String(detail.termsNow.creditLimit)} />
                  {detail.contract.option === "option_a" ? (
                    <>
                      <Field label="Royalti (%)" name="royaltyPercent" inputMode="decimal" />
                      <Field label="Diskon air (%)" name="waterDiscountPercent" inputMode="decimal" />
                    </>
                  ) : null}
                </div>
                <TextAreaField label="Alasan perubahan" name="reason" required rows={2} />
              </P3ActionForm>
            </div>
          ) : null}
          {phase3 && detail.evaluations.length ? (
            <div className="mt-6 border-t pt-4">
              <div className="text-sm font-medium">Evaluasi berkala (PAR-77)</div>
              <ul className="mt-2 grid gap-3">
                {detail.evaluations.map((e) => (
                  <li key={e.id} className="rounded-md border p-3 text-sm">
                    <div>
                      Jatuh tempo {formatTanggal(e.dueDate)} · {e.conductedAt ? <ToneBadge tone="success">Dilaksanakan {formatTanggal(e.conductedAt.toISOString().slice(0, 10))}</ToneBadge> : <ToneBadge tone="warning">Belum</ToneBadge>}
                    </div>
                    {e.summary ? <p className="mt-1 whitespace-pre-line">{e.summary}</p> : null}
                    {e.recommendation ? <p className="mt-1 text-muted-foreground">Rekomendasi: {e.recommendation}</p> : null}
                    {!e.conductedAt && can(ctx, "p3.partner_evaluation.create") ? (
                      <P3ActionForm action={recordEvaluationAction.bind(null, e.id)} submitLabel="Simpan evaluasi" className="mt-2 max-w-2xl">
                        <TextAreaField label="Ringkasan evaluasi (kinerja, neraca air, mutu, tagihan)" name="summary" required rows={3} />
                        <Field label="Rekomendasi" name="recommendation" />
                      </P3ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {options ? (
        <SectionCard title="Input kontrak baru" description="Admin Keuangan menginput; kontrak berlaku setelah pemilik menyetujui (pemisahan tugas). Opsi B tanpa royalti & diskon air. Kosongkan isian angka untuk memakai nilai PAR-35/PAR-78.">
          {partnerCustomers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada pelanggan mitra tertaut. Tautkan dulu di halaman Mitra depot.</p>
          ) : (
            <P3ActionForm action={createContractAction} submitLabel="Simpan & ajukan" testId="form-kontrak-baru" className="max-w-3xl">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Tenant mitra" name="tenantId" required options={options.tenants.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} />
                <SelectField label="Pelanggan mitra" name="customerId" required options={partnerCustomers.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` }))} />
                <SelectField
                  label="Opsi"
                  name="option"
                  required
                  defaultValue="option_b"
                  options={[{ value: "option_b", label: label("partner_option", "option_b") }, ...(phase3 ? [{ value: "option_a", label: label("partner_option", "option_a") }] : [])]}
                />
                <Field label="Tanggal mulai" name="startDate" type="date" required />
                <Field label="Masa kontrak (bulan)" name="termMonths" inputMode="numeric" hint="Kosong = PAR-78" />
                <Field label="Langganan per outlet per bulan (Rp)" name="subscriptionFeePerOutlet" inputMode="numeric" hint="Kosong = PAR-35" />
                <Field label="Fee awal (Rp)" name="initialFee" inputMode="numeric" />
                <Field label="Batas kredit air (Rp)" name="creditLimit" inputMode="numeric" />
                {phase3 ? (
                  <>
                    <Field label="Royalti (%) — Opsi A" name="royaltyPercent" inputMode="decimal" />
                    <Field label="Diskon air (%) — Opsi A" name="waterDiscountPercent" inputMode="decimal" />
                  </>
                ) : null}
              </div>
              <CheckField label="Tagihan air tempo digabung bulanan dengan faktur langganan (BR-05)" name="monthlyBilling" />
              <FileField label="Dokumen perjanjian (foto/PDF)" name="agreement" />
              <TextAreaField label="Dasar perjanjian / catatan untuk pemilik" name="reason" required rows={2} />
            </P3ActionForm>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
