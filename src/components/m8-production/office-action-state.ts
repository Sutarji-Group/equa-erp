/** Status hasil Server Action layar kantor M8 (isomorfik — dipakai server action & komponen klien). */
export type M8ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
};
