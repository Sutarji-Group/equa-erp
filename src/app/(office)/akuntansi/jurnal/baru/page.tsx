import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { FormCheckbox, FormInput, FormSelect, FormTextarea, JournalLinesInput } from "@/components/m11-accounting/ui";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { formatRupiah } from "@/lib/money";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import * as m11 from "@/server/modules/m11-accounting";

import { createManualJournalAction } from "../../actions";

export const metadata: Metadata = { title: "Jurnal manual baru" };

type Search = Promise<{ template?: string }>;

/**
 * Jurnal manual (US-M11-03): tanggal, akun debit/kredit, pusat laba, jumlah, keterangan, lampiran WAJIB; template jenis
 * berulang; akrual; penanda utang / pembayaran utang (US-M11-07). > PAR-20 diajukan ke pemilik; ≤ PAR-20 terposting
 * dan masuk daftar tinjauan pemilik.
 */
export default async function NewJournalPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.journal.create");
  const sp = await searchParams;
  const [templates, options, payables] = await Promise.all([m11.manualTemplates(ctx), m11.formOptions(ctx), m11.payablesView(ctx)]);
  const tpl = templates.find((t) => t.key === sp.template) ?? null;
  const defaults = tpl
    ? tpl.key === "salary"
      ? [
          { accountId: tpl.debitAccountId, profitCenter: tpl.profitCenter },
          { accountId: tpl.creditAccountId, profitCenter: tpl.profitCenter },
          { accountId: tpl.deductionAccountId, profitCenter: tpl.profitCenter, memo: "Potongan ganti rugi dari rekap penggajian" },
        ]
      : [
          { accountId: tpl.debitAccountId, profitCenter: tpl.profitCenter },
          { accountId: tpl.creditAccountId, profitCenter: tpl.profitCenter },
        ]
    : [];
  const openJournalPayables = payables.rows.filter((r) => r.source === "journal");

  return (
    <div className="grid gap-6">
      <PageHeader title="Jurnal manual baru" backHref="/akuntansi/jurnal" backLabel="Jurnal" description="Lampiran bukti (foto/PDF) wajib. Jurnal di atas ambang persetujuan diajukan ke pemilik sebelum terposting." />

      <SectionCard title="Template" description="Pilih jenis berulang untuk mengisi akun bawaan (dapat diubah).">
        <div className="flex flex-wrap gap-2" data-testid="template-jurnal">
          {templates.map((t) => (
            <Link key={t.key} href={`/akuntansi/jurnal/baru?template=${t.key}`} className={`rounded-md border px-3 py-1.5 text-sm ${tpl?.key === t.key ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"}`} title={t.hint}>
              {t.label}
            </Link>
          ))}
        </div>
        {tpl ? <p className="mt-2 text-sm text-muted-foreground">{tpl.hint}</p> : null}
      </SectionCard>

      <SectionCard title="Isi jurnal">
        <M11ActionForm action={createManualJournalAction} submitLabel="Simpan" testId="form-jurnal-manual" resetOnSuccess={false}>
          {tpl ? <input type="hidden" name="template" value={tpl.key} /> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormInput label="Tanggal" name="date" type="date" required defaultValue={ctxBusinessDate(ctx)} />
            <FormInput label="Lampiran bukti (foto/PDF)" name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" />
            <FormInput label="Periode asal (koreksi periode terkunci)" name="originPeriod" placeholder="YYYY-MM" hint="Isi bila mengoreksi transaksi periode Dikunci (FR-M11-10)." />
          </div>
          <FormTextarea label="Keterangan" name="description" required defaultValue={tpl ? tpl.label : ""} />
          <JournalLinesInput accounts={options.accounts} outlets={options.outlets} rows={6} defaults={defaults} testId="baris-jurnal" />
          <div className="flex flex-wrap gap-6">
            <FormCheckbox name="isAccrual" label="Jurnal akrual" hint="Dibalik otomatis tanggal 1 periode berikutnya (P-07 langkah 3)." />
            <FormCheckbox name="submitNow" label="Ajukan/posting sekarang" hint="Tanpa centang: disimpan sebagai draf." defaultChecked />
          </div>
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Utang (US-M11-07)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <FormInput label="Utang kepada (bila jurnal ini membentuk utang)" name="payeeName" />
              <FormInput label="Jatuh tempo" name="payableDueDate" type="date" />
              <FormSelect label="Pemasok (opsional)" name="payableSupplierId" options={options.suppliers.map((s) => ({ value: s.id, label: s.name }))} emptyLabel="—" />
              <FormSelect
                label="Jurnal ini membayar utang"
                name="settlesPayableId"
                options={openJournalPayables.map((p) => ({ value: p.id, label: `${p.supplierName} · ${p.number ?? ""} · sisa ${formatRupiah(p.outstanding)}` }))}
                emptyLabel="—"
                className="sm:col-span-2"
              />
            </div>
          </details>
        </M11ActionForm>
      </SectionCard>
    </div>
  );
}
