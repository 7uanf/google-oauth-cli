---
name: google
description: Google OAuth, Google Analytics 4 and Google Tag Manager from the terminal with one toolkit (google-oauth-cli) — `gauth` drives the Google Auth Platform (consent screen, web and desktop OAuth clients, secrets, redirect URIs, test users, branding, publishing, diagnose) and `ga` drives Google Analytics 4 through the official APIs (account/property/web stream, Measurement ID, retention, Google Signals, access, custom dimensions, reports) and `gtm` drives Tag Manager (container, GA4 Google tag, a generic dataLayer→GA4 event rule, publish). Use for ANY Google Sign-In / client ID / client secret / AUTH_GOOGLE_ID / redirect_uri_mismatch / "Se bloqueó esta app" / consent screen / test users / login fails with empty app logs task, and for ANY Google Analytics / GA4 / measurement ID / traffic numbers / Google Tag Manager / GTM / dataLayer events task.
metadata:
  priority: 9
  promptSignals:
    phrases:
      - "google oauth"
      - "oauth client"
      - "client id"
      - "client secret"
      - "google sign in"
      - "login con google"
      - "redirect_uri_mismatch"
      - "AUTH_GOOGLE_ID"
      - "consent screen"
      - "test users"
      - "usuarios de prueba"
      - "se bloqueó esta app"
      - "google analytics"
      - "ga4"
      - "measurement id"
      - "id de medición"
      - "tag manager"
      - "gtm"
      - "datalayer"
    minScore: 3
---

# google — `gauth` (OAuth) + `ga` (Analytics) + `gtm` (Tag Manager)

One package: **google-oauth-cli** (github.com/7uanf/google-oauth-cli). Two binaries:

- `gauth` — drives the Google Cloud Console with Chrome + CDP, because **the consent screen, test users,
  branding and personal-account OAuth clients have no API and no gcloud command**.
- `ga` — Google Analytics 4 via the official Admin + Data APIs. No browser except a one-time authorization.
- `gtm` — Google Tag Manager via the Tag Manager API v2. Shares `ga`'s token (`lib/gapi.mjs`).

Both print **one JSON object on stdout** (`gauth … --json`; `ga` always). Progress goes to stderr.

## Install / update

```bash
npm install -g github:7uanf/google-oauth-cli     # gives gauth, ga, google-oauth-mcp
```

## Where to run it

`gauth` opens a visible Chrome. If the user's main machine must stay free, run it on a secondary machine
over SSH (Juan: the Mac — `ssh jfernandez@Mac-mini-de-Juan.local 'export PATH=/opt/homebrew/bin:$PATH; gauth …'`).
The Chrome profile (`~/.google-oauth-cli/chrome-profile`) holds a live Google session: never commit or copy it.

## OAuth — `gauth`

```bash
gauth diagnose --project P --json        # START HERE → blockers[] with a `fix` each
gauth ensure   --project P --name N --redirect URL --email E --emails "a@x,b@y"   # idempotent end-to-end
gauth create   --project P --name N --type web --redirect URL[,URL2] --email E [--new-secret]
gauth create   --project P --name "N CLI" --type desktop --email E --out client.json   # for ga / gcloud --client-id-file
gauth renew    --project P --client <id|name> [--out F]     # adds a secret (max 2 per client)
gauth redirects --project P --client <id|name> --uri URL[,URL2]   # adds only the missing ones
gauth test-users list|add|remove --project P [--emails a@x,b@y]
gauth branding --project P --homepage U --privacy U --terms U --contact E
gauth publish  --project P
gauth login | gauth kill
```

`create` is idempotent: a client with the same name is reused (missing redirects are added; a new secret only
with `--new-secret`, or automatically for desktop + `--out`). It creates the consent screen if missing.

## Analytics — `ga`

First time per Google Cloud project:
1. `gauth create --project P --name "<App> CLI" --type desktop --email <owner> --out ~/.claude-skills/analytics/client.json`
   and `gauth test-users add --project P --emails <owner>`.
2. `gcloud services enable analyticsadmin.googleapis.com analyticsdata.googleapis.com --project=P`
3. `ga auth --client-file ~/.claude-skills/analytics/client.json [--browser-profile ~/.google-oauth-cli/chrome-profile]`
   (run in background; the user clicks Continue/Allow; "unverified app" is expected for our own Testing app).

```bash
ga whoami | ga accounts
ga ensure --account "Acme" --property "acme.com" --url https://acme.com --timezone America/Santiago \
          --currency USD --region CL --retention 14 [--viewer sa@proj.iam.gserviceaccount.com]   # → measurementId
ga grant  --property ID --email E --role viewer|analyst|editor|admin
ga report --property ID --days 28 | ga realtime --property ID
```

## Tag Manager — `gtm`

```bash
gtm accounts
gtm ensure --account "Acme" --container "acme.com" --domain acme.com --ga4 G-XXXX            --event-params chapter,network,label,...    # → publicId GTM-XXXX, version published
gtm publish --account ID --container ID
```

`ensure` (idempotent): web container + Google tag (GA4) on All Pages + **generic event rule**: data-layer
variables `dlv - <param>`, a Custom Event trigger matching `^[a-z][a-z0-9_]*$` and a GA4 Event tag sending
`{{Event}}` with those params. A new site event never needs a GTM change; a new *param* does (re-run with
the full list, then `ga dimensions --property ID --params <new>` so it shows in reports).

**The API cannot create a GTM account** (Terms of Service): create it once in tagmanager.google.com, then
everything else is API. Lessons verified against real GA4 hits:
- GTM auto-adds a `dest_ga` "Google Analytics" tag when the Google tag is created by API → **container
  compile error**. `gtm ensure` deletes it.
- The data layer **merges params across pushes**: the site must reset the whole param vocabulary on every
  event (`{...allParamsUndefined, event, ...params}`), or events carry the previous event's params.
- Verify end to end: load `gtm.js?id=GTM-…` in a headless browser, push events, capture `/g/collect` hits
  (`en=`, `ep.*`, `epn.*`). GA4 batches; flush by leaving the page.

## Error codes — act, never loop

| code | do this |
|---|---|
| `SIGN_IN_REQUIRED` | `gauth login` in background and ask the user to sign in in that Chrome window. Then run once. |
| `NO_ACCESS` / `PROJECT_NOT_FOUND` | Wrong account in the profile or wrong project id. |
| `CONSENT_NEEDS_EMAIL` | Re-run with `--email`. |
| `SECRET_LIMIT` | Client has 2 secrets: delete an old one in the console, or create another client. |
| `CLIENT_NOT_FOUND` | See `clients[]` in the JSON. |
| `TIMEOUT` / `UNEXPECTED` | Read `step` + `screenshot`. Fix the selector in `lib/clients.mjs` / `lib/ui.mjs`, retry ONCE. |
| `NOT_AUTHORIZED` / `TOKEN_EXPIRED` | `ga auth` (Testing-mode refresh tokens expire after 7 days). |
| `TOS_REQUIRED` | New GA account: give the user `url` to accept the Analytics terms, then `ga ensure` again. |
| `API_DISABLED` | Run the `enable` command from the JSON. |
| `ACCOUNT_REQUIRED` | No GTM account by that name: create it once in the web (ToS), then `gtm ensure`. |

**Rules**
- Max one retry per command. A second identical failure means the console changed: fix the code in the repo.
- **Never write one-off console scripts.** Add the capability to the repo so the next session has it.
- Never click the console with Playwright locators (the header widget intercepts pointer events → retry
  loop). Use `clickText` / `mustClick` / `setInput` from `lib/ui.mjs`.
- Never print secrets in chat or commit them; `--out` files go to a temp dir or the server.

## Facts that matter

1. **Testing + zero test users = every login rejected before it reaches the app** (empty app logs) → add test users.
2. **"Se bloqueó esta app" with gcloud** = gcloud's own client can't request sensitive scopes (Analytics,
   Drive…). Use a desktop client of the user's own project (`gauth create --type desktop`).
3. Publishing needs branding (homepage, privacy URL, authorized domain, developer contact). Only non-sensitive
   scopes (openid/email/profile) publish without Google verification.
4. Auth.js: redirect `APP_URL/api/auth/callback/google`; env `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.
5. GA4: load gtag only after cookie consent, never on staging/localhost; privacy policy must match `--retention`.
   Servers read GA/Search Console with a service account granted `viewer` (`ga grant`), not a person's token.
   Search Console ↔ GA linking has no API (Admin → Product links, 30 s).
