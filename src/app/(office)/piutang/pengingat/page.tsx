import { MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton } from "@/components/m5-receivables/action-buttons";
import { FilterDate, FilterForm, FormTextarea, PiiExportForm, ReminderBadge } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { openReminderAction, updateTemplateAction } from "../actions";

export const metadata: Metadata = { title: "Pengingat jatuh tempo" };

/**
 * Pengingat jatuh tempo lewat WA (US-M5-05): daftar harian H-n/H+n (PAR-13) per pelanggan dengan total sisa; tombol
 * membuka WhatsApp dengan template terisi (nomor faktur, jumlah, jatuh tempo, rekening PT) dan status "Dibuka"
 * tercatat. Faktur bersengketa tidak diingatkan; pelanggan tagihan bulanan diingatkan berdasarkan faktur bulanan.
 * Template dikelola pemilik.
 */
export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ tanggal?: string }> }) {
  const { ctx } = await requirePermission("m5.reminder.read");
  const sp = await searchParams;
  const list = await m5.listReminders(ctx, { date: sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : null });
  const templates = await m5.listReceivableTemplates(ctx);
  const canSend = can(ctx, "m5.reminder.send");
  const canEditTemplate = can(ctx, "m1.wa_template.update");
  const canCard = can(ctx, "m5.aging.read");
  const active = list.groups.filter((g) => g.status !== "skipped");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pengingat jatuh tempo"
        description={`Daftar ${formatTanggal(list.date)}: H-${list.daysBeforeDue} sebelum dan H+${list.daysAfterDue} sesudah jatuh tempo (PAR-13). Bila WhatsApp Business API aktif, pengingat terkirim otomatis pagi hari.`}
      />
      <FilterForm action="/piutang/pengingat" testId="filter-pengingat">
        <FilterDate name="tanggal" value={list.date} label="Tanggal" />
      </FilterForm>

      <SectionCard
        title={`${active.length} pelanggan perlu diingatkan · total ${formatRupiah(active.reduce((s, g) => s + g.total, 0))}`}
        actions={<PiiExportForm reportKey="m5.reminders" filters={{ date: list.date }} testId="ekspor-pengingat" />}
        flush
      >
        {list.groups.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-pengingat">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Pengingat</TableHead>
                  <TableHead>Faktur</TableHead>
                  <TableHead className="text-right">Total sisa</TableHead>
                  <TableHead>Status</TableHead>
                  {canSend ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.groups.map((g) => (
                  <TableRow key={g.key} className="align-top" data-testid={`pengingat-${g.customerCode ?? g.customerId}-${g.kind}`}>
                    <TableCell>
                      {canCard ? (
                        <Link href={`/piutang/pelanggan/${g.customerId}`} className="font-medium text-primary hover:underline">
                          {g.customerName}
                        </Link>
                      ) : (
                        <span className="font-medium">{g.customerName}</span>
                      )}
                      {g.monthlyBilling ? <span className="block text-xs text-muted-foreground">Tagihan bulanan — diingatkan atas faktur bulanan</span> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{m5.reminderKindLabel(g.kind, list)}</TableCell>
                    <TableCell className="text-xs">
                      <ul className="grid gap-0.5">
                        {g.invoices.map((i) => (
                          <li key={i.id}>
                            <Link href={`/piutang/faktur/${i.id}`} className="hover:underline">
                              {i.number}
                            </Link>{" "}
                            · jatuh tempo {formatTanggal(i.dueDate, { weekday: false })} · {formatRupiah(i.outstanding)}
                            {i.skipReason ? <span className="block text-muted-foreground">{i.skipReason}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(g.total)}</TableCell>
                    <TableCell>
                      <ReminderBadge status={g.status} />
                      {g.openedAt ? <span className="block text-xs text-muted-foreground">{formatTanggalJam(g.openedAt)}</span> : null}
                    </TableCell>
                    {canSend ? (
                      <TableCell>
                        {g.status !== "skipped" ? (
                          <M5ActionButton
                            label={g.status === "opened" ? "Buka lagi" : "Buka WhatsApp"}
                            icon={<MessageCircle aria-hidden />}
                            variant={g.status === "opened" ? "outline" : "default"}
                            action={openReminderAction.bind(null, g.customerId, g.kind, list.date)}
                            testId={`buka-wa-${g.customerCode ?? g.customerId}-${g.kind}`}
                          />
                        ) : (
                          <ToneBadge tone="muted">Ditunda (sengketa)</ToneBadge>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada pengingat pada tanggal ini" description="Pengingat muncul untuk faktur yang jatuh tempo sesuai PAR-13." compact />
        )}
      </SectionCard>

      <SectionCard
        title="Template pesan"
        description={canEditTemplate ? "Template dikelola pemilik; setiap perubahan menjadi versi baru dan berjejak. Variabel ditulis {{nama_variabel}}." : "Template dikelola pemilik (baca saja)."}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {templates.map((tpl) => (
            <div key={tpl.kind} className="grid gap-2 rounded-lg border p-4" data-testid={`template-${tpl.kind}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{label("wa_message_kind", tpl.kind)}</p>
                <ToneBadge tone={tpl.isDefault ? "muted" : "info"}>{tpl.isDefault ? "Bawaan" : `Versi ${tpl.version}`}</ToneBadge>
              </div>
              <pre className="text-sm whitespace-pre-wrap text-muted-foreground">{tpl.body}</pre>
              <p className="text-xs text-muted-foreground">Wajib memuat: {m5.TEMPLATE_REQUIRED_VARIABLES[tpl.kind].map((v) => `{{${v}}}`).join(", ")}</p>
              {canEditTemplate ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-primary">Ubah template</summary>
                  <M5ActionForm action={updateTemplateAction} submitLabel="Simpan versi baru" className="mt-2" resetOnSuccess={false}>
                    <input type="hidden" name="kind" value={tpl.kind} />
                    <FormTextarea label="Isi template" name="body" defaultValue={tpl.body} rows={7} required />
                    <FormTextarea label="Alasan perubahan" name="reason" required />
                  </M5ActionForm>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
