import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, SelectField } from "@/components/p3-partner/fields";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { issuePinAction, registerDeviceAction, registerOperatorAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian mitra" };

/**
 * Rincian mitra untuk EQUA: outlet, pelanggan mitra, kontrak, neraca air bulan berjalan, tagihan, hak baca EQUA
 * (US-P3-02 KP-2). Admin sistem: akun operator/pemilik mitra & tablet POS (B-07; persetujuan pemilik US-M10-01 KP-8).
 */
export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requirePermission(["p3.partner.read", "p3.partner_supply.read"]);
  const d = await p3.getPartnerDetail(ctx, id);
  const isAdmin = can(ctx, "m10.user.create");
  const outletOpts = d.outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }));

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={d.tenant.name} />
      <PageHeader title={d.tenant.name} backHref="/kemitraan" backLabel="Mitra depot" description={`${d.terms.partner} · kode ${d.tenant.code}`} meta={d.tenant.readOnly ? <ToneBadge tone="warning">Mode baca-saja</ToneBadge> : !d.tenant.isActive ? <ToneBadge tone="muted">Nonaktif</ToneBadge> : <ToneBadge tone="success">Aktif</ToneBadge>} />
      <SectionCard title="Outlet & pelanggan mitra">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Outlet</TableHead>
                <TableHead>Aktif sejak</TableHead>
                <TableHead>Mulai ditagih</TableHead>
                <TableHead>Pelanggan mitra (M1)</TableHead>
                <TableHead className="text-right">Batas kredit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.outlets.map((o) => {
                const c = d.customers.find((x) => x.outletId === o.id);
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">
                      {o.code} — {o.name}
                    </TableCell>
                    <TableCell>{o.activatedOn ? formatTanggal(o.activatedOn) : <ToneBadge tone="warning">Onboarding</ToneBadge>}</TableCell>
                    <TableCell>{o.billingStartDate ? formatTanggal(o.billingStartDate) : "—"}</TableCell>
                    <TableCell>{c ? `${c.name} · ${label("credit_status", c.creditStatus)}${c.monthlyBilling ? " · tagihan bulanan" : ""}` : <span className="text-muted-foreground">belum ditautkan</span>}</TableCell>
                    <TableCell className="text-right">{c ? <MoneyText value={c.creditLimit} /> : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      <SectionCard title="Kontrak" actions={<Link href="/kemitraan/kontrak" className="text-sm text-primary hover:underline">Kelola kontrak</Link>}>
        {d.contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada kontrak. Admin Keuangan menginput kontrak (tarif langganan & tanggal mulai) untuk disetujui pemilik.</p>
        ) : (
          <div className="grid gap-2">
            {d.contracts.map((c) => (
              <KeyValueList
                key={c.id}
                columns={3}
                items={[
                  { label: "Nomor", value: c.number },
                  { label: "Status", value: <StatusBadge enumName="partner_contract_status" value={c.status} /> },
                  { label: "Opsi", value: label("partner_option", c.option) },
                  { label: "Masa", value: `${formatTanggal(c.startDate)} – ${formatTanggal(c.endDate)}` },
                  { label: "Langganan/outlet", value: <MoneyText value={c.subscriptionFeePerOutlet} /> },
                  { label: "Batas kredit", value: <MoneyText value={c.creditLimit} /> },
                ]}
              />
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Neraca air bulan berjalan" description="Galon terjual × 19 L vs air diterima dari EQUA (PAR-79).">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Air dari EQUA (L)</TableHead>
                <TableHead className="text-right">Galon terjual</TableHead>
                <TableHead className="text-right">Liter terjual</TableHead>
                <TableHead className="text-right">Kelebihan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.waterBalance.map((b) => (
                <TableRow key={b.outletId}>
                  <TableCell>{b.outletName}</TableCell>
                  <TableCell className="text-right">{b.receivedFromEquaL.toLocaleString("id-ID")}</TableCell>
                  <TableCell className="text-right">{b.gallonsSold.toLocaleString("id-ID")}</TableCell>
                  <TableCell className="text-right">{b.soldL.toLocaleString("id-ID")}</TableCell>
                  <TableCell className="text-right">{b.exceeded ? <ToneBadge tone="danger">{b.excessPct}%</ToneBadge> : `${b.excessPct}%`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {d.invoices ? (
        <SectionCard title="Tagihan mitra (M5)">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Faktur</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.invoices.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/piutang/faktur/${i.id}`} className="text-primary hover:underline">
                        {i.number}
                      </Link>
                    </TableCell>
                    <TableCell>{label("invoice_kind", i.kind)}</TableCell>
                    <TableCell>{formatTanggal(i.dueDate)}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={i.amount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={i.outstandingAmount} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="invoice_status" value={i.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
      <SectionCard title="Hak baca EQUA atas data mitra (tercantum di kontrak)">
        <ul className="list-inside list-disc text-sm">
          {d.readRights.map((r) => (
            <li key={r.key}>{r.label}</li>
          ))}
        </ul>
      </SectionCard>
      {d.accounts ? (
        <SectionCard title="Akun mitra" description="Akun aktif setelah pemilik menyetujui (Persetujuan). Operator depot masuk POS dengan PIN; pemilik mitra masuk portal /mitra.">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Pengguna</TableHead>
                  <TableHead>Peran</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>PIN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.accounts.map((a) => (
                  <TableRow key={a.userId}>
                    <TableCell>{a.fullName}</TableCell>
                    <TableCell>{a.username}</TableCell>
                    <TableCell>{a.roles.map((r) => label("role", r)).join(", ")}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="user_status" value={a.status} />
                    </TableCell>
                    <TableCell>
                      {isAdmin && a.roles.includes("depot_operator") && a.status === "active" ? (
                        <P3ActionForm action={issuePinAction.bind(null, d.tenant.id, a.userId)} submitLabel="Kode PIN" variant="outline" resetOnSuccess={false} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {isAdmin ? (
            <P3ActionForm action={registerOperatorAction.bind(null, d.tenant.id)} submitLabel="Buat akun mitra" testId="form-akun-mitra" className="mt-4 max-w-2xl">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nama lengkap" name="fullName" required />
                <Field label="Nama pengguna" name="username" required />
                <SelectField label="Peran" name="role" required defaultValue="depot_operator" options={[{ value: "depot_operator", label: "Operator depot (POS)" }, { value: "partner_owner", label: "Pemilik mitra (portal)" }]} />
                <SelectField label="Outlet (operator)" name="outletId" options={outletOpts} />
                <Field label="Nomor HP" name="phone" inputMode="tel" />
                <Field label="Alasan / dasar perjanjian" name="reason" required />
              </div>
            </P3ActionForm>
          ) : null}
        </SectionCard>
      ) : null}
      {d.devices ? (
        <SectionCard title="Tablet POS mitra">
          <ul className="grid gap-1 text-sm">
            {d.devices.map((dv) => (
              <li key={dv.id}>
                {dv.deviceCode} — {dv.name} · {dv.outletName ?? "-"} · <StatusBadge enumName="device_status" value={dv.status} /> {dv.lastSyncAt ? `· sinkron ${formatTanggalJam(dv.lastSyncAt)}` : ""}
              </li>
            ))}
          </ul>
          {can(ctx, "m10.device.register") ? (
            <P3ActionForm action={registerDeviceAction.bind(null, d.tenant.id)} submitLabel="Daftarkan tablet" testId="form-perangkat-mitra" className="mt-4 max-w-2xl" resetOnSuccess={false}>
              <div className="grid gap-3 sm:grid-cols-3">
                <SelectField label="Outlet" name="outletId" required options={outletOpts} />
                <Field label="Kode perangkat" name="deviceCode" required placeholder="TAB-M01" />
                <Field label="Nama perangkat" name="name" required />
              </div>
            </P3ActionForm>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
