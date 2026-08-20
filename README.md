# badging — Royal Oak Arbeitszeit

A small PWA time clock: `index.html` (hosted on GitHub Pages) talks to a Google Apps Script backend (`Code.gs`) that stores the day's clock-in/out state. `service-worker.js` handles offline caching and displays push notifications.

## How notifications work

Reminders are **not** driven by the app being open. A time-driven trigger inside Apps Script (`checkAndNotify`, installed via `installTrigger()`) runs **every 5 minutes on Google's servers**, checks your current clock-in state, and — if a reminder is due — sends a push notification via Firebase Cloud Messaging (FCM) straight to your phone. This works even if your phone is locked or the app/tab is fully closed.

Flow: `Code.gs` (5-min trigger) → FCM → your phone's push service → `service-worker.js`'s `push` listener → notification shown.

Reminders are organised as **time windows**. Inside a window you get a reminder every 30 minutes, but **only for as long as the action is actually still pending** — clock in, and the check-in reminder stops immediately.

| Window | Fires when | Notification |
|---|---|---|
| 09:00–11:00 | Not clocked in yet | "Einstempeln nicht vergessen!" |
| 11:30–13:30 | Working, no break taken yet | "Mittagspause nicht vergessen!" + time left to Feierabend |
| 11:30–13:30 | Currently on break | "Pause beenden?" + how long you've been on break |
| 16:00–22:00 | Still clocked in (working or on break) | "Ausstempeln nicht vergessen!" + time left / overtime |

Notification bodies carry live numbers rather than fixed text: `Noch 2 Std 15 Min bis Feierabend.` while you're under your target hours, `Du hast bereits 40 Min Überstunden.` once you're past it, and `Du bist seit 35 Minuten in der Pause.` during a break.

All "already sent" markers reset at midnight and on a fresh clock-in.

## How to change reminder behavior

All reminder settings live in **`Code.gs`**, near the top, in the "Erinnerungen" section:

```js
const ERINNERUNGEN_AM_WOCHENENDE = false;      // fire reminders on Sat/Sun?
const ERINNERUNG_WIEDERHOLUNG_MINUTEN = 30;    // repeat gap inside every window

const ERINNERUNG_KOMMEN_AKTIV = true;          // "you haven't clocked in"
const ERINNERUNG_KOMMEN_VON = "09:00";
const ERINNERUNG_KOMMEN_BIS = "11:00";

const ERINNERUNG_PAUSE_AKTIV = true;           // break start + break end
const ERINNERUNG_PAUSE_VON = "11:30";
const ERINNERUNG_PAUSE_BIS = "13:30";

const ERINNERUNG_GEHEN_AKTIV = true;           // "you haven't clocked out"
const ERINNERUNG_GEHEN_VON = "16:00";
const ERINNERUNG_GEHEN_BIS = "22:00";
```

To move a window, edit its `_VON` / `_BIS` times. To silence one entirely, set its `_AKTIV` to `false`. To be nagged more or less often, change `ERINNERUNG_WIEDERHOLUNG_MINUTEN`. Wording lives in the `sendPush_(...)` calls inside `checkAndNotify()` just below.

Note the windows are checked by a trigger that runs every 5 minutes, so a reminder lands at the first 5-minute tick inside the window, not exactly on the minute.

## Entering times manually

Tap the **Kommen**, **Pause**, or **Gehen** card to type a value instead of using the buttons — useful when you forgot to stamp, or stamped at the wrong time. The stamp buttons keep working exactly as before; both paths write to the same state.

- **Kommen / Gehen** open a time picker. Entering a Kommen time on a fresh day also starts the day (status → working); entering a Gehen time ends it (status → finished) and closes a running break.
- **Pause** takes minutes, bounded to **30–120** (`PAUSE_MIN_MINUTEN` / `PAUSE_MAX_MINUTEN`, set in both `index.html` and `Code.gs`). Before you've taken a real break this sets the *planned* break used for the Feierabend estimate; once a break has actually run, it overwrites the *actual* recorded break.

**⚠️ After editing `Code.gs`, you must redeploy — saving alone is not enough:**

1. Apps Script editor (script.google.com) → paste in your changes → save.
2. **Deploy → Manage deployments → ✏️ edit the existing deployment → Version: "New version" → Deploy.**

Saving the script updates what the 5-minute trigger runs (so `checkAndNotify` picks up changes quickly), but the live `/exec` URL that the app itself talks to stays pinned to whatever was last deployed until you explicitly push a new version.

**Do you need to reload/clear the app on your phone after a change?**

- **`Code.gs` only** (reminder times, wording, milestones, etc.): no. It's pure backend — the phone never caches anything from it (the service worker explicitly never caches `script.google.com` requests). Redeploying is enough; effective immediately.
- **`index.html` or `service-worker.js`**: reload the app once. Thanks to the network-first fetch strategy, a normal reload picks up changes automatically — the previous "clear all site data" workaround should only be needed again if something is genuinely stuck.

## First-time setup (already done, for reference)

- A Firebase project (`badging-e9359`) provides the push channel. Its Web config lives in both `index.html` (`FIREBASE_CONFIG`, `FIREBASE_VAPID_KEY`) and `service-worker.js` — kept in sync manually since a service worker can't read the page's JS.
- The server-side send path (`Code.gs`) authenticates to FCM using a service account, stored **only** in Apps Script's Script Properties (never in this repo):
  - `FCM_PROJECT_ID` — Firebase project ID
  - `FCM_CLIENT_EMAIL` — service account `client_email`
  - `FCM_PRIVATE_KEY` — service account `private_key`
  - `FCM_TOKEN` — your phone's push token, set automatically by the app when you tap "🔔 Benachrichtigungen aktivieren"
- `installTrigger()` (run once from the Apps Script editor) installs the 5-minute `checkAndNotify` trigger.

## Troubleshooting

- **Test a push directly**, without touching your phone's app at all: open `<your-exec-url>?action=debugPush` in a browser or via curl. Returns `{"ok":true,...}` on success, or an error message describing exactly what failed (bad token, auth failure, etc.).
- **`FCM_TOKEN` missing or stale in Script Properties**: reload the app on your phone and tap "🔔 Benachrichtigungen aktivieren" again.
- **Nothing happens after editing `Code.gs`**: you almost certainly forgot to deploy a new version (see above) — saving in the editor does not update the live endpoint.
- **App seems stuck on old behavior after updating `index.html` or `service-worker.js`**: GitHub Pages can take up to a minute to propagate a push. If it's still stale after that, the phone's service worker may need a fresh install — clear the site's data in Chrome (address bar icon → site settings → clear & reset) and reload.
