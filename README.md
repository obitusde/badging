# badging — Royal Oak Arbeitszeit

A small PWA time clock: `index.html` (hosted on GitHub Pages) talks to a Google Apps Script backend (`Code.gs`) that stores the day's clock-in/out state. `service-worker.js` handles offline caching and displays push notifications.

## How notifications work

Reminders are **not** driven by the app being open. A time-driven trigger inside Apps Script (`checkAndNotify`, installed via `installTrigger()`) runs **every 5 minutes on Google's servers**, checks your current clock-in state, and — if a reminder is due — sends a push notification via Firebase Cloud Messaging (FCM) straight to your phone. This works even if your phone is locked or the app/tab is fully closed.

Flow: `Code.gs` (5-min trigger) → FCM → your phone's push service → `service-worker.js`'s `push` listener → notification shown.

There are five reminder types. Two are fixed clock-time reminders ("did you forget to X by time Y"), and two are **milestone-based** — they fire once at each listed threshold, not on a repeating interval:

| Reminder | Fires when | Notification |
|---|---|---|
| Morning | You haven't clocked in by a set time (off by default) | "Stempeln nicht vergessen!" |
| Lunch forgotten | You're clocked in ("ARBEIT") past a set time with no break started yet | "Mittagspause vergessen?" |
| Break duration | Your break ("PAUSE") has lasted 30 min, then again at 60 min | "Pause dauert schon 30/60 Minuten" |
| Feierabend | Milestones at 0 (Sollarbeitszeit reached), +30, +60 min overtime | "FEIERABEND!" / "30/60 Minuten Überstunden" |

Fixed-time reminders (morning, lunch-forgotten) reset at midnight. Milestone reminders (break duration, Feierabend) each fire exactly once per occurrence: break-duration milestones reset every time a new break starts, Feierabend milestones reset on a fresh clock-in (or at midnight). After the last configured milestone (60 min), no further reminders fire for that break/overtime period.

## How to change reminder behavior

All reminder settings live in **`Code.gs`**, near the top, in the "Erinnerungen" section:

```js
const ERINNERUNGEN_AM_WOCHENENDE = false;   // fire reminders on Sat/Sun?

const ERINNERUNG_MORGENS_AKTIV = false;     // morning reminder on/off
const ERINNERUNG_MORGENS_STUNDE = 9;
const ERINNERUNG_MORGENS_MINUTE = 0;

const ERINNERUNG_MITTAG_VERGESSEN_AKTIV = true;   // lunch-forgotten reminder on/off
const ERINNERUNG_MITTAG_VERGESSEN_STUNDE = 12;
const ERINNERUNG_MITTAG_VERGESSEN_MINUTE = 30;

const ERINNERUNG_PAUSE_DAUER_AKTIV = true;                        // break-duration reminder on/off
const ERINNERUNG_PAUSE_DAUER_MEILENSTEINE_MINUTEN = [30, 60];     // minutes into the break

const ERINNERUNG_FEIERABEND_AKTIV = true;                         // Feierabend reminder on/off
const ERINNERUNG_FEIERABEND_MEILENSTEINE_MINUTEN = [0, 30, 60];   // 0 = Soll reached, then overtime minutes
```

The two milestone arrays (`ERINNERUNG_PAUSE_DAUER_MEILENSTEINE_MINUTEN`, `ERINNERUNG_FEIERABEND_MEILENSTEINE_MINUTEN`) can have values added or removed freely — e.g. add `90` to get a third break-duration nudge, or `120` for a 2-hour-overtime alert. Each value needs no code change to work; it just won't have custom wording (see below) unless you add it.

Custom wording per milestone lives in two lookup objects further down in `Code.gs`, `PAUSE_DAUER_TEXTE_` and `FEIERABEND_MEILENSTEIN_TEXTE_`:

```js
const PAUSE_DAUER_TEXTE_ = {
  30: { title: 'Pause dauert schon 30 Minuten', body: 'Denk dran, rechtzeitig weiterzuarbeiten.' },
  60: { title: 'Pause dauert schon 60 Minuten', body: 'Das ist schon eine lange Pause — bitte zurückstempeln.' }
};
```

Any milestone value without an entry here falls back to a generic auto-generated message, so adding a new milestone number to the array above always works even before you write custom text for it.

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
