// =============================================================
// Royal Oak Arbeitszeit — Apps Script Backend
// =============================================================
// This file lives in Google Apps Script (script.google.com)
// The frontend (index.html) is now hosted on GitHub Pages and
// talks to this backend via JSON over HTTPS.
//
// Push notifications (Firebase Cloud Messaging) require these
// Script Properties to be set (Project Settings → Script Properties
// in the Apps Script editor — never commit these to GitHub):
//   FCM_PROJECT_ID    — Firebase project ID
//   FCM_CLIENT_EMAIL  — service account "client_email"
//   FCM_PRIVATE_KEY   — service account "private_key"
// The FCM_TOKEN property is set automatically by the app itself
// via the registerToken action once you open it on your phone.
//
// After first setup, run installTrigger() once (Run menu in the
// Apps Script editor) to install the 5-minute reminder check.
// =============================================================

const SOLL_STUNDEN = 8;
const SOLL_MINUTEN = 25;

// ----- Erinnerungen -----
// Jede Erinnerung kann einzeln ein-/ausgeschaltet werden (true / false)

// Erinnerungen am Wochenende? (Samstag + Sonntag)
const ERINNERUNGEN_AM_WOCHENENDE = false;

// 1. Morgen-Erinnerung: wenn noch nicht eingestempelt
const ERINNERUNG_MORGENS_AKTIV = false;
const ERINNERUNG_MORGENS_STUNDE = 9;
const ERINNERUNG_MORGENS_MINUTE = 0;

// 2. Mittag-Erinnerung: wenn keine Pause gestartet wurde
const ERINNERUNG_MITTAG_VERGESSEN_AKTIV = true;
const ERINNERUNG_MITTAG_VERGESSEN_STUNDE = 12;
const ERINNERUNG_MITTAG_VERGESSEN_MINUTE = 30;

// 3. Pause-Ende-Erinnerung: wenn Pause-Status zu lange aktiv
const ERINNERUNG_PAUSE_ENDE_AKTIV = true;
const ERINNERUNG_PAUSE_ENDE_STUNDE = 13;
const ERINNERUNG_PAUSE_ENDE_MINUTE = 30;

// 4. Feierabend-Erinnerung: bei erreichter Sollarbeitszeit
//    Wiederholt sich alle X Minuten bis ausgestempelt
const ERINNERUNG_FEIERABEND_AKTIV = true;
const ERINNERUNG_FEIERABEND_INTERVAL_MINUTEN = 15;

// =============================================================
// JSON API entry point — handles ALL requests from the PWA
// =============================================================
function doGet(e) {
  let result;
  try {
    const action = (e && e.parameter && e.parameter.action) || 'status';
    const clientDate = (e && e.parameter && e.parameter.date) || new Date().toDateString();

    if (action === 'status') {
      result = getHeutigenStatus(clientDate);
    }
    else if (action === 'stempeln') {
      const type = e.parameter.type;
      const pause = parseInt(e.parameter.pause, 10) || 45;
      result = stempeln(type, pause, clientDate);
    }
    else if (action === 'updatePause') {
      const pause = parseInt(e.parameter.pause, 10) || 45;
      result = updatePauseInScript(pause, clientDate);
    }
    else if (action === 'reset') {
      result = komplettReset();
    }
    else if (action === 'registerToken') {
      result = registerToken(e.parameter.token);
    }
    else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================================================
// Storage helpers
// =============================================================
function getStorage() {
  return PropertiesService.getUserProperties();
}

function getHeutigenStatus(clientHeuteStr) {
  const props = getStorage();
  const heuteStr = clientHeuteStr || new Date().toDateString();
  const gespeicherterTag = props.getProperty('LETZTER_TAG');

  if (gespeicherterTag !== heuteStr) {
    return {
      status: 'BEREIT',
      kommenZeit: null,
      gehenZeit: null,
      geplantePauseMinuten: 45,
      realePauseMs: 0,
      uiPauseStartZeit: null
    };
  }

  return {
    status: props.getProperty('STATUS') || 'BEREIT',
    kommenZeit: props.getProperty('KOMMEN_ZEIT') ? parseInt(props.getProperty('KOMMEN_ZEIT'), 10) : null,
    gehenZeit: props.getProperty('GEHEN_ZEIT') ? parseInt(props.getProperty('GEHEN_ZEIT'), 10) : null,
    geplantePauseMinuten: props.getProperty('GEPLANTE_PAUSE') ? parseInt(props.getProperty('GEPLANTE_PAUSE'), 10) : 45,
    realePauseMs: props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0,
    uiPauseStartZeit: props.getProperty('UI_PAUSE_START') ? parseInt(props.getProperty('UI_PAUSE_START'), 10) : null
  };
}

// =============================================================
// Actions: Kommen / Pause / Gehen
// =============================================================
function stempeln(aktion, geplantePause, clientHeuteStr) {
  const props = getStorage();
  const heuteStr = clientHeuteStr || new Date().toDateString();
  const jetztMs = new Date().getTime();

  props.setProperty('LETZTER_TAG', heuteStr);
  props.setProperty('GEPLANTE_PAUSE', geplantePause.toString());

  if (aktion === 'KOMMEN') {
    props.setProperty('STATUS', 'ARBEIT');
    props.setProperty('KOMMEN_ZEIT', jetztMs.toString());
    props.setProperty('REALE_PAUSE_MS', '0');
    props.deleteProperty('UI_PAUSE_START');
    props.deleteProperty('GEHEN_ZEIT');
    clearReminderFlags_();
  }
  else if (aktion === 'PAUSE_START') {
    props.setProperty('STATUS', 'PAUSE');
    props.setProperty('UI_PAUSE_START', jetztMs.toString());
  }
  else if (aktion === 'PAUSE_ENDE') {
    const startPauseStr = props.getProperty('UI_PAUSE_START');
    if (!startPauseStr) {
      return { error: 'Kein Pausenstart gefunden. Bitte neu laden.' };
    }
    props.setProperty('STATUS', 'ARBEIT');
    const startPause = parseInt(startPauseStr, 10);
    const bisherigePauseMs = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
    const aktuellePauseMs = jetztMs - startPause;
    props.setProperty('REALE_PAUSE_MS', (bisherigePauseMs + aktuellePauseMs).toString());
    props.deleteProperty('UI_PAUSE_START');
  }
  else if (aktion === 'GEHEN') {
    if (props.getProperty('STATUS') === 'PAUSE') {
      const startPauseStr = props.getProperty('UI_PAUSE_START');
      if (startPauseStr) {
        const startPause = parseInt(startPauseStr, 10);
        const bisherigePauseMs = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
        const aktuellePauseMs = jetztMs - startPause;
        props.setProperty('REALE_PAUSE_MS', (bisherigePauseMs + aktuellePauseMs).toString());
      }
      props.deleteProperty('UI_PAUSE_START');
    }
    props.setProperty('STATUS', 'BEENDET');
    props.setProperty('GEHEN_ZEIT', jetztMs.toString());
  }

  return getHeutigenStatus(heuteStr);
}

function updatePauseInScript(geplanteMinuten, clientHeuteStr) {
  const props = getStorage();
  props.setProperty('GEPLANTE_PAUSE', geplanteMinuten.toString());
  return getHeutigenStatus(clientHeuteStr || new Date().toDateString());
}

function komplettReset() {
  const props = getStorage();
  props.deleteAllProperties();
  clearReminderFlags_();
  return getHeutigenStatus(new Date().toDateString());
}

// =============================================================
// Push-Token-Registrierung
// =============================================================
function registerToken(token) {
  if (!token) return { error: 'Kein Token übergeben.' };
  PropertiesService.getScriptProperties().setProperty('FCM_TOKEN', token);
  return { ok: true };
}

// =============================================================
// Push senden via FCM HTTP v1 API
// =============================================================
function getFcmAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('FCM_ACCESS_TOKEN');
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties();
  const clientEmail = props.getProperty('FCM_CLIENT_EMAIL');
  const privateKey = (props.getProperty('FCM_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY fehlen in den Script Properties.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600
  };

  const b64url = (obj) => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  const unsigned = b64url(header) + '.' + b64url(claimSet);
  const signatureBytes = Utilities.computeRsaSha256Signature(unsigned, privateKey);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  const jwt = unsigned + '.' + signature;

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  const data = JSON.parse(response.getContentText());
  if (!data.access_token) {
    throw new Error('FCM OAuth fehlgeschlagen: ' + response.getContentText());
  }

  cache.put('FCM_ACCESS_TOKEN', data.access_token, 3000); // ~50 Minuten
  return data.access_token;
}

function sendPush_(title, body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('FCM_TOKEN');
  const projectId = props.getProperty('FCM_PROJECT_ID');
  if (!token || !projectId) return; // Noch kein Gerät registriert

  const accessToken = getFcmAccessToken_();
  const message = {
    message: {
      token: token,
      // Nur "data" (kein "notification") — so entscheidet immer der
      // Service Worker (onBackgroundMessage) über die Darstellung,
      // statt dass der Browser sie automatisch selbst anzeigt.
      data: { title: title, body: body }
    }
  };

  UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(message),
    muteHttpExceptions: true
  });
}

// =============================================================
// Erinnerungs-Prüfung — läuft alle 5 Minuten (siehe installTrigger)
// Funktioniert unabhängig davon, ob das Handy gesperrt oder die
// App geschlossen ist, da Apps Script serverseitig ausführt.
// =============================================================
function checkAndNotify() {
  if (!ERINNERUNGEN_AM_WOCHENENDE) {
    const tag = new Date().getDay();
    if (tag === 0 || tag === 6) return;
  }

  const props = PropertiesService.getScriptProperties();
  const heuteStr = new Date().toDateString();

  // Neuer Tag? Dann alle "schon gesendet"-Merker zurücksetzen.
  if (props.getProperty('REMINDER_TAG') !== heuteStr) {
    clearReminderFlags_();
    props.setProperty('REMINDER_TAG', heuteStr);
  }

  const status = getHeutigenStatus(heuteStr);
  const jetzt = new Date();
  const aktuelleUhrzeitNummer = jetzt.getHours() * 100 + jetzt.getMinutes();

  // --- Morgen-Erinnerung ---
  if (ERINNERUNG_MORGENS_AKTIV && status.status === 'BEREIT') {
    const morgenZeitNummer = ERINNERUNG_MORGENS_STUNDE * 100 + ERINNERUNG_MORGENS_MINUTE;
    if (aktuelleUhrzeitNummer >= morgenZeitNummer && !props.getProperty('SENT_MORGEN')) {
      sendPush_('Stempeln nicht vergessen!', 'Du hast heute noch nicht eingestempelt.');
      props.setProperty('SENT_MORGEN', '1');
    }
  }

  // --- Mittag-Erinnerung ---
  if (ERINNERUNG_MITTAG_VERGESSEN_AKTIV && status.status === 'ARBEIT' && status.realePauseMs === 0) {
    const mittagZeitNummer = ERINNERUNG_MITTAG_VERGESSEN_STUNDE * 100 + ERINNERUNG_MITTAG_VERGESSEN_MINUTE;
    if (aktuelleUhrzeitNummer >= mittagZeitNummer && !props.getProperty('SENT_MITTAG')) {
      sendPush_('Mittagspause vergessen?', 'Hast du vergessen, die Pause einzutragen?');
      props.setProperty('SENT_MITTAG', '1');
    }
  }

  // --- Pause-Ende-Erinnerung ---
  if (ERINNERUNG_PAUSE_ENDE_AKTIV && status.status === 'PAUSE') {
    const pauseEndeZeitNummer = ERINNERUNG_PAUSE_ENDE_STUNDE * 100 + ERINNERUNG_PAUSE_ENDE_MINUTE;
    if (aktuelleUhrzeitNummer >= pauseEndeZeitNummer && !props.getProperty('SENT_PAUSE_ENDE')) {
      sendPush_('Pause beenden?', 'Du bist laut App immer noch in der Pause.');
      props.setProperty('SENT_PAUSE_ENDE', '1');
    }
  }

  // --- Feierabend-Erinnerung ---
  if (ERINNERUNG_FEIERABEND_AKTIV && (status.status === 'ARBEIT' || status.status === 'PAUSE') && status.kommenZeit) {
    const sollMs = (SOLL_STUNDEN * 60 + SOLL_MINUTEN) * 60 * 1000;
    let pauseMs = status.realePauseMs;
    if (status.status === 'PAUSE' && status.uiPauseStartZeit) {
      pauseMs += (Date.now() - status.uiPauseStartZeit);
    }
    const feierabendMs = status.kommenZeit + sollMs + pauseMs;

    if (Date.now() >= feierabendMs) {
      const lastStr = props.getProperty('LAST_FEIERABEND_ERINNERUNG');
      const intervalMs = ERINNERUNG_FEIERABEND_INTERVAL_MINUTEN * 60 * 1000;

      if (!lastStr) {
        sendPush_('FEIERABEND!', 'Du hast deine Sollarbeitszeit erreicht. Vergiss das Ausstempeln nicht!');
        props.setProperty('LAST_FEIERABEND_ERINNERUNG', Date.now().toString());
      } else if (Date.now() - parseInt(lastStr, 10) >= intervalMs) {
        const ueberstundenMinuten = Math.floor((Date.now() - feierabendMs) / 60000);
        sendPush_('Immer noch eingestempelt!', 'Du bist seit ' + ueberstundenMinuten + ' Minuten im Feierabend. Bitte ausstempeln!');
        props.setProperty('LAST_FEIERABEND_ERINNERUNG', Date.now().toString());
      }
    }
  }
}

function clearReminderFlags_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SENT_MORGEN');
  props.deleteProperty('SENT_MITTAG');
  props.deleteProperty('SENT_PAUSE_ENDE');
  props.deleteProperty('LAST_FEIERABEND_ERINNERUNG');
}

// =============================================================
// Einmalig ausführen (Run-Menü), um den 5-Minuten-Trigger zu
// installieren bzw. neu zu installieren.
// =============================================================
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkAndNotify') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkAndNotify').timeBased().everyMinutes(5).create();
}
