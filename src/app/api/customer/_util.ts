/** Pembantu route handler API pelanggan: 401 berbahasa Indonesia & respons berkas privat. */
export function unauthorized(): Response {
  return Response.json({ ok: false, message: "Silakan masuk ke aplikasi EQUA terlebih dahulu." }, { status: 401 });
}

export function fileResponse(body: Buffer, contentType: string, filename: string, inline = false): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}
