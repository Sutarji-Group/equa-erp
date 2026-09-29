import "server-only";

/**
 * Tautan "Lihat jurnal" dari layar rincian transaksi ke jurnal akuntansinya (B-55, ketertelusuran dua arah FR-M11;
 * arah sebaliknya = `m11.sourceLink`). Hanya tampil bagi peran yang berhak membaca jurnal (`m11.journal.read`: pemilik,
 * Admin Keuangan, akuntan) — peran lain tidak melihat tautannya sama sekali.
 *
 * `sourceType` = jenis objek sumber jurnal otomatis M11 (`journals.source_object_type`, lihat
 * `m11-accounting/service/auto-journals.ts`): `trip`, `deposit`, `invoice`, `customer_payment`, `credit_note`,
 * `pos_sale`, `shift`, `purchase_receipt`, `water_supply_receipt`, …
 */
import { BookOpenText } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import type { ActorContext } from "@/server/core/context";
import { can } from "@/server/core/rbac";

/** Izin yang dibutuhkan untuk melihat tautan jurnal. */
export const JOURNAL_LINK_PERMISSION = "m11.journal.read";

/** URL daftar jurnal suatu transaksi sumber (`/akuntansi/jurnal?sumberTipe=&sumberId=`). */
export function journalHref(sourceType: string, sourceId: string): string {
  return `/akuntansi/jurnal?sumberTipe=${encodeURIComponent(sourceType)}&sumberId=${encodeURIComponent(sourceId)}`;
}

/** Tautan ditampilkan untuk pelaku ini? */
export function canSeeJournalLink(ctx: ActorContext): boolean {
  return can(ctx, JOURNAL_LINK_PERMISSION);
}

export function JournalLink({
  ctx,
  sourceType,
  sourceId,
  label = "Lihat jurnal",
  className,
}: {
  ctx: ActorContext;
  sourceType: string;
  sourceId: string | null | undefined;
  label?: string;
  className?: string;
}) {
  if (!sourceId || !canSeeJournalLink(ctx)) return null;
  return (
    <Link
      href={journalHref(sourceType, sourceId)}
      className={cn("inline-flex items-center gap-1 text-sm text-primary hover:underline", className)}
      data-testid={`journal-link-${sourceType}`}
    >
      <BookOpenText className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
