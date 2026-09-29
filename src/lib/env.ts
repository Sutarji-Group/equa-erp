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
    /** Tambahan S5 (B-69): token verifikasi langganan webhook Meta (`hub.verify_token`). */
    WA_WEBHOOK_VERIFY_TOKEN: optionalString,
    /** Tambahan S5 (B-69): rahasia aplikasi Meta untuk tanda tangan webhook `X-Hub-Signature-256`. */
    WA_APP_SECRET: optionalString,

    PAYMENT_GATEWAY: z.enum(["none", "midtrans"]).default("none"),
    MIDTRANS_SERVER_KEY: optionalString,
    MIDTRANS_CLIENT_KEY: optionalString,
    MIDTRANS_IS_PRODUCTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    GPS_INGEST_TOKEN: z.string().min(1).default(DEV_GPS_INGEST_TOKEN),

    /**
     * Izinkan rahasia bawaan dev & rahasia TOTP `plain:` seed saat `next start` (NODE_ENV=production) — HANYA untuk E2E
     * lokal (di-set playwright.config.ts). Tidak pernah berlaku di VERCEL_ENV=production.
     */
    ALLOW_DEV_SECRETS: z
      .enum(["0", "1", "true", "false"])
      .default("0")
      .transform((v) => v === "1" || v === "true"),
    /** Diisi Next.js (`phase-production-build` saat `next build`). */
    NEXT_PHASE: z.string().optional(),
    /**
     * Tambahan S5 QA (skenario E2E P-01..P-07): izinkan jam tersuntik KHUSUS uji E2E — cookie `equa_e2e_clock`
     * (selisih ms untuk waktu pelaku kantor & perangkat lapangan) dan `/api/cron/tick?now=`. Hanya aktif bila juga
     * ALLOW_DEV_SECRETS=1 dan BUKAN deploy Vercel production/preview (`e2eClockAllowed`). Lihat `src/server/core/e2e-clock.ts`.
     */
    E2E_CLOCK_OVERRIDE: z
      .enum(["0", "1", "true", "false"])
      .default("0")
      .transform((v) => v === "1" || v === "true"),
  })
  .superRefine((env, ctx) => {
    const need = (key: keyof typeof env, when: string) =>
      ctx.addIssue({ code: "custom", path: [key], message: `${key} wajib diisi bila ${when}.` });

    if (env.DB_DRIVER !== "pglite" && !env.DATABASE_URL) need("DATABASE_URL", `DB_DRIVER=${env.DB_DRIVER}`);
    if (env.WA_PROVIDER === "cloud_api") {
      if (!env.WA_CLOUD_TOKEN) need("WA_CLOUD_TOKEN", "WA_PROVIDER=cloud_api");
      if (!env.WA_CLOUD_PHONE_ID) need("WA_CLOUD_PHONE_ID", "WA_PROVIDER=cloud_api");
    }
    // B-69: webhook status Cloud API di produksi wajib bertanda tangan (tanpa rahasia → webhook ditolak, fail-closed).
    if (env.WA_PROVIDER === "cloud_api" && !devSecretsAllowed(env)) {
      if (!env.WA_APP_SECRET) need("WA_APP_SECRET", "WA_PROVIDER=cloud_api di produksi/preview");
      if (!env.WA_WEBHOOK_VERIFY_TOKEN) need("WA_WEBHOOK_VERIFY_TOKEN", "WA_PROVIDER=cloud_api di produksi/preview");
    }
    if (env.PAYMENT_GATEWAY === "midtrans" && !env.MIDTRANS_SERVER_KEY) {
      need("MIDTRANS_SERVER_KEY", "PAYMENT_GATEWAY=midtrans");
    }

    // Deploy produksi Vercel: tolak PGlite.
    if (env.VERCEL_ENV === "production" && env.DB_DRIVER === "pglite") {
      ctx.addIssue({ code: "custom", path: ["DB_DRIVER"], message: "Produksi wajib DB_DRIVER=neon atau pg." });
    }
    if (env.VERCEL_ENV === "production" && env.ALLOW_DEV_SECRETS) {
      ctx.addIssue({ code: "custom", path: ["ALLOW_DEV_SECRETS"], message: "ALLOW_DEV_SECRETS tidak boleh aktif di produksi." });
    }
    // Tambahan S5 QA: jam tersuntik E2E tidak boleh dinyalakan di deploy Vercel (fail-closed, bukan diabaikan diam-diam).
    if ((env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") && env.E2E_CLOCK_OVERRIDE) {
      ctx.addIssue({ code: "custom", path: ["E2E_CLOCK_OVERRIDE"], message: "E2E_CLOCK_OVERRIDE hanya untuk uji E2E lokal — tidak boleh aktif di deploy Vercel." });
    }
    // Fail-closed: produksi (NODE_ENV=production saat berjalan, termasuk self-host) & deploy Vercel production/preview
    // menolak rahasia bawaan dev yang tertulis di repo. Pengecualian eksplisit hanya ALLOW_DEV_SECRETS=1 (E2E lokal).
    if (!devSecretsAllowed(env)) {
      const when = "berjalan di produksi/preview (isi rahasia sendiri; E2E lokal: ALLOW_DEV_SECRETS=1)";
      if (env.SESSION_SECRET === DEV_SESSION_SECRET) need("SESSION_SECRET", when);
      if (env.CRON_SECRET === DEV_CRON_SECRET) need("CRON_SECRET", when);
      if (env.GPS_INGEST_TOKEN === DEV_GPS_INGEST_TOKEN) need("GPS_INGEST_TOKEN", when);
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

type EnvFlags = Pick<ServerEnv, "NODE_ENV" | "VERCEL_ENV" | "NEXT_PHASE" | "ALLOW_DEV_SECRETS">;

/**
 * Lingkungan berperilaku produksi: deploy Vercel production/preview, atau server Node `NODE_ENV=production` yang sedang
 * BERJALAN (bukan fase `next build`).
 */
export function isProductionLike(env: Omit<EnvFlags, "ALLOW_DEV_SECRETS">): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return true;
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build";
}

/** Rahasia bawaan dev / rahasia TOTP `plain:` seed boleh dipakai (dev, uji, build, atau E2E lokal eksplisit). */
export function devSecretsAllowed(env: EnvFlags): boolean {
  if (!isProductionLike(env)) return true;
  return env.ALLOW_DEV_SECRETS && env.VERCEL_ENV !== "production";
}

/**
 * Tambahan S5 QA: jam tersuntik khusus E2E boleh dipakai. WAJIB ketiganya: `E2E_CLOCK_OVERRIDE=1`, `ALLOW_DEV_SECRETS=1`
 * (dua pilihan eksplisit terpisah), dan bukan deploy Vercel production/preview. Bawaan (termasuk produksi & self-host
 * tanpa kedua flag) = mati; nilai cookie/kueri diabaikan.
 */
export function e2eClockAllowed(env: Pick<ServerEnv, "VERCEL_ENV" | "ALLOW_DEV_SECRETS" | "E2E_CLOCK_OVERRIDE">): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  return env.E2E_CLOCK_OVERRIDE === true && env.ALLOW_DEV_SECRETS === true;
}

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
