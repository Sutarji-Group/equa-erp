/** Status hasil Server Action P2 (isomorfik; sama bentuknya dengan `CustomerActionState` di adaptor web). */
export type P2ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
};
