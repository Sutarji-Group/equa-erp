"use client";

/**
 * Penjaga unggahan formulir kantor (B-18, D-10 butir 3) — dipasang SEKALI di kerangka kantor (`OfficeShell`), berlaku
 * untuk SEMUA `<input type="file">` di halaman kantor tanpa mengubah formulir modul:
 *
 * 1. Saat berkas dipilih: foto JPEG/PNG/WebP > `OFFICE_PHOTO_TARGET_BYTES` dikompres di perangkat lalu dipasang kembali
 *    ke input (DataTransfer) sehingga Server Action menerima foto kecil; berkas > batas unggah (4 MB) langsung ditandai
 *    tidak valid dengan pesan tindakan (bukan galat teknis "Body exceeded").
 * 2. Saat formulir dikirim: bila kompresi masih berjalan, pengiriman ditunda lalu diulang otomatis; bila total berkas
 *    melebihi batas, pengiriman dibatalkan dengan pesan tindakan.
 *
 * Input bertanda `data-upload-guard="off"` dilewati (mis. komponen yang sudah mengompres sendiri).
 */
import { useEffect } from "react";
import { toast } from "sonner";

import { prepareOfficeFiles } from "@/client/media/prepare-upload";
import { checkUploadSizes } from "@/lib/upload-limits";

function fileInputsOf(form: HTMLFormElement): HTMLInputElement[] {
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((i) => i.dataset.uploadGuard !== "off");
}

function filesOf(input: HTMLInputElement): File[] {
  return Array.from(input.files ?? []);
}

/** Pasang penjaga pada `root` (bawaan `document`). Mengembalikan fungsi pelepas. Diekspor untuk uji. */
export function installUploadGuard(root: Document = document, deps: { prepare?: typeof prepareOfficeFiles; notify?: (message: string) => void } = {}): () => void {
  const prepare = deps.prepare ?? prepareOfficeFiles;
  const notify = deps.notify ?? ((message: string) => toast.error(message, { id: `upload-guard:${message}` }));
  const pending = new Map<HTMLInputElement, Promise<void>>();

  async function processInput(input: HTMLInputElement): Promise<void> {
    input.setCustomValidity("");
    const files = filesOf(input);
    if (files.length === 0) return;
    const { files: prepared, changed } = await prepare(files);
    if (changed && typeof DataTransfer !== "undefined") {
      try {
        const dt = new DataTransfer();
        for (const f of prepared) dt.items.add(f);
        input.files = dt.files;
      } catch {
        // Peramban tanpa DataTransfer yang dapat ditulis → berkas asli tetap; ukuran diperiksa di bawah.
      }
    }
    const check = checkUploadSizes(filesOf(input));
    if (!check.ok) {
      input.setCustomValidity(check.message);
      input.reportValidity();
      notify(check.message);
    }
  }

  function onChange(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || input.dataset.uploadGuard === "off") return;
    input.dataset.uploadBusy = "1";
    const job = processInput(input).finally(() => {
      pending.delete(input);
      delete input.dataset.uploadBusy;
    });
    pending.set(input, job);
  }

  function onSubmit(event: Event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const inputs = fileInputsOf(form);
    if (inputs.length === 0) return;
    const busy = inputs.map((i) => pending.get(i)).filter((p): p is Promise<void> => !!p);
    const submitter = (event as SubmitEvent).submitter ?? null;
    if (busy.length > 0) {
      // Kompresi foto belum selesai → tunda, lalu kirim ulang dengan tombol yang sama.
      event.preventDefault();
      event.stopImmediatePropagation();
      void Promise.all(busy).then(() => {
        if (form.isConnected) form.requestSubmit(submitter instanceof HTMLElement && submitter.getAttribute("type") !== "button" ? (submitter as HTMLButtonElement) : undefined);
      });
      return;
    }
    const check = checkUploadSizes(inputs.flatMap(filesOf));
    if (!check.ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = inputs.find((i) => filesOf(i).length > 0) ?? inputs[0]!;
      target.setCustomValidity(check.message);
      target.reportValidity();
      notify(check.message);
    }
  }

  root.addEventListener("change", onChange, true);
  root.addEventListener("submit", onSubmit, true);
  return () => {
    root.removeEventListener("change", onChange, true);
    root.removeEventListener("submit", onSubmit, true);
  };
}

/** Komponen tanpa tampilan: pasang penjaga unggahan untuk halaman kantor. */
export function UploadGuard() {
  useEffect(() => installUploadGuard(), []);
  return null;
}
