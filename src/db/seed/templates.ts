/**
 * Template pesan WhatsApp bawaan (NFR-20; dikelola pemilik): konfirmasi pesanan (US-M2-07), struk rit (US-M3-03 KP-7),
 * bukti pelunasan (US-M3-05 KP-5), pengingat H-3 & H+1 (US-M5-05). Penanda `{{variabel}}` diisi `buildWaLink`.
 */
import type { EnumValue } from "@/lib/labels";

import type { DbOrTx } from "../client";
import { waTemplates } from "../schema";
import { seedId } from "./ids";
import { EQUA_TENANT_ID } from "./org";

type TemplateSeed = { kind: EnumValue<"wa_message_kind">; name: string; body: string };

export const WA_TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    kind: "order_confirmation",
    name: "Konfirmasi pesanan",
    body: [
      "Assalamualaikum {{nama_pelanggan}},",
      "Pesanan air Anda sudah kami catat:",
      "No. pesanan: {{nomor_pesanan}}",
      "Tanggal kirim: {{tanggal_kirim}} {{jam_kirim}}",
      "Jumlah: {{jumlah_tangki}} tangki (5.000 L/tangki)",
      "Harga: {{harga_per_rit}}/rit, total {{total}}",
      "Cara bayar: {{cara_bayar}}",
      "Hubungi kami: {{kontak_equa}}",
      "Terima kasih — {{nama_usaha}}",
    ].join("\n"),
  },
  {
    kind: "trip_receipt",
    name: "Struk rit",
    body: [
      "Struk pengiriman air {{nama_usaha}}",
      "No. rit: {{nomor_rit}}",
      "Tanggal: {{tanggal}}",
      "Volume terkirim: {{volume}}",
      "Harga: {{harga}}",
      "Cara bayar: {{cara_bayar}}",
      "Diterima oleh: {{nama_penerima}}",
      "{{sisa_piutang}}",
      "Terima kasih.",
    ].join("\n"),
  },
  {
    kind: "payment_receipt",
    name: "Bukti pelunasan",
    body: [
      "Bukti pelunasan {{nama_usaha}}",
      "Pelanggan: {{nama_pelanggan}}",
      "Tanggal: {{tanggal}}",
      "Jumlah dibayar: {{jumlah}}",
      "Faktur: {{daftar_faktur}}",
      "Sisa piutang: {{sisa_piutang}}",
      "Terima kasih.",
    ].join("\n"),
  },
  {
    kind: "reminder_before_due",
    name: "Pengingat H-3 jatuh tempo",
    body: [
      "Yth. {{nama_pelanggan}},",
      "Kami mengingatkan faktur {{nomor_faktur}} sebesar {{jumlah}} akan jatuh tempo pada {{jatuh_tempo}}.",
      "Pembayaran dapat ditransfer ke {{rekening}} a.n. {{nama_rekening}}.",
      "Abaikan pesan ini bila sudah membayar. Terima kasih — {{nama_usaha}}",
    ].join("\n"),
  },
  {
    kind: "reminder_after_due",
    name: "Pengingat H+1 lewat jatuh tempo",
    body: [
      "Yth. {{nama_pelanggan}},",
      "Faktur {{nomor_faktur}} sebesar {{jumlah}} telah jatuh tempo pada {{jatuh_tempo}}.",
      "Mohon segera melakukan pembayaran ke {{rekening}} a.n. {{nama_rekening}} agar pesanan tempo berikutnya tetap dapat dilayani.",
      "Terima kasih — {{nama_usaha}}",
    ].join("\n"),
  },
];

/** Variabel `{{…}}` yang dipakai sebuah template. */
export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
}

export async function seedWaTemplates(tx: DbOrTx): Promise<void> {
  await tx
    .insert(waTemplates)
    .values(
      WA_TEMPLATE_SEEDS.map((t) => ({
        id: seedId(`wa_template:${t.kind}:1`),
        tenantId: EQUA_TENANT_ID,
        kind: t.kind,
        name: t.name,
        body: t.body,
        variables: templateVariables(t.body),
        version: 1,
      })),
    )
    .onConflictDoNothing();
}
