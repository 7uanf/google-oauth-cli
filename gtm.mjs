#!/usr/bin/env node
/**
 * gtm — Google Tag Manager desde la terminal (Tag Manager API v2). Comparte el token de `ga` (lib/gapi.mjs).
 * Salida: SIEMPRE un JSON por stdout.
 *
 *   gtm accounts                                    cuentas y contenedores visibles
 *   gtm ensure  --account NOMBRE --container NOMBRE --domain sitio.com --ga4 G-XXXX [--no-publish]
 *               idempotente: contenedor web + etiqueta de Google (GA4) en todas las páginas + versión publicada
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
