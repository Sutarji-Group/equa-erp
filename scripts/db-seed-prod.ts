/**
 * `pnpm db:seed:prod` — seed PRODUKSI tanpa data demo (`src/db/seed/production.ts`): parameter Lampiran B, tenant EQUA,
 * bagan akun & pemetaan bawaan, template, dan akun pertama PEMILIK + ADMIN SISTEM. Jalankan SESUDAH `pnpm db:migrate`.
 *
 * Contoh (non-interaktif; kata sandi SEMENTARA lewat env agar tidak tercatat di riwayat shell):
 *   EQUA_OWNER_PASSWORD='…' EQUA_ADMIN_PASSWORD='…' DB_DRIVER=neon DATABASE_URL='…' pnpm db:seed:prod -- \
 *     --owner-username pemilik --owner-name "Nama Pemilik" --owner-phone 62812… \
 *     --admin-username admin.it --admin-name "Nama Admin Sistem" --yes
 * Interaktif (terminal): `pnpm db:seed:prod` lalu jawab pertanyaan (kata sandi tidak ditampilkan).
 * Hanya data acuan (tanpa akun): `pnpm db:seed:prod -- --no-accounts`.
 *
 * Idempoten: aman dijalankan ulang; akun yang sudah ada dilewati. Menolak DB berisi data demo.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { closeDb, getDb, getDbDriver } from "@/db/client";
import { type InitialAccountInput, ProductionSeedError, runProductionSeed, validateInitialAccounts } from "@/db/seed/production";

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[key] = argv[++i]!;
    else out[key] = true;
  }
  return out;
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (options.hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = Boolean(options.hidden);
  });
}

async function value(args: Args, key: string, question: string, required = true): Promise<string | null> {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (!interactive) {
    if (required) throw new ProductionSeedError(`Argumen --${key} wajib diisi (atau jalankan di terminal interaktif).`);
    return null;
  }
  const answer = await ask(question);
  if (!answer && required) throw new ProductionSeedError(`${question.replace(/:\s*$/, "")} wajib diisi.`);
  return answer || null;
}

async function password(envKey: string, label: string): Promise<string> {
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  if (!interactive) throw new ProductionSeedError(`Isi env ${envKey} (kata sandi sementara ${label}) atau jalankan di terminal interaktif.`);
  const first = await ask(`Kata sandi sementara ${label} (≥ 10 karakter, tidak ditampilkan): `, { hidden: true });
  const second = await ask(`Ulangi kata sandi ${label}: `, { hidden: true });
  if (first !== second) throw new ProductionSeedError(`Kata sandi ${label} tidak sama. Jalankan ulang skrip.`);
  return first;
}

async function collectAccounts(args: Args): Promise<InitialAccountInput[]> {
  if (args["no-accounts"]) return [];
  const owner: InitialAccountInput = {
    role: "owner",
    username: (await value(args, "owner-username", "Nama pengguna PEMILIK: "))!,
    fullName: (await value(args, "owner-name", "Nama lengkap pemilik: "))!,
    phone: await value(args, "owner-phone", "No. HP pemilik (62…, boleh kosong): ", false),
    password: await password("EQUA_OWNER_PASSWORD", "pemilik"),
  };
  const admin: InitialAccountInput = {
    role: "system_admin",
    username: (await value(args, "admin-username", "Nama pengguna ADMIN SISTEM: "))!,
    fullName: (await value(args, "admin-name", "Nama lengkap admin sistem: "))!,
    phone: await value(args, "admin-phone", "No. HP admin sistem (62…, boleh kosong): ", false),
    password: await password("EQUA_ADMIN_PASSWORD", "admin sistem"),
  };
  return validateInitialAccounts([owner, admin]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accounts = await collectAccounts(args);
  const driver = process.env.DB_DRIVER?.trim() || "pglite";
  console.log(`db:seed:prod → driver ${driver}${driver === "pglite" ? ` (${process.env.PGLITE_DATA_DIR || "./.data/pglite"}; hanya untuk gladi bersih lokal)` : ""}`);
  console.log(
    accounts.length
      ? `Akun pertama: ${accounts.map((a) => `${a.username} (${a.role === "owner" ? "pemilik" : "admin sistem"})`).join(", ")}`
      : "Tanpa akun (--no-accounts): hanya data acuan.",
  );
  if (!args.yes && interactive) {
    const ok = await ask("Lanjutkan? Ketik 'ya': ");
    if (ok.toLowerCase() !== "ya") {
      console.log("Dibatalkan.");
      return;
    }
  }
  const db = getDb();
  const summary = await runProductionSeed(db, { accounts });
  console.log(`Driver aktif: ${getDbDriver()}. Parameter baru: ${summary.parameters}.`);
  for (const a of summary.accounts) {
    console.log(`- ${a.username}: ${a.status === "created" ? "dibuat (wajib ganti kata sandi & daftar 2FA saat login pertama)" : "sudah ada — dilewati"}`);
  }
  console.table(summary.counts);
  console.log(
    "Langkah berikut: login di /masuk → pindai QR 2FA → ganti kata sandi sementara. Admin sistem membuat akun lain di Akses > Pengguna (disetujui pemilik); data awal lewat Master > Impor (docs/uat/cutover.md).",
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof ProductionSeedError) console.error(`Gagal: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
