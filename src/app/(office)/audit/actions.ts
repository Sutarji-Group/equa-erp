"use server";

import { verifyAuditChain } from "@/server/core/audit";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";

export type ChainCheck = { ok: boolean; checked: number; message: string };

/** Verifikasi rantai hash jejak audit (US-M10-05 KP-2, NFR-11). */
export async function verifyChainAction(): Promise<ChainCheck> {
  await requirePermission("m10.audit_log.read");
  const r = await verifyAuditChain(getDb());
  return r.ok
    ? { ok: true, checked: r.checked, message: `Rantai jejak audit utuh: ${r.checked.toLocaleString("id-ID")} catatan terverifikasi, tidak ada yang diubah.` }
    : { ok: false, checked: r.checked, message: `Rantai jejak audit TIDAK utuh pada catatan #${r.brokenAtSeq}: ${r.reason} Laporkan ke pemilik & tim IT.` };
}
