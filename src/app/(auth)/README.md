# (auth) — autentikasi web kantor

Rute: `/masuk` (nama pengguna + kata sandi), `/masuk/2fa` (TOTP), `/masuk/atur-2fa` (pendaftaran TOTP + QR),
`POST /keluar`. Server Action di `masuk/actions.ts`; logika di `src/server/core/auth` (`web-login.ts`, `session.ts`,
`office.ts`). Lihat `docs/ARCHITECTURE.md` §6. Aktivasi perangkat lapangan ada di `(field)/aktivasi-perangkat`.
