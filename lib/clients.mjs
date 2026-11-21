/**
 * Clientes OAuth (web y de escritorio) con la UI de la consola: crear (idempotente), agregar secreto,
 * agregar redirect URIs, y la pantalla de consentimiento si falta. Todo con clics por JS (lib/ui.mjs).
 * Uso: const c = clientsFor(page, project); await c.createClient({ name, type, redirects, email, out });
 * Códigos de Blocked: SIGN_IN_REQUIRED, NO_ACCESS, PROJECT_NOT_FOUND, CONSENT_NEEDS_EMAIL, CLIENT_NOT_FOUND, SECRET_LIMIT, USAGE.
 */
import { writeFileSync } from "node:fs";
import {
  Blocked, CLIENT_ID_RE, SECRET_RE, bodyText, clickText, consoleUrl, mustClick, open, setInput, sleep, step, waitFor,
} from "./ui.mjs";

export function clientsFor(page, project) {
  // ─── Pantalla de consentimiento ─────────────────────────────────────────────────────────────────────────────
  const GET_STARTED = /^(comenzar|get started|empezar)$/i;

  async function consentConfigured(page) {
    await open(page, consoleUrl(project, "overview"));
    const r = await page.evaluate((src) => {
      const rx = new RegExp(src, "i");
      return [...document.querySelectorAll("button, a")].some((b) => b.getBoundingClientRect().width > 0 && rx.test((b.innerText || "").trim()));
    }, GET_STARTED.source);
    return !r;
  }

  /** Wizard de 4 pasos (Información de la app → Público → Contacto → Finalizar). Idempotente. */
  async function ensureConsent(page, appName, email) {
    if (await consentConfigured(page)) return false;
    if (!email) throw new Blocked("CONSENT_NEEDS_EMAIL", "La pantalla de consentimiento no existe: pasa --email (correo de soporte de la cuenta).");
    step("creando pantalla de consentimiento");
    await mustClick(page, GET_STARTED, "Comenzar");
    await waitFor(page, () => !!document.querySelector('input[formcontrolname="displayName"]'), 20000, "no apareció el paso 1 del asistente");
    const next = () => clickText(page, /^(siguiente|next)$/i);

    await setInput(page, { formcontrol: "displayName" }, appName);
    // Correo de asistencia: desplegable (cfc-select) cuyas opciones llegan con demora. Hay que ESPERAR a que
    // aparezca la opción con el correo (elegirla a ciegas al segundo dejaba el campo vacío y el asistente no
    // avanzaba) y confirmar que quedó elegida antes de seguir.
    const pickEmail = async () => {
      await page.evaluate(() => (document.querySelector('cfc-select[formcontrolname="userSupportEmail"]') || document.querySelector("cfc-select"))?.click());
      await waitFor(page, () => [...document.querySelectorAll("cfc-option, [role=option], mat-option")].some((o) => o.getBoundingClientRect().width > 0 && /@/.test(o.textContent)), 15000, "no cargaron los correos de asistencia");
      return page.evaluate((email) => {
        const opts = [...document.querySelectorAll("cfc-option, [role=option], mat-option")].filter((o) => o.getBoundingClientRect().width > 0 && /@/.test(o.textContent));
        const hit = opts.find((o) => o.textContent.includes(email)) || opts[0];
        hit?.click();
        return hit?.textContent.trim() ?? null;
      }, email);
    };
    const chosen = await pickEmail();
    await sleep(800);
    const shown = await page.evaluate(() => (document.querySelector('cfc-select[formcontrolname="userSupportEmail"]')?.innerText || "").trim());
    if (!/@/.test(shown)) throw new Error(`No quedó elegido el correo de asistencia (opción: ${chosen}).`);
    await next();
    await sleep(2000);

    // Público: usuarios externos (las cuentas personales no pueden elegir "internos").
    await page.evaluate(() => {
      const r = [...document.querySelectorAll("mat-radio-button, [role=radio], label")].find((x) => /externos|external/i.test(x.textContent));
      (r?.querySelector("input") ?? r)?.click();
    });
    await sleep(700);
    await next();
    await sleep(2000);

    await setInput(page, { lastEmpty: true }, email);
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(700);
    await next();
    await sleep(2000);

    await page.evaluate(() => (document.querySelector("mat-checkbox input") ?? document.querySelector("mat-checkbox"))?.click());
    await sleep(700);
    await mustClick(page, /^(crear|create)$/i, "Crear");
    await sleep(8000);
    if (!(await consentConfigured(page))) throw new Error("El asistente terminó pero la consola sigue pidiendo 'Comenzar'.");
    return true;
  }

  // ─── Clientes ────────────────────────────────────────────────────────────────────────────────────────────────
  async function listClients(page) {
    await open(page, consoleUrl(project, "clients"), {
      ready: () => /ID de cliente|Client ID|No hay clientes|No OAuth clients|Crear cliente|Create client/i.test(document.body.innerText),
    });
    await sleep(1500);
    return page.evaluate(() =>
      [...document.querySelectorAll("a")]
        .filter((a) => /\/auth\/clients\/\d/.test(a.getAttribute("href") || ""))
        .map((a) => {
          const id = decodeURIComponent((a.getAttribute("href").match(/\/auth\/clients\/([^?/]+)/) || [])[1] || "");
          const row = a.closest("tr, [role=row]") ?? a.parentElement;
          const text = (row?.innerText || "").replace(/\s+/g, " ").trim();
          const type = /escritorio|desktop/i.test(text) ? "desktop" : /web/i.test(text) ? "web" : "other";
          return { name: (a.innerText || "").trim(), id, type };
        })
        .filter((c, i, arr) => c.id && arr.findIndex((x) => x.id === c.id) === i),
    );
  }

  async function findClient(page, ref) {
    const clients = await listClients(page);
    // "__first__": compatibilidad con el renew viejo (el cliente más nuevo de la lista).
    const hit = ref === "__first__" ? clients[0] : clients.find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref);
    if (!hit) throw new Blocked("CLIENT_NOT_FOUND", `No hay un cliente "${ref}" en ${project}.`, { clients });
    return hit;
  }

  const clientUrl = (id) => `https://console.cloud.google.com/auth/clients/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`;

  /** Texto + valores de inputs: los URIs ya cargados viven en inputs, no en el texto. */
  const pageValues = (page) =>
    page.evaluate(() => (document.body.innerText || "") + "\n" + [...document.querySelectorAll("input")].map((i) => i.value).join("\n"));

  async function addRedirects(page, client, uris) {
    await open(page, clientUrl(client.id), { ready: () => /URI/i.test(document.body.innerText) });
    const before = await pageValues(page);
    const missing = uris.filter((u) => !before.includes(u));
    if (!missing.length) return { added: [], present: uris };
    for (const uri of missing) {
      step(`agregando redirect ${uri}`);
      // Hay un "Agregar URI" para orígenes JS y otro para redirects: el de redirects es el último.
      const count = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^\+?\s*(agregar uri|add uri)$/i.test((b.innerText || "").trim())).length);
      if (!count) throw new Error("No encontré el botón 'Agregar URI'.");
      await clickText(page, /^\+?\s*(agregar uri|add uri)$/i, { index: count - 1 });
      await sleep(800);
      await setInput(page, { lastEmpty: true }, uri);
    }
    step("guardando cliente");
    await mustClick(page, /^(guardar|save)$/i, "Guardar");
    await sleep(5000);
    await open(page, clientUrl(client.id), { ready: () => /URI/i.test(document.body.innerText) });
    const after = await pageValues(page);
    const failed = uris.filter((u) => !after.includes(u));
    if (failed.length) throw new Error(`No quedaron guardados: ${failed.join(", ")}`);
    return { added: missing, present: uris };
  }

  /** Agrega un secreto (Google ya no muestra los viejos). Máximo 2 por cliente. */
  async function addSecret(page, client) {
    await open(page, clientUrl(client.id), { ready: () => /secret|secreto/i.test(document.body.innerText) });
    const text = await bodyText(page);
    const existing = (text.match(/\*{3,}[A-Za-z0-9_-]{3,6}/g) || []).length;
    if (existing >= 2)
      throw new Blocked("SECRET_LIMIT", "El cliente ya tiene 2 secretos (el máximo). Borra uno viejo desde la consola (Desactivar → Borrar) y vuelve a correr renew.", { clientId: client.id });
    step("agregando secreto");
    await mustClick(page, /(agregar|añadir|add)\s+(un\s+)?secret/i, "Agregar secreto");
    await waitFor(page, (src) => new RegExp(src).test(document.body.innerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" ")), 20000, "no apareció el secreto nuevo", SECRET_RE.source);
    const html = await page.evaluate(() => document.body.innerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" "));
    const secret = html.match(SECRET_RE)?.[0];
    await clickText(page, /^(aceptar|ok|cerrar|close|listo|done)$/i, { within: "overlay" });
    return secret;
  }


  async function createClient(page, opts) {
    const { name, redirects = [], email, appName, newSecret, out } = opts;
    const type = (opts.type ?? "web").toLowerCase();
    if (!name) throw new Blocked("USAGE", "Falta --name");
    if (!["web", "desktop"].includes(type)) throw new Blocked("USAGE", "--type debe ser web o desktop");
    const created = await ensureConsent(page, appName ?? name, email);

    const existing = (await listClients(page)).find((c) => c.name === name);
    if (existing) {
      step(`ya existe "${name}" → se reutiliza`);
      const redirectResult = type === "web" && redirects.length ? await addRedirects(page, existing, redirects) : null;
      let clientSecret = null;
      if (newSecret || (type === "desktop" && out)) clientSecret = await addSecret(page, existing);
      if (clientSecret && out) writeFileSync(out, JSON.stringify(installedJson(existing.id, clientSecret), null, 2));
      return {
        existing: true, consentCreated: created, clientId: existing.id, clientSecret, redirects: redirectResult, out: clientSecret ? out ?? null : null,
        hint: clientSecret ? undefined : "El secreto no se puede volver a ver: usa --new-secret (o gauth renew) si lo necesitas.",
      };
    }

    await open(page, `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(project)}`, {
      ready: () => !!document.querySelector("cfc-select, mat-select"),
    });
    step(`tipo de aplicación: ${type}`);
    await page.evaluate(() => (document.querySelector("cfc-select") ?? document.querySelector("mat-select"))?.click());
    await sleep(900);
    const option = type === "web" ? /aplicaci[oó]n web|web application/i : /(app|aplicaci[oó]n) de escritorio|desktop app/i;
    await mustClick(page, option, type === "web" ? "Aplicación web" : "App de escritorio");
    await sleep(1500);

    step("nombre");
    await setInput(page, { formcontrol: "displayName" }, name).catch(() => setInput(page, { label: /^nombre|^name/i }, name));

    for (const uri of type === "web" ? redirects : []) {
      step(`redirect ${uri}`);
      const count = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^\+?\s*(agregar uri|add uri)$/i.test((b.innerText || "").trim())).length);
      await clickText(page, /^\+?\s*(agregar uri|add uri)$/i, { index: Math.max(0, count - 1) });
      await sleep(700);
      await setInput(page, { lastEmpty: true }, uri);
    }

    step("crear");
    await mustClick(page, /^(crear|create)$/i, "Crear");
    await waitFor(page, (src) => new RegExp(src).test(document.body.innerText), 30000, "no apareció el diálogo con el ID del cliente", CLIENT_ID_RE.source);
    const dialog = await page.evaluate(() => document.body.innerText + "\n" + document.body.innerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" "));
    const clientId = dialog.match(CLIENT_ID_RE)?.[0];
    let clientSecret = dialog.match(SECRET_RE)?.[0] ?? null;
    await clickText(page, /^(aceptar|ok|cerrar|close|listo|done)$/i, { within: "overlay" });
    await sleep(1500);
    if (!clientSecret) clientSecret = await addSecret(page, { id: clientId, name });
    if (out) writeFileSync(out, JSON.stringify(type === "desktop" ? installedJson(clientId, clientSecret) : { web: { client_id: clientId, client_secret: clientSecret, redirect_uris: redirects } }, null, 2));
    return { existing: false, consentCreated: created, clientId, clientSecret, type, redirects, out: out ?? null };
  }


  // Todas las funciones de arriba reciben la página como primer argumento; aquí ya va atada.
  return {
    consentConfigured: () => consentConfigured(page),
    ensureConsent: (appName, email) => ensureConsent(page, appName, email),
    listClients: () => listClients(page),
    findClient: (ref) => findClient(page, ref),
    addRedirects: (client, uris) => addRedirects(page, client, uris),
    addSecret: (client) => addSecret(page, client),
    createClient: (opts) => createClient(page, opts),
  };
}

/** JSON "installed" que acepta `gcloud auth application-default login --client-id-file` y `ga auth`. */
export function installedJson(clientId, clientSecret) {
  return {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      redirect_uris: ["http://localhost"],
    },
  };
}
