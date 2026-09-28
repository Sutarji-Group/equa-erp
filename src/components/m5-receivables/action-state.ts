/**
 * Status hasil Server Action layar Piutang (/piutang/*) — isomorfik (dipakai server action & komponen klien).
 */
export type M5ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  /** Pesan sukses singkat (toast). */
  message?: string;
  /**
   * Tautan yang dibuka setelah berhasil (wa.me untuk WhatsApp, `mailto:` untuk draf e-mail) — US-M5-01 KP-5,
   * US-M5-02 KP-5, US-M5-05 KP-1.
   */
  link?: string | null;
};

export const EMPTY_M5_STATE: M5ActionState = {};
