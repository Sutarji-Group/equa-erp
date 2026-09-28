// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addToCart, cartItemCount, cartTotal, cashSuggestions, changeCartQuantity, computeChange } from "@/components/pos/cart";
import { PaymentPanel } from "@/components/pos/payment-panel";
import { POS_GRID_MAX, ProductGrid } from "@/components/pos/product-grid";

describe("POS — keranjang & pembayaran", () => {
  afterEach(() => cleanup());

  it("helper keranjang: tambah, ubah jumlah, hapus baris nol, total integer", () => {
    let lines = addToCart([], { id: "a", name: "Isi ulang", price: 5_000 });
    lines = addToCart(lines, { id: "a", name: "Isi ulang", price: 5_000 });
    lines = addToCart(lines, { id: "b", name: "Tutup", price: 1_000 });
    expect(cartTotal(lines)).toBe(11_000);
    expect(cartItemCount(lines)).toBe(3);
    lines = changeCartQuantity(lines, "b", -1);
    expect(lines.map((l) => l.productId)).toEqual(["a"]);
    expect(computeChange(10_000, 20_000)).toBe(10_000);
    expect(cashSuggestions(11_000)).toEqual([15_000, 20_000, 50_000]);
    expect(cashSuggestions(5_000)).toEqual([10_000, 20_000, 50_000]);
    expect(cashSuggestions(0)).toEqual([]);
  });

  it("US-M6-01 KP-1 kisi produk maksimal 12 tombol", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const products = Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, name: `Produk ${i}`, price: 1_000 }));
    const onSelect = vi.fn();
    render(<ProductGrid products={products} onSelect={onSelect} quantities={{ p0: 2 }} />);
    expect(screen.getAllByRole("button")).toHaveLength(POS_GRID_MAX);
    fireEvent.click(screen.getByRole("button", { name: /Produk 1,/ }));
    expect(onSelect).toHaveBeenCalledWith(products[1]);
    expect(screen.getByRole("button", { name: /Produk 0, Rp 1\.000, 2 di keranjang/ })).toBeTruthy();
    warn.mockRestore();
  });

  it("US-M6-01 KP-2 tunai: bawaan uang pas, kembalian dihitung, kurang → tombol nonaktif", async () => {
    const onPay = vi.fn();
    render(<PaymentPanel total={11_000} onPay={onPay} />);
    expect(screen.getByTestId("pos-change").textContent).toBe("Kembalian Rp 0");

    fireEvent.click(screen.getByRole("button", { name: "Rp 20.000" }));
    expect(screen.getByTestId("pos-change").textContent).toBe("Kembalian Rp 9.000");

    // Ketik 5.000 → kurang.
    fireEvent.click(screen.getByRole("button", { name: "Uang pas" }));
    fireEvent.click(screen.getByRole("button", { name: "Hapus satu angka" })); // "1100"
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Hapus satu angka" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "000" }));
    expect(screen.getByTestId("pos-change").textContent).toBe("Kurang Rp 6.000");
    expect((screen.getByRole("button", { name: /Simpan · Tunai/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Uang pas" }));
    fireEvent.click(screen.getByRole("button", { name: /Simpan · Tunai/ }));
    await waitFor(() => expect(onPay).toHaveBeenCalledWith({ method: "cash", received: 11_000, change: 0 }));
  });

  it("QRIS: referensi opsional", async () => {
    const onPay = vi.fn();
    render(<PaymentPanel total={5_000} onPay={onPay} />);
    fireEvent.click(screen.getByRole("radio", { name: /QRIS/ }));
    fireEvent.click(screen.getByRole("button", { name: /QRIS diterima/ }));
    await waitFor(() => expect(onPay).toHaveBeenCalledWith({ method: "qris", reference: null }));
  });
});
