// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  digitsOnly,
  formatIntegerDisplay,
  LiterInput,
  MoneyInput,
  parseIntegerInput,
} from "@/components/shared/integer-input";

function ControlledMoney({ initial = null, onChange, max }: { initial?: number | null; onChange?: (v: number | null) => void; max?: number }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <MoneyInput
        aria-label="Jumlah"
        value={value}
        max={max}
        onValueChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <output data-testid="value">{value === null ? "null" : String(value)}</output>
    </>
  );
}

describe("MoneyInput / IntegerInput — rupiah bulat (D-04)", () => {
  afterEach(() => cleanup());

  it("fungsi format & urai: ribuan bertitik, hanya digit, tanpa pecahan", () => {
    expect(formatIntegerDisplay(1_250_000)).toBe("1.250.000");
    expect(formatIntegerDisplay(0)).toBe("0");
    expect(formatIntegerDisplay(null)).toBe("");
    expect(digitsOnly("Rp 1.250.000")).toBe("1250000");
    expect(parseIntegerInput("")).toBeNull();
    expect(parseIntegerInput("1.250.000")).toBe(1_250_000);
    expect(parseIntegerInput("007")).toBe(7);
    expect(parseIntegerInput("12,5")).toBe(125); // koma diabaikan: tidak ada desimal
    expect(parseIntegerInput("5001", 5000)).toBeUndefined(); // di atas batas → ditolak
    expect(parseIntegerInput("99999999999999999")).toBeUndefined(); // di luar integer aman
  });

  it("menampilkan nilai awal berformat dengan awalan Rp", () => {
    render(<ControlledMoney initial={5000} />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    expect(input.value).toBe("5.000");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByText("Rp")).toBeTruthy();
  });

  it("mengetik angka → tampilan berformat & nilai integer", async () => {
    const onChange = vi.fn();
    render(<ControlledMoney onChange={onChange} />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    await userEvent.type(input, "1250000");
    expect(input.value).toBe("1.250.000");
    expect(onChange).toHaveBeenLastCalledWith(1_250_000);
    expect(screen.getByTestId("value").textContent).toBe("1250000");
  });

  it("huruf, koma, dan titik diabaikan (hanya bilangan bulat)", async () => {
    render(<ControlledMoney />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    await userEvent.type(input, "12a,5.0");
    expect(input.value).toBe("1.250");
    expect(screen.getByTestId("value").textContent).toBe("1250");
    expect(Number.isInteger(Number(screen.getByTestId("value").textContent))).toBe(true);
  });

  it("mengosongkan kolom → null", async () => {
    render(<ControlledMoney initial={2000} />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    await userEvent.clear(input);
    expect(input.value).toBe("");
    expect(screen.getByTestId("value").textContent).toBe("null");
  });

  it("ketikan melebihi max ditolak, nilai lama dipertahankan", async () => {
    render(<ControlledMoney initial={200_000} max={200_000} />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2000000" } });
    expect(screen.getByTestId("value").textContent).toBe("200000");
    expect(input.value).toBe("200.000");
  });

  it("tempel teks rupiah diurai; teks berpecahan ditolak", () => {
    render(<ControlledMoney />);
    const input = screen.getByLabelText("Jumlah") as HTMLInputElement;
    input.focus();
    fireEvent.paste(input, { clipboardData: { getData: () => "Rp 1.250.000" } });
    expect(screen.getByTestId("value").textContent).toBe("1250000");
    expect(input.value).toBe("1.250.000");

    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "1.000,50" } });
    expect(screen.getByTestId("value").textContent).toBe("1250000");
  });

  it("LiterInput memakai akhiran L dan nilai liter bulat", async () => {
    function ControlledLiter() {
      const [v, setV] = useState<number | null>(null);
      return (
        <>
          <LiterInput aria-label="Volume" value={v} onValueChange={setV} />
          <output data-testid="liter">{String(v)}</output>
        </>
      );
    }
    render(<ControlledLiter />);
    const input = screen.getByLabelText("Volume") as HTMLInputElement;
    await userEvent.type(input, "5000");
    expect(input.value).toBe("5.000");
    expect(screen.getByText("L")).toBeTruthy();
    expect(screen.getByTestId("liter").textContent).toBe("5000");
  });
});
