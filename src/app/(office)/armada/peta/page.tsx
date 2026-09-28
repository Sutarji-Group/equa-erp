import { History, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { FleetLiveMap } from "@/components/m12-fleet/fleet-live-map";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/ids";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "Peta truk" };

/**
 * Peta posisi truk real-time (US-M12-02): Dispatcher (web) & pemilik (web/ponsel). Diperbarui ≤ 1 menit; klik truk →
 * rit hari ini, rit berikutnya, perkiraan tiba, kontak sopir, riwayat & putar ulang 24 jam. Peran lain tidak mendapat
 * data posisi (izin `m12.position.read`).
 */
export default async function PetaPage({ searchParams }: PageProps<"/armada/peta">) {
  const { ctx } = await requirePermission("m12.position.read");
  const sp = await searchParams;
  const selected = typeof sp.truk === "string" && isUuid(sp.truk) ? sp.truk : null;
  const snapshot = await m12.getFleetSnapshot(ctx, {});
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Peta truk"
        description="Posisi ketujuh truk dengan status rit. Posisi lebih tua dari batas PAR-48 ditandai basi."
        actions={
          <div className="flex flex-wrap gap-2">
            {can(ctx, "m12.trip_history.read") ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/armada/riwayat">
                  <History aria-hidden />
                  Riwayat perjalanan
                </Link>
              </Button>
            ) : null}
            {can(ctx, "m12.fleet_event.read") ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/armada/kejadian">
                  <TriangleAlert aria-hidden />
                  Kejadian armada
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <FleetLiveMap initial={snapshot} selectedTruckId={selected} />
    </div>
  );
}
