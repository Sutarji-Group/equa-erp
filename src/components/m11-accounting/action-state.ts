/**
 * Status hasil Server Action layar Akuntansi (/akuntansi/*) — isomorfik (dipakai server action & komponen klien).
 */
export type M11ActionState = {
  ok?: boolean;
  /** Pesan galat berbahasa Indonesia (tanpa kode teknis). */
  error?: string;
  /** Pesan sukses singkat (toast). */
  message?: string;
  /** Halaman yang dibuka setelah berhasil (mis. rincian jurnal baru). */
  redirectTo?: string | null;
  /** Data pratinjau (impor bagan akun/aset) untuk ditampilkan formulir. */
  preview?: { rows: { line: number; code: string; name: string; action: string; errors: string[] }[]; summary: string } | null;
};

export const EMPTY_M11_STATE: M11ActionState = {};
