# Alerts

The app has no server side. Alerts come from a check that runs on the phone: for every saved
panel whose alerts are on, it reads the servers (Client API), each server's `/resources` and the
latest backup, and with an application key the nodes (Application API) plus a probe of each
node's Wings. The result is compared with the thresholds in *Settings* and the switches of each
panel (*Settings → Panels → a panel*).

| Alert | Rule | Default | Severity |
|---|---|---|---|
| Server stopped or crashed | was `running`/`starting` at the previous check, `offline` now, status normal | on | critical |
| Server unreachable | `/resources` answers 502/504 (the panel cannot reach the node) and the node is not already reported | on | critical |
| Disk | disk used ≥ N % of the server's limit (servers with a limit only) | 90 % | warning, critical at 100 % |
| Memory | memory used ≥ N % of the limit while running | 95 % | warning |
| Backup failed | the latest finished backup has `is_successful: false` | on | warning |
| Node unreachable | the Wings probe gets no answer (application key needed) | on | critical |
| Node allocated | memory or disk allocated to servers ≥ N % of the node's capacity | 95 % | warning |

Suspended, installing or restoring servers and nodes in maintenance mode are not watched.

The node probe needs no daemon token: a running Wings answers 401, and no answer means
unreachable. The check therefore never reads node configurations from the panel, so the daemon
tokens the node screen gets from the panel stay in memory and never reach the background task. A
token an admin pasted for a node is used if there is one.

The panel does not say whether a server stopped on purpose or crashed: Wings reports a crash only
as a message on the console socket, which a background check does not keep open. The alert
therefore says "stopped or crashed".

A notification is sent once per problem: the ids of the previous check are kept, and only new
ones notify. A problem that goes away and comes back notifies again.

To keep a check short, it looks at the first 40 servers of each panel and the backups of the
first 15. Large panels are better watched with the push relay below.

## Background checks

On Android and iOS the check runs as a background task, asked for every 30 minutes. The task uses
`expo-background-task` (WorkManager on Android, BGTaskScheduler on iOS), the replacement Expo
recommends for the deprecated `expo-background-fetch`; notifications are local
(`expo-notifications`). Keys and pasted daemon tokens are read from the keychain/keystore with
"after first unlock" access, so the check works while the phone is locked. The task is registered once a
panel is saved and the setting is on.

Limits:

- **iOS decides when a background task runs.** It learns from how often the app is used; runs
  can be hours apart, may not happen at all in Low Power Mode, and stop after the app is
  force-quit from the app switcher until it is opened again. The setting is a request, not a
  schedule.
- **Android** runs the task at the earliest after the interval (minimum 15 minutes); Doze and
  manufacturer battery savers can delay it further. Some vendors stop background work for apps
  that are not opened for a while.
- Background tasks do not run in Expo Go; a development or release build is needed.
- The web version has no background checks and no notifications; the *Alerts* tab checks by
  hand and whenever it is opened.

## Push relay

Alerts that must arrive within a minute come from
[Lumen Console Relay](https://github.com/luminare-dev/lumen-console-relay), a small self-hosted
service next to the panel. It holds a read-only panel key (a dedicated subuser account is
enough), polls every minute with the same rules and alert ids as this check, keeps the console
socket of each server open to see crashes within seconds, and pushes through Expo's push service
or a self-hosted ntfy server. It also checks every server, not only the first 40.

*Settings → Push relay* pairs the phone: enter the relay address and a one-time pairing code
from `lumen-relay pair`, or scan its QR code with the phone camera (the link
`lumenconsole://relay?url=…&code=…` opens the screen filled in). Choose ntfy or Expo push, then
the events per panel (the same four switches as above). The app never sends panel keys to the
relay; the relay keeps only a device token, and *Unregister* removes it.

A tapped relay push opens the server (`lumenconsole://alert?origin=…&server=…`) or the node.

The background check stays on as a fallback. For panels the relay pushes for (at least one event
on), it no longer sends its own notifications, so a problem is not notified twice; the *Alerts*
tab still shows everything it finds.
