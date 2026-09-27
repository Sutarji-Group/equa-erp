import { redirect } from "next/navigation";

/** Akar situs: arahkan ke halaman masuk (proxy/sesi akan mengarahkan pengguna yang sudah masuk ke /beranda). */
export default function Home(): never {
  redirect("/masuk");
}
