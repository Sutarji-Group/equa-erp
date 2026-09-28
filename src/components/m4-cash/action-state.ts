/** Status hasil Server Action layar kas (isomorfik). */
export type CashActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
};
