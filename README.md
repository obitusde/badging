# badging — Royal Oak Arbeitszeit

A small PWA time clock: `index.html` (hosted on GitHub Pages) talks to a Google Apps Script backend (`Code.gs`) that stores the day's clock-in/out state. `service-worker.js` handles offline caching and displays push notifications.

## How notifications work

Reminders are **not** driven by the app being open. A time-driven trigger inside Apps Script (`checkAndNotify`, installed via `installTrigger()`) runs **every 5 minutes on Google's servers**, checks your current clock-in state, and — if a reminder is due — sends a push notification via Firebase Cloud Messaging (FCM) straight to your phone. This works even if your phone is locked or the app/tab is fully closed.

Flow: `Code.gs` (5-min trigger) → FCM → your phone's push service → `service-worker.js`'s `push` listener → notification shown.

There are four reminder types:

| Reminder | Fires when | Notification |
|---|---|---|
| Morning | You haven't clocked in by a set time | "Stempeln nicht vergessen!" |
| Lunch | You're clocked in ("ARBEIT") past a set time with no break started yet | "Mittagspause vergessen?" |
| Break-end | You're still on break ("PAUSE") past a set time | "Pause beenden?" |
| Feierabend | You've reached your Sollarbeitszeit (target hours) and are still clocked in; repeats every N minutes until you clock out | "FEIERABEND!" / "Immer noch eingestempelt!" |

Each reminder fires at most once per condition per day (the morning/lunch/break-end reminders reset at midnight; the Feierabend reminder keeps repeating at the configured interval until you clock out).

## How to change reminder behavior

All reminder settings live in **`Code.gs`**, near the top, in the "Erinnerungen" section:

```js
const ERINNERUNGEN_AM_WOCHENENDE = false;   // fire reminders on Sat/Sun?

const ERINNERUNG_MORGENS_AKTIV = false;     // morning reminder on/off
const ERINNERUNG_MORGENS_STUNDE = 9;
const ERINNERUNG_MORGENS_MINUTE = 0;

const ERINNERUNG_MITTAG_VERGESSEN_AKTIV = true;   // lunch reminder on/off
const ERINNERUNG_MITTAG_VERGESSEN_STUNDE = 12;
const ERINNERUNG_MITTAG_VERGESSEN_MINUTE = 30;

const ERINNERUNG_PAUSE_ENDE_AKTIV = true;   // break-end reminder on/off
const ERINNERUNG_PAUSE_ENDE_STUNDE = 13;
const ERINNERUNG_PAUSE_ENDE_MINUTE = 30;

const ERINNERUNG_FEIERABEND_AKTIV = true;   // Feierabend reminder on/off
const ERINNERUNG_FEIERABEND_INTERVAL_MINUTEN = 15;   // repeat interval
```

To change wording, hours, minutes, on/off toggles, or the repeat interval: edit these constants (or the reminder text inside the `checkAndNotify()` function further down) directly in `Code.gs`.

**⚠️ After editing `Code.gs`, you must redeploy — saving alone is not enough:**

1. Apps Script editor (script.google.com) → paste in your changes → save.
2. **Deploy → Manage deployments → ✏️ edit the existing deployment → Version: "New version" → Deploy.**

Saving the script updates what the 5-minute trigger runs (so `checkAndNotify` picks up changes quickly), but the live `/exec` URL that the app itself talks to stays pinned to whatever was last deployed until you explicitly push a new version.

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
