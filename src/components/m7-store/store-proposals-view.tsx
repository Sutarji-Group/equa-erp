"use client";

import { Lightbulb } from "lucide-react";
import { useState } from "react";

import { BigButton } from "@/components/field/big-button";
import { usePos } from "@/components/m6-pos/pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection, ReasonField } from "@/components/m6-pos/ui";
import { newId } from "@/lib/ids";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";

import { useStore } from "./store-context";

type Kind = "product" | "price" | "supplier";

/**
 * Usulan kasir (US-M7-02 KP-2, 7.7.3): barang baru, perubahan harga jual (tanggal berlaku), pemasok baru — semuanya
 * berlaku setelah disetujui Admin Keuangan.
 */
export function StoreProposalsView() {
  const { send, session } = usePos();
  const { store } = useStore();
  const [kind, setKind] = useState<Kind>("product");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("pcs");
  const [general, setGeneral] = useState<number | null>(null);
  const [partner, setPartner] = useState<number | null>(null);
  const [minStock, setMinStock] = useState<number | null>(null);
  const [productId, setProductId] = useState("");
  const [priceKind, setPriceKind] = useState<"general" | "partner">("general");
  const [price, setPrice] = useState<number | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(store?.businessDate ?? "");
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState("");
  const [contact, setContact] = useState("");
  const [term, setTerm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (store === undefined) return <Banner tone="info">Mengunduh data toko…</Banner>;
  if (!store) return <Banner tone="danger">Perangkat ini bukan POS toko.</Banner>;

  async function submit() {
    setError(null);
    setDone(null);
    try {
      if (kind === "product") {
        if (code.trim().length < 2 || name.trim().length < 2) return setError("Isi kode dan nama barang.");
        if (!general || !partner) return setError("Isi harga umum dan harga mitra.");
        await send("m7.store_product.propose", { productId: newId(), code: code.trim(), name: name.trim(), unit: unit.trim() || "pcs", generalPrice: general, partnerPrice: partner, minStock }, `Usulan barang ${name.trim()}`);
        setCode("");
        setName("");
        setGeneral(null);
        setPartner(null);
        setMinStock(null);
      } else if (kind === "price") {
        if (!productId) return setError("Pilih barang.");
        if (!price) return setError("Isi harga baru.");
        if (!effectiveFrom) return setError("Isi tanggal berlaku.");
        if (reason.trim().length < 3) return setError("Isi alasan perubahan harga.");
        await send("m7.store_price.propose", { priceId: newId(), productId, kind: priceKind, price, effectiveFrom, reason: reason.trim() }, "Usulan harga jual");
        setPrice(null);
        setReason("");
      } else {
        if (name.trim().length < 2) return setError("Isi nama pemasok.");
        await send("m7.supplier.create", { supplierId: newId(), name: name.trim(), contactName: contact.trim() || null, phone: phone.trim() || null, paymentTermDays: term }, `Usulan pemasok ${name.trim()}`);
        setName("");
        setContact("");
        setPhone("");
        setTerm(null);
      }
      setDone("Usulan terkirim ke Admin Keuangan. Berlaku setelah disetujui.");
      if (session.sync.online) void session.sync.syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Usulan gagal disimpan.");
    }
  }

  const active = store.products.filter((p) => p.status === "active");
  const current = active.find((p) => p.id === productId);
  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <PosSection title="Ajukan usulan" testId="usulan-toko">
        <ChoiceButtons
          label="Jenis usulan"
          value={kind}
          onChange={setKind}
          options={[
            { value: "product", label: "Barang baru" },
            { value: "price", label: "Harga jual" },
            { value: "supplier", label: "Pemasok baru" },
          ]}
        />
        {done ? <Banner tone="success">{done}</Banner> : null}
        {kind === "product" ? (
          <>
            <ReasonField id="kode-barang" label="Kode barang" value={code} onChange={setCode} />
            <ReasonField id="nama-barang" label="Nama barang" value={name} onChange={setName} />
            <ReasonField id="satuan" label="Satuan" value={unit} onChange={setUnit} />
            <NumberField id="harga-umum" label="Harga umum" prefix="Rp" value={general} onChange={setGeneral} />
            <NumberField id="harga-mitra" label="Harga mitra" prefix="Rp" value={partner} onChange={setPartner} />
            <NumberField id="stok-min" label="Stok minimum" value={minStock} onChange={setMinStock} />
          </>
        ) : kind === "price" ? (
          <>
            <label className="flex flex-col gap-1.5 text-base font-medium">
              Barang
              <select aria-label="Barang" value={productId} onChange={(e) => setProductId(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg">
                <option value="">— pilih barang —</option>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <ChoiceButtons
              label="Jenis harga"
              value={priceKind}
              onChange={setPriceKind}
              options={[
                { value: "general", label: "Harga umum" },
                { value: "partner", label: "Harga mitra" },
              ]}
            />
            {current ? <p className="text-base text-muted-foreground">Harga sekarang: {typeof current.prices[priceKind] === "number" ? formatRupiah(current.prices[priceKind]!) : "—"}</p> : null}
            <NumberField id="harga-baru" label="Harga baru" prefix="Rp" value={price} onChange={setPrice} />
            <label className="flex flex-col gap-1.5 text-base font-medium">
              Tanggal berlaku
              <input type="date" aria-label="Tanggal berlaku" min={store.businessDate} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg" />
            </label>
            <ReasonField id="alasan-harga" label="Alasan" value={reason} onChange={setReason} />
          </>
        ) : (
          <>
            <ReasonField id="nama-pemasok" label="Nama pemasok" value={name} onChange={setName} />
            <ReasonField id="kontak-pemasok" label="Nama kontak" value={contact} onChange={setContact} />
            <ReasonField id="telp-pemasok" label="Telepon" value={phone} onChange={setPhone} />
            <NumberField id="tempo-pemasok" label="Tempo bayar (hari; kosong = 30 hari)" value={term} onChange={setTerm} />
          </>
        )}
        <ErrorText>{error}</ErrorText>
        <BigButton icon={<Lightbulb aria-hidden />} onClick={() => void submit()}>
          Kirim usulan
        </BigButton>
      </PosSection>
      <PosSection title="Usulan & persetujuan saya">
        <ul className="flex flex-col divide-y">
          {store.proposals.map((p) => (
            <li key={p.id} className="flex flex-col gap-0.5 py-2 text-base">
              <span className="font-semibold">{p.label}</span>
              <span className="text-sm text-muted-foreground">
                {formatTanggalJam(p.createdAt)} · {label("approval_status", p.status)}
                {p.decisionReason ? ` · ${p.decisionReason}` : ""}
              </span>
            </li>
          ))}
          {store.proposals.length === 0 ? <li className="py-3 text-muted-foreground">Belum ada usulan.</li> : null}
        </ul>
      </PosSection>
    </div>
  );
}
