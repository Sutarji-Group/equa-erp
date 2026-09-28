/**
 * Bentuk hasil Server Action halaman M10 (isomorfik — dipakai server action & `ActionForm` klien).
 * `secret` = nilai yang hanya ditampilkan SEKALI (kode aktivasi perangkat, kode PIN, kata sandi sementara).
 */
export type ActionState =
  | {
      ok?: boolean;
      error?: string;
      message?: string;
      secret?: { label: string; value: string; note?: string };
    }
  | undefined;

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
