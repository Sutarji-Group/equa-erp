"use client";

import { Eraser } from "lucide-react";
import { type PointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type SignaturePadHandle = {
  /** Hapus goresan. */
  clear: () => void;
  /** `true` bila belum ada goresan. */
  isEmpty: () => boolean;
  /** Ekspor PNG (latar putih). `null` bila kosong. */
  toBlob: () => Promise<Blob | null>;
};

export type SignaturePadProps = {
  ref?: Ref<SignaturePadHandle>;
  /** Dipanggil saat status kosong/terisi berubah. */
  onChange?: (isEmpty: boolean) => void;
  /** Tinggi area tanda tangan (px). Bawaan 220. */
  height?: number;
  /** Warna tinta. Bawaan hitam. */
  penColor?: string;
  /** Tebal garis (px CSS). Bawaan 2,5. */
  penWidth?: number;
  /** Teks panduan di area kosong. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

type Point = { x: number; y: number };

/**
 * Bidang tanda tangan penerima (US-M3-03 KP-1): kanvas untuk sentuh, pena, dan tetikus (Pointer Events), tombol
 * "Hapus", ekspor PNG `Blob` lewat `ref.toBlob()`.
 */
export function SignaturePad({
  ref,
  onChange,
  height = 220,
  penColor = "#000000",
  penWidth = 2.5,
  placeholder = "Minta penerima tanda tangan di sini",
  disabled,
  className,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = penColor;
    ctx.fillStyle = penColor;
    ctx.lineWidth = penWidth;
    for (const stroke of strokesRef.current) {
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0]!.x, stroke[0]!.y, penWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      stroke.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
  }, [penColor, penWidth]);

  // Sesuaikan resolusi kanvas dengan ukuran tampil & devicePixelRatio (tajam di ponsel).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      redraw();
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  const emptyRef = useRef(true);
  const setEmptyState = useCallback((next: boolean) => {
    if (emptyRef.current === next) return;
    emptyRef.current = next;
    setEmpty(next);
    onChangeRef.current?.(next);
  }, []);

  function pointFrom(e: PointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleDown(e: PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    strokesRef.current.push([pointFrom(e)]);
    redraw();
    setEmptyState(false);
  }

  function handleMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || disabled) return;
    e.preventDefault();
    strokesRef.current[strokesRef.current.length - 1]!.push(pointFrom(e));
    redraw();
  }

  function handleUp(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  const clear = useCallback(() => {
    strokesRef.current = [];
    redraw();
    setEmptyState(true);
  }, [redraw, setEmptyState]);

  useImperativeHandle(
    ref,
    () => ({
      clear,
      isEmpty: () => strokesRef.current.length === 0,
      toBlob: async () => {
        const canvas = canvasRef.current;
        if (!canvas || strokesRef.current.length === 0) return null;
        // Salin ke kanvas berlatar putih agar PNG terbaca di latar apa pun.
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        return new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), "image/png"));
      },
    }),
    [clear],
  );

  return (
    <div data-slot="signature-pad" className={cn("flex flex-col gap-2", className)}>
      <div className="relative overflow-hidden rounded-xl border-2 border-dashed bg-white" style={{ height }}>
        <canvas
          ref={canvasRef}
          className={cn("absolute inset-0 size-full touch-none", disabled ? "cursor-not-allowed" : "cursor-crosshair")}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          onPointerLeave={handleUp}
          role="img"
          aria-label={empty ? "Bidang tanda tangan kosong" : "Tanda tangan sudah diisi"}
        />
        {empty ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-base text-neutral-500">{placeholder}</p>
        ) : null}
        <span aria-hidden className="pointer-events-none absolute inset-x-6 bottom-6 border-b-2 border-neutral-300" />
      </div>
      <button
        type="button"
        onClick={clear}
        disabled={disabled || empty}
        className="inline-flex min-h-12 items-center justify-center gap-2 self-end rounded-xl border-2 px-4 text-base font-semibold hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-40"
      >
        <Eraser className="size-5" aria-hidden />
        Hapus tanda tangan
      </button>
    </div>
  );
}
