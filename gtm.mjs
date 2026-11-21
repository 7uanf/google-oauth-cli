#!/usr/bin/env node
/**
 * gtm — Google Tag Manager desde la terminal (Tag Manager API v2). Comparte el token de `ga` (lib/gapi.mjs).
 * Salida: SIEMPRE un JSON por stdout.
 *
 *   gtm accounts                                    cuentas y contenedores visibles
 *   gtm ensure  --account NOMBRE --container NOMBRE --domain sitio.com --ga4 G-XXXX [--no-publish]
 *               [--event-params a,b,c] [--events-regex '^[a-z][a-z0-9_]*$']
 *               idempotente: contenedor web + etiqueta de Google (GA4) en todas las páginas + versión publicada.
 *               Con --event-params agrega además la regla genérica de eventos: todo `dataLayer.push({event,…})`
 *               cuyo nombre cumpla --events-regex llega a GA4 con esos parámetros (sin tocar GTM por evento).
 *   gtm publish --account ID --container ID         crea versión con lo pendiente del espacio de trabajo y la publica
 *
 * Códigos: ACCOUNT_REQUIRED (la API no crea cuentas: trae `url`), NOT_AUTHORIZED, TOKEN_EXPIRED,
 * API_DISABLED (trae `enable`), PERMISSION_DENIED, USAGE, HTTP_ERROR.
 *
 * Consentimiento: el sitio debe cargar el contenedor SOLO después de que el visitante acepte cookies (modo
 * estricto). Así ninguna etiqueta corre antes del "sí" y no hace falta configurar consentimiento dentro de GTM.
 */
import { Blocked, api, emit, need, parseCli } from "./lib/gapi.mjs";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";
/** Activador integrado "All Pages" (Todas las páginas): existe en todos los contenedores web. */
const ALL_PAGES = "2147479553";
const { positional, flag } = parseCli();
const [cmd] = positional;

async function accounts() {
  const list = (await api("GET", `${BASE}/accounts`)).account ?? [];
  return Promise.all(
    list.map(async (a) => ({
      accountId: a.accountId,
      name: a.name,
      containers: ((await api("GET", `${BASE}/${a.path}/containers`)).container ?? []).map((c) => ({
        containerId: c.containerId, name: c.name, publicId: c.publicId, usageContext: c.usageContext, domainName: c.domainName,
      })),
    })),
  );
}

async function defaultWorkspace(containerPath) {
  const ws = (await api("GET", `${BASE}/${containerPath}/workspaces`)).workspace ?? [];
  if (!ws.length) throw new Blocked("HTTP_ERROR", "El contenedor no tiene espacio de trabajo.");
  return ws.find((w) => /default|predeterminado/i.test(w.name)) ?? ws[0];
}

/** Crea una versión con lo pendiente del espacio de trabajo y la publica. Sin cambios, no hace nada. */
async function publish(workspace, notes) {
  const status = await api("GET", `${BASE}/${workspace.path}/status`);
  if (!(status.workspaceChange ?? []).length) return { published: false, reason: "sin cambios pendientes" };
  const created = await api("POST", `${BASE}/${workspace.path}:create_version`, { name: notes, notes });
  if (created.compilerError) throw new Blocked("HTTP_ERROR", "El contenedor tiene errores de compilación; revisa el espacio de trabajo.");
  const version = created.containerVersion;
  await api("POST", `${BASE}/${version.path}:publish`);
  return { published: true, versionId: version.containerVersionId, name: version.name };
}

/** Variable integrada "Event" (la usan el activador y la etiqueta genérica). Idempotente. */
async function enableEventVariable(workspace) {
  const list = (await api("GET", `${BASE}/${workspace.path}/built_in_variables`)).builtInVariable ?? [];
  if (list.some((v) => v.type === "event")) return;
  await api("POST", `${BASE}/${workspace.path}/built_in_variables?type=event`);
}

/**
 * Regla genérica de eventos: variables de capa de datos para un vocabulario fijo de parámetros, un activador
 * de evento personalizado por regex y una etiqueta de evento GA4 que envía {{Event}} con esos parámetros.
 * Idempotente: crea lo que falte (por nombre) y agrega a la etiqueta los parámetros nuevos.
 */
async function ensureEventRule(workspace, ga4, params, regex, steps) {
  await enableEventVariable(workspace);
  const vars = (await api("GET", `${BASE}/${workspace.path}/variables`)).variable ?? [];
  for (const p of params) {
    const name = `dlv - ${p}`;
    if (vars.some((v) => v.name === name)) continue;
    await api("POST", `${BASE}/${workspace.path}/variables`, {
      name,
      type: "v",
      parameter: [
        { type: "integer", key: "dataLayerVersion", value: "2" },
        { type: "boolean", key: "setDefaultValue", value: "false" },
        { type: "template", key: "name", value: p },
      ],
    });
    steps.push(`variable ${name}`);
  }

  const TRIGGER = "Eventos del sitio (dataLayer)";
  const triggers = (await api("GET", `${BASE}/${workspace.path}/triggers`)).trigger ?? [];
  let trigger = triggers.find((t) => t.name === TRIGGER);
  if (!trigger) {
    trigger = await api("POST", `${BASE}/${workspace.path}/triggers`, {
      name: TRIGGER,
      type: "customEvent",
      customEventFilter: [
        { type: "matchRegex", parameter: [{ type: "template", key: "arg0", value: "{{_event}}" }, { type: "template", key: "arg1", value: regex }] },
      ],
    });
    steps.push(`activador "${TRIGGER}" (${regex})`);
  }

  const TAG = "GA4 — eventos del sitio";
  const table = {
    type: "list",
    key: "eventSettingsTable",
    list: params.map((p) => ({
      type: "map",
      map: [
        { type: "template", key: "parameter", value: p },
        { type: "template", key: "parameterValue", value: `{{dlv - ${p}}}` },
      ],
    })),
  };
  const body = {
    name: TAG,
    type: "gaawe",
    parameter: [
      { type: "template", key: "eventName", value: "{{Event}}" },
      { type: "template", key: "measurementIdOverride", value: ga4 },
      table,
    ],
    firingTriggerId: [trigger.triggerId],
  };
  const tags = (await api("GET", `${BASE}/${workspace.path}/tags`)).tag ?? [];
  const existing = tags.find((t) => t.name === TAG);
  if (!existing) {
    await api("POST", `${BASE}/${workspace.path}/tags`, body);
    steps.push(`etiqueta "${TAG}" con ${params.length} parámetros`);
  } else {
    const current = (existing.parameter ?? []).find((x) => x.key === "eventSettingsTable")?.list?.length ?? 0;
    if (current !== params.length) {
      await api("PUT", `${BASE}/${existing.path}`, { ...body, fingerprint: existing.fingerprint });
      steps.push(`etiqueta "${TAG}" actualizada (${params.length} parámetros)`);
    } else steps.push(`etiqueta "${TAG}" existente`);
  }
}

async function ensure() {
  const accountName = need(flag("account"), "--account");
  const containerName = need(flag("container"), "--container");
  const domain = need(flag("domain"), "--domain");
  const ga4 = need(flag("ga4"), "--ga4 G-XXXX");
  if (!/^G-[A-Z0-9]+$/.test(ga4)) throw new Blocked("USAGE", "--ga4 debe ser un ID de medición G-XXXX");
  const steps = [];

  const account = ((await api("GET", `${BASE}/accounts`)).account ?? []).find((a) => a.name === accountName);
  if (!account)
    throw new Blocked("ACCOUNT_REQUIRED", `No hay una cuenta de Tag Manager llamada "${accountName}". La API no crea cuentas: créala (y acepta las condiciones) en la web y vuelve a correr gtm ensure.`, {
      url: "https://tagmanager.google.com/#/admin/accounts/create",
    });
  steps.push(`cuenta ${account.accountId}`);

  let container = ((await api("GET", `${BASE}/${account.path}/containers`)).container ?? []).find((c) => c.name === containerName);
  if (!container) {
    container = await api("POST", `${BASE}/${account.path}/containers`, { name: containerName, usageContext: ["web"], domainName: [domain] });
    steps.push(`contenedor creado ${container.publicId}`);
  } else steps.push(`contenedor existente ${container.publicId}`);

  const workspace = await defaultWorkspace(container.path);
  const tags = (await api("GET", `${BASE}/${workspace.path}/tags`)).tag ?? [];
  const hasTag = tags.some((t) => t.type === "googtag" && (t.parameter ?? []).some((p) => p.key === "tagId" && p.value === ga4));
  if (!hasTag) {
    await api("POST", `${BASE}/${workspace.path}/tags`, {
      name: `Google tag — GA4 ${ga4}`,
      type: "googtag",
      parameter: [{ type: "template", key: "tagId", value: ga4 }],
      firingTriggerId: [ALL_PAGES],
    });
    steps.push(`etiqueta de Google creada (${ga4}, todas las páginas)`);
  } else steps.push("etiqueta de Google existente");

  const params = (flag("event-params") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (params.length) await ensureEventRule(workspace, ga4, params, flag("events-regex") ?? "^[a-z][a-z0-9_]*$", steps);

  const pub = flag("no-publish") ? { published: false, reason: "--no-publish" } : await publish(workspace, `GA4 ${ga4} (gtm ensure)`);
  steps.push(pub.published ? `versión ${pub.versionId} publicada` : `sin publicar: ${pub.reason}`);
  return { accountId: account.accountId, containerId: container.containerId, publicId: container.publicId, ga4, ...pub, steps };
}

try {
  const result =
    cmd === "accounts" ? { accounts: await accounts() }
    : cmd === "ensure" ? await ensure()
    : cmd === "publish"
      ? await publish(await defaultWorkspace(`accounts/${need(flag("account"), "--account")}/containers/${need(flag("container"), "--container")}`), flag("notes") ?? "gtm publish")
      : (() => { throw new Blocked("USAGE", `Comando desconocido: ${cmd ?? "(ninguno)"}. Ver la cabecera de gtm.mjs.`); })();
  emit({ ok: true, ...result });
} catch (err) {
  if (err instanceof Blocked) emit({ ok: false, blocked: err.code !== "HTTP_ERROR", code: err.code, message: err.message, ...err.extra });
  else emit({ ok: false, code: "UNEXPECTED", message: String(err?.message ?? err) });
  process.exit(1);
}
