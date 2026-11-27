# API coverage

The app talks to three APIs, always over https:

1. the panel's **Client API** (`/api/client`), with a client key of the user's account;
2. the panel's **Application API** (`/api/application`), optional, with an application key;
3. the **Wings** daemon of each node, only for the node health probe and, with a daemon token an
   admin enters, its system information. The live console also connects to the node, with a
   short-lived token the panel issues.

Neither panel publishes an OpenAPI document. The endpoints and shapes below were read from the
route files and transformers of Pterodactyl Panel 1.12 (`routes/api-client.php`,
`routes/api-application.php`, `app/Transformers/Api/…`, `develop` of 2026-10-21) and Hydrodactyl
(`routes/api-client.php`, `routes/servers/wings.php`, `routes/api-application.php`, canary of
2026-10-21), and from Wings (`router/router_system.go`, `router/middleware/middleware.go`). The
mock server in `src/mock/` follows the same shapes and is what the tests run against.

## Conventions

- Requests: `Authorization: Bearer <key>`, `Accept: application/json`, JSON bodies; file contents
  are sent as `text/plain`. `credentials: omit`, `cache: no-store`, redirects are refused.
- Answers use Fractal envelopes: `{object, attributes}` for one item, `{object: "list", data,
  meta.pagination}` for lists. Lists are read page by page (`per_page=100`, at most 500 items, 300
  servers).
- Errors: `{"errors":[{"code","status","detail"}]}`. The app shows `detail` for 400/422 and 409.
  502/504 mean the panel could not reach the node (`DaemonConnectionException`).
- Keys: Pterodactyl client keys start with `ptlc_`, application keys with `ptla_`; Hydrodactyl uses
  `hydro_` for both; keys from before Pterodactyl 1.4 have no prefix. The app refuses only a key
  with the other type's prefix, and checks every key against the panel before saving it.

## Panel flavour

`GET /api/client/version` answers `{"version": "…"}` on Hydrodactyl and 404 on Pterodactyl; that
decides the flavour when a panel is added. On Hydrodactyl every server also has `daemon_type`
(`wings`, `elytra` or `calagopus`) and the per-server endpoints moved below it:
`/api/client/servers/{daemon_type}/{id}/…`. The server view and `/resources` answer on the plain
path on both panels. The client builds the path from `daemon_type`, so the same screens work on
both.

## Client API endpoints used

All per-server paths are below `/api/client/servers/{id}` (Pterodactyl) or
`/api/client/servers/{daemon_type}/{id}` (Hydrodactyl).

| Endpoint | Method | Where in the app |
|---|---|---|
| `/api/client` (`filter[*]`, `type`) | GET | Servers list and search; the alert check |
| `/api/client/account` | GET | Connect (checks the key), account screen |
| `/api/client/account/api-keys` | GET | Account: the account's keys (identifier, note, IPs, last use) |
| `/api/client/version` | GET | Flavour detection (Hydrodactyl only) |
| `/api/client/servers/{id}` | GET | Server view (limits, node, SFTP, `daemon_type`) |
| `/api/client/servers/{id}/resources` | GET | State, CPU, memory, disk, network, uptime; every 10 s on the server screen; alerts |
| `/api/client/servers/{id}/resources/history` | GET | Hydrodactyl only: CPU sparkline from the panel's stored samples |
| `…/power` | POST | Start, restart, stop, kill (each confirmed) |
| `…/websocket` | GET | Console token and socket address |
| `…/files/list` | GET | File manager |
| `…/files/contents` | GET | Text editor (files up to 512 KiB that are not binary) |
| `…/files/write` | POST | Save in the editor |
| `…/files/rename` | PUT | Rename (same folder) |
| `…/files/delete` | POST | Delete file or folder (confirmed) |
| `…/files/create-folder` | POST | New folder |
| `…/files/download` | GET | Signed node link, opened in the browser |
| `…/files/upload` | GET | Signed node link; the file is posted there as multipart `files` with `directory` |
| `…/databases` | GET | Databases (host, name, user, allowed hosts; no passwords) |
| `…/schedules` | GET | Schedules with cron, state, last and next run |
| `…/schedules/{id}/execute` | POST | Run now (confirmed) |
| `…/backups` | GET, POST | Backups list (polled while one runs); create |
| `…/backups/{uuid}/download` | GET | Signed node link |
| `…/backups/{uuid}/restore` | POST | Restore with optional `truncate` (confirmed) |
| `…/network/allocations` | GET | Allocations, primary marked |
| `…/startup` | GET | Startup command and the visible variables |
| `…/startup/variable` | PUT | Edit an editable variable (the panel validates with the egg's rules) |
| `…/users` | GET | Subusers with 2FA state and permission count |

## Console WebSocket

1. `GET …/websocket` returns `{data: {token, socket}}`; the token is a JWT valid for about ten
   minutes, the socket `wss://<node>:<port>/api/servers/<uuid>/ws`. The app refuses a `ws://`
   socket.
2. On open the app sends `{"event":"auth","args":[token]}`. After `auth success` it sends
   `send logs` and `send stats`.
3. It handles `console output`, `install output`, `daemon message`, `daemon error`, `status`,
   `stats` (JSON: memory, limit, CPU, disk, network, state, uptime), `token expiring` and
   `token expired` (fetches a new token and sends `auth` again) and `jwt error`.
4. Commands go out as `{"event":"send command","args":[command]}`. Power actions use the REST
   endpoint, not `set state`, so they follow the same permission checks and confirmations.
5. Close code 4409 means the server is suspended. After three failed reconnects the console gives
   up and explains why.

Wings checks the socket's `Origin` against the panel address and its `allowed_origins` setting.
The native apps send the panel's origin (React Native's WebSocket accepts headers). A browser
always sends its own origin, so the **web build** connects only to nodes that list it in
`allowed_origins`; the app says so when the node closes the socket.

## Application API endpoints used

| Endpoint | Method | Where in the app |
|---|---|---|
| `/api/application/users` (`filter[email]`, `filter[username]`) | GET, POST | Users list and search (on the panel); new user; connect check (`per_page=1`) |
| `/api/application/users/{id}` | GET, PATCH | User detail (role, 2FA); edit; the account's 2FA state |
| `/api/application/servers` (`filter[name]`) | GET | All servers; servers a user owns |
| `/api/application/servers/{id}` | GET | Server detail |
| `/api/application/servers/{id}/suspend`, `/unsuspend` | POST | Suspend/unsuspend (confirmed); "suspend all servers" of a user |
| `/api/application/servers/{id}/reinstall` | POST | Reinstall (confirmed by typing the name) |
| `/api/application/nodes` | GET | Nodes with allocated memory/disk; alerts |
| `/api/application/nodes/{id}` | GET | Node detail |
| `/api/application/nodes/{id}/allocations` | GET | Allocation usage from two one-item pages: all, and `filter[server_id]=none` (free) |
| `/api/application/locations` | GET | Locations with their node count |
| `/api/application/nests`, `/nests/{id}/eggs` | GET | Nests and eggs (read-only) |
| `/api/application/panel/status` | GET | Hydrodactyl only: panel host CPU, memory, disk, uptime |

## Wings endpoints used

| Endpoint | Auth | Where in the app |
|---|---|---|
| `GET https://<fqdn>:<daemon_listen>/api/system?v=2` | none | Node probe: a running Wings answers **401** with `WWW-Authenticate: Bearer`; no answer means unreachable |
| the same | `Bearer <daemon token>` | Wings version, Docker version, running/total containers, OS, kernel, threads, memory |
| signed `/download/file`, `/download/backup`, `/upload/file` links | JWT in the link | Downloads and uploads issued by the panel |

The daemon token gives full control of a node. The app uses it only when an admin enters it for
that node; it is stored in the keychain and sent only to that node. The app does **not** read it
from `GET /api/application/nodes/{id}/configuration`, which returns it to any application key with
node read access: copying node secrets to phones should be a deliberate step. Nodes on `http://`
are not probed and never get a token.

Without a token, node health is derived from the panel: reachability from the probe above,
allocation from `allocated_resources` against `memory`/`disk`, maintenance mode, and the servers'
`/resources` (502/504 when the panel cannot reach the node).

## Not used, and gaps

| What | Why |
|---|---|
| 2FA state of the own account (client API) | Only `GET /account/two-factor` says it, and that call creates a new TOTP setup secret as a side effect. With an application key the app reads `2fa` from the user instead. Without one (or when the key may not read users) the account screen says so in plain words, offers a button that opens `<panel>/account` in the browser, and explains the reason behind a "Why?" toggle. |
| Suspending a user account | The panel has no user suspension. The app offers "suspend all servers of this user" instead. |
| Creating servers, editing build/startup as admin, deleting users or servers | Out of scope for the phone; easy to add later (`POST /servers`, `PATCH /servers/{id}/build`, …). |
| Creating or rotating database passwords, schedule editing, subuser editing, allocation changes, API key management, SSH keys | Read-only in the app; the panel's web UI covers them. |
| File copy, compress, decompress, chmod, pull from URL, moving between folders | Not built; rename works within a folder. |
| Activity logs (`/activity`) | Not shown yet. |
| Hydrodactyl extras: marketplace (mod installer), subdomains, server groups, webhooks, egg change, startup command editing, Elytra/Calagopus-specific endpoints | Detected panels expose them, but they are new and still changing on the canary branch; the app shows only resource history and the panel status. Listed as follow-ups. |
| Pyrodactyl and other forks | Treated as Pterodactyl when `/api/client/version` answers 404. |
| Push notifications | Needs a relay (see [alerts.md](alerts.md)). |
| Web build | Panels and nodes usually send no CORS headers for other origins, so the web build is a preview and the test target, not a supported way to manage a panel. |
