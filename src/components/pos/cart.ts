/** Utilitas murni keranjang & pembayaran POS (isomorfik, dapat diuji). Semua nilai integer rupiah. */

export type CartLine = {
  productId: string;
  name: string;
  /** Harga satuan (integer rupiah, dari master). */
  unitPrice: number;
  quantity: number;
};

/** Total keranjang. */
export function cartTotal(lines: readonly CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

/** Jumlah barang di keranjang. */
export function cartItemCount(lines: readonly CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

/** Tambah 1 produk (baris baru bila belum ada). */
export function addToCart(lines: readonly CartLine[], product: { id: string; name: string; price: number }): CartLine[] {
  const existing = lines.find((l) => l.productId === product.id);
  if (existing) return lines.map((l) => (l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l));
  return [...lines, { productId: product.id, name: product.name, unitPrice: product.price, quantity: 1 }];
}

/** Ubah jumlah baris sebesar `delta`; baris dengan jumlah ≤ 0 dibuang. */
export function changeCartQuantity(lines: readonly CartLine[], productId: string, delta: number): CartLine[] {
  return lines
    .map((l) => (l.productId === productId ? { ...l, quantity: l.quantity + delta } : l))
    .filter((l) => l.quantity > 0);
}

/** Kembalian tunai (negatif = uang kurang). */
export function computeChange(total: number, received: number): number {
  return received - total;
}

const NOTE_STEPS = [5_000, 10_000, 20_000, 50_000, 100_000] as const;

/**
 * Usulan nominal uang diterima di atas total (dibulatkan ke atas ke kelipatan pecahan umum), maks `limit` nilai.
 * `11.000` → `[15.000, 20.000, 50.000]`.
 */
export function cashSuggestions(total: number, limit = 3): number[] {
  if (total <= 0) return [];
  const result: number[] = [];
  for (const step of NOTE_STEPS) {
    const v = Math.ceil(total / step) * step;
    if (v > total && !result.includes(v)) result.push(v);
    if (result.length >= limit) break;
  }
  return result;
}
