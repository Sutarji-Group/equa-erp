// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PinPad } from "@/components/field/pin-pad";

function tap(digits: string) {
  for (const d of digits) fireEvent.click(screen.getByRole("button", { name: d }));
}

function filledDots(): number {
  return screen.getAllByTestId("pin-dot").filter((el) => el.hasAttribute("data-filled")).length;
}

describe("PinPad — PIN 6 digit", () => {
  afterEach(() => cleanup());

  it("US-M10-02 KP-3 menampilkan 6 titik dan memanggil onComplete tepat setelah digit ke-6", async () => {
    const onComplete = vi.fn();
    render(<PinPad onComplete={onComplete} />);
    expect(screen.getAllByTestId("pin-dot")).toHaveLength(6);

    tap("12345");
    expect(filledDots()).toBe(5);
    expect(onComplete).not.toHaveBeenCalled();

    tap("6");
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith("123456");
    // Dikosongkan setelah selesai agar dapat diulang bila salah.
    await waitFor(() => expect(filledDots()).toBe(0));
  });

  it("hapus satu angka & hapus semua", async () => {
    const onComplete = vi.fn();
    render(<PinPad onComplete={onComplete} />);
    tap("987");
    fireEvent.click(screen.getByRole("button", { name: "Hapus satu angka" }));
    expect(filledDots()).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Hapus semua" }));
    expect(filledDots()).toBe(0);
    tap("111222");
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith("111222"));
  });

  it("tidak menerima lebih dari 6 digit saat verifikasi berjalan", async () => {
    let resolve!: () => void;
    const onComplete = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<PinPad onComplete={onComplete} />);
    tap("123456");
    tap("7");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("123456");
    resolve();
    await waitFor(() => expect(filledDots()).toBe(0));
  });

  it("papan ketik fisik: angka & Backspace", async () => {
    const onComplete = vi.fn();
    render(<PinPad onComplete={onComplete} />);
    await userEvent.keyboard("1234");
    expect(filledDots()).toBe(4);
    await userEvent.keyboard("{Backspace}");
    expect(filledDots()).toBe(3);
    await userEvent.keyboard("456");
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith("123456"));
  });

  it("nonaktif (terkunci) menolak input dan menampilkan pesan", () => {
    const onComplete = vi.fn();
    render(<PinPad onComplete={onComplete} disabled error="Terlalu banyak PIN salah. Coba lagi pukul 14.45." />);
    tap("123456");
    expect(onComplete).not.toHaveBeenCalled();
    expect(filledDots()).toBe(0);
    expect(screen.getByText(/Terlalu banyak PIN salah/)).toBeTruthy();
  });
});
