/** Data contoh untuk halaman demo /ui-kit (bukan data nyata; tidak disimpan). */
import type { OrderStatus } from "@/lib/labels";

export type DemoOrderRow = {
  id: string;
  number: string;
  customer: string;
  businessDate: string;
  volumeL: number;
  total: number;
  status: OrderStatus;
  truck: string;
};

const CUSTOMERS = [
  "Hotel Puncak Indah",
  "Pondok Pesantren Al-Ikhlas",
  "Perumahan Griya Cianjur",
  "Rumah Makan Sari Sunda",
  "Pabrik Tahu Bu Imas",
  "Depot Mitra Cugenang",
  "Kolam Renang Tirta",
  "Klinik Sehat Bersama",
];
const STATUSES: OrderStatus[] = ["new", "awaiting_approval", "scheduled", "in_delivery", "completed", "cancelled"];
const TRUCKS = ["F 8123 AB", "F 8456 CD", "F 8789 EF", "F 8012 GH"];

export const DEMO_ORDERS: DemoOrderRow[] = Array.from({ length: 37 }, (_, i) => {
  const day = 1 + (i % 26);
  return {
    id: `order-${i + 1}`,
    number: `P-26-${String(120 + i).padStart(6, "0")}`,
    customer: CUSTOMERS[i % CUSTOMERS.length]!,
    businessDate: `2026-09-${String(day).padStart(2, "0")}`,
    volumeL: i % 7 === 0 ? 10_000 : 5_000,
    total: (i % 7 === 0 ? 2 : 1) * (200_000 + (i % 4) * 25_000),
    status: STATUSES[i % STATUSES.length]!,
    truck: TRUCKS[i % TRUCKS.length]!,
  };
});

export const DEMO_CUSTOMERS = CUSTOMERS.map((name, i) => ({
  value: `cust-${i + 1}`,
  label: name,
  description: `Kec. ${["Cianjur", "Cugenang", "Pacet", "Cipanas", "Karangtengah"][i % 5]} · 08xx-xxxx-${String(1000 + i * 37).slice(-4)}`,
}));

/** Pencarian pelanggan palsu (latensi 400 ms). */
export function searchDemoCustomers(query: string, signal: AbortSignal) {
  return new Promise<typeof DEMO_CUSTOMERS>((resolve, reject) => {
    const t = setTimeout(() => {
      const q = query.toLowerCase();
      resolve(DEMO_CUSTOMERS.filter((c) => c.label.toLowerCase().includes(q)));
    }, 400);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Dibatalkan", "AbortError"));
    });
  });
}

export const DEMO_PRODUCTS = [
  { id: "p1", name: "Isi ulang 19 L", price: 5_000, unitLabel: "galon" },
  { id: "p2", name: "Galon baru + isi", price: 45_000, unitLabel: "galon" },
  { id: "p3", name: "Tutup galon", price: 1_000 },
  { id: "p4", name: "Tisu galon", price: 500 },
  { id: "p5", name: "Cuci galon", price: 2_000 },
  { id: "p6", name: "Isi ulang 5 L", price: 2_000 },
  { id: "p7", name: "Segel galon", price: 500 },
  { id: "p8", name: "Pompa manual", price: 25_000 },
];

export const DEMO_TRIPS = [
  { id: "t1", seq: 1, number: "P-26-000120/1", customer: "Hotel Puncak Indah", address: "Jl. Raya Puncak Km 82, Cipanas", volumeL: 5_000, time: "07.00", payment: "Tunai", status: "completed" as const },
  { id: "t2", seq: 2, number: "P-26-000121/1", customer: "Pondok Pesantren Al-Ikhlas", address: "Kp. Babakan, Cugenang", volumeL: 5_000, time: "09.00", payment: "Tempo", status: "departed" as const, note: true },
  { id: "t3", seq: 3, number: "P-26-000125/1", customer: "Rumah Makan Sari Sunda", address: "Jl. Dr. Muwardi 12, Cianjur", volumeL: 5_000, time: "11.00", payment: "Transfer", status: "assigned" as const },
  { id: "t4", seq: 4, number: "P-26-000130/1", customer: "Depot EQUA Pacet (internal)", address: "Jl. Raya Pacet", volumeL: 5_000, time: "13.30", payment: "Internal", status: "assigned" as const },
];

/** Waktu acuan tetap untuk data demo (Minggu, 27 Sep 2026 15.30 WIB) agar render murni. */
export const DEMO_NOW = new Date("2026-09-27T08:30:00Z");

/** Instan `minutes` menit sebelum `DEMO_NOW`. */
export function demoAgo(minutes: number): Date {
  return new Date(DEMO_NOW.getTime() - minutes * 60_000);
}
