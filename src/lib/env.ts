/**
 * Validasi env server (Zod). Nilai opsional punya bawaan dev sehingga `pnpm dev` jalan tanpa `.env`.
 * Dibaca malas (lazy) lewat `serverEnv()` agar `next build` tidak gagal saat env produksi belum tersedia.
 * Dokumentasi tiap variabel: `.env.example`.
 *
 * Hanya untuk kode server & skrip. Jangan impor dari komponen klien (berisi rahasia).
 */
import { z } from "zod";

const DEV_SESSION_SECRET = "dev-only-session-secret-ganti-di-produksi-0000000000";
const DEV_CRON_SECRET = "dev-cron-secret";
const DEV_GPS_INGEST_TOKEN = "dev-gps-ingest-token";

const optionalString = z.string().min(1).optional();

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Vercel mengisi otomatis: `production` | `preview` | `development`. */
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),

    DB_DRIVER: z.enum(["pglite", "neon", "pg"]).default("pglite"),
    DATABASE_URL: optionalString,
    PGLITE_DATA_DIR: z.string().min(1).default("./.data/pglite"),

    APP_URL: z.url().default("http://localhost:3000"),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET minimal 32 karakter.").default(DEV_SESSION_SECRET),
    CRON_SECRET: z.string().min(1).default(DEV_CRON_SECRET),

    BLOB_READ_WRITE_TOKEN: optionalString,

    RESEND_API_KEY: optionalString,
    EMAIL_FROM: z.string().min(1).default("EQUA <noreply@equa.local>"),

    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    VAPID_SUBJECT: z.string().min(1).default("mailto:admin@equa.local"),

    MAP_ROUTING_PROVIDER: z.enum(["straight_line_x1_3", "osrm", "google"]).default("straight_line_x1_3"),
    MAP_ROUTING_URL: optionalString,
    MAP_ROUTING_API_KEY: optionalString,

    WA_PROVIDER: z.enum(["link", "cloud_api"]).default("link"),
    WA_CLOUD_TOKEN: optionalString,
    WA_CLOUD_PHONE_ID: optionalString,

    PAYMENT_GATEWAY: z.enum(["none", "midtrans"]).default("none"),
    MIDTRANS_SERVER_KEY: optionalString,
    MIDTRANS_CLIENT_KEY: optionalString,
    MIDTRANS_IS_PRODUCTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    GPS_INGEST_TOKEN: z.string().min(1).default(DEV_GPS_INGEST_TOKEN),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, when: string) =>
      ctx.addIssue({ code: "custom", path: [key], message: `${key} wajib diisi bila ${when}.` });

    if (env.DB_DRIVER !== "pglite" && !env.DATABASE_URL) need("DATABASE_URL", `DB_DRIVER=${env.DB_DRIVER}`);
    if (env.WA_PROVIDER === "cloud_api") {
      if (!env.WA_CLOUD_TOKEN) need("WA_CLOUD_TOKEN", "WA_PROVIDER=cloud_api");
      if (!env.WA_CLOUD_PHONE_ID) need("WA_CLOUD_PHONE_ID", "WA_PROVIDER=cloud_api");
    }
    if (env.PAYMENT_GATEWAY === "midtrans" && !env.MIDTRANS_SERVER_KEY) {
      need("MIDTRANS_SERVER_KEY", "PAYMENT_GATEWAY=midtrans");
    }

    // Deploy produksi Vercel: tolak rahasia bawaan dev & PGlite.
    if (env.VERCEL_ENV === "production") {
      if (env.DB_DRIVER === "pglite") {
        ctx.addIssue({ code: "custom", path: ["DB_DRIVER"], message: "Produksi wajib DB_DRIVER=neon atau pg." });
      }
      if (env.SESSION_SECRET === DEV_SESSION_SECRET) need("SESSION_SECRET", "berjalan di produksi");
      if (env.CRON_SECRET === DEV_CRON_SECRET) need("CRON_SECRET", "berjalan di produksi");
      if (env.GPS_INGEST_TOKEN === DEV_GPS_INGEST_TOKEN) need("GPS_INGEST_TOKEN", "berjalan di produksi");
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Urai env dari objek apa pun (string kosong dianggap tidak diisi). Melempar galat berbahasa Indonesia. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && v.trim() !== "") cleaned[k] = v.trim();
  }
  const result = serverEnvSchema.safeParse(cleaned);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `- ${i.path.join(".") || "(env)"}: ${i.message}`).join("\n");
    throw new Error(`Konfigurasi env server tidak valid:\n${detail}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Env server tervalidasi (di-cache per proses). */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

/** Kosongkan cache (khusus uji setelah mengubah `process.env`). */
export function resetServerEnvCache(): void {
  cached = undefined;
}
