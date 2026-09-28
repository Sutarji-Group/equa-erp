/**
 * M4 — kontrak data pull lapangan `m4.my_cash` (isomorfik, tanpa impor server): hasil penerimaan setoran & keputusan
 * selisih milik pengguna sendiri (US-M4-02 KP-8) dan saldo ganti rugi karyawan bersangkutan (US-M4-03 KP-3).
 * Diisi penyedia pull `src/server/modules/m4-cash/service/pull.ts`; ditampilkan `MyCashCard`
 * (`src/components/m4-cash/my-cash-card.tsx`) di aplikasi sopir/POS.
 */

export const M4_MY_CASH_KEY = "m4.my_cash" as const;

export type MyCashRestitutionItem = { id: string; businessDate: string; amount: number; settledAmount: number; status: string; reason: string };

export type MyCashDeposit = {
  id: string;
  number: string;
  businessDate: string;
  sourceType: string;
  status: string;
  expectedNet: number;
  receivedAmount: number | null;
  discrepancyAmount: number | null;
  discrepancyReason: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  /** Keputusan pemilik atas selisih setoran ini (Disetujui/Ditolak) bila ada. */
  decision: string | null;
  decisionReason: string | null;
};

export type MyCashReference = {
  employeeId: string | null;
  restitution: { outstanding: number; recorded: number; settled: number; items: MyCashRestitutionItem[] };
  deposits: MyCashDeposit[];
};
