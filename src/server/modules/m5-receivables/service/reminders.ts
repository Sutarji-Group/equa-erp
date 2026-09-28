/**
 * M5 — pengingat jatuh tempo lewat WA (US-M5-05; FR-M5-05, NFR-20, K21; PAR-13):
 * daftar harian H-3 sebelum jatuh tempo & H+1 sesudahnya per pelanggan dengan total sisa; tombol membuka WhatsApp
 * dengan template terisi (nomor faktur, jumlah, jatuh tempo, rekening PT) dan status "dibuka" tercatat. Faktur
 * bersengketa tidak diingatkan (7.5.6); pelanggan tagihan bulanan diingatkan berdasarkan faktur bulanan; faktur saldo
 * awal diingatkan setelah total saldo awal ditandatangani. Bila WhatsApp Cloud API aktif (`WA_PROVIDER=cloud_api`),
 * job harian mengirim otomatis tanpa mengubah alur (KP-2).
 */
import "server-only";

import { and, eq, gt, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { customers, invoices, receivableReminders, waMessageLogs } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, isBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { buildWaLink, getWhatsAppProvider, recordWaOpened, renderTemplate, type WhatsAppProvider } from "@/server/core/wa";

import { openingSignoff } from "./common";
import { disputeSuspended } from "./credit-hold";
import { customerBankAccount } from "./payments";
import { activeTemplate, companyName } from "./templates";

export type ReminderKind = "before_due" | "after_due";

export type ReminderGroup = {
  key: string;
  customerId: string;
  customerName: string;
  customerCode: string | null;
  waPhone: string;
  monthlyBilling: boolean;
  kind: ReminderKind;
  invoices: { id: string; number: string; kind: string; dueDate: string; outstanding: number; status: "scheduled" | "opened" | "skipped"; skipReason: string | null }[];
  total: number;
  status: "scheduled" | "opened" | "skipped";
  openedAt: Date | null;
};

type Candidate = typeof invoices.$inferSelect & { customerName: string; customerCode: string | null; waPhone: string; monthlyBilling: boolean; reminderKind: ReminderKind; skipReason: string | null };

/** Faktur yang perlu diingatkan pada `date` (H-PAR-13 & H+PAR-13). */
async function candidates(tx: Tx, tenantId: string, date: BusinessDate): Promise<Candidate[]> {
  const par13 = await params.get(tx, "PAR-13", date);
  const beforeDue = addDays(date, par13.days_before_due);
  const afterDue = addDays(date, -par13.days_after_due);
  const signoff = await openingSignoff(tx, tenantId);
  const rows = await tx
    .select({ inv: invoices, name: customers.name, code: customers.code, wa: customers.waPhone, monthly: customers.monthlyBilling })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.tenantId, tenantId), gt(invoices.outstandingAmount, 0), or(eq(invoices.dueDate, beforeDue), eq(invoices.dueDate, afterDue))));
  const out: Candidate[] = [];
  for (const r of rows) {
    // Pelanggan tagihan bulanan: hanya faktur bulanan yang diingatkan (KP-3).
    if (r.monthly && r.inv.kind !== "monthly") continue;
    if (r.inv.isOpeningBalance && signoff?.status !== "signed") continue;
    const reminderKind: ReminderKind = r.inv.dueDate === beforeDue ? "before_due" : "after_due";
    out.push({
      ...r.inv,
      customerName: r.name,
      customerCode: r.code,
      waPhone: r.wa,
      monthlyBilling: r.monthly,
      reminderKind,
      skipReason: disputeSuspended(r.inv, date) ? "Faktur bersengketa — pengingat ditunda sampai diputuskan (7.5.6)." : null,
    });
  }
  return out;
}

/** Daftar pengingat harian per pelanggan (KP-1) — gabungan kandidat & status "dibuka" yang tercatat. */
export async function listReminders(ctx: ActorContext, input: { date?: BusinessDate | null } = {}, opts: { tx?: Tx } = {}): Promise<{ date: BusinessDate; groups: ReminderGroup[] }> {
  await authorize(ctx, "m5.reminder.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = input.date && isBusinessDate(input.date) ? input.date : ctxBusinessDate(ctx);
  return { date, groups: await reminderGroups(tx, ctx.tenantId, date) };
}

async function reminderGroups(tx: Tx, tenantId: string, date: BusinessDate): Promise<ReminderGroup[]> {
  const list = await candidates(tx, tenantId, date);
  const ids = list.map((c) => c.id);
  const logged = ids.length ? await tx.select().from(receivableReminders).where(inArray(receivableReminders.invoiceId, ids)) : [];
  const groups = new Map<string, ReminderGroup>();
  for (const c of list) {
    const key = `${c.customerId}|${c.reminderKind}`;
    const rec = logged.find((l) => l.invoiceId === c.id && l.kind === c.reminderKind);
    const status: ReminderGroup["invoices"][number]["status"] = c.skipReason ? "skipped" : rec?.status === "opened" ? "opened" : "scheduled";
    const g =
      groups.get(key) ??
      ({
        key,
        customerId: c.customerId,
        customerName: c.customerName,
        customerCode: c.customerCode,
        waPhone: c.waPhone,
        monthlyBilling: c.monthlyBilling,
        kind: c.reminderKind,
        invoices: [],
        total: 0,
        status: "scheduled",
        openedAt: null,
      } satisfies ReminderGroup);
    g.invoices.push({ id: c.id, number: c.number, kind: c.kind, dueDate: c.dueDate, outstanding: c.outstandingAmount, status, skipReason: c.skipReason });
    if (status !== "skipped") g.total += c.outstandingAmount;
    if (rec?.openedAt && (!g.openedAt || rec.openedAt > g.openedAt)) g.openedAt = rec.openedAt;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const active = g.invoices.filter((i) => i.status !== "skipped");
    g.status = active.length === 0 ? "skipped" : active.every((i) => i.status === "opened") ? "opened" : "scheduled";
  }
  return [...groups.values()].sort((a, b) => (a.kind === b.kind ? a.customerName.localeCompare(b.customerName, "id") : a.kind === "after_due" ? -1 : 1));
}

async function renderReminder(tx: Tx, tenantId: string, date: BusinessDate, g: ReminderGroup) {
  const active = g.invoices.filter((i) => i.status !== "skipped");
  if (!active.length) throw new DomainError("NOTHING_TO_REMIND", "Semua faktur pelanggan ini sedang bersengketa — pengingat ditunda (7.5.6).");
  const tplKind = g.kind === "before_due" ? "reminder_before_due" : "reminder_after_due";
  const tpl = await activeTemplate(tx, tenantId, tplKind);
  const bank = await customerBankAccount(tx, tenantId);
  const due = [...new Set(active.map((i) => i.dueDate))].map((d) => formatTanggal(d, { weekday: false })).join(", ");
  const { text } = renderTemplate(tpl.body, {
    nama_pelanggan: g.customerName,
    nomor_faktur: active.map((i) => i.number).join(", "),
    jumlah: formatRupiah(g.total),
    jatuh_tempo: due,
    rekening: bank?.text ?? "rekening resmi usaha",
    nama_rekening: bank?.accountName ?? "",
    nama_usaha: await companyName(tx, tenantId, date),
  });
  return { text, tpl, active };
}

const openSchema = z.object({
  customerId: z.string().uuid(),
  kind: z.enum(["before_due", "after_due"]),
  date: z.string().refine((v) => isBusinessDate(v), { error: "Tanggal tidak valid." }).optional().nullable(),
});

/** Tombol "Buka WhatsApp" (KP-1): template terisi → tautan wa.me; status "dibuka" tercatat per faktur. */
export async function openReminder(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<{ link: string; text: string }> {
  await authorize(ctx, "m5.reminder.send", { tx: opts.tx });
  const data = parseInput(openSchema, input);
  return runService(ctx, opts, async (tx) => {
    const date = data.date ?? ctxBusinessDate(ctx);
    const groups = await reminderGroups(tx, ctx.tenantId, date);
    const g = groups.find((x) => x.customerId === data.customerId && x.kind === data.kind);
    if (!g) throw new DomainError("NO_REMINDER", "Tidak ada faktur yang perlu diingatkan untuk pelanggan ini pada tanggal tersebut.");
    const { text, tpl, active } = await renderReminder(tx, ctx.tenantId, date, g);
    const link = buildWaLink(g.waPhone, text);
    const log = await recordWaOpened(tx, ctx, {
      kind: tpl.kind,
      toPhone: g.waPhone,
      renderedText: text,
      templateId: tpl.id,
      customerId: g.customerId,
      objectType: "receivable_reminder",
      objectId: `${g.customerId}:${g.kind}:${date}`,
    });
    await markOpened(tx, ctx, { tenantId: ctx.tenantId, customerId: g.customerId, kind: g.kind, date, invoices: active, total: g.total, waMessageLogId: log.id, openedBy: ctx.userId });
    await auditRecord(tx, {
      ctx,
      objectType: "customer",
      objectId: g.customerId,
      action: "reminder_opened",
      after: { kind: g.kind, invoices: active.map((i) => i.number), total: g.total, date },
      rule: "US-M5-05 KP-1",
    });
    return { link, text };
  });
}

async function markOpened(
  tx: Tx,
  ctx: ActorContext,
  input: { tenantId: string; customerId: string; kind: ReminderKind; date: BusinessDate; invoices: { id: string }[]; total: number; waMessageLogId: string | null; openedBy: string | null },
) {
  for (const inv of input.invoices) {
    const [row] = await tx
      .select()
      .from(receivableReminders)
      .where(and(eq(receivableReminders.invoiceId, inv.id), eq(receivableReminders.kind, input.kind)))
      .limit(1);
    if (row) {
      await tx
        .update(receivableReminders)
        .set({ status: "opened", openedAt: ctx.now, openedBy: input.openedBy, waMessageLogId: input.waMessageLogId, totalOutstanding: input.total, updatedAt: ctx.now })
        .where(eq(receivableReminders.id, row.id));
    } else {
      await tx.insert(receivableReminders).values({
        tenantId: input.tenantId,
        customerId: input.customerId,
        invoiceId: inv.id,
        kind: input.kind,
        scheduledDate: input.date,
        totalOutstanding: input.total,
        status: "opened",
        openedAt: ctx.now,
        openedBy: input.openedBy,
        waMessageLogId: input.waMessageLogId,
      });
    }
  }
}

export type ReminderRunSummary = { date: BusinessDate; groups: number; scheduled: number; skipped: number; autoSent: number };

/**
 * Job harian: catat pengingat Dijadwalkan (idempoten per faktur & jenis), yang bersengketa Dilewati; beri tahu Admin
 * Keuangan; bila Cloud API aktif kirim otomatis (status dibuka/terkirim tercatat).
 */
export async function generateReminders(tx: Tx, ctx: ActorContext, tenantId: string, date: BusinessDate, opts: { provider?: WhatsAppProvider } = {}): Promise<ReminderRunSummary> {
  const groups = await reminderGroups(tx, tenantId, date);
  const summary: ReminderRunSummary = { date, groups: groups.length, scheduled: 0, skipped: 0, autoSent: 0 };
  for (const g of groups) {
    for (const inv of g.invoices) {
      const res = await tx
        .insert(receivableReminders)
        .values({
          tenantId,
          customerId: g.customerId,
          invoiceId: inv.id,
          kind: g.kind,
          scheduledDate: date,
          totalOutstanding: g.total,
          status: inv.status === "skipped" ? "skipped" : "scheduled",
          skipReason: inv.skipReason,
        })
        .onConflictDoNothing()
        .returning({ id: receivableReminders.id });
      if (res.length) {
        if (inv.status === "skipped") summary.skipped++;
        else summary.scheduled++;
      }
    }
  }
  let provider: WhatsAppProvider | null = opts.provider ?? null;
  if (!provider) {
    try {
      provider = getWhatsAppProvider();
    } catch {
      provider = null;
    }
  }
  if (provider && provider.kind === "cloud_api") {
    for (const g of groups.filter((x) => x.status === "scheduled")) {
      const { text, tpl, active } = await renderReminder(tx, tenantId, date, g);
      const res = await provider.send({ to: g.waPhone, text, kind: tpl.kind });
      if (res.mode === "cloud_api" && res.status === "sent") {
        const [log] = await tx
          .insert(waMessageLogs)
          .values({ tenantId, kind: tpl.kind, templateId: tpl.id, customerId: g.customerId, toPhone: g.waPhone, renderedText: text, objectType: "receivable_reminder", objectId: `${g.customerId}:${g.kind}:${date}`, provider: "cloud_api", status: "sent", providerMessageId: res.providerMessageId, sentAt: ctx.now })
          .returning({ id: waMessageLogs.id });
        await markOpened(tx, ctx, { tenantId, customerId: g.customerId, kind: g.kind, date, invoices: active, total: g.total, waMessageLogId: log!.id, openedBy: null });
        summary.autoSent++;
      }
    }
  }
  const pending = groups.filter((g) => g.status === "scheduled").length - summary.autoSent;
  if (pending > 0) {
    await notify(tx, {
      event: "receivable.reminder_due",
      tenantId,
      title: `${pending} pelanggan perlu diingatkan hari ini`,
      body: `Pengingat H-3 / H+1 (PAR-13) siap dibuka di WhatsApp dari daftar pengingat.`,
      valueText: formatTanggal(date, { weekday: false }),
      link: `/piutang/pengingat?tanggal=${date}`,
      groupKey: `receivable.reminder_due:${tenantId}:${date}`,
      now: ctx.now,
    });
  }
  return summary;
}
