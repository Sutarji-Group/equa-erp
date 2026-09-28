/**
 * Status hasil Server Action layar Pesanan & jadwal (isomorfik — dipakai server action & komponen klien).
 */
export type ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  /** Kode galat layanan (mis. `AFTER_CUTOFF`) agar layar dapat menawarkan tindakan lanjutan. */
  code?: string;
  /** Pesan sukses singkat (toast). */
  message?: string;
  /** Peringatan (tidak memblokir), mis. kapasitas terlampaui. */
  warnings?: string[];
  /** Tautan hasil (mis. WhatsApp). */
  link?: string;
  /** Penanda unik per keberhasilan. */
  nonce?: number;
};

export const EMPTY_ACTION_STATE: ActionState = {};
