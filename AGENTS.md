# clashadmin

Clash / Shadowrocket subscription generator. Stack: yarn (v1) + Vue 3 + Vite + TypeScript, Hono server run with tsx.

## Layout

- `shared/` – pure functions used by both sides: URI parsers (`parse.ts`), Clash YAML import and proxy-to-URI conversion (`yaml.ts`), Clash YAML / Shadowrocket renderers and chain validation (`render.ts`)
- `server/` – Hono API (`app.ts`), JSON file store (`store.ts`, writes `data/db.json`, git-ignored)
- `src/` – Vue panel (single page, `App.vue`)

## Commands

- `yarn dev` – server on 127.0.0.1:8787 + Vite on 5173 (proxies `/api` and `/sub`)
- `yarn test` – vitest (shared + server)
- `yarn typecheck` – vue-tsc
- `yarn build` – typecheck + Vite build; `yarn start` then serves `dist/` and the API from one port

Auth: admin password comes from `ADMIN_PASSWORD` (env or `.env`, min 8 chars; server refuses to start without it). All `/api/*` except `/api/session` and `/api/login` require the session cookie; new routes must stay under `/api/` to be covered.

Docker: `./start.sh` (build + `docker compose up -d`, waits for readiness) and `./stop.sh`. The image runs the server with tsx (a runtime dependency) and serves the built `dist/`; data lives in `./data`.

URL imports (`server/source.ts`) refuse loopback/private/link-local targets, re-checked on every redirect and at DNS resolution time; `IMPORT_ALLOW_PRIVATE=1` disables this.

Env: `ADMIN_PASSWORD`, `IMPORT_ALLOW_PRIVATE`, `PUBLIC_URL` (when set, the origin used for both subscription links and the QR code), `PORT`, `HOST` (default 0.0.0.0; `/sub/*` is token-protected), `DATA_FILE`.

## Conventions

- Dependencies are pinned to exact versions; prefer releases at least 7 days old.
- New protocols: add a parser in `shared/parse.ts` and a test in `shared/shared.test.ts`.
- New output formats: add a renderer in `shared/render.ts` and a `target` case in `/sub/:token/:target`.
- Chains: Clash uses `dialer-proxy`; Shadowrocket uses a `chain=<dialer name>` query parameter on the node link (undocumented, confirmed on a real device). Both come from `plan()` in `shared/render.ts`; Shadowrocket drops chained nodes whose protocol is in `ROCKET_NO_CHAIN` or whose dialer is not in its output, with a warning, rather than letting them connect directly.
