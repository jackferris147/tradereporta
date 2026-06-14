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
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

// Exchanges the user's stored Google refresh token for a fresh access token.
// Throws if no refresh token is stored or the refresh call fails — callers
// should surface "reconnect Google Drive" to the user on either case.
async function getGoogleAccessToken(userId, env) {
  if (!userId) throw new Error("Missing userId");
  if (!env.TRADE_REPORTA_KV) throw new Error("KV namespace not bound");
  const refreshToken = await env.TRADE_REPORTA_KV.get("gdrive_" + userId);
  if (!refreshToken) throw new Error("No refresh token found for user");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth not configured");
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!r.ok) {
    let detail = "";
    try { detail = await r.text(); } catch {}
    throw new Error(`Token refresh failed: ${r.status} ${detail.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data || !data.access_token) throw new Error("No access_token in refresh response");
  return data.access_token;
}

// Escapes single quotes in Drive query string literals.
function driveQuote(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Returns the Drive folder ID, creating it if it does not exist. Search is scoped
// to drive.file so it only finds folders this app has created — which is exactly
// what we want for idempotent "Trade Reporta/<job>" structure.
async function findOrCreateFolder(accessToken, name, parentId) {
  let query = `mimeType='application/vnd.google-apps.folder' and name='${driveQuote(name)}' and trashed=false`;
  if (parentId) query += ` and '${driveQuote(parentId)}' in parents`;
  const searchUrl = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(query) + "&fields=files(id)";
  const searchRes = await fetch(searchUrl, {
    headers: { "Authorization": "Bearer " + accessToken }
  });
  if (!searchRes.ok) {
    const detail = await searchRes.text();
    throw new Error(`Drive search failed (${searchRes.status}): ${detail.slice(0, 200)}`);
  }
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }
  const meta = { name: name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(meta)
  });
  if (!createRes.ok) {
    const detail = await createRes.text();
    throw new Error(`Drive folder create failed (${createRes.status}): ${detail.slice(0, 200)}`);
  }
  const createData = await createRes.json();
  return createData.id;
}

// Uploads a single binary file to Drive under parentFolderId using multipart/related.
// `file.data` is base64 (no data: prefix); we decode it to bytes and build the body
// as a Uint8Array so binary content survives intact (string concat would coerce).
async function uploadFileToDrive(accessToken, file, parentFolderId) {
  const boundary = "trbnd_" + Math.random().toString(16).slice(2);
  const fileBytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
  const metadata = { name: file.name, parents: [parentFolderId] };
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${file.mimeType}\r\n\r\n`
  );
  const footer = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(header.length + fileBytes.length + footer.length);
  body.set(header, 0);
  body.set(fileBytes, header.length);
  body.set(footer, header.length + fileBytes.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body: body
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Drive upload failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  return await r.json();
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
      let userId = null;
      try {
        const verifiedUser = await verify.json();
        userId = verifiedUser && verifiedUser.id;
      } catch (e) { /* userId stays null; downstream routes that need it will 401 */ }

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

      // /api/google-auth — exchange Google OAuth code for tokens, store refresh token in KV
      if (url.pathname === "/api/google-auth" && request.method === "POST") {
        if (!userId) return jsonError(401, "Unauthorized", origin);
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
          console.error(`[${reqId}] Google OAuth secrets missing — CLIENT_ID set=${!!env.GOOGLE_CLIENT_ID}, CLIENT_SECRET set=${!!env.GOOGLE_CLIENT_SECRET}, REDIRECT_URI set=${!!env.GOOGLE_REDIRECT_URI}`);
          return jsonError(500, "Google OAuth not configured", origin);
        }
        let body;
        try {
          body = await request.json();
        } catch (e) {
          console.error(`[${reqId}] /api/google-auth invalid JSON body`);
          return jsonError(400, "Invalid JSON", origin);
        }
        if (!body || !body.code) {
          console.error(`[${reqId}] /api/google-auth missing code in body`);
          return jsonError(400, "Missing code", origin);
        }
        const codeLen = (body.code || "").length;
        const clientIdTail = env.GOOGLE_CLIENT_ID.slice(-32);
        console.log(`[${reqId}] /api/google-auth exchanging code len=${codeLen} redirect_uri="${env.GOOGLE_REDIRECT_URI}" client_id_tail="${clientIdTail}"`);
        let tokenRes;
        try {
          tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code: body.code,
              client_id: env.GOOGLE_CLIENT_ID,
              client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: env.GOOGLE_REDIRECT_URI,
              grant_type: "authorization_code",
            }).toString(),
          });
        } catch (e) {
          console.error(`[${reqId}] Google token fetch threw: ${e && e.message}`);
          return jsonError(502, "Token exchange failed", origin);
        }
        // Parse the body into JSON. Never log access_token / refresh_token; log keys only.
        let tokens = null;
        try { tokens = await tokenRes.json(); } catch (e) { /* leave tokens null */ }
        const tokenKeys = tokens && typeof tokens === "object" ? Object.keys(tokens).join(",") : "(none)";
        console.log(`[${reqId}] Google token response status=${tokenRes.status} content-type="${tokenRes.headers.get("content-type") || ""}" keys=${tokenKeys}`);
        if (!tokens) {
          console.error(`[${reqId}] Google token response was non-JSON`);
          return jsonError(502, "Token exchange returned non-JSON", origin);
        }
        if (!tokenRes.ok) {
          // Error responses don't carry tokens; safe to log error + description.
          console.error(`[${reqId}] Google token exchange ${tokenRes.status}: error="${tokens.error}" description="${tokens.error_description}"`);
          return new Response(JSON.stringify({ error: tokens.error || "Token exchange failed", details: tokens.error_description || null }), {
            status: tokenRes.status,
            headers: { "Content-Type": "application/json", ...baseHeaders }
          });
        }
        if (!tokens.refresh_token) {
          console.error(`[${reqId}] Google token exchange succeeded but no refresh_token returned — keys=${Object.keys(tokens).join(",")}. User likely needs to revoke prior consent at https://myaccount.google.com/permissions then reconnect (prompt=consent in auth URL forces a fresh refresh_token).`);
          return jsonError(401, "No refresh token returned", origin);
        }
        console.log(`[${reqId}] /api/google-auth success — stored refresh token for user ${userId} (token_type=${tokens.token_type}, scope="${tokens.scope}", expires_in=${tokens.expires_in})`);
        await env.TRADE_REPORTA_KV.put("gdrive_" + userId, tokens.refresh_token);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...baseHeaders }
        });
      }

      // /api/google-status — does the current user have a stored refresh token?
      if (url.pathname === "/api/google-status" && request.method === "GET") {
        if (!userId) return jsonError(401, "Unauthorized", origin);
        const existing = await env.TRADE_REPORTA_KV.get("gdrive_" + userId);
        return new Response(JSON.stringify({ connected: !!existing }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...baseHeaders }
        });
      }

      // /api/drive-upload — push a job pack (photos + optional PDF) to Drive under
      // Trade Reporta/<folderName>. Body: { files:[{name,data(base64),mimeType}], folderName }
      if (url.pathname === "/api/drive-upload" && request.method === "POST") {
        if (!userId) return jsonError(401, "Unauthorized", origin);
        let accessToken;
        try {
          accessToken = await getGoogleAccessToken(userId, env);
        } catch (e) {
          console.warn(`[${reqId}] /api/drive-upload no access token: ${e && e.message}`);
          return new Response(JSON.stringify({ error: "Google Drive not connected. Please connect in Settings." }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...baseHeaders }
          });
        }
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return jsonError(400, "Invalid JSON", origin);
        }
        const files = Array.isArray(body && body.files) ? body.files : [];
        const folderName = (body && typeof body.folderName === "string" && body.folderName.trim()) || "";
        if (!folderName) return jsonError(400, "Missing folderName", origin);
        if (!files.length) return jsonError(400, "No files supplied", origin);
        console.log(`[${reqId}] /api/drive-upload folder="${folderName}" fileCount=${files.length}`);
        try {
          const rootFolderId = await findOrCreateFolder(accessToken, "Trade Reporta", null);
          const jobFolderId = await findOrCreateFolder(accessToken, folderName, rootFolderId);
          const uploaded = [];
          for (const file of files) {
            if (!file || typeof file.data !== "string" || !file.name || !file.mimeType) {
              console.warn(`[${reqId}] /api/drive-upload skipping malformed file entry`);
              continue;
            }
            const meta = await uploadFileToDrive(accessToken, file, jobFolderId);
            uploaded.push(meta.name || file.name);
          }
          const folderMetaRes = await fetch(
            "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(jobFolderId) + "?fields=webViewLink",
            { headers: { "Authorization": "Bearer " + accessToken } }
          );
          let folderUrl = null;
          if (folderMetaRes.ok) {
            const folderMeta = await folderMetaRes.json();
            folderUrl = folderMeta.webViewLink || null;
          }
          console.log(`[${reqId}] /api/drive-upload uploaded=${uploaded.length} folder="${folderName}"`);
          return new Response(JSON.stringify({ success: true, uploaded: uploaded, folderUrl: folderUrl }), {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders }
          });
        } catch (e) {
          console.error(`[${reqId}] /api/drive-upload failed: ${e && e.message}`);
          return jsonError(502, "Drive upload failed: " + (e && e.message ? e.message : "unknown"), origin);
        }
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
