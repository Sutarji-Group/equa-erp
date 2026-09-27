// Setup global Vitest. Berjalan sebelum setiap berkas uji.
// - Zona waktu proses dipaksa UTC (vitest.config.ts `test.env.TZ`) agar logika WIB tidak bergantung mesin.
// - Uji komponen React (happy-dom) boleh memanggil `cleanup` dari @testing-library/react sendiri.
process.env.TZ = "UTC";
