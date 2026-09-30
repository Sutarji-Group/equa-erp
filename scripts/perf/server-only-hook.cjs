/**
 * Kait pemuat untuk skrip `scripts/perf/*` (dijalankan `tsx`, bukan Next.js/Vitest). tsx memuat berkas TS sebagai
 * CommonJS, jadi resolusi `require` ditambal untuk dua paket:
 * - `server-only` (penanda yang melempar galat di luar kondisi `react-server`) → modul kosong, sama seperti alias Vitest
 *   (`tests/stubs/server-only.ts`);
 * - `@react-pdf/renderer` (paket ESM-only yang subpath-nya tidak bisa di-`require`) → proksi kosong. Skrip uji beban
 *   tidak pernah merender PDF; modul yang mengimpornya hanya perlu termuat.
 * Pakai: `tsx --require ./scripts/perf/server-only-hook.cjs scripts/perf/<skrip>.ts`.
 */
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- berkas CommonJS yang dimuat `node --require` */

const Module = require("node:module");
const path = require("node:path");

const SERVER_ONLY_STUB = path.resolve(__dirname, "../../tests/stubs/server-only.ts");
const REACT_PDF_STUB = "equa-perf:react-pdf-stub";

/** Proksi yang dapat dipanggil/dibaca/di-`new` pada kedalaman berapa pun (mis. `StyleSheet.create({...}).judul`). */
function inert() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, key) => (key === "__esModule" ? true : key === Symbol.toPrimitive ? () => "" : inert()),
    apply: () => inert(),
    construct: () => inert(),
  });
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolvePerfStubs(request, ...rest) {
  if (request === "server-only") return SERVER_ONLY_STUB;
  if (request === "@react-pdf/renderer") return REACT_PDF_STUB;
  return originalResolve.call(this, request, ...rest);
};

const stub = new Module(REACT_PDF_STUB);
stub.filename = REACT_PDF_STUB;
stub.loaded = true;
stub.exports = inert();
Module._cache[REACT_PDF_STUB] = stub;
