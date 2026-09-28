/**
 * Galat domain EQUA (docs/ARCHITECTURE.md §3 butir 6). Pesan SELALU Bahasa Indonesia, berisi tindakan, tanpa kode
 * teknis — UI menampilkan `error.message` apa adanya. `code` untuk logika program/uji, bukan untuk pengguna.
 *
 * - `DomainError(code, pesan)`       — pelanggaran aturan bisnis (HTTP 422).
 * - `ForbiddenError`                 — peran/lingkup/pemisahan tugas menolak (HTTP 403); dicatat di log akses.
 * - `NotFoundError`                  — objek tidak ada / di luar tenant (HTTP 404).
 * - `ValidationError`                — isian tidak valid; menerjemahkan isu Zod ke Indonesia (HTTP 400).
 * - `ConflictError`                  — status objek sudah berubah (mis. persetujuan sudah diputuskan) (HTTP 409).
 *
 * Isomorfik (tanpa 'server-only'): aman diimpor komponen klien untuk `instanceof`/`toUserMessage`.
 */
import type { ZodError, ZodType, z } from "zod";

export type DomainErrorDetails = Record<string, unknown>;

export class DomainError extends Error {
  readonly code: string;
  readonly details?: DomainErrorDetails;
  /** Status HTTP yang disarankan untuk route handler. */
  readonly status: number = 422;

  constructor(code: string, message: string, details?: DomainErrorDetails) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export type ForbiddenErrorOptions = {
  /** Izin yang diminta, mis. `m4.deposit.receive`. */
  permission?: string;
  /** Kode aturan yang dilanggar, mis. `SOD-01`, `SCOPE-OUTLET`, `PTB-31`. */
  rule?: string;
  objectType?: string;
  objectId?: string;
  details?: DomainErrorDetails;
};

export class ForbiddenError extends DomainError {
  override readonly status = 403;
  readonly permission?: string;
  readonly rule?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  /** Sudah dicatat ke `access_logs` (hindari pencatatan ganda). */
  logged = false;

  constructor(message: string, options: ForbiddenErrorOptions = {}) {
    super("FORBIDDEN", message, options.details);
    this.name = "ForbiddenError";
    this.permission = options.permission;
    this.rule = options.rule;
    this.objectType = options.objectType;
    this.objectId = options.objectId;
  }
}

export class NotFoundError extends DomainError {
  override readonly status = 404;
  constructor(message = "Data tidak ditemukan. Muat ulang halaman lalu coba lagi.", details?: DomainErrorDetails) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  override readonly status = 409;
  constructor(code: string, message: string, details?: DomainErrorDetails) {
    super(code, message, details);
    this.name = "ConflictError";
  }
}

export type ValidationIssue = { path: string; message: string };

export class ValidationError extends DomainError {
  override readonly status = 400;
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = []) {
    super("VALIDATION", message, { issues });
    this.name = "ValidationError";
    this.issues = issues;
  }

  /** Satu isian tidak valid. */
  static field(path: string, message: string): ValidationError {
    return new ValidationError(message, [{ path, message }]);
  }

  /**
   * Terjemahkan `ZodError` menjadi ValidationError berbahasa Indonesia. Pesan kustom skema (`{ error: "…" }`)
   * dipertahankan; pesan bawaan Zod (Inggris) diterjemahkan dari kode isunya.
   */
  static fromZod(error: ZodError, labels: FieldLabels = {}): ValidationError {
    const issues = error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      const message = looksLikeZodDefault(issue.message) ? translateZodIssue(issue as unknown as RawIssueLike) : issue.message;
      return { path, message: withFieldLabel(path, message, labels) };
    });
    return new ValidationError(summarize(issues), issues);
  }
}

/** Label Indonesia per jalur isian (mis. `{ amount: "Jumlah" }`) untuk pesan galat. */
export type FieldLabels = Record<string, string>;

function summarize(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "Isian tidak valid. Periksa kembali lalu simpan ulang.";
  const first = issues[0]!.message;
  return issues.length === 1 ? first : `${first} (dan ${issues.length - 1} isian lain perlu diperbaiki).`;
}

function withFieldLabel(path: string, message: string, labels: FieldLabels): string {
  const label = labels[path];
  if (!label) return message;
  return message.toLowerCase().startsWith(label.toLowerCase()) ? message : `${label}: ${message}`;
}

const ZOD_DEFAULT_PATTERN = /^(Invalid|Too (big|small)|Expected|Unrecognized|Number must|String must|Required)/;

function looksLikeZodDefault(message: string): boolean {
  return ZOD_DEFAULT_PATTERN.test(message);
}

type RawIssueLike = {
  code: string;
  input?: unknown;
  expected?: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  format?: string;
  values?: unknown[];
  keys?: string[];
  divisor?: number;
};

const FORMAT_LABELS: Record<string, string> = {
  email: "alamat e-mail",
  url: "alamat URL",
  uuid: "ID",
  datetime: "tanggal dan jam",
  date: "tanggal (YYYY-MM-DD)",
  time: "jam (HH:mm)",
  regex: "format",
};

/**
 * Pesan Indonesia yang ramah pengguna untuk satu isu Zod (dipakai sebagai error map per-parse, sehingga pesan kustom
 * skema tetap diutamakan).
 */
export function translateZodIssue(issue: RawIssueLike): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined || issue.input === null) return "Wajib diisi.";
      if (issue.expected === "number" || issue.expected === "int") return "Harus berupa angka.";
      if (issue.expected === "string") return "Harus berupa teks.";
      if (issue.expected === "boolean") return "Harus dipilih ya atau tidak.";
      if (issue.expected === "date") return "Tanggal tidak valid.";
      if (issue.expected === "array") return "Harus berupa daftar.";
      return "Isian tidak valid.";
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") {
        return min <= 1 ? "Wajib diisi." : `Minimal ${min} karakter.`;
      }
      if (issue.origin === "array" || issue.origin === "set") return `Pilih minimal ${min} item.`;
      return issue.inclusive === false ? `Harus lebih dari ${min}.` : `Minimal ${min}.`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return `Maksimal ${max} karakter.`;
      if (issue.origin === "array" || issue.origin === "set") return `Maksimal ${max} item.`;
      return issue.inclusive === false ? `Harus kurang dari ${max}.` : `Maksimal ${max}.`;
    }
    case "invalid_format":
      return `Format ${FORMAT_LABELS[issue.format ?? ""] ?? "isian"} tidak valid.`;
    case "invalid_value":
    case "invalid_union":
      return "Pilihan tidak valid. Pilih salah satu dari daftar.";
    case "not_multiple_of":
      return `Harus kelipatan ${issue.divisor}.`;
    case "unrecognized_keys":
      return `Isian tidak dikenal: ${(issue.keys ?? []).join(", ")}.`;
    default:
      return "Isian tidak valid.";
  }
}

/** Error map Zod per-parse berbahasa Indonesia. */
export const indonesianZodErrorMap = (issue: unknown): string => translateZodIssue(issue as RawIssueLike);

/**
 * Validasi masukan layanan dengan Zod (langkah ke-2 lapisan layanan). Melempar `ValidationError` Indonesia.
 * `labels` memberi nama isian pada pesan (mis. `{ amount: "Jumlah" }`).
 */
export function parseInput<S extends ZodType>(schema: S, input: unknown, labels: FieldLabels = {}): z.output<S> {
  const result = schema.safeParse(input, { error: indonesianZodErrorMap });
  if (!result.success) throw ValidationError.fromZod(result.error, labels);
  return result.data;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** SQLSTATE trigger pengerasan DB (src/db/sql/hardening.sql): EQ001 hapus ditolak, EQ002 append-only. */
const HARDENING_SQLSTATES = new Set(["EQ001", "EQ002"]);

/** Benar bila galat berasal dari trigger pengerasan DB (disalin dari `@/db/hardening` agar berkas ini isomorfik). */
export function isHardeningViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return HARDENING_SQLSTATES.has(code);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const GENERIC_MESSAGE = "Terjadi kesalahan di server. Coba lagi; bila berulang, hubungi admin sistem.";

/**
 * Pesan yang aman ditampilkan ke pengguna untuk galat apa pun: pesan DomainError apa adanya; pelanggaran trigger
 * pengerasan DB (EQ001/EQ002) diterjemahkan; galat lain → pesan umum (detail teknis hanya di log server).
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  if (isHardeningViolation(error)) {
    return "Data tidak boleh dihapus atau diubah langsung. Lakukan koreksi dengan transaksi pembalik beralasan.";
  }
  return GENERIC_MESSAGE;
}

/** Status HTTP untuk galat apa pun (DomainError → status-nya; lainnya 500). */
export function toHttpStatus(error: unknown): number {
  if (error instanceof DomainError) return error.status;
  if (isHardeningViolation(error)) return 409;
  return 500;
}

/** Respons JSON standar untuk route handler: `{ ok: false, code, message, issues? }`. */
export function errorResponse(error: unknown): Response {
  const status = toHttpStatus(error);
  const body: Record<string, unknown> = {
    ok: false,
    code: error instanceof DomainError ? error.code : "INTERNAL",
    message: toUserMessage(error),
  };
  if (error instanceof ValidationError) body.issues = error.issues;
  if (status >= 500) console.error("[equa] galat tak tertangani:", error);
  return Response.json(body, { status });
}
