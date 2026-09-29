// @vitest-environment happy-dom
/**
 * B-18 (D-10 butir 3): batas unggah Server Action 4 MB + kompresi foto di peramban + pesan tindakan; B-24: pesan sukses
 * Server Action tetap tampil setelah revalidasi (flash dari dalam aksi, bukan efek formulir).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareOfficeFiles, shouldCompress } from "@/client/media/prepare-upload";
import { installUploadGuard } from "@/components/shared/upload-guard";
import { isNextControlError, withFlash } from "@/components/shared/use-flash-action";
import {
  ACTION_TRANSPORT_FAILURE_MESSAGE,
  checkUploadSizes,
  formatFileSize,
  MAX_OFFICE_UPLOAD_BYTES,
  OFFICE_PHOTO_TARGET_BYTES,
  SERVER_ACTION_BODY_LIMIT,
  SERVER_ACTION_BODY_LIMIT_BYTES,
} from "@/lib/upload-limits";

import nextConfig from "../../next.config";

const MB = 1024 * 1024;

function fakeFile(name: string, size: number, type: string): File {
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

function formWithFile(file: File | null): { form: HTMLFormElement; input: HTMLInputElement } {
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "file";
  input.name = "evidence";
  Object.defineProperty(input, "files", { configurable: true, get: () => (file ? [file] : []), set: () => {} });
  form.appendChild(input);
  document.body.appendChild(form);
  return { form, input };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("B-18 batas unggah formulir kantor", () => {
  it("B-18 D-10 serverActions.bodySizeLimit = 4mb di next.config (di bawah batas Vercel 4,5 MB)", () => {
    expect(SERVER_ACTION_BODY_LIMIT).toBe("4mb");
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("4mb");
    expect(SERVER_ACTION_BODY_LIMIT_BYTES).toBeLessThan(4.5 * MB);
    expect(MAX_OFFICE_UPLOAD_BYTES).toBeLessThan(SERVER_ACTION_BODY_LIMIT_BYTES);
  });

  it("B-18 D-10 PDF > 4 MB ditolak dengan pesan tindakan (bukan galat teknis); total beberapa berkas juga dibatasi", () => {
    expect(formatFileSize(4 * MB)).toBe("4 MB");
    expect(formatFileSize(5.2 * MB)).toBe("5,2 MB");
    const pdf = checkUploadSizes([{ name: "perjanjian.pdf", size: 5.2 * MB, type: "application/pdf" }]);
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) {
      expect(pdf.message).toContain("perjanjian.pdf");
      expect(pdf.message).toContain("5,2 MB");
      expect(pdf.message).toMatch(/Perkecil PDF/);
      expect(pdf.message).not.toMatch(/Body|exceeded|413/);
    }
    const two = checkUploadSizes([
      { name: "a.pdf", size: 2.5 * MB, type: "application/pdf" },
      { name: "b.pdf", size: 2.5 * MB, type: "application/pdf" },
    ]);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.message).toMatch(/Total lampiran 5 MB/);
    expect(checkUploadSizes([{ name: "slip.jpg", size: 900 * 1024, type: "image/jpeg" }, { name: "kosong", size: 0 }]).ok).toBe(true);
  });

  it("B-18 foto kantor > 1 MB dikompres di peramban (JPEG ≤ sasaran); PDF/Excel & foto kecil dibiarkan; gagal kompres → berkas asli", async () => {
    const big = fakeFile("slip-setor.png", 3 * MB, "image/png");
    const small = fakeFile("kecil.jpg", 200 * 1024, "image/jpeg");
    const pdf = fakeFile("mutasi.pdf", 2 * MB, "application/pdf");
    expect(shouldCompress(big)).toBe(true);
    expect(shouldCompress(small)).toBe(false);
    expect(shouldCompress(pdf)).toBe(false);
    const compress = vi.fn(async (_file: Blob, _options: { maxBytes?: number }) => ({ blob: new Blob([new Uint8Array(400 * 1024)], { type: "image/jpeg" }) }));
    const res = await prepareOfficeFiles([big, small, pdf], { compress });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(compress.mock.calls[0]![1]).toMatchObject({ maxBytes: OFFICE_PHOTO_TARGET_BYTES });
    expect(res.changed).toBe(true);
    expect(res.files.map((f) => f.name)).toEqual(["slip-setor.jpg", "kecil.jpg", "mutasi.pdf"]);
    expect(res.files[0]!.type).toBe("image/jpeg");
    expect(res.files[0]!.size).toBe(400 * 1024);
    const failing = await prepareOfficeFiles([big], { compress: async () => Promise.reject(new Error("canvas")) });
    expect(failing).toEqual({ files: [big], changed: false });
  });

  it("B-18 penjaga kantor: pengiriman formulir dengan PDF 6 MB dibatalkan + pesan tindakan; berkas dalam batas diteruskan", () => {
    const notify = vi.fn();
    const uninstall = installUploadGuard(document, { notify, prepare: async (files) => ({ files: [...files], changed: false }) });
    try {
      const { form, input } = formWithFile(fakeFile("nota.pdf", 6 * MB, "application/pdf"));
      const reportValidity = vi.spyOn(input, "reportValidity");
      const submit = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/nota\.pdf.*melebihi batas unggah 4 MB/));
      expect(reportValidity).toHaveBeenCalled();
      expect(input.validationMessage || notify.mock.calls[0]![0]).toMatch(/4 MB/);

      const ok = formWithFile(fakeFile("nota-kecil.pdf", 1 * MB, "application/pdf"));
      const submitOk = new Event("submit", { bubbles: true, cancelable: true });
      ok.form.dispatchEvent(submitOk);
      expect(submitOk.defaultPrevented).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("B-18 penjaga kantor: formulir dikirim saat foto masih dikompres → ditunda lalu dikirim ulang otomatis", async () => {
    let release: () => void = () => {};
    const prepare = vi.fn(
      (files: readonly File[]) =>
        new Promise<{ files: File[]; changed: boolean }>((resolve) => {
          release = () => resolve({ files: [...files], changed: false });
        }),
    );
    const uninstall = installUploadGuard(document, { notify: vi.fn(), prepare });
    try {
      const { form, input } = formWithFile(fakeFile("foto.jpg", 3 * MB, "image/jpeg"));
      const requestSubmit = vi.fn();
      form.requestSubmit = requestSubmit;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(prepare).toHaveBeenCalledTimes(1);
      const submit = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      expect(requestSubmit).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    } finally {
      uninstall();
    }
  });
});

describe("B-24 pesan sukses Server Action lintas revalidasi", () => {
  type S = { ok?: boolean; error?: string; message?: string };

  it("B-24 pesan sukses di-flash dari dalam aksi (sebelum pohon hasil revalidasi dipasang) — tetap tampil walau formulir dilepas", async () => {
    const flash = vi.fn();
    const order: string[] = [];
    const action = async (): Promise<S> => {
      order.push("server");
      return { ok: true, message: "Nota pengganti diterima sebagai nota pembelian." };
    };
    const wrapped = withFlash(action, { flash: (m) => (order.push("flash"), flash(m)) });
    const next = await wrapped({}, new FormData());
    order.push("react-commit");
    expect(next).toEqual({ ok: true, message: "Nota pengganti diterima sebagai nota pembelian." });
    expect(flash).toHaveBeenCalledWith("Nota pengganti diterima sebagai nota pembelian.");
    // Flash terjadi sebelum React menerapkan state/pohon baru (saat formulir mungkin sudah tidak ada).
    expect(order).toEqual(["server", "flash", "react-commit"]);
    // Galat layanan tidak di-flash sebagai sukses.
    const err = await withFlash(async (): Promise<S> => ({ ok: false, error: "Nota sudah diterima." }), { flash })({}, new FormData());
    expect(err.error).toBe("Nota sudah diterima.");
    expect(flash).toHaveBeenCalledTimes(1);
  });

  it("B-24 B-18 galat transport (mis. badan permintaan > 4 MB) menjadi pesan tindakan; redirect/notFound Next diteruskan", async () => {
    const failing = withFlash(async (): Promise<S> => {
      throw new Error("Body exceeded 4mb limit");
    });
    await expect(failing({ ok: true, message: "lama" }, new FormData())).resolves.toEqual({ ok: false, error: ACTION_TRANSPORT_FAILURE_MESSAGE, message: undefined });
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/piutang;307;" });
    expect(isNextControlError(redirect)).toBe(true);
    await expect(
      withFlash(async (): Promise<S> => {
        throw redirect;
      })({}, new FormData()),
    ).rejects.toBe(redirect);
  });
});
