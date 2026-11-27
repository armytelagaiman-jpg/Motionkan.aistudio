/**
 * Motionkan Studio — Character Image Revision Worker
 * Deploy as a separate Cloudflare Worker.
 *
 * Required Worker bindings:
 *   Secret: OPENAI_API_KEY
 *   Variable: SUPABASE_URL
 *   Variable: SUPABASE_PUBLISHABLE_KEY
 *
 * Endpoint:
 *   POST /v1/character/revise
 * Multipart fields:
 *   image      required original/generated character image
 *   reference  optional identity reference photo
 *   prompt     required revision instructions
 */
const ALLOWED_ORIGINS = new Set([
  "https://motionkan-aistudio.motionkan-ai.workers.dev",
  "https://motionkan-studio.com",
  "https://www.motionkan-studio.com"
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://motionkan-aistudio.motionkan-ai.workers.dev",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) }
  });
}
async function verifyUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const response = await fetch(env.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", {
    headers: {
      "apikey": env.SUPABASE_PUBLISHABLE_KEY,
      "Authorization": auth
    }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user && user.id ? user : null;
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "motionkan-character-image-revision", configured: !!(env.OPENAI_API_KEY && env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY) }, 200, origin);
    }
    if (url.pathname !== "/v1/character/revise" || request.method !== "POST") {
      return json({ error: "Endpoint tidak ditemukan." }, 404, origin);
    }
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin tidak diizinkan." }, 403, origin);
    if (!env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
      return json({ error: "Worker belum dikonfigurasi. Hubungi administrator." }, 503, origin);
    }
    try {
      const user = await verifyUser(request, env);
      if (!user) return json({ error: "Sesi login tidak valid atau sudah berakhir. Silakan login kembali." }, 401, origin);

      const form = await request.formData();
      const image = form.get("image");
      const reference = form.get("reference");
      const prompt = String(form.get("prompt") || "").trim();
      if (!(image instanceof File)) return json({ error: "Gambar karakter yang akan direvisi wajib diunggah." }, 400, origin);
      if (!ALLOWED_TYPES.has(image.type) || image.size > MAX_IMAGE_BYTES) {
        return json({ error: "Gambar utama harus PNG, JPG, atau WEBP dengan ukuran maksimal 8 MB." }, 400, origin);
      }
      if (reference && (!(reference instanceof File) || !ALLOWED_TYPES.has(reference.type) || reference.size > MAX_IMAGE_BYTES)) {
        return json({ error: "Foto referensi harus PNG, JPG, atau WEBP dengan ukuran maksimal 8 MB." }, 400, origin);
      }
      if (!prompt || prompt.length > 6000) return json({ error: "Instruksi revisi wajib diisi (maksimal 6.000 karakter)." }, 400, origin);

      const apiForm = new FormData();
      apiForm.append("model", "gpt-image-2.6-flare");
      apiForm.append("image[]", image, image.name || "character.png");
      if (reference) apiForm.append("image[]", reference, reference.name || "identity-reference.png");
      apiForm.append("prompt", [
        "Edit the first supplied image. Apply only the requested changes.",
        "Preserve the character's identity and all unrequested visual details. If a second image is supplied, use it as the identity reference for facial features and recognizable appearance.",
        "Do not add text, captions, logos, or watermarks unless explicitly requested.",
        "Requested revision:",
        prompt
      ].join("\n\n"));
      apiForm.append("quality", "medium");
      apiForm.append("size", "auto");
      apiForm.append("output_format", "png");

      const upstream = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY },
        body: apiForm
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const message = result?.error?.message || "Layanan gambar sedang tidak dapat memproses permintaan.";
        return json({ error: message, provider_status: upstream.status }, upstream.status === 429 ? 429 : 502, origin);
      }
      const imageData = result?.data?.[0]?.b64_json;
      if (!imageData) return json({ error: "Layanan gambar tidak mengembalikan hasil gambar." }, 502, origin);
      return json({
        ok: true,
        image: "data:image/png;base64," + imageData,
        revised_prompt: result?.data?.[0]?.revised_prompt || null,
        model: "gpt-image-2.6-flare"
      }, 200, origin);
    } catch (error) {
      return json({ error: error?.message || "Terjadi kesalahan saat memproses gambar." }, 500, origin);
    }
  }
};
