import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, SelectField } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { linkCustomerAction } from "./actions";

export const metadata: Metadata = { title: "Mitra depot" };

/**
 * Mitra depot EQUA (RL-7, US-P3-08 KP-1): daftar tenant mitra dengan kontrak, piutang, dukungan terbuka, pasokan
 * menunggu, sanksi; tautan pelanggan mitra (segmen depot pihak ketiga) ke tenant & outlet mitra.
 */
export default async function PartnersPage() {
  const { ctx } = await requirePermission("p3.partner.read");
  const rows = await p3.listPartners(ctx);
  const canLink = can(ctx, "p3.partner_customer.link");
  const options = canLink ? await p3.partnerFormOptions(ctx) : null;
  const outstanding = rows.reduce((s, r) => s + r.receivable.outstanding, 0);
  const overdue = rows.reduce((s, r) => s + r.receivable.overdue, 0);

  return (
    <div className="grid gap-6">
      <PageHeader title="Mitra depot EQUA" description="Paket Minimum Mitra Fase 1: pelanggan mitra, pasokan air, tagihan langganan, dukungan teknis. EQUA hanya membaca data yang diperjanjikan (NFR-30)." actions={<ExportButtons excelHref="/api/export/p3.partners?format=xlsx" pdfHref="/api/export/p3.partners?format=pdf" />} />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Mitra terdaftar" value={String(rows.length)} />
        <KpiTile label="Piutang mitra" value={<MoneyText value={outstanding} />} href="/kemitraan/langganan" hrefLabel="Tagihan" />
        <KpiTile label="Lewat tempo" value={<MoneyText value={overdue} />} tone={overdue > 0 ? "danger" : "neutral"} />
      </div>
      <SectionCard title="Daftar mitra">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada mitra" description="Tenant mitra dibuat admin sistem di Outlet › Tenant & paket POS, lalu pelanggan mitra ditautkan di bawah." compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Mitra</TableHead>
                  <TableHead>Outlet</TableHead>
                  <TableHead>Kontrak</TableHead>
                  <TableHead className="text-right">Piutang</TableHead>
                  <TableHead className="text-right">Lewat tempo</TableHead>
                  <TableHead className="text-right">Dukungan</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.tenant.id}>
                    <TableCell>
                      <Link href={`/kemitraan/mitra/${r.tenant.id}`} className="font-medium text-primary hover:underline">
                        {r.tenant.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{r.tenant.code} · {r.customers.map((c) => c.name).join(", ") || "belum ada pelanggan mitra"}</div>
                    </TableCell>
                    <TableCell>{r.outlets.map((o) => `${o.code}${o.activatedOn ? "" : " (belum Aktif)"}`).join(", ")}</TableCell>
                    <TableCell>{r.contract ? <StatusBadge enumName="partner_contract_status" value={r.contract.status} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.receivable.outstanding} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.receivable.overdue} />
                    </TableCell>
                    <TableCell className="text-right">{r.openSupport}</TableCell>
                    <TableCell className="space-x-1">
                      {!r.tenant.isActive ? <ToneBadge tone="muted">Nonaktif</ToneBadge> : r.tenant.readOnly ? <ToneBadge tone="warning">Baca-saja</ToneBadge> : <ToneBadge tone="success">Aktif</ToneBadge>}
                      {r.activeSanctions ? <ToneBadge tone="danger">{r.activeSanctions} sanksi</ToneBadge> : null}
                      {r.pendingSupplies ? <ToneBadge tone="info">{r.pendingSupplies} pasokan menunggu</ToneBadge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      {options ? (
        <SectionCard title="Tautkan pelanggan mitra" description="Pelanggan M1 bersegmen depot pihak ketiga ditandai mitra depot EQUA (+ mitra toko BR-18) dan ditautkan ke tenant & outlet mitra. Pesanan air selanjutnya lewat Pesanan seperti pelanggan biasa (harga zona Opsi B).">
          <P3ActionForm action={linkCustomerAction} submitLabel="Tautkan" testId="form-tautan-mitra" className="max-w-2xl">
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField label="Pelanggan (depot pihak ketiga)" name="customerId" required options={options.customers.map((c) => ({ value: c.id, label: `${c.name}${c.isEquaPartner ? " (sudah mitra)" : ""}` }))} />
              <SelectField label="Tenant mitra" name="tenantId" required options={options.tenants.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))} />
              <SelectField label="Outlet depot mitra" name="outletId" required options={options.outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} />
            </div>
            <Field label="Dasar perjanjian / alasan" name="reason" required />
          </P3ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
