"use client";

/**
 * Aksi per item antrean lapangan (NFR-07, NFR-08): "Kirim ulang" untuk data yang ditolak karena foto/lampiran gagal
 * diunggah (belum pernah sampai server), dan "Sudah dibaca" untuk item ditolak agar pita merah "data ditolak" hilang.
 */
import { useState } from "react";

import { canRetryOutboxItem, markRejectedReviewed, retryOutboxItem, syncNow, type OutboxItem } from "@/client/offline";
import { Button } from "@/components/ui/button";

export function OutboxItemActions({ item }: { item: OutboxItem }) {
  const [busy, setBusy] = useState(false);
  if (item.status !== "rejected") return null;
  const retry = canRetryOutboxItem(item);
  if (!retry && item.reviewedAt) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {retry ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-12 text-base"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (await retryOutboxItem(item.id)) void syncNow({ force: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Kirim ulang
        </Button>
      ) : null}
      {!item.reviewedAt ? (
        <Button type="button" variant="ghost" className="min-h-12 text-base" disabled={busy} onClick={() => void markRejectedReviewed(item.userId, [item.id])}>
          Sudah dibaca
        </Button>
      ) : null}
    </div>
  );
}
