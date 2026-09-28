/**
 * Konstanta data demo (HANYA untuk dev/uji/demo — dokumentasi di README). Jangan dipakai di produksi.
 */

/** Tanggal berlaku bawaan parameter, harga, tarif, pemetaan akun (cukup lampau agar semua tanggal uji tercakup). */
export const SEED_EFFECTIVE_FROM = "2025-01-01";

/** Kata sandi demo semua pengguna web kantor. */
export const SEED_DEMO_PASSWORD = "equa-demo-2026";

/** PIN demo semua pengguna lapangan/POS. */
export const SEED_DEMO_PIN = "123456";

/**
 * Rahasia TOTP demo (base32, 20 byte) untuk peran wajib 2FA (PTB-35). Disimpan di `users.totp_secret_enc` dengan
 * awalan `plain:` (dev saja) — lapisan autentikasi harus menerima awalan ini di luar produksi.
 */
export const SEED_TOTP_SECRETS = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
  keuangan2: "EQUADEMOKEUANGANDUARAHASIATOTPAA",
  admin1: "EQUADEMOADMINSATURAHASIATOTPAAAA",
  admin2: "EQUADEMOADMINDUARAHASIATOTPAAAAA",
} as const;

/** Awalan rahasia TOTP tak terenkripsi (dev). */
export const PLAIN_SECRET_PREFIX = "plain:";

/** Kode tenant EQUA. */
export const EQUA_TENANT_CODE = "EQUA";
