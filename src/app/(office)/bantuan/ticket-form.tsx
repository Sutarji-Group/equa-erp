"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import { submitTicketAction } from "./actions";

export function TicketForm() {
  const [category, setCategory] = useState<"app_issue" | "feedback">("app_issue");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await submitTicketAction({ category, subject, description, userAgent: navigator.userAgent });
          if (r?.error) setError(r.error);
          else {
            toast.success("Laporan terkirim. Status jawabannya tampil di bawah.");
            setSubject("");
            setDescription("");
          }
        });
      }}
    >
      <RadioGroup value={category} onValueChange={(v) => setCategory(v as typeof category)} className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="app_issue" id="kategori-kendala" />
          <Label htmlFor="kategori-kendala">Kendala aplikasi</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="feedback" id="kategori-masukan" />
          <Label htmlFor="kategori-masukan">Masukan</Label>
        </div>
      </RadioGroup>
      <div className="grid gap-1.5">
        <Label htmlFor="tiket-judul">Judul</Label>
        <Input id="tiket-judul" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="mis. Tombol Simpan tidak merespons" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tiket-uraian">Ceritakan kendalanya</Label>
        <Textarea id="tiket-uraian" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Apa yang Anda lakukan, apa yang terjadi, di halaman mana." />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          Kirim laporan
        </Button>
      </div>
    </form>
  );
}
