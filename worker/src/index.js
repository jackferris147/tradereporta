import puppeteer from "@cloudflare/puppeteer";

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

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: baseHeaders });
    }

    const provided = request.headers.get("X-PDF-Secret") || "";
    if (!env.PDF_SECRET || provided !== env.PDF_SECRET) {
      return new Response("Forbidden", { status: 403, headers: baseHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: baseHeaders });
    }

    const html = body && typeof body.html === "string" ? body.html : "";
    const filename = safeFilename(body && body.filename);
    if (!html) {
      return new Response("Missing html", { status: 400, headers: baseHeaders });
    }

    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: true,
      });
      return new Response(pdf, {
        headers: {
          ...baseHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      return new Response("Render error: " + msg, { status: 500, headers: baseHeaders });
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  },
};
