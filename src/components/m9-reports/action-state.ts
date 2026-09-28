/** Status hasil Server Action layar laporan & kotak masuk (isomorfik). */
export type ReportActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  message?: string;
};
