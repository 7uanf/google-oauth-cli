/**
 * APIs de Google con la cuenta del usuario (OAuth de app de escritorio, loopback + PKCE): un único token con
 * los scopes de Analytics y Tag Manager, compartido por `ga` y `gtm`.
 *
 * Por qué un cliente propio: el de gcloud está BLOQUEADO para estos scopes ("Se bloqueó esta app").
 *   gauth create --project <gcp> --name "<App> CLI" --type desktop --email <correo> --out client.json
 *   ga auth --client-file client.json [--cdp 9222 --auto-consent]
 *
 * Duración: en modo Prueba Google vence el refresh token a los 7 días (TOKEN_EXPIRED). Para automatizar sin
 * vencimientos, publica la app (gauth branding + gauth publish): app no verificada, pero sirve al dueño.
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Credenciales de API compartidas por `ga` y `gtm` (cliente de escritorio + token). Modo 600, fuera de repos. */
export const HOME = process.env.GAPI_HOME ?? path.join(os.homedir(), ".google-oauth-cli", "api");
const TOKEN = path.join(HOME, "token.json");
const CLIENT = path.join(HOME, "client.json");
/** Un solo token para todo: Analytics (Admin + Data) y Tag Manager. */
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/analytics.manage.users",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
  "https://www.googleapis.com/auth/tagmanager.publish",
  "https://www.googleapis.com/auth/tagmanager.readonly",
];

// ─── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────
export class Blocked extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
export const log = (m) => process.stderr.write(`[ga] ${m}\n`);
export const emit = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

/** Argumentos: `cmd [sub] --flag valor --flag2 v1,v2`. */
export function parseCli(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      positional.push(argv[i]);
      continue;
    }
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    (flags[k] ??= []).push(v);
  }
  return {
    positional,
    flag: (k) => flags[k]?.[0],
    many: (k) => (flags[k] ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean),
  };
}
const cli = parseCli();
const flag = cli.flag;
export const need = (v, what) => {
  if (!v) throw new Blocked("USAGE", `Falta ${what}`);
  return v;
};

function readClient(file = CLIENT) {
  if (!existsSync(file)) throw new Blocked("NOT_AUTHORIZED", `No hay cliente OAuth en ${file}. Corre: ga auth --client-file <json de gauth create --type desktop>`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  return { id: c.client_id, secret: c.client_secret };
}

// ─── OAuth: autorización (loopback + PKCE) y renovación del token ───────────────────────────────────────────
export async function authorize() {
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
      openAuth(auth.toString()).catch((e) => log(`No pude abrir el navegador: ${e.message}`));
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

/**
 * Abre la autorización. Con `--cdp <puerto>` la abre en el Chrome de automatización (ya con sesión) y, con
 * `--auto-consent`, avanza sola por las pantallas de Google (elegir cuenta, "app no verificada" → Continuar,
 * "Seleccionar todo", Continuar). Es la app del propio usuario: el flag es la autorización explícita para eso.
 */
async function openAuth(url) {
  const port = flag("cdp");
  if (!port) return openBrowser(url);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port === "true" ? 9222 : port}`);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!flag("auto-consent")) return;
  const email = flag("email");
  for (let i = 0; i < 40 && !page.isClosed() && !page.url().startsWith("http://127.0.0.1"); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await page
      .evaluate((email) => {
        const visible = (n) => n.getBoundingClientRect().width > 0;
        const byText = (re) =>
          [...document.querySelectorAll("button, [role=button], a, [role=link], li, div[data-identifier]")]
            .filter(visible)
            .find((n) => re.test((n.innerText || n.getAttribute("data-identifier") || "").trim()));
        // 1) Selector de cuenta.
        const account = email && [...document.querySelectorAll("[data-identifier], [data-email]")].find((n) => (n.getAttribute("data-identifier") || n.getAttribute("data-email")) === email);
        if (account) return account.click();
        // 2) Casillas de permisos: "Seleccionar todo".
        const all = [...document.querySelectorAll("input[type=checkbox]")].find((c) => /seleccionar todo|select all/i.test(c.closest("label, div")?.innerText || ""));
        if (all && !all.checked) all.click();
        // 3) Continuar / Permitir (también en la pantalla de app no verificada).
        const go = byText(/^(continuar|continue|permitir|allow)$/i);
        if (go) go.click();
      }, email)
      .catch(() => {});
  }
  await page.close().catch(() => {});
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

export async function accessToken() {
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
export async function api(method, url, body) {
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

export async function whoami() {
  const t = await accessToken();
  const info = await (await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${t}`)).json();
  return { email: info.email ?? null, scopes: (info.scope ?? "").split(" ") };
}

