/**
 * Status hasil Server Action layar Data master (isomorfik — dipakai server action & komponen klien).
 */
export type DuplicateCandidateView = {
  customerId: string;
  code: string | null;
  name: string;
  reasonText: string;
  isActive: boolean;
};

export type ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  /** Pesan sukses singkat (toast). */
  message?: string;
  /** Kandidat duplikat pelanggan (US-M1-01 KP-7) — formulir menampilkan & meminta konfirmasi. */
  duplicates?: DuplicateCandidateView[];
  /** Penanda unik per keberhasilan (agar formulir dapat dikosongkan ulang). */
  nonce?: number;
};

export const EMPTY_ACTION_STATE: ActionState = {};
