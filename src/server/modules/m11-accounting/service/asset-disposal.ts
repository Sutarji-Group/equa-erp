/**
 * M11 — efek jurnal pelepasan aset tetap setelah TERPOSTING (US-M11-05 KP-4, BR-35): aset ditandai "Dilepas" dengan
 * hasil & laba/rugi pelepasan. Dipanggil `afterManualPosted` (langsung ≤ PAR-20, atau setelah persetujuan pemilik).
 */
import "server-only";

import { eq } from "drizzle-orm";

import { fixedAssets, journals } from "@/db/schema";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";

export type AssetDisposalInfo = { assetId: string; date: string; proceeds: number; gainLoss: number; bookValue: number };

export async function applyAssetDisposal(tx: Tx, ctx: ActorContext, journal: typeof journals.$inferSelect, info: AssetDisposalInfo): Promise<void> {
  const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, info.assetId)).for("update").limit(1);
  if (!a || a.status === "disposed") return;
  await tx
    .update(fixedAssets)
    .set({ status: "disposed", disposedAt: info.date, disposalProceeds: info.proceeds, disposalGainLoss: info.gainLoss, disposalJournalId: journal.id, updatedAt: new Date() })
    .where(eq(fixedAssets.id, a.id));
  await auditRecord(tx, {
    ctx,
    objectType: "fixed_asset",
    objectId: a.id,
    action: "dispose",
    before: { status: a.status, bookValue: info.bookValue },
    after: { status: "disposed", proceeds: info.proceeds, gainLoss: info.gainLoss, journal: journal.number },
    rule: "US-M11-05 KP-4, BR-35",
  });
}
