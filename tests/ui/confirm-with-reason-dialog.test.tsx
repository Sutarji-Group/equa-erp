// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildReasonResult,
  ConfirmWithReasonDialog,
  validateReason,
} from "@/components/shared/confirm-with-reason-dialog";

const VOID_REASONS = [
  { code: "wrong_product", label: "Salah produk" },
  { code: "wrong_quantity", label: "Salah jumlah" },
];

describe("ConfirmWithReasonDialog — alasan wajib", () => {
  afterEach(() => cleanup());

  it("validateReason: teks bebas wajib & minimal panjang; kode wajib; 'lainnya' wajib teks", () => {
    expect(validateReason({ reasonCode: null, reasonText: "" })).toMatch(/Tuliskan alasan/);
    expect(validateReason({ reasonCode: null, reasonText: "  ab " })).toMatch(/minimal 3/);
    expect(validateReason({ reasonCode: null, reasonText: "Salah input" })).toBeNull();
    expect(validateReason({ reasons: VOID_REASONS, reasonCode: null, reasonText: "" })).toBe("Pilih salah satu alasan.");
    expect(validateReason({ reasons: VOID_REASONS, reasonCode: "tidak-ada", reasonText: "" })).toBe("Pilih salah satu alasan.");
    expect(validateReason({ reasons: VOID_REASONS, reasonCode: "wrong_product", reasonText: "" })).toBeNull();
    const withOther = [...VOID_REASONS, { code: "other", label: "Lainnya" }];
    expect(validateReason({ reasons: withOther, reasonCode: "other", reasonText: "" })).toMatch(/alasan lainnya/);
    expect(validateReason({ reasons: withOther, reasonCode: "other", reasonText: "Printer macet" })).toBeNull();
  });

  it("buildReasonResult menyusun alasan siap simpan", () => {
    expect(buildReasonResult(VOID_REASONS, "other", "wrong_product", "")).toEqual({
      reasonCode: "wrong_product",
      reasonText: "",
      reason: "Salah produk",
    });
    expect(buildReasonResult(VOID_REASONS, "other", "wrong_product", " galon 2 ")).toMatchObject({ reason: "Salah produk: galon 2" });
    expect(buildReasonResult(undefined, "other", null, " Tidak sesuai ")).toEqual({ reasonCode: null, reasonText: "Tidak sesuai", reason: "Tidak sesuai" });
  });

  it("US-M10-04 KP-3 menolak konfirmasi tanpa alasan (onConfirm tidak dipanggil)", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmWithReasonDialog open onOpenChange={() => {}} title="Tolak permintaan?" confirmLabel="Tolak" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Tolak" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Tuliskan alasan/);

    await userEvent.type(screen.getByLabelText("Alasan"), "Nominal tidak sesuai nota");
    await userEvent.click(screen.getByRole("button", { name: "Tolak" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({ reasonCode: null, reasonText: "Nominal tidak sesuai nota", reason: "Nominal tidak sesuai nota" });
  });

  it("US-M6-03 KP-1 void: wajib pilih kode alasan; 'Lainnya' wajib teks", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => {}} title="Void transaksi?" confirmLabel="Void" reasons={VOID_REASONS} onConfirm={onConfirm} />,
    );
    // "Lainnya" ditambahkan otomatis.
    expect(screen.getByLabelText("Lainnya")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Void" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Pilih salah satu alasan.");

    await userEvent.click(screen.getByLabelText("Lainnya"));
    await userEvent.click(screen.getByRole("button", { name: "Void" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/alasan lainnya/);

    await userEvent.click(screen.getByLabelText("Salah jumlah"));
    await userEvent.click(screen.getByRole("button", { name: "Void" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({ reasonCode: "wrong_quantity", reason: "Salah jumlah" });
  });

  it("galat dari onConfirm ditampilkan dan dialog tetap terbuka", async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmWithReasonDialog
        open
        onOpenChange={onOpenChange}
        title="Tolak?"
        confirmLabel="Tolak"
        onConfirm={async () => {
          throw new Error("Permintaan sudah diputuskan orang lain. Muat ulang halaman.");
        }}
      />,
    );
    await userEvent.type(screen.getByLabelText("Alasan"), "Tidak sesuai");
    await userEvent.click(screen.getByRole("button", { name: "Tolak" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/sudah diputuskan/));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
