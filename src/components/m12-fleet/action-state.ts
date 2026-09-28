/** Status hasil Server Action layar armada M12 (isomorfik). */
export type M12ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
};
