#!/usr/bin/env node
/**
 * ga — Google Analytics 4 desde la terminal, con las APIs oficiales (Admin + Data). Sin navegador salvo para
 * autorizar una vez. Salida: SIEMPRE un JSON por stdout; el progreso va por stderr.
 *
 *   ga auth     --client-file F.json [--browser-profile DIR]   autoriza (OAuth de app de escritorio, loopback)
 *   ga whoami                                                  cuenta autorizada y scopes
 *   ga accounts                                                cuentas y propiedades visibles
 *   ga ensure   --account NOMBRE --property NOMBRE --url https://sitio --timezone America/Santiago
 *               [--currency USD] [--region CL] [--retention 14] [--viewer correo]...   (idempotente)
 *   ga grant    --property ID --email E [--role viewer|analyst|editor|admin]
 *   ga report   --property ID [--days 28]                      resumen: usuarios, sesiones, países, páginas
 *   ga realtime --property ID                                  usuarios activos ahora
 *
 * Códigos: NOT_AUTHORIZED, TOKEN_EXPIRED, TOS_REQUIRED (trae `url`), API_DISABLED (trae `enable`),
 * PERMISSION_DENIED, USAGE, HTTP_ERROR. Con `blocked: true` no se reintenta: se resuelve la causa.
 *
 * Por qué un cliente propio: el cliente por defecto de gcloud está BLOQUEADO para scopes de Analytics
 * ("Se bloqueó esta app"). El cliente de escritorio se crea con el skill `oauth`:
 *   gauth create --project <gcp> --name "<App> CLI" --type desktop --email <correo> --out client.json
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.homedir(), ".claude-skills", "analytics");
const TOKEN = path.join(HOME, "token.json");
const CLIENT = path.join(HOME, "client.json");
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/analytics.manage.users",
  "https://www.googleapis.com/auth/analytics.readonly",
];
const ADMIN = "https://analyticsadmin.googleapis.com";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

// ─── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────
class Blocked extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const log = (m) => process.stderr.write(`[ga] ${m}\n`);
const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

const argv = process.argv.slice(2);
const [cmd] = argv;
const flags = {};
for (let i = 1; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  (flags[k] ??= []).push(v);
}
const flag = (k) => flags[k]?.[0];
const many = (k) => (flags[k] ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
const need = (v, what) => {
  if (!v) throw new Blocked("USAGE", `Falta ${what}`);
  return v;
};

function readClient(file = CLIENT) {
  if (!existsSync(file)) throw new Blocked("NOT_AUTHORIZED", `No hay cliente OAuth en ${file}. Corre: ga auth --client-file <json de gauth>`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  return { id: c.client_id, secret: c.client_secret };
}

// ─── OAuth: autorización (loopback + PKCE) y renovación del token ───────────────────────────────────────────
async function authorize() {
  const file = need(flag("client-file") ?? (existsSync(CLIENT) ? CLIENT : null), "--client-file");
  mkdirSync(HOME, { recursive: true });
  if (path.resolve(file) !== path.resolve(CLIENT)) writeFileSync(CLIENT, readFileSync(file));
  chmodSafe(CLIENT);
  const client = readClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("hex");

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/") return res.end();
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ok ? "<h2>Listo. Ya puedes cerrar esta pestaña.</h2>" : `<h2>Error: ${url.searchParams.get("error") ?? "respuesta inválida"}</h2>`);
      server.close();
      if (ok) resolve({ code: url.searchParams.get("code"), redirectUri });
      else reject(new Blocked("NOT_AUTHORIZED", `Google respondió: ${url.searchParams.get("error") ?? "sin código"}`));
    });
    let redirectUri;
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
        access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      log("Abre esta URL y acepta (cuenta de Google con acceso a Analytics):");
      process.stderr.write(auth.toString() + "\n");
      openBrowser(auth.toString());
    });
    setTimeout(() => {
      server.close();
      reject(new Blocked("NOT_AUTHORIZED", "Nadie autorizó en 10 minutos."));
    }, 600000).unref();
  });

  const token = await postForm("https://oauth2.googleapis.com/token", {
    code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier,
  });
  if (!token.refresh_token) throw new Blocked("NOT_AUTHORIZED", "Google no devolvió refresh_token (revoca el acceso anterior y repite).");
  saveToken({ ...token, obtained_at: Date.now() });
  return whoami();
}

/** Abre la URL: en el Chrome de automatización (ya con sesión) si se pasa --browser-profile; si no, el navegador por defecto. */
function openBrowser(url) {
  const profile = flag("browser-profile");
  if (process.platform === "darwin") {
    if (profile) spawnSync("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${profile}`, "--no-first-run", url]);
    else spawnSync("open", [url]);
  } else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url]);
  else spawnSync("xdg-open", [url]);
}

function chmodSafe(f) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* Windows */
  }
}
function saveToken(t) {
  writeFileSync(TOKEN, JSON.stringify(t, null, 2));
  chmodSafe(TOKEN);
}

async function accessToken() {
  if (!existsSync(TOKEN)) throw new Blocked("NOT_AUTHORIZED", "No hay token. Corre: ga auth --client-file <json>");
  const t = JSON.parse(readFileSync(TOKEN, "utf8"));
  if (t.access_token && Date.now() < t.obtained_at + (t.expires_in - 120) * 1000) return t.access_token;
  const client = readClient();
  try {
    const fresh = await postForm("https://oauth2.googleapis.com/token", {
      client_id: client.id, client_secret: client.secret, refresh_token: t.refresh_token, grant_type: "refresh_token",
    });
    saveToken({ ...t, ...fresh, obtained_at: Date.now() });
    return fresh.access_token;
  } catch (e) {
    // En modo "Prueba" Google vence los refresh tokens a los 7 días.
    throw new Blocked("TOKEN_EXPIRED", `No se pudo renovar el token (${e.message}). Corre ga auth de nuevo.`);
  }
}

async function postForm(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description ?? json.error ?? res.status);
  return json;
}

/** Llamada a las APIs de Google con manejo de errores comunes. */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.ok) return json;
  const msg = json.error?.message ?? text;
  if (/has not been used|is disabled/i.test(msg)) {
    const service = msg.match(/([a-z]+\.googleapis\.com)/)?.[1];
    const project = msg.match(/project (\d+)/)?.[1];
    throw new Blocked("API_DISABLED", msg.split("\n")[0], { enable: `gcloud services enable ${service} --project=${project}` });
  }
  if (res.status === 403) throw new Blocked("PERMISSION_DENIED", msg.split("\n")[0]);
  throw new Blocked("HTTP_ERROR", `${res.status} ${msg.split("\n")[0]}`, { url });
}

async function whoami() {
  const t = await accessToken();
  const info = await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${t}`)).json();
  return { email: info.email ?? null, scopes: (info.scope ?? "").split(" ") };
}

// ─── Analytics Admin ─────────────────────────────────────────────────────────────────────────────────────────
async function accounts() {
  const out = [];
  let pageToken = "";
  do {
    const r = await api("GET", `${ADMIN}/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const a of r.accountSummaries ?? [])
      out.push({
        account: a.account, name: a.displayName,
        properties: (a.propertySummaries ?? []).map((p) => ({ property: p.property, id: p.property.split("/")[1], name: p.displayName })),
      });
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

const ROLES = { viewer: "predefinedRoles/viewer", analyst: "predefinedRoles/analyst", editor: "predefinedRoles/editor", admin: "predefinedRoles/admin" };

async function grant(resource, email, role = "viewer") {
  const existing = await api("GET", `${ADMIN}/v1alpha/${resource}/accessBindings?pageSize=200`);
  const hit = (existing.accessBindings ?? []).find((b) => b.user === email);
  if (hit && hit.roles?.includes(ROLES[role])) return { email, role, already: true };
  if (hit) {
    await api("PATCH", `${ADMIN}/v1alpha/${hit.name}`, { user: email, roles: [ROLES[role]] });
    return { email, role, updated: true };
  }
  await api("POST", `${ADMIN}/v1alpha/${resource}/accessBindings`, { user: email, roles: [ROLES[role]] });
  return { email, role, added: true };
}

async function ensure() {
  const accountName = need(flag("account"), "--account");
  const propertyName = need(flag("property"), "--property");
  const url = need(flag("url"), "--url");
  const steps = [];

  let account = (await accounts()).find((a) => a.name === accountName);
  if (!account) {
    // Crear una cuenta exige aceptar las condiciones de Analytics: la API da un ticket y el usuario acepta en la web.
    const ticket = await api("POST", `${ADMIN}/v1beta/accounts:provisionAccountTicket`, {
      account: { displayName: accountName, regionCode: flag("region") ?? "CL" },
      redirectUri: "https://analytics.google.com/analytics/web/",
    });
    throw new Blocked("TOS_REQUIRED", "Hay que aceptar las Condiciones de Google Analytics para crear la cuenta. Abre la URL, acepta y vuelve a correr ga ensure.", {
      url: `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${ticket.accountTicketId}`,
    });
  }
  steps.push(`cuenta ${account.account}`);

  let prop = account.properties.find((p) => p.name === propertyName);
  if (!prop) {
    const created = await api("POST", `${ADMIN}/v1beta/properties`, {
      parent: account.account, displayName: propertyName, timeZone: flag("timezone") ?? "America/Santiago",
      currencyCode: flag("currency") ?? "USD", industryCategory: "TECHNOLOGY",
    });
    prop = { property: created.name, id: created.name.split("/")[1], name: propertyName };
    steps.push(`propiedad creada ${prop.property}`);
  } else steps.push(`propiedad existente ${prop.property}`);

  const streams = (await api("GET", `${ADMIN}/v1beta/${prop.property}/dataStreams`)).dataStreams ?? [];
  let stream = streams.find((s) => s.type === "WEB_DATA_STREAM" && s.webStreamData?.defaultUri?.replace(/\/$/, "") === url.replace(/\/$/, ""));
  if (!stream) {
    stream = await api("POST", `${ADMIN}/v1beta/${prop.property}/dataStreams`, {
      type: "WEB_DATA_STREAM", displayName: new URL(url).hostname, webStreamData: { defaultUri: url },
    });
    steps.push("flujo web creado");
  } else steps.push("flujo web existente");

  const months = Number(flag("retention") ?? 14);
  const retention = months >= 14 ? "FOURTEEN_MONTHS" : "TWO_MONTHS";
  await api("PATCH", `${ADMIN}/v1beta/${prop.property}/dataRetentionSettings?updateMask=eventDataRetention,resetUserDataOnNewActivity`, {
    name: `${prop.property}/dataRetentionSettings`, eventDataRetention: retention, resetUserDataOnNewActivity: true,
  });
  steps.push(`retención ${retention}`);
  try {
    await api("PATCH", `${ADMIN}/v1alpha/${prop.property}/googleSignalsSettings?updateMask=state`, { state: "GOOGLE_SIGNALS_DISABLED" });
    steps.push("Google Signals desactivado");
  } catch (e) {
    steps.push(`Google Signals: no se pudo ajustar (${e.message})`);
  }

  const viewers = [];
  for (const email of many("viewer")) viewers.push(await grant(prop.property, email, "viewer"));

  return {
    account: account.account, property: prop.property, propertyId: prop.id, stream: stream.name,
    measurementId: stream.webStreamData?.measurementId, retention, viewers, steps,
  };
}

// ─── Analytics Data ──────────────────────────────────────────────────────────────────────────────────────────
async function report() {
  const property = `properties/${need(flag("property"), "--property").replace(/^properties\//, "")}`;
  const days = Number(flag("days") ?? 28);
  const range = [{ startDate: `${days}daysAgo`, endDate: "today" }];
  const run = (body) => api("POST", `${DATA}/${property}:runReport`, { dateRanges: range, ...body });
  const rows = (r) => (r.rows ?? []).map((row) => [...(row.dimensionValues ?? []).map((d) => d.value), ...row.metricValues.map((m) => Number(m.value))]);
  const [totals, countries, pages] = await Promise.all([
    run({ metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }, { name: "averageSessionDuration" }] }),
    run({ dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], limit: 10, orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] }),
    run({ dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }], limit: 10, orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }] }),
  ]);
  const [activeUsers = 0, sessions = 0, views = 0, avgSession = 0] = rows(totals)[0] ?? [];
  return { property, days, activeUsers, sessions, views, avgSessionSeconds: Math.round(avgSession), countries: rows(countries), pages: rows(pages) };
}

async function realtime() {
  const property = `properties/${need(flag("property"), "--property").replace(/^properties\//, "")}`;
  const r = await api("POST", `${DATA}/${property}:runRealtimeReport`, { metrics: [{ name: "activeUsers" }] });
  return { property, activeUsersNow: Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0) };
}

// ─── Despacho ────────────────────────────────────────────────────────────────────────────────────────────────
try {
  const result =
    cmd === "auth" ? await authorize()
    : cmd === "whoami" ? await whoami()
    : cmd === "accounts" ? { accounts: await accounts() }
    : cmd === "ensure" ? await ensure()
    : cmd === "grant" ? await grant(`properties/${need(flag("property"), "--property").replace(/^properties\//, "")}`, need(flag("email"), "--email"), flag("role") ?? "viewer")
    : cmd === "report" ? await report()
    : cmd === "realtime" ? await realtime()
    : (() => { throw new Blocked("USAGE", `Comando desconocido: ${cmd ?? "(ninguno)"}. Ver la cabecera de ga.mjs.`); })();
  emit({ ok: true, ...result });
} catch (err) {
  if (err instanceof Blocked) emit({ ok: false, blocked: err.code !== "HTTP_ERROR", code: err.code, message: err.message, ...err.extra });
  else emit({ ok: false, code: "UNEXPECTED", message: String(err?.message ?? err) });
  process.exit(1);
}
