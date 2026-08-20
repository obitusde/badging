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

// ----- Pause-Grenzen (auch im Frontend gesetzt) -----
const PAUSE_MIN_MINUTEN = 30;
const PAUSE_MAX_MINUTEN = 120;

// ----- Erinnerungen -----
// Jede Erinnerung ist ein Zeitfenster "von–bis". Innerhalb des Fensters
// wird alle ERINNERUNG_WIEDERHOLUNG_MINUTEN erinnert, aber nur solange
// die jeweilige Aktion noch aussteht (z. B. noch nicht eingestempelt).

// Erinnerungen am Wochenende? (Samstag + Sonntag)
const ERINNERUNGEN_AM_WOCHENENDE = false;

// Wiederholungsabstand innerhalb eines Fensters
const ERINNERUNG_WIEDERHOLUNG_MINUTEN = 30;

// 1. Einstempeln — wenn morgens noch nicht gestempelt wurde
const ERINNERUNG_KOMMEN_AKTIV = true;
const ERINNERUNG_KOMMEN_VON = "09:00";
const ERINNERUNG_KOMMEN_BIS = "11:00";

// 2. Mittagspause — Pause starten (wenn noch keine) bzw. beenden
const ERINNERUNG_PAUSE_AKTIV = true;
const ERINNERUNG_PAUSE_VON = "11:30";
const ERINNERUNG_PAUSE_BIS = "13:30";

// 3. Ausstempeln — wenn nachmittags noch eingestempelt
const ERINNERUNG_GEHEN_AKTIV = true;
const ERINNERUNG_GEHEN_VON = "16:00";
const ERINNERUNG_GEHEN_BIS = "22:00";

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
    else if (action === 'setZeit') {
      result = setZeit(e.parameter.feld, e.parameter.wert, clientDate);
    }
    else if (action === 'reset') {
      result = komplettReset();
    }
    else if (action === 'registerToken') {
      result = registerToken(e.parameter.token);
    }
    else if (action === 'debugPush') {
      // Temporär zum Debuggen — danach wieder entfernen.
      result = sendPush_('Debug', 'Testnachricht von debugPush');
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

// =============================================================
// Manuelle Zeiteingabe — Kommen / Gehen / Pause direkt setzen
// (die Stempel-Buttons funktionieren unverändert weiter)
// =============================================================
function setZeit(feld, wert, clientHeuteStr) {
  const props = getStorage();
  const heuteStr = clientHeuteStr || new Date().toDateString();
  props.setProperty('LETZTER_TAG', heuteStr);

  if (feld === 'kommen') {
    const ms = zeitZuMs_(wert, heuteStr);
    if (ms === null) return { error: 'Ungültige Uhrzeit.' };
    props.setProperty('KOMMEN_ZEIT', ms.toString());
    // Wer eine Kommen-Zeit einträgt, hat den Tag begonnen.
    if ((props.getProperty('STATUS') || 'BEREIT') === 'BEREIT') {
      props.setProperty('STATUS', 'ARBEIT');
      if (!props.getProperty('REALE_PAUSE_MS')) props.setProperty('REALE_PAUSE_MS', '0');
    }
    clearReminderFlags_();
  }
  else if (feld === 'gehen') {
    const ms = zeitZuMs_(wert, heuteStr);
    if (ms === null) return { error: 'Ungültige Uhrzeit.' };
    // Eine noch laufende Pause vorher sauber abschließen
    if (props.getProperty('STATUS') === 'PAUSE') {
      const startPauseStr = props.getProperty('UI_PAUSE_START');
      if (startPauseStr) {
        const bisherigePauseMs = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
        props.setProperty('REALE_PAUSE_MS', (bisherigePauseMs + (Date.now() - parseInt(startPauseStr, 10))).toString());
      }
      props.deleteProperty('UI_PAUSE_START');
    }
    props.setProperty('GEHEN_ZEIT', ms.toString());
    props.setProperty('STATUS', 'BEENDET');
  }
  else if (feld === 'pause') {
    let minuten = parseInt(wert, 10);
    if (isNaN(minuten)) return { error: 'Ungültige Pausendauer.' };
    minuten = Math.min(PAUSE_MAX_MINUTEN, Math.max(PAUSE_MIN_MINUTEN, minuten));
    props.setProperty('GEPLANTE_PAUSE', minuten.toString());

    const status = props.getProperty('STATUS') || 'BEREIT';
    const realeBisher = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
    // Ist die Pause schon real gelaufen (oder läuft gerade), zählt der
    // eingetragene Wert ab jetzt als tatsächliche Pausendauer.
    if (realeBisher > 0 || status === 'PAUSE') {
      props.setProperty('REALE_PAUSE_MS', (minuten * 60000).toString());
      if (status === 'PAUSE') props.setProperty('UI_PAUSE_START', Date.now().toString());
    }
  }
  else {
    return { error: 'Unbekanntes Feld: ' + feld };
  }

  return getHeutigenStatus(heuteStr);
}

// "HH:MM" am gegebenen Tag → Millisekunden-Timestamp
function zeitZuMs_(hhmm, heuteStr) {
  if (!hhmm || hhmm.indexOf(':') === -1) return null;
  const teile = hhmm.split(':');
  const h = parseInt(teile[0], 10);
  const m = parseInt(teile[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  // heuteStr kommt als toDateString() vom Client. Lässt es sich nicht
  // parsen, lieber auf heute zurückfallen als die Eingabe abzulehnen.
  let d = new Date(heuteStr);
  if (isNaN(d.getTime())) d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
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
  if (!token || !projectId) {
    return { skipped: true, reason: 'FCM_TOKEN oder FCM_PROJECT_ID fehlt.' };
  }

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

  const response = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(message),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) {
    throw new Error('FCM-Versand fehlgeschlagen (' + code + '): ' + text);
  }
  return { ok: true, fcmResponse: text };
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
  const jetztMinuten = jetzt.getHours() * 60 + jetzt.getMinutes();

  // --- 1. Einstempeln vergessen? ---
  if (ERINNERUNG_KOMMEN_AKTIV
      && status.status === 'BEREIT'
      && imFenster_(jetztMinuten, ERINNERUNG_KOMMEN_VON, ERINNERUNG_KOMMEN_BIS)
      && darfSenden_(props, 'KOMMEN')) {
    sendPush_('Einstempeln nicht vergessen!', 'Du hast heute noch nicht eingestempelt.');
    merkeGesendet_(props, 'KOMMEN');
  }

  // --- 2a. Mittagspause noch nicht gestartet ---
  if (ERINNERUNG_PAUSE_AKTIV
      && status.status === 'ARBEIT'
      && status.realePauseMs === 0
      && imFenster_(jetztMinuten, ERINNERUNG_PAUSE_VON, ERINNERUNG_PAUSE_BIS)
      && darfSenden_(props, 'PAUSE_START')) {
    sendPush_('Mittagspause nicht vergessen!', 'Noch keine Pause eingetragen. ' + restzeitText_(status));
    merkeGesendet_(props, 'PAUSE_START');
  }

  // --- 2b. Pause läuft noch ---
  if (ERINNERUNG_PAUSE_AKTIV
      && status.status === 'PAUSE'
      && imFenster_(jetztMinuten, ERINNERUNG_PAUSE_VON, ERINNERUNG_PAUSE_BIS)
      && darfSenden_(props, 'PAUSE_ENDE')) {
    const pauseMinuten = Math.floor(aktuellePauseMs_(status) / 60000);
    sendPush_('Pause beenden?', 'Du bist seit ' + pauseMinuten + ' Minuten in der Pause. ' + restzeitText_(status));
    merkeGesendet_(props, 'PAUSE_ENDE');
  }

  // --- 3. Ausstempeln vergessen? ---
  if (ERINNERUNG_GEHEN_AKTIV
      && (status.status === 'ARBEIT' || status.status === 'PAUSE')
      && imFenster_(jetztMinuten, ERINNERUNG_GEHEN_VON, ERINNERUNG_GEHEN_BIS)
      && darfSenden_(props, 'GEHEN')) {
    sendPush_('Ausstempeln nicht vergessen!', restzeitText_(status));
    merkeGesendet_(props, 'GEHEN');
  }
}

// --- Hilfsfunktionen für die Erinnerungs-Fenster ---

function minutenAusZeit_(hhmm) {
  const teile = hhmm.split(':');
  return parseInt(teile[0], 10) * 60 + parseInt(teile[1], 10);
}

function imFenster_(jetztMinuten, von, bis) {
  return jetztMinuten >= minutenAusZeit_(von) && jetztMinuten < minutenAusZeit_(bis);
}

function darfSenden_(props, key) {
  const zuletzt = props.getProperty('LAST_SENT_' + key);
  if (!zuletzt) return true;
  return (Date.now() - parseInt(zuletzt, 10)) >= ERINNERUNG_WIEDERHOLUNG_MINUTEN * 60000;
}

function merkeGesendet_(props, key) {
  props.setProperty('LAST_SENT_' + key, Date.now().toString());
}

// Tatsächlich angefallene Pause inkl. einer gerade laufenden Pause
function aktuellePauseMs_(status) {
  let p = status.realePauseMs || 0;
  if (status.status === 'PAUSE' && status.uiPauseStartZeit) {
    p += (Date.now() - status.uiPauseStartZeit);
  }
  return p;
}

// "Noch 2 Std 15 Min bis Feierabend." bzw. Überstunden-Variante
function restzeitText_(status) {
  if (!status.kommenZeit) return '';
  const sollMs = (SOLL_STUNDEN * 60 + SOLL_MINUTEN) * 60 * 1000;
  let pauseMs = aktuellePauseMs_(status);
  if (pauseMs === 0) pauseMs = (status.geplantePauseMinuten || 0) * 60000;
  const restMs = (status.kommenZeit + sollMs + pauseMs) - Date.now();
  if (restMs > 0) {
    return 'Noch ' + formatDauerKurz_(restMs) + ' bis Feierabend.';
  }
  return 'Du hast bereits ' + formatDauerKurz_(-restMs) + ' Überstunden.';
}

function formatDauerKurz_(ms) {
  const gesamtMinuten = Math.floor(Math.abs(ms) / 60000);
  const stunden = Math.floor(gesamtMinuten / 60);
  const minuten = gesamtMinuten % 60;
  return stunden > 0 ? (stunden + ' Std ' + minuten + ' Min') : (minuten + ' Min');
}

function clearReminderFlags_() {
  const props = PropertiesService.getScriptProperties();
  ['KOMMEN', 'PAUSE_START', 'PAUSE_ENDE', 'GEHEN'].forEach(function (key) {
    props.deleteProperty('LAST_SENT_' + key);
  });
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
