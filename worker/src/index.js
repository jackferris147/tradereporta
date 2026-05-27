// Trade Reporta — PDF Worker
// Renders inspection-report HTML to PDF via the Cloudflare Browser Rendering REST API.
// (Switched from @cloudflare/puppeteer because the WebSocket-based binding kept hanging.)
//
// Required secrets (set with `wrangler secret put`):
//   PDF_SECRET       — shared secret between app and worker (X-PDF-Secret header)
//   CF_ACCOUNT_ID    — Cloudflare account ID (32-char hex)
//   CF_API_TOKEN     — API token with "Browser Rendering — Edit" permission

const ALLOWED_ORIGINS = [
  "https://tradereporta.com.au",
  "https://www.tradereporta.com.au",
  "https://jackferris147.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-PDF-Secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function safeFilename(name) {
  return (name || "report.pdf").replace(/[^\w.\-]/g, "_").slice(0, 120);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const baseHeaders = corsHeaders(origin);
    const reqId = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || String(Date.now());

    console.log(`[${reqId}] ${request.method} ${request.url} origin="${origin}"`);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }
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
