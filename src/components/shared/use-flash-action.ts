"use client";

/**
 * Status Server Action dengan pesan "flash" lintas revalidasi (B-24) — pengganti `useActionState` untuk formulir kantor.
 *
 * Masalah: Server Action yang me-revalidasi halaman mengirim pohon baru BERSAMAAN dengan hasil aksi. Bila formulir
 * pemanggil tidak ada lagi di pohon baru (mis. "Terima sebagai nota" di `/toko/pembelian/[id]` hilang setelah nota
 * diterima), komponennya dilepas sebelum efeknya berjalan sehingga pesan sukses (toast/efek) tidak pernah tampil.
 *
 * Solusi: pesan sukses ditampilkan dari DALAM fungsi aksi yang dibungkus — segera setelah respons tiba dan SEBELUM React
 * memasang pohon hasil revalidasi — lewat `Toaster` global (sonner) yang hidup di luar formulir. Toast memakai `id`
 * pesan sehingga tidak ganda. Galat transport (jaringan putus, badan permintaan melebihi batas unggah) diubah menjadi
 * status `error` berbahasa Indonesia alih-alih layar galat; pengalihan/404 bawaan Next tetap diteruskan.
 */
import { useActionState, useMemo } from "react";
import { toast } from "sonner";

import { ACTION_TRANSPORT_FAILURE_MESSAGE } from "@/lib/upload-limits";

/** Bentuk minimum status aksi kantor (semua modul memakai `{ ok?, error?, message? }`). */
export type FlashActionState = { ok?: boolean; error?: string; message?: string } | undefined;

/** Galat kendali Next (redirect / notFound / dll.) — harus diteruskan agar router menanganinya. */
export function isNextControlError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/** Tampilkan pesan sukses (satu toast per pesan). */
export function flashSuccess(message: string): void {
  toast.success(message, { id: `flash:${message}` });
}

/**
 * Bungkus aksi: pesan sukses di-flash saat respons tiba; galat transport → status galat. Diekspor untuk uji.
 */
export function withFlash<S extends FlashActionState>(action: (state: S, formData: FormData) => Promise<S>, opts: { flash?: (message: string) => void } = {}) {
  const flash = opts.flash ?? flashSuccess;
  return async (state: S, formData: FormData): Promise<S> => {
    let next: S;
    try {
      next = await action(state, formData);
    } catch (error) {
      if (isNextControlError(error)) throw error;
      return { ...(state ?? {}), ok: false, error: ACTION_TRANSPORT_FAILURE_MESSAGE, message: undefined } as S;
    }
    if (next?.ok && next.message) flash(next.message);
    return next;
  };
}

/**
 * `useActionState` + flash lintas revalidasi. Formulir TIDAK perlu lagi memanggil `toast.success(state.message)` di
 * efeknya (pesan inline `role="status"` tetap boleh ditampilkan selama formulir masih ada).
 */
export function useFlashActionState<S extends FlashActionState>(action: (state: S, formData: FormData) => Promise<S>, initialState: S) {
  const wrapped = useMemo(() => withFlash(action) as (state: Awaited<S>, formData: FormData) => Promise<S>, [action]);
  return useActionState<S, FormData>(wrapped, initialState as Awaited<S>);
}
