# Frontend and browser authentication

The React frontend and `/v1/*` control API are served from the same Cloudflare Worker. Browser
access uses a username and password stored in D1; the machine-to-machine LiveKit webhook and agent
callback routes retain their separate signature and bearer-token authentication.

## Database setup

The `AUTH_DB` binding points at `oral-exam-auth`. Provision the database once, apply its migrations,
and create the experiment's single user:

```sh
pnpm exec wrangler d1 create oral-exam-auth
pnpm exec wrangler d1 migrations apply oral-exam-auth --remote
pnpm auth:create-user -- --remote oral-exam-auth <username>
```

The user script prompts for the password without echoing it, derives a uniquely salted
PBKDF2-HMAC-SHA-256 hash with 600,000 iterations, and passes only that one-way hash to
`wrangler d1 execute`. The plaintext password is never sent to D1, printed, or placed in shell
history. Passwords must contain 12 to 256 characters.

Change an existing user's password with the matching helper. This also revokes all of that user's
active browser sessions:

```sh
pnpm auth:change-password -- --remote oral-exam-auth <username>
```

For local development, apply the migration and create a separate local user:

```sh
pnpm exec wrangler d1 migrations apply oral-exam-auth --local
pnpm auth:create-user -- --local oral-exam-auth <username>
pnpm auth:change-password -- --local oral-exam-auth <username>
pnpm exec wrangler dev
pnpm dev
```

Vite proxies `/v1` and its WebSocket upgrades to Wrangler on port 8787. No browser-readable
`VITE_*` credential is required.

## Session security

`POST /v1/auth/login` accepts a small JSON username/password body and returns an opaque 256-bit
session token in a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie. D1 stores only the
SHA-256 digest of that token. Sessions expire after 24 hours, a new login revokes older sessions for
that user, and logout deletes the server-side session.

The Worker requires the configured browser origin on login, logout, every state-changing browser
request, and the control WebSocket upgrade. Login failures are rate-limited per source address and
return the same response and password-hash workload whether or not the username exists.

The LiveKit participant token returned by `POST /v1/conversations/:id/livekit-access` remains a
separate short-lived, room-scoped capability. It stays in memory and responses use
`Cache-Control: no-store`.
