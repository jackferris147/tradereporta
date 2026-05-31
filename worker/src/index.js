// Trade Reporta — Worker
// Routes:
//   POST /api/ai         — Anthropic Claude proxy (Supabase-authed)
//   POST /api/transcribe — OpenAI Whisper proxy (Supabase-authed)
//   POST /* (default)    — Browser Rendering PDF (PDF_SECRET-authed)
//
// Required secrets (set with `wrangler secret put`):
//   PDF_SECRET        — shared secret between app and worker (X-PDF-Secret header)
//   CF_ACCOUNT_ID     — Cloudflare account ID
//   CF_API_TOKEN      — API token with "Browser Rendering — Edit" permission
//   ANTHROPIC_KEY     — Anthropic API key for /api/ai
//   OPENAI_KEY        — OpenAI API key for /api/transcribe
//   SUPABASE_URL      — Supabase project URL for session verification
//   SUPABASE_ANON_KEY — Supabase publishable/anon key for /auth/v1/user lookup

const ALLOWED_ORIGINS = [
  "https://tradereporta.com.au",
  "https://www.tradereporta.com.au",
  "http://localhost:8080",
  "http://localhost:8765",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8765",
];

function corsHeaders(origin) {
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PDF-Secret, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (isAllowed) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonError(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

function safeFilename(name) {
  return (name || "report.pdf").replace(/[^\w.\-]/g, "_").slice(0, 120);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const baseHeaders = corsHeaders(origin);
    const url = new URL(request.url);
    const reqId = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || String(Date.now());

    console.log(`[${reqId}] ${request.method} ${url.pathname} origin="${origin}"`);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    // /api/* routes — Supabase-authed AI proxy
    if (url.pathname.startsWith("/api/")) {
      // Origin enforcement: stops anyone using the Worker URL directly from outside the app
      if (!ALLOWED_ORIGINS.includes(origin)) {
        console.warn(`[${reqId}] /api/* rejected: origin "${origin}" not in allowlist`);
        return jsonError(403, "Forbidden origin", origin);
      }

      // Supabase session verification
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        console.error(`[${reqId}] SUPABASE_URL or SUPABASE_ANON_KEY missing`);
        return jsonError(500, "Server not configured", origin);
      }
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
      if (!token) {
        return jsonError(401, "Unauthorized", origin);
      }
      let verify;
      try {
        verify = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: { "Authorization": `Bearer ${token}`, "apikey": env.SUPABASE_ANON_KEY }
        });
      } catch (e) {
        console.error(`[${reqId}] Supabase verify fetch threw: ${e && e.message}`);
        return jsonError(502, "Auth check failed", origin);
      }
      if (!verify.ok) {
        console.warn(`[${reqId}] Supabase verify failed status=${verify.status}`);
        return jsonError(401, "Unauthorized", origin);
      }

      // /api/ai — Anthropic Claude proxy
      if (url.pathname === "/api/ai" && request.method === "POST") {
        if (!env.ANTHROPIC_KEY) {
          console.error(`[${reqId}] ANTHROPIC_KEY missing`);
          return jsonError(500, "AI not configured", origin);
        }
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return jsonError(400, "Invalid JSON", origin);
        }
        let upstream;
        try {
          upstream = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": env.ANTHROPIC_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
          });
        } catch (e) {
          console.error(`[${reqId}] /api/ai upstream threw: ${e && e.message}`);
          return jsonError(502, "AI upstream error", origin);
        }
        const data = await upstream.json();
        return new Response(JSON.stringify(data), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...baseHeaders }
        });
      }

      // /api/transcribe — OpenAI Whisper proxy
      if (url.pathname === "/api/transcribe" && request.method === "POST") {
        if (!env.OPENAI_KEY) {
          console.error(`[${reqId}] OPENAI_KEY missing`);
          return jsonError(500, "Transcription not configured", origin);
        }
        let formData;
        try {
          formData = await request.formData();
        } catch (e) {
          return jsonError(400, "Invalid form data", origin);
        }
        let upstream;
        try {
          upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.OPENAI_KEY}` },
            body: formData,
          });
        } catch (e) {
          console.error(`[${reqId}] /api/transcribe upstream threw: ${e && e.message}`);
          return jsonError(502, "Transcription upstream error", origin);
        }
        const data = await upstream.json();
        return new Response(JSON.stringify(data), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...baseHeaders }
        });
      }

      return jsonError(404, "Not found", origin);
    }

    // === Existing PDF route (PDF_SECRET-authed) ===
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: baseHeaders });
    }

    // Shared-secret check (app ↔ worker)
    if (!env.PDF_SECRET) {
      console.error(`[${reqId}] PDF_SECRET not set on worker`);
      return new Response("Server not configured (PDF_SECRET missing)", { status: 500, headers: baseHeaders });
    }
    const provided = request.headers.get("X-PDF-Secret") || "";
    if (provided !== env.PDF_SECRET) {
      console.warn(`[${reqId}] secret mismatch (provided len=${provided.length})`);
      return new Response("Forbidden", { status: 403, headers: baseHeaders });
    }

    // Cloudflare API credentials
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
      console.error(`[${reqId}] CF_ACCOUNT_ID or CF_API_TOKEN missing — set with wrangler secret put`);
      return new Response("Server not configured (CF credentials missing)", { status: 500, headers: baseHeaders });
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      console.error(`[${reqId}] invalid JSON: ${e && e.message}`);
      return new Response("Invalid JSON", { status: 400, headers: baseHeaders });
    }
    const html = body && typeof body.html === "string" ? body.html : "";
    const filename = safeFilename(body && body.filename);
    if (!html) {
      console.warn(`[${reqId}] missing html`);
      return new Response("Missing html", { status: 400, headers: baseHeaders });
    }
    console.log(`[${reqId}] html length=${html.length} chars, filename="${filename}"`);

    // Call Cloudflare Browser Rendering REST API
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`;
    const apiBody = {
      html: html,
      gotoOptions: {
        waitUntil: "load",
        timeout: 30000,
      },
      pdfOptions: {
        format: "a4",
        printBackground: true,
        preferCSSPageSize: true,
        scale: 1,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      },
    };

    console.log(`[${reqId}] calling REST API at ${apiUrl}...`);
    const t0 = Date.now();
    let apiResp;
    try {
      apiResp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(apiBody),
      });
    } catch (e) {
      console.error(`[${reqId}] REST API fetch threw: ${e && e.message}`);
      return new Response("Render error: API fetch failed", { status: 502, headers: baseHeaders });
    }

    const elapsed = Date.now() - t0;
    const respCT = apiResp.headers.get("Content-Type") || "";
    console.log(`[${reqId}] REST API responded status=${apiResp.status} content-type="${respCT}" in ${elapsed}ms`);

    if (!apiResp.ok) {
      let detail;
      try { detail = await apiResp.text(); } catch { detail = "(no body)"; }
      console.error(`[${reqId}] REST API error: ${detail.slice(0, 500)}`);
      return new Response("Render error: " + detail.slice(0, 500), {
        status: apiResp.status,
        headers: baseHeaders,
      });
    }

    // Success path — body is binary PDF
    const pdf = await apiResp.arrayBuffer();
    console.log(`[${reqId}] PDF received, ${pdf.byteLength} bytes`);

    return new Response(pdf, {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  },
};
