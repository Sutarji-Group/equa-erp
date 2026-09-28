/**
 * M5 — template pesan WA piutang (US-M5-05 KP-2; NFR-20): pengingat H-3 / H+1, faktur, faktur bulanan, pernyataan
 * piutang, bukti pelunasan. Tabel `wa_templates` (milik M1) — versi baru setiap perubahan, lama dinonaktifkan; dikelola
 * pemilik (`m1.wa_template.update`). Bila tenant belum punya template untuk suatu jenis, dipakai teks bawaan di bawah.
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { waTemplates } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import type { BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ValidationError, parseInput } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";

export type M5TemplateKind = Extract<EnumValue<"wa_message_kind">, "reminder_before_due" | "reminder_after_due" | "invoice" | "monthly_invoice" | "statement" | "payment_receipt">;

export const M5_TEMPLATE_KINDS: readonly M5TemplateKind[] = ["reminder_before_due", "reminder_after_due", "invoice", "monthly_invoice", "statement", "payment_receipt"];

/** Variabel wajib per jenis (US-M5-05 KP-1: nomor faktur, jumlah, jatuh tempo, rekening PT). */
export const TEMPLATE_REQUIRED_VARIABLES: Record<M5TemplateKind, readonly string[]> = {
  reminder_before_due: ["nomor_faktur", "jumlah", "jatuh_tempo", "rekening"],
  reminder_after_due: ["nomor_faktur", "jumlah", "jatuh_tempo", "rekening"],
  invoice: ["nomor_faktur", "jumlah", "jatuh_tempo"],
  monthly_invoice: ["nomor_faktur", "jumlah", "jatuh_tempo"],
  statement: ["saldo", "tanggal"],
  payment_receipt: ["jumlah", "tanggal"],
};

export const DEFAULT_TEMPLATE_BODIES: Record<M5TemplateKind, string> = {
  reminder_before_due: [
    "Yth. {{nama_pelanggan}},",
    "Kami mengingatkan faktur {{nomor_faktur}} sebesar {{jumlah}} akan jatuh tempo pada {{jatuh_tempo}}.",
    "Pembayaran dapat ditransfer ke {{rekening}} a.n. {{nama_rekening}}.",
    "Abaikan pesan ini bila sudah membayar. Terima kasih — {{nama_usaha}}",
  ].join("\n"),
  reminder_after_due: [
    "Yth. {{nama_pelanggan}},",
    "Faktur {{nomor_faktur}} sebesar {{jumlah}} telah jatuh tempo pada {{jatuh_tempo}}.",
    "Mohon segera melakukan pembayaran ke {{rekening}} a.n. {{nama_rekening}} agar pesanan tempo berikutnya tetap dapat dilayani.",
    "Terima kasih — {{nama_usaha}}",
  ].join("\n"),
  invoice: [
    "Yth. {{nama_pelanggan}},",
    "Berikut faktur {{nomor_faktur}} tanggal {{tanggal_faktur}} sebesar {{jumlah}}, jatuh tempo {{jatuh_tempo}}.",
    "Pembayaran ke {{rekening}} a.n. {{nama_rekening}}. Harga tanpa PPN.",
    "{{tautan_pdf}}",
    "Terima kasih — {{nama_usaha}}",
  ].join("\n"),
  monthly_invoice: [
    "Yth. {{nama_pelanggan}},",
    "Faktur bulanan {{nomor_faktur}} untuk layanan {{periode}} sebesar {{jumlah}}, jatuh tempo {{jatuh_tempo}}.",
    "Rincian rit terlampir pada PDF. Pembayaran ke {{rekening}} a.n. {{nama_rekening}}.",
    "{{tautan_pdf}}",
    "Terima kasih — {{nama_usaha}}",
  ].join("\n"),
  statement: [
    "Yth. {{nama_pelanggan}},",
    "Pernyataan piutang per {{tanggal}}: saldo terutang {{saldo}} ({{jumlah_faktur}} faktur terbuka).",
    "{{rincian}}",
    "Mohon konfirmasi bila ada perbedaan. Terima kasih — {{nama_usaha}}",
  ].join("\n"),
  payment_receipt: [
    "Bukti pelunasan {{nama_usaha}}",
    "Pelanggan: {{nama_pelanggan}}",
    "Tanggal: {{tanggal}}",
    "Jumlah dibayar: {{jumlah}}",
    "Faktur: {{daftar_faktur}}",
    "Sisa piutang: {{sisa_piutang}}",
    "Terima kasih.",
  ].join("\n"),
};

export type ActiveTemplate = { id: string | null; kind: M5TemplateKind; name: string; body: string; version: number; isDefault: boolean };

/** Template aktif tenant (versi terbaru aktif) atau teks bawaan. */
export async function activeTemplate(tx: Tx, tenantId: string, kind: M5TemplateKind): Promise<ActiveTemplate> {
  const [row] = await tx
    .select()
    .from(waTemplates)
    .where(and(eq(waTemplates.tenantId, tenantId), eq(waTemplates.kind, kind), eq(waTemplates.isActive, true)))
    .orderBy(desc(waTemplates.version))
    .limit(1);
  if (row) return { id: row.id, kind, name: row.name, body: row.body, version: row.version, isDefault: false };
  return { id: null, kind, name: label("wa_message_kind", kind), body: DEFAULT_TEMPLATE_BODIES[kind], version: 0, isDefault: true };
}

/** Nama usaha (identitas PT bila sudah berdiri, Bab 2.3). */
export async function companyName(tx: Tx, tenantId: string, date: BusinessDate): Promise<string> {
  const id = await params.get(tx, "company.identity", date, { tenantId });
  return id.legal_name || id.name;
}

export async function listReceivableTemplates(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<ActiveTemplate[]> {
  await authorizeAny(ctx, ["m5.reminder.read", "m1.wa_template.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const out: ActiveTemplate[] = [];
  for (const kind of M5_TEMPLATE_KINDS) out.push(await activeTemplate(tx, ctx.tenantId, kind));
  return out;
}

const updateSchema = z.object({
  kind: z.enum(M5_TEMPLATE_KINDS as unknown as [M5TemplateKind, ...M5TemplateKind[]], { error: "Jenis template tidak dikenal." }),
  body: z.string().trim().min(20, { error: "Isi template terlalu pendek (minimal 20 karakter)." }).max(2000),
  reason: z.string().trim().min(3, { error: "Alasan perubahan template wajib diisi." }),
});

/** Pemilik mengubah template (versi baru; wajib memuat variabel inti; berjejak). */
export async function updateReceivableTemplate(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.wa_template.update", { tx: opts.tx });
  const data = parseInput(updateSchema, input, { kind: "Jenis", body: "Isi template", reason: "Alasan" });
  const missing = TEMPLATE_REQUIRED_VARIABLES[data.kind].filter((v) => !data.body.includes(`{{${v}}}`));
  if (missing.length) throw ValidationError.field("body", `Template wajib memuat: ${missing.map((m) => `{{${m}}}`).join(", ")} (US-M5-05 KP-1).`);
  return runService(ctx, opts, async (tx) => {
    const current = await activeTemplate(tx, ctx.tenantId, data.kind);
    const [latest] = await tx
      .select({ version: waTemplates.version })
      .from(waTemplates)
      .where(and(eq(waTemplates.tenantId, ctx.tenantId), eq(waTemplates.kind, data.kind)))
      .orderBy(desc(waTemplates.version))
      .limit(1);
    if (current.id) {
      await tx
        .update(waTemplates)
        .set({ isActive: false, deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: `Diganti versi baru: ${data.reason}`, updatedAt: ctx.now })
        .where(eq(waTemplates.id, current.id));
    }
    const variables = [...new Set([...data.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
    const [row] = await tx
      .insert(waTemplates)
      .values({ tenantId: ctx.tenantId, kind: data.kind, name: current.name, body: data.body, variables, version: (latest?.version ?? 0) + 1, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "wa_template",
      objectId: row!.id,
      action: "update",
      before: current.id ? { version: current.version, body: current.body } : null,
      after: { kind: data.kind, version: row!.version, body: data.body },
      reason: data.reason,
      rule: "US-M5-05 KP-2",
      businessDate: ctxBusinessDate(ctx),
    });
    return row!;
  });
}
