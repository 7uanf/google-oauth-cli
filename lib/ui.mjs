/**
 * Primitivas de UI contra la Google Cloud Console (las usan lib/clients.mjs y los comandos nuevos).
 *
 * BUCLE DE CLICS (la causa de las sesiones que se quedaban en loop): una capa del header de la consola
 * (<one-cloud-bar-widget>) "intercepts pointer events" y Playwright reintenta locator.click() hasta agotar el
 * timeout. Aquí todos los clics son por JS (element.click()), que no pasa por esos chequeos.
 * Además: `networkidle` nunca llega en la consola (va domcontentloaded + esperar texto), `page.screenshot()`
 * se puede colgar (siempre con timeout) y la verificación es releyendo el texto tras recargar.
 */
import os from "node:os";
import path from "node:path";

const SHOTS = os.tmpdir();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Errores con código estable ────────────────────────────────────────────────────────────────────────────
/** Error que NO se arregla reintentando: el agente debe leer `code` y actuar (o avisar al usuario). */
export class Blocked extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

let currentStep = "boot";
/** Último paso anunciado (para reportar dónde se cortó un TIMEOUT). */
export const lastStep = () => currentStep;

export function step(name) {
  currentStep = name;
  process.stderr.write(`[gauth] ${name}\n`);
}


// ─── Navegación ──────────────────────────────────────────────────────────────────────────────────────────────
export async function screenshot(page, name) {
  const file = path.join(SHOTS, `gauth-${name}.png`);
  try {
    await page.screenshot({ path: file, timeout: 8000 });
    return file;
  } catch {
    return null;
  }
}

export function consoleUrl(project, screen) {
  return `https://console.cloud.google.com/auth/${screen}?project=${encodeURIComponent(project)}`;
}

/**
 * Va a una URL de la consola y espera a que cargue. Si Google pide iniciar sesión, trae la ventana al frente y
 * espera UNA vez (GAUTH_SIGNIN_WAIT, 300 s). Si no se completa → SIGN_IN_REQUIRED (no reintentar: avisar).
 */
export async function open(page, url, { ready } = {}) {
  step(`abriendo ${url.replace(/^https:\/\/console\.cloud\.google\.com/, "")}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);
  if (page.url().includes("accounts.google.com")) {
    const wait = Number(process.env.GAUTH_SIGNIN_WAIT ?? 300);
    process.stderr.write(`\n[gauth] ⚠ Hay que iniciar sesión en la ventana de Chrome que se abrió (espero ${wait} s)...\n\n`);
    await page.bringToFront().catch(() => {});
    const deadline = Date.now() + wait * 1000;
    while (page.url().includes("accounts.google.com")) {
      if (Date.now() > deadline) throw new Blocked("SIGN_IN_REQUIRED", "Nadie inició sesión en la ventana de Chrome. Pídele al usuario que lo haga y vuelve a correr el comando una vez.");
      await sleep(1000);
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  // Esperar a que aparezca contenido real de la consola.
  await waitFor(page, ready ?? (() => document.body.innerText.length > 400), 45000, "la consola no terminó de cargar");
  const text = await bodyText(page);
  if (/no tienes permiso|you don.t have permission|you need additional access|necesitas acceso adicional/i.test(text))
    throw new Blocked("NO_ACCESS", "La cuenta con sesión en el perfil no tiene acceso a este proyecto.");
  if (/project .* (not found|does not exist)|no se encontró el proyecto/i.test(text))
    throw new Blocked("PROJECT_NOT_FOUND", "El proyecto no existe o la cuenta no lo ve.");
  await sleep(1500);
}

/** Espera a que `predicate` (que corre en la página) sea verdadero. */
export async function waitFor(page, predicate, timeoutMs, message, arg) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page.evaluate(predicate, arg).catch(() => false);
    if (ok) return true;
    if (Date.now() > deadline) {
      if (message) throw new Error(message);
      return false;
    }
    await sleep(600);
  }
}

export const bodyText = (page) => page.evaluate(() => document.body.innerText || "");

/**
 * Clic por JS en el primer botón/enlace visible y habilitado cuyo texto (o aria-label) cumpla `re`.
 * `within`: "overlay" busca solo dentro del diálogo abierto; "page" en todo el documento.
 */
export async function clickText(page, re, { within = "page", index = 0 } = {}) {
  return page.evaluate(
    ({ source, flags, within, index }) => {
      const rx = new RegExp(source, flags);
      const root =
        within === "overlay"
          ? [...document.querySelectorAll(".cdk-overlay-pane, [role=dialog], mat-dialog-container")].pop() ?? document
          : document;
      const nodes = [...root.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem], [role=option], mat-option, cfc-option")].filter((n) => {
        const r = n.getBoundingClientRect();
        const disabled = n.disabled || n.getAttribute("aria-disabled") === "true";
        return r.width > 0 && r.height > 0 && !disabled;
      });
      const hits = nodes.filter((n) => rx.test((n.innerText || n.getAttribute("aria-label") || "").trim()));
      const hit = hits[index];
      if (!hit) return { ok: false, seen: nodes.map((n) => (n.innerText || "").trim()).filter(Boolean).slice(0, 15) };
      hit.scrollIntoView({ block: "center" });
      hit.click();
      return { ok: true, clicked: (hit.innerText || hit.getAttribute("aria-label") || "").trim().slice(0, 50) };
    },
    { source: re.source, flags: re.flags, within, index },
  );
}

/** Como clickText pero falla con un mensaje claro si no encuentra el botón. */
export async function mustClick(page, re, what, opts) {
  const r = await clickText(page, re, opts);
  if (!r.ok) throw new Error(`No encontré el botón "${what}". Visibles: ${JSON.stringify(r.seen)}`);
  return r;
}

/**
 * Escribe en un input por JS + eventos (así lo lee Angular). Elige el input con `pick`:
 * - { formcontrol: "displayName" }
 * - { label: /regex/ }  → el input cuyo bloque de texto cercano menciona el campo
 * - { lastEmpty: true }  → el último input de texto visible y vacío (el que se acaba de agregar)
 */
export async function setInput(page, pick, value) {
  const handle = await page.evaluateHandle(
    ({ pick }) => {
      const inputs = [...document.querySelectorAll("input, textarea")].filter((el) => {
        const t = el.getAttribute("type") || "text";
        const r = el.getBoundingClientRect();
        return !["search", "hidden", "file", "checkbox", "radio"].includes(t) && r.width > 0 && r.height > 0;
      });
      if (pick.formcontrol) return inputs.find((el) => el.getAttribute("formcontrolname") === pick.formcontrol) ?? null;
      if (pick.lastEmpty) return [...inputs].reverse().find((el) => !el.value) ?? null;
      if (pick.label) {
        const rx = new RegExp(pick.label.source, pick.label.flags);
        for (const el of inputs) {
          if (rx.test(el.getAttribute("aria-label") || "")) return el;
          let node = el;
          for (let i = 0; i < 6 && node; i++) {
            node = node.parentElement;
            const text = (node?.innerText || "").trim();
            if (text && text.length < 500 && rx.test(text)) return el;
          }
        }
      }
      return null;
    },
    { pick: { ...pick, label: pick.label ? { source: pick.label.source, flags: pick.label.flags } : undefined } },
  );
  const el = handle.asElement();
  if (!el) throw new Error(`No encontré el campo ${JSON.stringify(pick.formcontrol ?? pick.label?.source ?? "vacío")}`);
  // fill() de Playwright no hace chequeos de puntero (no le afecta la capa del header) y dispara input/change.
  await el.fill(value, { timeout: 10000 });
  await el.evaluate((node) => node.dispatchEvent(new Event("blur", { bubbles: true })));
  return el;
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const CLIENT_ID_RE = /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/;
export const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{20,}/;
