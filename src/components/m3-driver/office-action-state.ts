/** Status hasil Server Action layar kantor M3 (isomorfik). */
export type M3ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
};
