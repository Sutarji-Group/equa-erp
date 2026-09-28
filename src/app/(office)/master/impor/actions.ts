"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, str } from "../_lib/form";

const base = "/master/impor";

/** Unggah berkas impor → laporan validasi per baris (US-M1-06 KP-2). */
export async function uploadImportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let batchId: string | null = null;
  const res = await attempt(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Pilih berkas Excel (.xlsx) hasil template.");
    const r = await m1.uploadImport(ctx, {
      kind: str(fd, "kind") ?? "",
      mode: (str(fd, "mode") ?? "test") as m1.ImportMode,
      filename: file.name,
      file: Buffer.from(await file.arrayBuffer()),
    });
    batchId = r.batch.id;
  });
  if (batchId) {
    revalidatePath(base);
    redirect(`${base}/${batchId}`);
  }
  return res;
}

export async function resolveRowAction(batchId: string, rowId: string, decision: "exclude" | "include" | "merge" | "create_new", reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.resolveImportRow(ctx, batchId, rowId, { decision, reason: reason || undefined }).then(() => undefined), "Baris diperbarui.");
  revalidatePath(`${base}/${batchId}`);
  return res;
}

export async function mergeRowAction(batchId: string, rowId: string, targetCustomerId: string | null): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.resolveImportRow(ctx, batchId, rowId, { decision: "merge", targetCustomerId: targetCustomerId ?? undefined }).then(() => undefined), "Baris digabung ke pelanggan yang ada.");
  revalidatePath(`${base}/${batchId}`);
  return res;
}

export async function updateRowAction(batchId: string, rowId: string, keys: string[], _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const patch: Record<string, string | null> = {};
  for (const k of keys) patch[k] = str(fd, k);
  const res = await attempt(() => m1.updateImportRow(ctx, batchId, rowId, patch).then(() => undefined), "Baris diperbaiki dan dinilai ulang.");
  revalidatePath(`${base}/${batchId}`);
  return res;
}

export async function commitImportAction(batchId: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m1.commitImport(ctx, batchId);
    return { ok: true, message: `Data dimasukkan: ${r.summary.created} baru${r.summary.merged ? `, ${r.summary.merged} digabung` : ""}, ${r.summary.excluded} dikecualikan.` };
  });
  revalidatePath(`${base}/${batchId}`);
  revalidatePath(base);
  return res;
}

export async function cancelImportAction(batchId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.cancelImport(ctx, batchId, reason).then(() => undefined), "Batch dibatalkan.");
  revalidatePath(`${base}/${batchId}`);
  revalidatePath(base);
  return res;
}
