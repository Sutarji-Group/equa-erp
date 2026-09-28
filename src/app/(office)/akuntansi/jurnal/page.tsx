import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ActionButton, M11ReasonButton } from "@/components/m11-accounting/action-buttons";
import {
  Amount,
  FilterForm,
  FilterInput,
  FilterSelect,
  FormCheckbox,
  FormInput,
  FormSelect,
  JournalKindBadge,
  JournalLinesInput,
  JournalLink,
  JournalStatusBadge,
  QueueStatusBadge,
  exportHref,
  hrefWith,
  periodLabel,
  periodOptions,
} from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam, monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { generateRecurringAction, generateRetroactiveAction, markReviewedAction, retryAllQueueAction, retryQueueAction, saveRecurringAction, verifyRetroactiveAction } from "../actions";

export const metadata: Metadata = { title: "Jurnal" };

type Search = Promise<{
  tab?: string;
  periode?: string;
  jenis?: string;
  status?: string;
  q?: string;
  sumberTipe?: string;
  sumberId?: string;
  tinjauan?: string;
  antrean?: string;
  tanggal?: string;
}>;

const TABS = [
  { key: "jurnal", label: "Jurnal" },
  { key: "antrean", label: "Daftar tunggu" },
  { key: "tinjauan", label: "Tinjauan pemilik" },
  { key: "harian", label: "Rekonsiliasi harian" },
  { key: "berulang", label: "Jurnal berulang" },
  { key: "retroaktif", label: "Retroaktif" },
] as const;

/**
 * Jurnal (US-M11-02, US-M11-03): daftar jurnal otomatis & manual dengan ketertelusuran ke sumber, daftar tunggu
 * (pemetaan hilang/akun nonaktif), daftar tinjauan pemilik (≤ PAR-20), rekonsiliasi jurnal per hari vs H+0, jurnal
 * berulang, dan pembangkitan retroaktif.
 */
export default async function JournalsPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.journal.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const tab = sp.antrean ? "antrean" : sp.tinjauan ? "tinjauan" : (TABS.find((t) => t.key === sp.tab)?.key ?? "jurnal");
  const canCreate = can(ctx, "m11.journal.create");
  const canRetry = can(ctx, "m11.journal_queue.retry");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Jurnal"
        description="Jurnal otomatis dari setiap transaksi operasional (tidak dapat diubah — koreksi lewat sumbernya) dan jurnal manual berlampiran dengan persetujuan sesuai ambang."
        actions={
          <div className="flex flex-wrap gap-2">
            {canCreate ? (
              <Button asChild size="sm">
                <Link href="/akuntansi/jurnal/baru">Jurnal manual baru</Link>
              </Button>
            ) : null}
            <ExportButtons excelHref={exportHref("m11.journals", "xlsx", { period: sp.periode ?? null })} pdfHref={exportHref("m11.journals", "pdf", { period: sp.periode ?? null })} />
          </div>
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Bagian jurnal">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "tinjauan" ? hrefWith("/akuntansi/jurnal", { tinjauan: monthOf(today) }) : hrefWith("/akuntansi/jurnal", { tab: t.key === "jurnal" ? null : t.key })}
            className={`rounded-md border px-3 py-1.5 text-sm ${tab === t.key ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent"}`}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "jurnal" ? <JournalList ctx={ctx} sp={sp} today={today} /> : null}
      {tab === "antrean" ? <QueueTab ctx={ctx} canRetry={canRetry} /> : null}
      {tab === "tinjauan" ? <ReviewTab ctx={ctx} period={sp.tinjauan ?? monthOf(today)} today={today} /> : null}
      {tab === "harian" ? <DailyTab ctx={ctx} date={sp.tanggal ?? today} /> : null}
      {tab === "berulang" ? <RecurringTab ctx={ctx} /> : null}
      {tab === "retroaktif" ? <RetroactiveTab ctx={ctx} /> : null}
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof requirePermission>>["ctx"];

async function JournalList({ ctx, sp, today }: { ctx: Ctx; sp: Awaited<Search>; today: string }) {
  const rows = await m11.listJournals(ctx, {
    period: sp.periode ?? null,
    kind: (sp.jenis as never) ?? null,
    status: (sp.status as never) ?? null,
    q: sp.q ?? null,
    sourceObjectType: sp.sumberTipe ?? null,
    sourceObjectId: sp.sumberId ?? null,
  });
  return (
    <SectionCard
      title={sp.sumberId ? `Jurnal untuk ${m11.SOURCE_OBJECT_LABELS[sp.sumberTipe ?? ""] ?? sp.sumberTipe} ini` : `Jurnal (${rows.length})`}
      flush
      actions={
        <FilterForm action="/akuntansi/jurnal">
          <FilterSelect name="periode" value={sp.periode} label="Periode" options={periodOptions(monthOf(today), 18, 1)} emptyLabel="Semua" />
          <FilterSelect name="jenis" value={sp.jenis} label="Jenis" options={enumOptions("journal_kind")} emptyLabel="Semua" />
          <FilterSelect name="status" value={sp.status} label="Status" options={enumOptions("journal_status")} emptyLabel="Semua" />
          <FilterInput name="q" value={sp.q} label="Cari" type="search" placeholder="Nomor atau keterangan" />
        </FilterForm>
      }
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table data-testid="tabel-jurnal">
            <TableHeader>
              <TableRow>
                <TableHead>Nomor</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead>Keterangan</TableHead>
                <TableHead>Jenis</TableHead>
                <TableHead>Modul</TableHead>
                <TableHead className="text-right">Nilai</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <JournalLink id={j.id} number={j.number} />
                    {j.period && j.period !== j.journalDate.slice(0, 7) ? <span className="block text-xs text-muted-foreground">periode {j.period}</span> : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatTanggal(j.journalDate, { weekday: false })}
                    {j.originPeriod ? <span className="block text-xs text-warning-foreground">asal periode {j.originPeriod}</span> : null}
                  </TableCell>
                  <TableCell className="max-w-96 text-sm">{j.description}</TableCell>
                  <TableCell>
                    <JournalKindBadge kind={j.kind} />
                  </TableCell>
                  <TableCell className="text-xs">{j.module ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <Amount value={j.totalDebit} />
                  </TableCell>
                  <TableCell className="space-x-1">
                    <JournalStatusBadge status={j.status} />
                    {j.reversed ? <ToneBadge tone="muted">Dibalik</ToneBadge> : null}
                    {j.requiresOwnerReview && !j.ownerReviewedAt ? <ToneBadge tone="warning">Tinjauan pemilik</ToneBadge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="Belum ada jurnal yang cocok" description="Jurnal otomatis terbentuk saat transaksi lapangan tersinkron." compact />
      )}
    </SectionCard>
  );
}

async function QueueTab({ ctx, canRetry }: { ctx: Ctx; canRetry: boolean }) {
  const rows = await m11.listJournalQueue(ctx, { status: "pending" });
  return (
    <SectionCard
      title={`Daftar tunggu jurnal (${rows.length})`}
      description="Peristiwa yang gagal terposting (pemetaan hilang, akun nonaktif) — tidak ada yang hilang. Lengkapi pemetaan lalu proses ulang."
      flush
      actions={canRetry && rows.length ? <M11ActionButton label="Proses ulang semua" action={retryAllQueueAction} testId="proses-ulang-semua" /> : null}
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table data-testid="tabel-antrean">
            <TableHeader>
              <TableRow>
                <TableHead>Peristiwa</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead>Alasan</TableHead>
                <TableHead>Percobaan</TableHead>
                <TableHead>Status</TableHead>
                {canRetry ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((q) => (
                <TableRow key={q.id}>
                  <TableCell className="font-mono text-xs">{q.eventKey}</TableCell>
                  <TableCell className="text-sm">{q.journalDate ? formatTanggal(q.journalDate, { weekday: false }) : "—"}</TableCell>
                  <TableCell className="max-w-96 text-sm">
                    {label("journal_queue_reason", q.reason)}
                    <span className="block text-xs text-muted-foreground">{q.message}</span>
                  </TableCell>
                  <TableCell>{q.attempts}</TableCell>
                  <TableCell>
                    <QueueStatusBadge status={q.status} />
                  </TableCell>
                  {canRetry ? (
                    <TableCell className="text-right">
                      <M11ActionButton label="Proses ulang" action={retryQueueAction.bind(null, q.id)} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="Daftar tunggu kosong" description="Semua peristiwa keuangan sudah menjadi jurnal." compact />
      )}
    </SectionCard>
  );
}

async function ReviewTab({ ctx, period, today }: { ctx: Ctx; period: string; today: string }) {
  const periods = await m11.listPeriods(ctx);
  const p = periods.find((x) => x.period === period && x.id);
  const rows = p?.id ? await m11.ownerReviewList(ctx, { periodId: p.id }) : [];
  const unreviewed = rows.filter((r) => !r.ownerReviewedAt);
  return (
    <SectionCard
      title={`Daftar tinjauan pemilik — ${periodLabel(period)}`}
      description="Jurnal manual ≤ ambang persetujuan (PAR-20) terposting oleh Admin Keuangan dan wajib ditandai 'ditinjau' pemilik sebelum periode ditutup (PTB-12)."
      flush
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <FilterForm action="/akuntansi/jurnal">
            <FilterSelect name="tinjauan" value={period} label="Periode" options={periodOptions(monthOf(today), 12)} />
          </FilterForm>
          {p?.id && can(ctx, "m11.journal.review") && unreviewed.length ? <M11ActionButton label={`Tandai ditinjau (${unreviewed.length})`} variant="default" action={markReviewedAction.bind(null, p.id)} testId="tandai-ditinjau" /> : null}
        </div>
      }
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table data-testid="tabel-tinjauan">
            <TableHeader>
              <TableRow>
                <TableHead>Nomor</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead>Keterangan</TableHead>
                <TableHead className="text-right">Nilai</TableHead>
                <TableHead>Ditinjau</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <JournalLink id={j.id} number={j.number} />
                  </TableCell>
                  <TableCell>{formatTanggal(j.journalDate, { weekday: false })}</TableCell>
                  <TableCell className="max-w-96 text-sm">{j.description}</TableCell>
                  <TableCell className="text-right">
                    <Amount value={j.totalDebit} />
                  </TableCell>
                  <TableCell>{j.ownerReviewedAt ? <ToneBadge tone="success">{formatTanggalJam(j.ownerReviewedAt)}</ToneBadge> : <ToneBadge tone="warning">Belum</ToneBadge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="Tidak ada jurnal manual yang perlu ditinjau pada periode ini" compact />
      )}
    </SectionCard>
  );
}

async function DailyTab({ ctx, date }: { ctx: Ctx; date: string }) {
  const r = await m11.dailyReconciliation(ctx, { date });
  return (
    <SectionCard
      title={`Rekonsiliasi jurnal per hari — ${formatTanggal(date)}`}
      description={`Jumlah & nilai peristiwa H+0 dibandingkan jurnal otomatis bertanggal sama.${r.h0Published ? "" : " Ringkasan H+0 hari ini belum terbit."}`}
      flush
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <FilterForm action="/akuntansi/jurnal">
            <input type="hidden" name="tab" value="harian" />
            <FilterInput name="tanggal" value={date} label="Tanggal" type="date" />
          </FilterForm>
          <ExportButtons excelHref={exportHref("m11.daily_reconciliation", "xlsx", { date })} />
        </div>
      }
    >
      <div className="overflow-x-auto">
        <Table data-testid="tabel-rekonsiliasi-harian">
          <TableHeader>
            <TableRow>
              <TableHead>Modul</TableHead>
              <TableHead>Peristiwa</TableHead>
              <TableHead className="text-right">Jumlah peristiwa</TableHead>
              <TableHead className="text-right">Jumlah jurnal</TableHead>
              <TableHead className="text-right">Nilai peristiwa</TableHead>
              <TableHead className="text-right">Nilai jurnal</TableHead>
              <TableHead>Daftar tunggu</TableHead>
              <TableHead>Cocok</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((x) => (
              <TableRow key={x.key}>
                <TableCell>{x.module}</TableCell>
                <TableCell>{x.label}</TableCell>
                <TableCell className="text-right">{x.events}</TableCell>
                <TableCell className="text-right">{x.journals}</TableCell>
                <TableCell className="text-right">
                  <Amount value={x.eventValue} />
                </TableCell>
                <TableCell className="text-right">
                  <Amount value={x.journalValue} />
                </TableCell>
                <TableCell>{x.queued ? <ToneBadge tone="warning">{x.queued}</ToneBadge> : "—"}</TableCell>
                <TableCell>
                  <ToneBadge tone={x.match ? "success" : "danger"} dot>
                    {x.match ? "Cocok" : "Selisih"}
                  </ToneBadge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
  );
}

async function RecurringTab({ ctx }: { ctx: Ctx }) {
  const [rows, options] = await Promise.all([m11.listRecurringJournals(ctx), m11.formOptions(ctx)]);
  const canEdit = can(ctx, "m11.recurring_journal.update");
  return (
    <div className="grid gap-6">
      <SectionCard
        title="Jurnal berulang bulanan"
        description="Sewa (termasuk aset pribadi yang disewakan ke PT, K15), listrik, gaji — dibuat sebagai DRAF tiap bulan dan tetap wajib lampiran & persetujuan sesuai ambang. Penyusutan otomatis, bukan jurnal berulang."
        flush
        actions={canEdit ? <M11ActionButton label="Buat draf bulan ini" action={generateRecurringAction} testId="buat-draf-berulang" /> : null}
      >
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-berulang">
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Terakhir dibuat</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {r.name}
                      {r.isAccrual ? <ToneBadge tone="info" className="ml-2">Akrual</ToneBadge> : null}
                    </TableCell>
                    <TableCell>{label("recurring_journal_template", r.template)}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0)} />
                    </TableCell>
                    <TableCell>tgl {r.dayOfMonth}</TableCell>
                    <TableCell>{r.lastGeneratedPeriod ?? "—"}</TableCell>
                    <TableCell>{r.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada jurnal berulang" compact />
        )}
      </SectionCard>
      {canEdit ? (
        <SectionCard title="Tambah jurnal berulang">
          <M11ActionForm action={saveRecurringAction} submitLabel="Simpan jurnal berulang" testId="form-berulang">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormInput label="Nama" name="name" required />
              <FormSelect label="Template" name="template" options={enumOptions("recurring_journal_template")} required emptyLabel="Pilih" />
              <FormInput label="Keterangan" name="description" required />
              <FormInput label="Tanggal tiap bulan" name="dayOfMonth" type="number" min="1" max="28" defaultValue={1} />
            </div>
            <FormCheckbox name="isAccrual" label="Akrual (dibalik otomatis tanggal 1 bulan berikutnya)" />
            <JournalLinesInput accounts={options.accounts} outlets={options.outlets} rows={4} />
          </M11ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}

async function RetroactiveTab({ ctx }: { ctx: Ctx }) {
  const runs = await m11.listRetroactiveRuns(ctx);
  return (
    <SectionCard
      title="Jurnal retroaktif (PTB-47)"
      description="Bila M11 menyusul modul operasional, jurnal seluruh peristiwa sejak cut-over dibangkitkan dari data operasional dan diverifikasi akuntan sebelum periode pertama ditutup."
      flush
      actions={can(ctx, "m11.retroactive.run") ? <M11ActionButton label="Bangkitkan jurnal retroaktif" action={generateRetroactiveAction} testId="bangkitkan-retroaktif" /> : null}
    >
      {runs.length ? (
        <div className="overflow-x-auto">
          <Table data-testid="tabel-retroaktif">
            <TableHeader>
              <TableRow>
                <TableHead>Dijalankan</TableHead>
                <TableHead>Rentang</TableHead>
                <TableHead className="text-right">Baru</TableHead>
                <TableHead className="text-right">Sudah ada</TableHead>
                <TableHead className="text-right">Daftar tunggu</TableHead>
                <TableHead>Periode</TableHead>
                <TableHead>Verifikasi akuntan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatTanggalJam(r.startedAt)}</TableCell>
                  <TableCell>
                    {r.fromDate} s.d. {r.toDate}
                  </TableCell>
                  <TableCell className="text-right">{r.posted}</TableCell>
                  <TableCell className="text-right">{r.duplicates}</TableCell>
                  <TableCell className="text-right">{r.queued}</TableCell>
                  <TableCell>{r.periods.join(", ") || "—"}</TableCell>
                  <TableCell>
                    {r.verifiedAt ? (
                      <ToneBadge tone="success">Diverifikasi {formatTanggal(r.verifiedAt, { weekday: false })}</ToneBadge>
                    ) : can(ctx, "m11.retroactive.attest") ? (
                      <M11ReasonButton label="Verifikasi" title="Verifikasi jurnal retroaktif" description="Catatan verifikasi disimpan pada setiap periode yang tersentuh." confirmLabel="Verifikasi" action={verifyRetroactiveAction.bind(null, r.id)} />
                    ) : (
                      <ToneBadge tone="warning">Belum</ToneBadge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="Belum pernah dibangkitkan" compact />
      )}
    </SectionCard>
  );
}
