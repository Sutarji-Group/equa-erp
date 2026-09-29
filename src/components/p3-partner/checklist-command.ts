/**
 * Muatan perintah POS `p3.quality_checklist.submit` (murni, tanpa React — dapat diuji & dipakai komponen klien).
 * Foto bukti per butir dikirim sebagai lampiran perintah berjenis `quality_photo_<butir>`; server memetakannya ke butir
 * (klien tidak tahu ID lampiran sebelum `enqueue`).
 */
import type { EnqueueAttachment } from "@/client/offline";

export type ChecklistPhoto = { blob: Blob; capturedAt: Date };
export type ChecklistItemState = { result: "pass" | "fail" | null; actionNote: string; photo: ChecklistPhoto | null };
export type ChecklistCommandPayload = { checklistId: string; shiftId: string | null; items: { itemKey: string; result: "pass" | "fail"; actionNote: string | null }[] };

export function buildChecklistCommand(
  items: readonly { key: string; photoRequired: boolean }[],
  state: Record<string, ChecklistItemState | undefined>,
  opts: { checklistId: string; shiftId?: string | null },
): { payload: ChecklistCommandPayload; attachments: EnqueueAttachment[] } | { error: string } {
  const out: ChecklistCommandPayload["items"] = [];
  const attachments: EnqueueAttachment[] = [];
  for (const it of items) {
    const s = state[it.key];
    if (!s?.result) return { error: "Isi semua butir daftar periksa (lulus / tidak lulus)." };
    if (s.result === "fail" && s.actionNote.trim().length < 3) return { error: "Butir tidak lulus — tulis tindakan yang dilakukan." };
    if (it.photoRequired && !s.photo) return { error: "Ambil foto bukti untuk butir bertanda kamera." };
    out.push({ itemKey: it.key, result: s.result, actionNote: s.result === "fail" ? s.actionNote.trim() : null });
    if (s.photo) attachments.push({ kind: `quality_photo_${it.key}`, blob: s.photo.blob, capturedAt: s.photo.capturedAt });
  }
  return { payload: { checklistId: opts.checklistId, shiftId: opts.shiftId ?? null, items: out }, attachments };
}
