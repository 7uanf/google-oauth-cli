#!/usr/bin/env node
/**
 * ga — Google Analytics 4 desde la terminal, con las APIs oficiales (Admin + Data). Sin navegador salvo para
 * autorizar una vez. Salida: SIEMPRE un JSON por stdout; el progreso va por stderr.
 *
 *   ga auth     --client-file F.json [--cdp 9222 --auto-consent --email E]   autoriza ga + gtm (un solo token)
 *   ga whoami                                                  cuenta autorizada y scopes
 *   ga accounts                                                cuentas y propiedades visibles
 *   ga ensure   --account NOMBRE --property NOMBRE --url https://sitio --timezone America/Santiago
 *               [--currency USD] [--region CL] [--retention 14] [--viewer correo]...   (idempotente)
 *   ga grant    --property ID --email E [--role viewer|analyst|editor|admin]
 *   ga dimensions --property ID --params a,b,c      registra parámetros de evento como dimensiones (idempotente)
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
import { Blocked, api, authorize, emit, need, parseCli, whoami } from "./lib/gapi.mjs";

const ADMIN = "https://analyticsadmin.googleapis.com";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const { positional, flag, many } = parseCli();
const [cmd] = positional;

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

/**
 * Registra parámetros de evento como dimensiones personalizadas (alcance evento). Sin esto GA4 recibe los
 * parámetros pero no aparecen en los reportes. Idempotente; los rechazados (p. ej. ya predefinidos) se
 * informan sin cortar el resto.
 */
async function dimensions() {
  const property = `properties/${need(flag("property"), "--property").replace(/^properties\//, "")}`;
  const params = many("params");
  if (!params.length) throw new Blocked("USAGE", "Falta --params a,b,c");
  const existing = ((await api("GET", `${ADMIN}/v1beta/${property}/customDimensions?pageSize=200`)).customDimensions ?? []).map((d) => d.parameterName);
  const created = [], skipped = [], failed = [];
  for (const p of params) {
    if (existing.includes(p)) { skipped.push(p); continue; }
    try {
      await api("POST", `${ADMIN}/v1beta/${property}/customDimensions`, { parameterName: p, displayName: p, scope: "EVENT", description: "Parámetro de evento del sitio (ver docs/ANALYTICS-EVENTS.md)" });
      created.push(p);
    } catch (e) {
      failed.push({ param: p, error: e.message });
    }
  }
  return { property, created, alreadyRegistered: skipped, failed };
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
    : cmd === "dimensions" ? await dimensions()
    : cmd === "report" ? await report()
    : cmd === "realtime" ? await realtime()
    : (() => { throw new Blocked("USAGE", `Comando desconocido: ${cmd ?? "(ninguno)"}. Ver la cabecera de ga.mjs.`); })();
  emit({ ok: true, ...result });
} catch (err) {
  if (err instanceof Blocked) emit({ ok: false, blocked: err.code !== "HTTP_ERROR", code: err.code, message: err.message, ...err.extra });
  else emit({ ok: false, code: "UNEXPECTED", message: String(err?.message ?? err) });
  process.exit(1);
}
