import { Database, HardDrive, ListChecks, ShieldCheck, Smartphone, UserCog } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { requireOfficeSession } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";

export const metadata: Metadata = { title: "Akses & pengaturan" };

const LINKS = [
  { href: "/akses/pengguna", title: "Pengguna", body: "Akun, peran, lingkup, reset PIN/kata sandi/2FA.", perm: "m10.user.read", icon: UserCog },
  { href: "/akses/peran", title: "Peran & matriks", body: "Matriks peran × tindakan, pemisahan tugas, percobaan ditolak.", perm: "m10.role.read", icon: ShieldCheck },
  { href: "/akses/perangkat", title: "Perangkat", body: "Pendaftaran, penetapan, blokir, hapus jarak jauh, riwayat.", perm: "m10.device.read", icon: Smartphone },
  { href: "/akses/sinkron", title: "Perangkat & sinkron", body: "Kesehatan sinkron, insiden, versi minimal aplikasi.", perm: "m10.sync_health.read", icon: HardDrive },
  { href: "/akses/tinjauan", title: "Tinjauan hak akses", body: "Tinjauan kuartalan oleh pemilik.", perm: "m10.access_review.read", icon: ListChecks },
  { href: "/akses/data-pribadi", title: "Data pribadi", body: "Anonimisasi, retensi, status cadangan.", perm: "m10.personal_data.read", icon: Database },
] as const;

/** Ringkasan menu Akses (tautan sesuai izin pelaku). */
export default async function AksesPage() {
  const { ctx } = await requireOfficeSession();
  const links = LINKS.filter((l) => can(ctx, l.perm));
  return (
    <>
      <PageHeader title="Akses & pengaturan" description="Pengguna, hak akses, perangkat, dan jejak audit (M10)." />
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">Menu akses tidak tersedia untuk peran Anda.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex h-full gap-3 rounded-lg border bg-card p-4 hover:bg-accent">
                <l.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="block font-medium">{l.title}</span>
                  <span className="text-sm text-muted-foreground">{l.body}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
