import type { Metadata } from "next";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ReasonButton } from "@/components/m11-accounting/action-buttons";
import { FilterForm, FilterInput, FilterSelect, FormCheckbox, FormInput, FormSelect, PROFIT_CENTER_OPTIONS, exportHref } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { createAccountAction, deactivateAccountAction, importAccountsAction, reactivateAccountAction, updateAccountAction } from "../actions";

export const metadata: Metadata = { title: "Bagan akun" };

type Search = Promise<{ q?: string; jenis?: string; lini?: string; nonaktif?: string }>;

/**
 * Bagan akun & pusat laba (US-M11-01 KP-1): impor template akuntan (pratinjau → simpan), tambah/ubah akun berjejak,
 * nonaktifkan (tidak dihapus). Akuntan & pemilik melihat (baca-saja).
 */
export default async function AccountsPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.account.read");
  const sp = await searchParams;
  const [rows, centers] = await Promise.all([m11.listAccounts(ctx, { includeInactive: sp.nonaktif === "1" }), m11.listProfitCenters(ctx)]);
  const q = (sp.q ?? "").toLowerCase();
  const filtered = rows.filter(
    (r) => (!q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) && (!sp.jenis || r.type === sp.jenis) && (!sp.lini || r.profitCenter === sp.lini),
  );
  const canCreate = can(ctx, "m11.account.create");
  const canUpdate = can(ctx, "m11.account.update");
  const canDeactivate = can(ctx, "m11.account.deactivate");
  const typeOptions = enumOptions("account_type");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Bagan akun"
        description="Bagan akun dari template akuntan (K9) dengan pusat laba per lini L1–L5 dan umum/kantor. Akun tidak dihapus — dinonaktifkan; setiap perubahan berjejak."
        actions={<ExportButtons excelHref={exportHref("m11.accounts", "xlsx")} pdfHref={exportHref("m11.accounts", "pdf")} />}
      />

      <SectionCard title="Pusat laba" description="L1 diperlakukan sebagai pusat biaya yang dialokasikan ke L2 & L3 setiap akhir bulan (PAR-65).">
        <div className="flex flex-wrap gap-2" data-testid="pusat-laba">
          {centers.map((c) => (
            <ToneBadge key={c.code} tone={c.code === "SHARED" ? "neutral" : "info"}>
              {c.code} · {c.name}
            </ToneBadge>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={`Akun (${filtered.length})`}
        flush
        actions={
          <FilterForm action="/akuntansi/akun">
            <FilterInput name="q" value={sp.q} label="Cari" type="search" placeholder="Kode atau nama" />
            <FilterSelect name="jenis" value={sp.jenis} label="Jenis" options={typeOptions} emptyLabel="Semua" />
            <FilterSelect name="lini" value={sp.lini} label="Pusat laba" options={PROFIT_CENTER_OPTIONS} emptyLabel="Semua" />
            <FilterSelect name="nonaktif" value={sp.nonaktif} label="Status" options={[{ value: "1", label: "Termasuk nonaktif" }]} emptyLabel="Aktif saja" />
          </FilterForm>
        }
      >
        {filtered.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-akun">
              <TableHeader>
                <TableRow>
                  <TableHead>Kode</TableHead>
                  <TableHead>Nama</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Pusat laba</TableHead>
                  <TableHead>Penanda</TableHead>
                  <TableHead className="text-right">Pemakaian</TableHead>
                  {canDeactivate || canUpdate ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={a.id} className={a.isActive ? undefined : "opacity-60"}>
                    <TableCell className="font-mono">{a.code}</TableCell>
                    <TableCell className={a.isPostable ? undefined : "font-semibold"}>
                      {a.name}
                      {a.parentCode ? <span className="block text-xs text-muted-foreground">Induk {a.parentCode}</span> : null}
                    </TableCell>
                    <TableCell>{label("account_type", a.type)}</TableCell>
                    <TableCell>{a.profitCenter ?? "—"}</TableCell>
                    <TableCell className="space-x-1">
                      {!a.isPostable ? <ToneBadge tone="neutral">Induk</ToneBadge> : null}
                      {a.isCash ? <ToneBadge tone="info">Kas/bank</ToneBadge> : null}
                      {a.isInternalTransfer ? <ToneBadge tone="warning">Internal</ToneBadge> : null}
                      {!a.isActive ? <ToneBadge tone="muted">Nonaktif</ToneBadge> : null}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {a.lineCount} baris · {a.mappingCount} pemetaan
                    </TableCell>
                    {canDeactivate || canUpdate ? (
                      <TableCell className="text-right">
                        {a.isActive && canDeactivate ? (
                          <M11ReasonButton
                            label="Nonaktifkan"
                            title={`Nonaktifkan akun ${a.code}?`}
                            description="Akun tidak dihapus. Akun yang masih dipakai pemetaan harus diganti pemetaannya dulu."
                            action={deactivateAccountAction.bind(null, a.id)}
                            destructive
                          />
                        ) : null}
                        {!a.isActive && canUpdate ? <M11ReasonButton label="Aktifkan" title={`Aktifkan kembali akun ${a.code}?`} action={reactivateAccountAction.bind(null, a.id)} /> : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada akun yang cocok" compact />
        )}
      </SectionCard>

      {canCreate ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard title="Impor template akuntan (K9)" description="Kolom: Kode, Nama, Jenis, Pusat laba, Induk, Saldo normal, Header, Internal, Kas. Pratinjau dulu, lalu simpan.">
            <M11ActionForm
              action={importAccountsAction}
              submitLabel="Pratinjau"
              variant="outline"
              testId="impor-akun"
              resetOnSuccess={false}
              extraButtons={
                <button type="submit" name="mode" value="commit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                  Simpan impor
                </button>
              }
            >
              <FormInput label="Berkas (CSV/Excel)" name="file" type="file" accept=".csv,.xlsx" required />
              <FormInput label="Alasan impor" name="reason" hint="Wajib saat menyimpan, mis. 'Template akuntan versi 1'." />
            </M11ActionForm>
          </SectionCard>

          <SectionCard title="Tambah akun" description="Kode & jenis tidak dapat diubah — buat akun baru lalu nonaktifkan yang lama.">
            <M11ActionForm action={createAccountAction} submitLabel="Tambah akun" testId="tambah-akun">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormInput label="Kode" name="code" required placeholder="6-1901" />
                <FormInput label="Nama akun" name="name" required />
                <FormSelect label="Jenis" name="type" options={typeOptions} required emptyLabel="Pilih jenis" />
                <FormSelect label="Pusat laba" name="profitCenter" options={PROFIT_CENTER_OPTIONS} emptyLabel="—" />
                <FormInput label="Kode induk" name="parentCode" placeholder="6-0000" />
              </div>
              <div className="flex flex-wrap gap-4">
                <FormCheckbox name="isHeader" label="Akun induk (tidak diposting)" />
                <FormCheckbox name="isCash" label="Akun kas/bank (arus kas)" />
                <FormCheckbox name="isInternalTransfer" label="Transfer internal (dieliminasi konsolidasi)" />
              </div>
            </M11ActionForm>
          </SectionCard>
        </div>
      ) : null}

      {canUpdate ? (
        <SectionCard title="Ubah nama / pusat laba akun" description="Perubahan berjejak (sebelum/sesudah + alasan).">
          <M11ActionForm action={updateAccountAction} submitLabel="Simpan perubahan" testId="ubah-akun">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormSelect label="Akun" name="accountId" required options={rows.map((r) => ({ value: r.id, label: `${r.code} ${r.name}` }))} emptyLabel="Pilih akun" />
              <FormInput label="Nama baru" name="name" />
              <FormSelect label="Pusat laba" name="profitCenter" options={PROFIT_CENTER_OPTIONS} emptyLabel="—" />
              <FormInput label="Alasan" name="reason" required />
            </div>
          </M11ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
