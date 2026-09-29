/**
 * Nota kredit KOREKSI atas faktur bulanan mitra (`partner_subscription`) — temuan S5B (US-P3-09 KP-2/KP-3, BR-05,
 * US-M11-02). Faktur mitra dapat menggabungkan komponen berbeda lini: langganan/royalti/fee awal (L5), rit air tempo
 * (L2, pendapatannya diakui saat rit Selesai) dan spare part (L4). Nota kredit faktur ini dijurnal ke L5
 * (`profitCenterOfKind`), maka nota kredit koreksi DIBATASI ke sisa komponen L5. Koreksi baris air dilakukan lewat
 * Koreksi rit M3 (`trip.corrected` → nota kredit `trip_correction` + jurnal pendapatan air L2) — bukan nota kredit
 * umum yang membalik pendapatan langganan L5.
 */
import "server-only";

import { and, eq, inArray, sql, sum } from "drizzle-orm";

import { domainEvents, invoiceLines } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { type Tx } from "@/server/core/db";
import { ValidationError } from "@/server/core/errors";

import type { InvoiceRow } from "./common";

/** Komponen baris faktur mitra yang pendapatannya L5 (langganan sistem, royalti, fee awal kemitraan). */
export const PARTNER_L5_COMPONENTS = ["subscription", "royalty", "other"] as const;

/** Sisa komponen L5 faktur mitra yang masih dapat dikoreksi dengan nota kredit (dikurangi nota kredit koreksi/sengketa sebelumnya). */
export async function partnerL5Remaining(tx: Tx, inv: Pick<InvoiceRow, "id">): Promise<number> {
  const [l5] = await tx
    .select({ total: sum(invoiceLines.amount) })
    .from(invoiceLines)
    .where(and(eq(invoiceLines.invoiceId, inv.id), inArray(invoiceLines.component, [...PARTNER_L5_COMPONENTS])));
  const [credited] = await tx
    .select({ total: sql<string>`coalesce(sum((${domainEvents.payload}->>'amount')::bigint), 0)` })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.type, "credit_note.issued"),
        sql`${domainEvents.payload}->>'invoiceId' = ${inv.id}`,
        sql`coalesce(${domainEvents.payload}->>'purpose', 'correction') in ('correction', 'dispute')`,
      ),
    );
  return Math.max(0, Number(l5?.total ?? 0) - Number(credited?.total ?? 0));
}

/** Tolak nota kredit koreksi faktur mitra yang melebihi sisa komponen L5 (koreksi air lewat Koreksi rit). */
export async function assertPartnerCreditNoteWithinL5(tx: Tx, inv: InvoiceRow, amount: number): Promise<void> {
  if (inv.kind !== "partner_subscription") return;
  const remaining = await partnerL5Remaining(tx, inv);
  if (amount <= remaining) return;
  throw ValidationError.field(
    "amount",
    `Nota kredit faktur mitra ${inv.number} hanya untuk komponen langganan/royalti (sisa ${formatRupiah(remaining)}). ` +
      "Koreksi volume/harga rit air lewat menu Koreksi rit (Sopir – kantor) agar pendapatan air ikut terkoreksi.",
  );
}
