/**
 * Jurnal otomatis M11 untuk data uji beban — "templat dari layanan, replikasi massal":
 *
 * 1. Kemunculan PERTAMA setiap varian peristiwa (jenis event × pola entri × dimensi outlet/truk) diproses MESIN M11 ASLI
 *    (`processEvent` → pemetaan akun, pusat laba, penomoran `J-YYMM-NNNNN`, periode, `postJournal`) atas event domain
 *    sungguhan yang sudah tersimpan.
 * 2. Kemunculan berikutnya menyalin baris jurnal templat itu (akun, pusat laba, outlet, truk, memo) dengan nilai entri
 *    peristiwa tersebut; nomor jurnal melanjutkan urutan bulan yang sama (`document_sequences` disinkronkan sebelum &
 *    sesudah setiap pemanggilan mesin sehingga tidak ada nomor ganda).
 *
 * Invarian yang dijaga: satu jurnal otomatis per event (`source_event_id`), debit = kredit per jurnal (trigger EQ004 di
 * COMMIT tetap aktif), periode terbuka, nomor unik per tenant.
 */
import { and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { documentSequences, domainEvents, journalLines, journals } from "@/db/schema";
import { newId } from "@/lib/ids";
import { monthOf, type BusinessDate } from "@/lib/time";
import type { DomainEvent } from "@/server/core/events";
import { processEvent } from "@/server/modules/m11-accounting/service/engine";

type TemplateLine = Omit<typeof journalLines.$inferInsert, "id" | "journalId" | "debit" | "credit">;

type Template = {
  ref: string | null;
  description: string;
  sourceType: string | null;
  /** Per entri bukan-nol: [baris debit, baris kredit]. */
  pairs: [TemplateLine, TemplateLine][];
};

export type JournalEventInput = {
  event: typeof domainEvents.$inferInsert & { id: string; type: string; payload: Record<string, unknown> };
  /** Kunci varian (jenis event + dimensi yang memengaruhi akun/pusat laba/outlet). */
  variant: string;
  /** Nilai entri bukan-nol, berurutan seperti spesifikasi M11. */
  amounts: number[];
  ref: string | null;
  sourceObject: { type: string; id: string };
  date: BusinessDate;
  postedAt: Date;
};

export class JournalFactory {
  private templates = new Map<string, Template>();
  private counters = new Map<string, number>();
  readonly journals: (typeof journals.$inferInsert)[] = [];
  readonly lines: (typeof journalLines.$inferInsert)[] = [];
  templateCount = 0;
  replicated = 0;
  /** Event yang sudah disisipkan saat membuat templat (tidak ikut antrean harian). */
  readonly insertedEventIds = new Set<string>();

  constructor(
    private tenantId: string,
    private periods: Map<string, string>,
    private today: BusinessDate,
  ) {}

  private scopeKey(date: BusinessDate): string {
    return `${date.slice(2, 4)}${date.slice(5, 7)}`;
  }

  private async readCounter(tx: DbOrTx, scope: string): Promise<number> {
    const [row] = await tx
      .select({ v: documentSequences.lastValue })
      .from(documentSequences)
      .where(and(eq(documentSequences.tenantId, this.tenantId), eq(documentSequences.kind, "journal"), eq(documentSequences.scopeKey, scope)))
      .limit(1);
    return Number(row?.v ?? 0);
  }

  /** Tulis penghitung memori ke `document_sequences` (tidak pernah mundur). */
  async syncSequences(tx: DbOrTx): Promise<void> {
    for (const [scope, value] of this.counters) {
      await tx
        .insert(documentSequences)
        .values({ id: newId(), tenantId: this.tenantId, kind: "journal", scopeKey: scope, lastValue: value })
        .onConflictDoUpdate({
          target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
          set: { lastValue: sql`greatest(${documentSequences.lastValue}, ${value})`, updatedAt: new Date() },
        });
    }
  }

  private async nextNumber(tx: DbOrTx, date: BusinessDate): Promise<string> {
    const scope = this.scopeKey(date);
    if (!this.counters.has(scope)) this.counters.set(scope, await this.readCounter(tx, scope));
    const n = this.counters.get(scope)! + 1;
    this.counters.set(scope, n);
    // Format sama dengan core/numbering (5 digit minimum; lebih dari 99.999/bulan tetap unik — lihat uji-beban.md §Kapasitas).
    return `J-${scope}-${String(n).padStart(5, "0")}`;
  }

  /**
   * Buat jurnal untuk satu event. Event HARUS sudah/akan tersimpan sebelum baris jurnal ditulis (FK `source_event_id`);
   * untuk templat, event disisipkan seketika lalu mesin M11 dijalankan.
   */
  async journalFor(tx: DbOrTx, input: JournalEventInput): Promise<"template" | "replica"> {
    let tpl = this.templates.get(input.variant);
    if (!tpl) {
      tpl = await this.createTemplate(tx, input);
      this.templates.set(input.variant, tpl);
      return "template";
    }
    if (tpl.pairs.length !== input.amounts.length) {
      throw new Error(`Varian ${input.variant}: templat ${tpl.pairs.length} entri, event ${input.amounts.length} entri.`);
    }
    const id = newId();
    const total = input.amounts.reduce((s, a) => s + a, 0);
    const description = tpl.ref && input.ref ? tpl.description.split(tpl.ref).join(input.ref) : tpl.description;
    this.journals.push({
      id,
      tenantId: this.tenantId,
      number: await this.nextNumber(tx, input.date),
      kind: "auto",
      status: "posted",
      journalDate: input.date,
      periodId: this.periods.get(monthOf(input.date))!,
      description,
      sourceType: tpl.sourceType,
      sourceObjectType: input.sourceObject.type,
      sourceObjectId: input.sourceObject.id,
      sourceEventId: input.event.id,
      totalDebit: total,
      totalCredit: total,
      postedAt: input.postedAt,
      createdAt: input.postedAt,
      updatedAt: input.postedAt,
    });
    let lineNo = 0;
    input.amounts.forEach((amount, i) => {
      const [dr, cr] = tpl.pairs[i]!;
      this.lines.push({ ...dr, id: newId(), journalId: id, lineNo: ++lineNo, debit: amount, credit: 0, createdAt: input.postedAt, updatedAt: input.postedAt });
      this.lines.push({ ...cr, id: newId(), journalId: id, lineNo: ++lineNo, debit: 0, credit: amount, createdAt: input.postedAt, updatedAt: input.postedAt });
    });
    this.replicated++;
    return "replica";
  }

  private async createTemplate(tx: DbOrTx, input: JournalEventInput): Promise<Template> {
    // Nomor yang sudah dibagikan di memori harus terlihat oleh `nextNumber` mesin (tidak ada nomor ganda).
    await this.syncSequences(tx);
    await tx.insert(domainEvents).values(input.event);
    this.insertedEventIds.add(input.event.id);
    const [stored] = await tx.select().from(domainEvents).where(eq(domainEvents.id, input.event.id)).limit(1);
    if (!stored) throw new Error(`Event templat ${input.variant} tidak tersimpan.`);
    const result = await processEvent(tx as never, stored as unknown as DomainEvent, { today: this.today });
    if (result.status !== "posted") {
      throw new Error(`Mesin M11 tidak memosting templat ${input.variant}: ${JSON.stringify(result)}`);
    }
    const scope = this.scopeKey(input.date);
    this.counters.set(scope, Math.max(this.counters.get(scope) ?? 0, await this.readCounter(tx, scope)));
    const [j] = await tx.select().from(journals).where(eq(journals.id, result.journalIds[0]!)).limit(1);
    const ls = await tx.select().from(journalLines).where(eq(journalLines.journalId, j!.id)).orderBy(journalLines.lineNo);
    if (ls.length !== input.amounts.length * 2) {
      throw new Error(`Varian ${input.variant}: mesin menghasilkan ${ls.length} baris untuk ${input.amounts.length} entri.`);
    }
    const pairs: [TemplateLine, TemplateLine][] = [];
    for (let i = 0; i < ls.length; i += 2) {
      const strip = (l: (typeof ls)[number]): TemplateLine => ({
        accountId: l.accountId,
        profitCenter: l.profitCenter,
        outletId: l.outletId,
        truckId: l.truckId,
        waterSourceId: l.waterSourceId,
        description: l.description,
        lineNo: l.lineNo,
      });
      const a = ls[i]!;
      const b = ls[i + 1]!;
      if (!(a.debit > 0 && b.credit > 0) || a.debit !== input.amounts[i / 2] || b.credit !== input.amounts[i / 2]) {
        throw new Error(`Varian ${input.variant}: bentuk baris templat tidak terduga.`);
      }
      pairs.push([strip(a), strip(b)]);
    }
    this.templateCount++;
    return { ref: input.ref, description: j!.description, sourceType: j!.sourceType, pairs };
  }

  /** Ambil & kosongkan antrean baris untuk ditulis. */
  drain(): { journals: (typeof journals.$inferInsert)[]; lines: (typeof journalLines.$inferInsert)[] } {
    const out = { journals: this.journals.splice(0), lines: this.lines.splice(0) };
    return out;
  }
}
