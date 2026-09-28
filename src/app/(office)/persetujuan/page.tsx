import { inArray, eq } from "drizzle-orm";
import { CheckCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { employees, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatTanggalJam, toBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import * as approvals from "@/server/core/approvals";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { describeApprovalRules } from "@/server/modules/m10-access";

import { DecisionButtons } from "./decision-buttons";

export const metadata: Metadata = { title: "Persetujuan" };

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Tautan objek dari payload (`payload.link`, diisi modul saat mengajukan) bila ada. */
function objectLink(payload: Record<string, unknown> | null): string | null {
  const link = payload?.link;
  return typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

/**
 * Kotak persetujuan (US-M10-04): satu mekanisme untuk semua jenis 6.2a; lewat tenggat di atas; detail + tautan objek;
 * setujui/tolak (alasan wajib saat tolak). Permintaan milik sendiri tampil tanpa tombol keputusan (FR-M10-03).
 */
export default async function PersetujuanPage({ searchParams }: PageProps<"/persetujuan">) {
  const { ctx } = await requirePermission("m10.approval.read");
  const sp = await searchParams;
  const focusId = typeof sp.id === "string" ? sp.id : null;
  const listed = await approvals.listInbox(ctx);
  // Tautan push (`/persetujuan?id=…`, US-M10-04 KP-3): permintaan yang dibuka dari ponsel tampil paling atas agar dapat
  // diputuskan dengan satu ketuk.
  const inbox = focusId ? [...listed.filter((i) => i.id === focusId), ...listed.filter((i) => i.id !== focusId)] : listed;
  const rules = await describeApprovalRules(getDb(), toBusinessDate(ctx.now));
  const mine = await approvals.listMine(ctx, { limit: 20 });
  const names = await namesFor([...new Set([...inbox, ...mine].map((r) => r.requesterUserId))]);
  const overdue = inbox.filter((i) => i.isOverdue).length;

  return (
    <>
      <PageHeader
        title="Persetujuan"
        description={
          inbox.length
            ? `${inbox.length} permintaan menunggu${overdue ? `, ${overdue} lewat tenggat (di atas)` : ""}.`
            : "Permintaan persetujuan yang menunggu keputusan Anda."
        }
      />
      {inbox.length === 0 ? (
        <EmptyState icon={CheckCheck} title="Tidak ada permintaan menunggu" description="Semua permintaan sudah diputuskan." />
      ) : (
        <ul className="grid gap-4">
          {inbox.map((item) => {
            const link = objectLink(item.payload);
            return (
              <li
                key={item.id}
                id={`permintaan-${item.id}`}
                className={cn("rounded-lg border bg-card p-4", item.isOverdue && "border-destructive/50", focusId === item.id && "ring-2 ring-ring")}
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">
                      {item.typeLabel} · <span className="tabular">{item.number}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">{item.reason}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.isOverdue ? <ToneBadge tone="danger">Lewat tenggat</ToneBadge> : null}
                    {item.viaDelegation ? <ToneBadge tone="info">Delegasi</ToneBadge> : null}
                    <StatusBadge enumName="approval_status" value={item.status} />
                  </div>
                </div>
                <KeyValueList
                  columns={3}
                  items={[
                    { label: "Pemohon", value: `${names.get(item.requesterUserId) ?? "—"}${item.requesterRole ? ` (${label("role", item.requesterRole)})` : ""}` },
                    { label: "Nilai", value: item.amount != null ? <MoneyText value={item.amount} /> : "—" },
                    { label: "Tenggat", value: item.deadlineAt ? formatTanggalJam(item.deadlineAt) : "—" },
                    {
                      label: "Objek",
                      value: link ? (
                        <Link href={link} className="text-primary underline-offset-4 hover:underline">
                          {item.objectType} {item.objectId}
                        </Link>
                      ) : (
                        `${item.objectType} ${item.objectId}`
                      ),
                    },
                    { label: "Diajukan", value: formatTanggalJam(item.createdAt) },
                    { label: "Penyetuju", value: label("role", item.approverRole) },
                  ]}
                />
                <div className="mt-4">
                  {item.canDecide ? (
                    <DecisionButtons id={item.id} number={item.number} />
                  ) : (
                    <p className="text-sm text-muted-foreground">{item.blockedReason}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <SectionCard title="Aturan persetujuan (Bab 6.2a)" description="Pemohon, penyetuju, ambang dari parameter yang berlaku hari ini, tenggat, dan perlakuan bila lewat tenggat." className="mt-8">
        <details>
          <summary className="cursor-pointer text-sm font-medium">Tampilkan {rules.length} jenis persetujuan</summary>
          <div className="mt-3 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[720px] text-sm" data-testid="aturan-persetujuan">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">Jenis</th>
                  <th className="py-2 pr-3">Pemohon</th>
                  <th className="py-2 pr-3">Penyetuju</th>
                  <th className="py-2 pr-3">Ambang / syarat</th>
                  <th className="py-2 pr-3">Tenggat</th>
                  <th className="py-2">Bila lewat tenggat</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.type} className="border-b align-top">
                    <td className="py-2 pr-3 font-medium">{r.label}</td>
                    <td className="py-2 pr-3">{r.requesters.join(", ")}</td>
                    <td className="py-2 pr-3">{r.approver}</td>
                    <td className="py-2 pr-3">
                      {r.threshold}
                      {r.thresholdParam ? <span className="block text-xs text-muted-foreground">{r.thresholdParam}: {JSON.stringify(r.thresholdValue)}</span> : null}
                    </td>
                    <td className="py-2 pr-3">{r.deadline}</td>
                    <td className="py-2">{r.expireNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </SectionCard>

      <SectionCard title="Permintaan saya" description="Riwayat permintaan yang Anda ajukan." className="mt-8">
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada permintaan.</p>
        ) : (
          <ul className="grid gap-2">
            {mine.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <span>
                  <span className="tabular font-medium">{r.number}</span> · {label("approval_type", r.type)} · {r.reason}
                  {r.decisionReason ? <span className="text-muted-foreground"> — alasan keputusan: {r.decisionReason}</span> : null}
                </span>
                <StatusBadge enumName="approval_status" value={r.status} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
