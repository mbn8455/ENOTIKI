# Sincronizzazione cross-device (Firebase + cifratura client-side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far sincronizzare in tempo reale, tra tutti i device di Marco ed Eugenia, l'intero stato dell'app ENOTIKI (oggi isolato per browser in `localStorage`), protetto da una password di famiglia cifrata lato client.

**Architecture:** Un nuovo modulo ES `publish/sync.js` incapsula Firebase Realtime Database (backend gratuito, sync realtime via WebSocket) e la cifratura AES-GCM/PBKDF2 via Web Crypto nativo. `publish/index.html` viene esteso — non riscritto — per: mostrare un gate "Password di famiglia" a schermo intero finché non sbloccato, applicare gli aggiornamenti remoti allo stato del componente, e propagare ogni modifica locale (già oggi centralizzata in `persist()`) anche verso Firebase.

**Tech Stack:** Firebase JS SDK modulare v12.17.1 via CDN gstatic (`<script type="module">`, nessun bundler), Web Crypto API nativa del browser (PBKDF2 + AES-GCM), Firebase Realtime Database (piano gratuito Spark), Firebase Authentication (provider Anonymous).

## Global Constraints

- Nessun build step/bundler: tutti gli script restano `<script>` inclusi direttamente, coerente con `support.js`/`image-slot.js`/`_ds_bundle.js` già presenti.
- SDK Firebase: versione modulare pinnata `12.17.1`, import da `https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js` (e `firebase-auth.js`, `firebase-database.js` alla stessa versione).
- Cifratura: AES-GCM 256 bit, chiave derivata con PBKDF2-SHA256, 150000 iterazioni. IV casuale a 12 byte per ogni scrittura. Nessuna libreria esterna oltre Web Crypto nativo.
- Chiave `localStorage` per la password salvata sul device: `enotiki-sync-pass-v1` (separata da `vita-dash-v1`, che resta invariata).
- Path Firebase per il blob di stato: `state` (root del Realtime Database).
- Debounce delle scritture verso Firebase: 800ms dopo l'ultima modifica locale.
- Strategia sui conflitti: last-write-wins sull'intero blob, confronto tramite `updatedAt` (epoch ms).
- Gli script `type="module"` non funzionano aperti come file locale (`file://`) per via delle restrizioni CORS sui moduli ES: ogni verifica manuale in questo piano richiede di servire `publish/` via HTTP locale (`python -m http.server 8765 --directory publish`, eseguito dalla root del repo), non aprendo `index.html` con doppio click.
- Il gate "Password di famiglia" riusa le classi CSS esistenti del design system (`dialog`, `dialog-title`, `field`, `input`, `btn`, `btn-primary`, `text-muted`) — nessun nuovo stile globale.
- Push su `main` (GitHub Pages) è un'azione pubblicamente visibile: richiede conferma esplicita dell'utente prima di essere eseguita (stesso principio già seguito per il flusso Excel, vedi `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md`).

---

## Task 1: Setup del progetto Firebase (azione manuale dell'utente)

**Files:** nessuno — solo configurazione esterna su console.firebase.google.com. Nessun commit in questo task.

**Interfaces:**
- Produces: un blocco `firebaseConfig` (oggetto JS con `apiKey`, `authDomain`, `databaseURL`, `projectId`, ecc.) che il Task 2 incollerà in `publish/sync.js`.

- [ ] **Step 1: Crea il progetto Firebase**

Vai su https://console.firebase.google.com, crea un nuovo progetto (es. nome `enotiki-dashboard`). Google Analytics non serve, puoi disattivarlo.

- [ ] **Step 2: Abilita l'autenticazione anonima**

Nel progetto: `Build → Authentication → Get started → Sign-in method → Anonymous → Enable`.

- [ ] **Step 3: Crea la Realtime Database**

`Build → Realtime Database → Create Database`. Scegli una location (es. Europe). Parti in modalità "locked" (nessun accesso pubblico di default), poi imposta le regole allo Step 4.

- [ ] **Step 4: Imposta le security rules**

Nella tab "Rules" della Realtime Database, incolla e pubblica:

```json
{
  "rules": {
    "state": {
      ".read": "auth != null",
      ".write": "auth != null"
    }
  }
}
```

- [ ] **Step 5: Registra una Web App e recupera la config**

`Project settings (icona ingranaggio) → General → Your apps → Add app → Web (</>)`. Dai un nome (es. `enotiki-web`), non serve Firebase Hosting. Copia l'oggetto `firebaseConfig` mostrato (contiene `apiKey`, `authDomain`, `databaseURL`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).

- [ ] **Step 6: Consegna la configurazione**

Incolla l'intero blocco `firebaseConfig` nella chat con Claude. Questi valori sono identificatori pubblici del progetto (non segreti — la protezione reale è la cifratura del Task 3), quindi possono comparire nel codice sorgente pubblico del sito.

Non procedere al Task 2 finché questo blocco non è stato fornito.

---

## Task 2: Modulo di cifratura + bootstrap Firebase in `sync.js`

**Files:**
- Create: `publish/sync.js`
- Modify: `publish/index.html:11` (aggiunta script tag nel `<helmet>`)

**Interfaces:**
- Consumes: il blocco `firebaseConfig` ottenuto al Task 1.
- Produces: `window.SyncManager` con `init(onRemoteState, onError)` (avvia l'app Firebase + login anonimo, ritorna una Promise) e `hasStoredPassword()` (bool). Evento globale `enotiki-sync-ready` disparato quando il modulo ha finito di caricarsi e `window.SyncManager` è pronto all'uso. Funzioni interne `deriveKey`, `encryptPayload`, `decryptPayload` (non esportate — usate internamente, il Task 3 le richiamerà da dentro lo stesso file).

- [ ] **Step 1: Crea `publish/sync.js`**

```javascript
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  databaseURL: "REPLACE_ME",
  projectId: "REPLACE_ME"
};

const SYNC_STORAGE_KEY = "enotiki-sync-pass-v1";
const STATE_PATH = "state";
const PBKDF2_ITERATIONS = 150000;

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(key, saltBytes, stateObj, updatedAt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(stateObj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(saltBytes),
    updatedAt
  };
}

async function decryptPayload(key, remote) {
  const iv = base64ToBytes(remote.iv);
  const cipherBytes = base64ToBytes(remote.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

const SyncManager = {
  _app: null,
  _auth: null,
  _db: null,
  _authReady: null,
  _key: null,
  _salt: null,
  _lastAppliedAt: 0,
  _pushTimer: null,
  _onRemoteState: null,
  _onError: null,

  init(onRemoteState, onError) {
    this._onRemoteState = onRemoteState;
    this._onError = onError;
    this._app = initializeApp(FIREBASE_CONFIG);
    this._auth = getAuth(this._app);
    this._db = getDatabase(this._app);
    this._authReady = signInAnonymously(this._auth).catch((e) => {
      if (this._onError) this._onError("auth: " + e.message);
    });
    return this._authReady;
  },

  hasStoredPassword() {
    return !!localStorage.getItem(SYNC_STORAGE_KEY);
  }
};

window.SyncManager = SyncManager;
window.dispatchEvent(new Event("enotiki-sync-ready"));
```

- [ ] **Step 2: Sostituisci i placeholder `REPLACE_ME` con i valori reali**

Usa `apiKey`, `authDomain`, `databaseURL`, `projectId` dal blocco `firebaseConfig` fornito al Task 1.

- [ ] **Step 3: Aggiungi lo script tag nel `<helmet>` di `index.html`**

In `publish/index.html`, riga 11, il contenuto attuale è:

```html
<script src="./image-slot.js"></script>
```

Aggiungi subito dopo:

```html
<script src="./image-slot.js"></script>
<script type="module" src="./sync.js"></script>
```

- [ ] **Step 4: Avvia un server locale e apri la pagina**

Dalla root del repo:

```bash
python -m http.server 8765 --directory publish
```

Apri `http://localhost:8765/index.html` nel browser (Browser pane). Apri la console: non devono comparire errori 404 sugli import di `sync.js` né errori di CORS sui moduli.

- [ ] **Step 5: Verifica login anonimo e round-trip di cifratura dalla console del browser**

Nella console DevTools della pagina caricata, esegui:

```javascript
await window.SyncManager.init(() => {}, (msg) => console.error("sync error:", msg));
console.log("auth ok, uid:", window.SyncManager._auth.currentUser && window.SyncManager._auth.currentUser.uid);
```

Atteso: nessun errore stampato, `uid` è una stringa non vuota (login anonimo riuscito — conferma che `FIREBASE_CONFIG` è corretta e le regole Auth sono attive).

Poi, sempre in console, verifica il round-trip di cifratura importando temporaneamente il modulo:

```javascript
const mod = await import("./sync.js");
```

Se l'import non espone le funzioni interne (sono private al modulo, per design — vedi Interfaces sopra), verifica indirettamente più avanti nel Task 3 tramite `unlockWithPassword`. Conferma qui solo che il modulo si carica senza errori e che `window.SyncManager.hasStoredPassword()` ritorna `false` su un browser pulito (nessuna chiave `enotiki-sync-pass-v1` in `localStorage`).

- [ ] **Step 6: Commit**

```bash
git add publish/sync.js publish/index.html
git commit -m "Add Firebase bootstrap and client-side encryption module"
```

---

## Task 3: Logica di sincronizzazione realtime in `SyncManager`

**Files:**
- Modify: `publish/sync.js` (aggiunge metodi all'oggetto `SyncManager` già creato nel Task 2)

**Interfaces:**
- Consumes: `deriveKey`, `encryptPayload`, `decryptPayload` (definite nel Task 2, stesso file), `ref`/`onValue`/`set`/`get` da `firebase-database.js` (già importati nel Task 2).
- Produces: `SyncManager.autoUnlock(currentLocalState)` → `Promise<{ok: boolean, noPassword?: boolean, firstSetup?: boolean, state?: object}>`; `SyncManager.unlockWithPassword(password, currentLocalState)` → stessa forma di ritorno; `SyncManager.schedulePush(state)` → `void`, effetto collaterale: scrittura debounced su Firebase.

- [ ] **Step 1: Aggiungi i metodi a `SyncManager` in `publish/sync.js`**

Nell'oggetto `SyncManager` creato nel Task 2, subito dopo il metodo `hasStoredPassword() { ... }` (e prima della `}` di chiusura dell'oggetto), aggiungi una virgola dopo la chiusura di `hasStoredPassword` e inserisci:

```javascript
  autoUnlock(currentLocalState) {
    const stored = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!stored) return Promise.resolve({ ok: false, noPassword: true });
    return this.unlockWithPassword(stored, currentLocalState);
  },

  async unlockWithPassword(password, currentLocalState) {
    if (this._authReady) await this._authReady;
    const snap = await get(ref(this._db, STATE_PATH));
    const remote = snap.val();
    if (!remote) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      this._salt = salt;
      this._key = key;
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      await this._writeRemote(currentLocalState);
      this._subscribe();
      return { ok: true, firstSetup: true };
    }
    const salt = base64ToBytes(remote.salt);
    const key = await deriveKey(password, salt);
    try {
      const state = await decryptPayload(key, remote);
      this._salt = salt;
      this._key = key;
      this._lastAppliedAt = remote.updatedAt || 0;
      localStorage.setItem(SYNC_STORAGE_KEY, password);
      this._subscribe();
      return { ok: true, firstSetup: false, state };
    } catch (e) {
      return { ok: false };
    }
  },

  _subscribe() {
    onValue(ref(this._db, STATE_PATH), async (snap) => {
      const remote = snap.val();
      if (!remote || !this._key) return;
      if (remote.updatedAt && remote.updatedAt <= this._lastAppliedAt) return;
      try {
        const state = await decryptPayload(this._key, remote);
        this._lastAppliedAt = remote.updatedAt;
        if (this._onRemoteState) this._onRemoteState(state);
      } catch (e) {
        if (this._onError) this._onError("decrypt: " + e.message);
      }
    });
  },

  schedulePush(state) {
    if (!this._key) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._writeRemote(state), 800);
  },

  async _writeRemote(state) {
    const updatedAt = Date.now();
    const payload = await encryptPayload(this._key, this._salt, state, updatedAt);
    this._lastAppliedAt = updatedAt;
    await set(ref(this._db, STATE_PATH), payload);
  }
```

- [ ] **Step 2: Verifica first-setup e password corretta (una sola scheda browser)**

Con il server locale del Task 2 ancora attivo, apri `http://localhost:8765/index.html`, poi in console:

```javascript
await window.SyncManager.init(() => {}, (msg) => console.error("sync error:", msg));
const r1 = await window.SyncManager.unlockWithPassword("prova123", { film: [], appunti: [], events: [], habits: [], investimenti: [], movimenti: [], parametri: [], farmaci: [], libri: [], portfolioHistory: [], depositi: [], nextId: 1 });
console.log(r1);
```

Atteso: `{ ok: true, firstSetup: true }`. Controlla nella console Firebase (Realtime Database → tab Data) che sotto `state` sia comparso un nodo con `ciphertext`, `iv`, `salt`, `updatedAt`.

- [ ] **Step 3: Verifica password sbagliata su un secondo "device"**

Apri una **finestra in incognito** (o un secondo profilo browser) sullo stesso `http://localhost:8765/index.html`. In console:

```javascript
await window.SyncManager.init(() => {}, (msg) => console.error("sync error:", msg));
const r2 = await window.SyncManager.unlockWithPassword("password-sbagliata", {});
console.log(r2);
```

Atteso: `{ ok: false }` (la decifratura fallisce per via del tag di autenticazione AES-GCM). Poi, nella stessa finestra incognito:

```javascript
const r3 = await window.SyncManager.unlockWithPassword("prova123", {});
console.log(r3);
```

Atteso: `{ ok: true, firstSetup: false, state: { film: [], appunti: [], ... } }` — lo stato scritto dal primo "device" allo Step 2.

- [ ] **Step 4: Verifica propagazione realtime tra le due finestre**

Con entrambe le finestre ancora sbloccate (Step 2 e Step 3), nella prima finestra esegui:

```javascript
await window.SyncManager._writeRemote({ film: [{ id: 999, titolo: "Test sync" }], appunti: [], events: [], habits: [], investimenti: [], movimenti: [], parametri: [], farmaci: [], libri: [], portfolioHistory: [], depositi: [], nextId: 2 });
```

Nella seconda finestra, registra prima un listener (se `_onRemoteState` non è ancora collegato a nulla di visibile, verifica leggendo `window.SyncManager._lastAppliedAt` prima e dopo, oppure ripassa `onRemoteState` reale in `init`):

```javascript
await window.SyncManager.init((state) => console.log("REMOTE UPDATE:", state), (msg) => console.error(msg));
await window.SyncManager.unlockWithPassword("prova123", {});
```

Atteso: entro un paio di secondi dalla scrittura nella prima finestra, la seconda stampa `REMOTE UPDATE:` con `film` contenente `Test sync` — conferma che il listener realtime funziona end-to-end.

- [ ] **Step 5: Pulisci i dati di test**

Nella console Firebase (Realtime Database → tab Data), elimina manualmente il nodo `state` creato durante i test, così il Task 4 riparte da un database vuoto (comportamento "primo setup" reale).

- [ ] **Step 6: Commit**

```bash
git add publish/sync.js
git commit -m "Add realtime unlock/subscribe/push logic to SyncManager"
```

---

## Task 4: Integrazione in `index.html` — gate password e wiring dello stato

**Files:**
- Modify: `publish/index.html:1073-1098` (nuovi campi di stato)
- Modify: `publish/index.html:1102-1130` (bootstrap sync in `componentDidMount`)
- Modify: `publish/index.html:1204-1206` (refactor `persist()`)
- Modify: `publish/index.html:20-21` (overlay del gate nel template)
- Modify: `publish/index.html:1827-1828` (nuovi binding in `renderVals()`)

**Interfaces:**
- Consumes: `window.SyncManager.init`, `.hasStoredPassword`, `.autoUnlock`, `.unlockWithPassword`, `.schedulePush` (dal Task 3); evento `enotiki-sync-ready` (dal Task 2).
- Produces: metodo di componente `getSyncableState()` (ritorna l'oggetto sincronizzabile), `applyRemoteState(remote)`, `submitSyncPassword()` — usati solo internamente al componente, nessun consumatore in task successivi.

- [ ] **Step 1: Aggiungi i nuovi campi di stato**

In `publish/index.html`, l'ultima riga dell'oggetto `state` (riga 1097) è oggi:

```javascript
    newLibroTitolo: "", newLibroCategoria: "Trading & Investimenti", newLibroStato: "Da leggere", newLibroPresentazione: "", newLibroRiassunto: ""
  };
```

Sostituiscila con:

```javascript
    newLibroTitolo: "", newLibroCategoria: "Trading & Investimenti", newLibroStato: "Da leggere", newLibroPresentazione: "", newLibroRiassunto: "",
    syncUnlocked: false, syncPasswordInput: "", syncError: "", syncBusy: false
  };
```

- [ ] **Step 2: Aggiungi l'overlay del gate nel template**

In `publish/index.html`, righe 20-21 sono oggi:

```html
<div style="min-height: 100vh; background: var(--color-bg); color: var(--color-text); font-family: var(--font-body); display: flex; flex-direction: column;">
  <nav style="{{ navWrapperStyle }}">
```

Inserisci l'overlay subito dopo l'apertura del div e prima di `<nav>`:

```html
<div style="min-height: 100vh; background: var(--color-bg); color: var(--color-text); font-family: var(--font-body); display: flex; flex-direction: column;">
  <sc-if value="{{ !syncUnlocked }}" hint-placeholder-val="{{ true }}">
    <div style="position:fixed;inset:0;z-index:9999;background:var(--color-bg);display:flex;align-items:center;justify-content:center;padding:24px;">
      <div class="dialog" style="max-width:360px;width:100%;">
        <div class="dialog-title">Password di famiglia</div>
        <p class="text-muted" style="margin:0 0 16px;font-size:14px;">Inserisci la password condivisa per sincronizzare i dati tra i device.</p>
        <div class="field">
          <label>Password</label>
          <input class="input" type="password" value="{{ syncPasswordInput }}" onChange="{{ onSyncPasswordChange }}" placeholder="Password">
        </div>
        <sc-if value="{{ syncError }}" hint-placeholder-val="{{ false }}">
          <p style="color:#c0392b;font-size:13px;margin:0 0 12px;">{{ syncError }}</p>
        </sc-if>
        <div class="dialog-actions">
          <button class="btn btn-primary" disabled="{{ syncSubmitDisabled }}" onClick="{{ submitSyncPassword }}">Entra</button>
        </div>
      </div>
    </div>
  </sc-if>
  <nav style="{{ navWrapperStyle }}">
```

- [ ] **Step 3: Refactor di `persist()` in `getSyncableState()` + `persistLocal()` + `persist()` + `applyRemoteState()`**

In `publish/index.html`, la riga 1205 è oggi:

```javascript
  persist = () => {
    try { localStorage.setItem("vita-dash-v1", JSON.stringify({ film: this.state.film, appunti: this.state.appunti, events: this.state.events, habits: this.state.habits, investimenti: this.state.investimenti, movimenti: this.state.movimenti, parametri: this.state.parametri, farmaci: this.state.farmaci, libri: this.state.libri, portfolioHistory: this.state.portfolioHistory, depositi: this.state.depositi, nextId: this.nextId })); } catch (e) {}
  };
```

Sostituiscila con:

```javascript
  getSyncableState = () => ({
    film: this.state.film, appunti: this.state.appunti, events: this.state.events, habits: this.state.habits,
    investimenti: this.state.investimenti, movimenti: this.state.movimenti, parametri: this.state.parametri,
    farmaci: this.state.farmaci, libri: this.state.libri, portfolioHistory: this.state.portfolioHistory,
    depositi: this.state.depositi, nextId: this.nextId
  });
  persistLocal = () => {
    try { localStorage.setItem("vita-dash-v1", JSON.stringify(this.getSyncableState())); } catch (e) {}
  };
  persist = () => {
    this.persistLocal();
    if (window.SyncManager) window.SyncManager.schedulePush(this.getSyncableState());
  };
  applyRemoteState = (remote) => {
    if (remote.nextId) this.nextId = remote.nextId;
    this.setState({ ...remote }, this.persistLocal);
  };
```

- [ ] **Step 4: Aggiungi il bootstrap della sync in `componentDidMount`**

In `publish/index.html`, individua la fine del blocco try/catch di hydrate da `localStorage` (righe 1102-1130), che termina con:

```javascript
    } catch (e) {}
    fetch("libri.json").then((r) => r.json()).then((data) => {
```

Inserisci, subito dopo `} catch (e) {}` e prima del `fetch("libri.json")`:

```javascript
    } catch (e) {}
    const startSync = () => {
      window.SyncManager.init(
        (remote) => this.applyRemoteState(remote),
        (msg) => console.error("[sync]", msg)
      );
      window.SyncManager.autoUnlock(this.getSyncableState()).then((res) => {
        if (res && res.ok) {
          this.setState({ syncUnlocked: true });
          if (res.state) this.applyRemoteState(res.state);
        }
      });
    };
    if (window.SyncManager) startSync(); else window.addEventListener("enotiki-sync-ready", startSync, { once: true });
    fetch("libri.json").then((r) => r.json()).then((data) => {
```

- [ ] **Step 5: Aggiungi il metodo `submitSyncPassword`**

Subito dopo la chiusura del blocco `componentWillUnmount() { window.removeEventListener("resize", this.handleResize); }` (riga 1202), aggiungi:

```javascript
  submitSyncPassword = () => {
    const password = this.state.syncPasswordInput.trim();
    if (!password) return;
    this.setState({ syncBusy: true, syncError: "" });
    window.SyncManager.unlockWithPassword(password, this.getSyncableState()).then((res) => {
      if (res && res.ok) {
        this.setState({ syncUnlocked: true, syncBusy: false, syncPasswordInput: "", syncError: "" });
        if (res.state) this.applyRemoteState(res.state);
      } else {
        this.setState({ syncBusy: false, syncError: "Password errata. Riprova." });
      }
    });
  };
```

- [ ] **Step 6: Aggiungi i nuovi binding in `renderVals()`**

In `publish/index.html`, la fine dell'oggetto ritornato da `renderVals()` (righe 1827-1828) è oggi:

```javascript
      categoriaOptions
    };
```

Sostituiscila con:

```javascript
      categoriaOptions,
      syncUnlocked: this.state.syncUnlocked,
      syncPasswordInput: this.state.syncPasswordInput,
      onSyncPasswordChange: (e) => this.setState({ syncPasswordInput: e.target.value }),
      syncError: this.state.syncError,
      submitSyncPassword: this.submitSyncPassword,
      syncSubmitDisabled: this.state.syncBusy || !this.state.syncPasswordInput.trim()
    };
```

- [ ] **Step 7: Verifica end-to-end su due finestre browser**

Assicurati che il database Firebase sia vuoto (pulito al Task 3 Step 5). Riavvia il server locale se necessario (`python -m http.server 8765 --directory publish`).

Finestra A (normale): apri `http://localhost:8765/index.html`. Deve comparire il gate "Password di famiglia". Inserisci `famiglia123` e premi "Entra". Il gate deve sparire (primo setup: lo stato locale corrente di questa finestra viene pubblicato su Firebase).

Finestra B (incognito): apri lo stesso URL. Deve comparire il gate. Inserisci una password sbagliata: deve comparire l'errore "Password errata. Riprova." e il gate deve restare aperto. Inserisci `famiglia123`: il gate deve sparire e i dati mostrati devono essere quelli pubblicati dalla Finestra A.

Da Finestra A, apri la sezione Habit Tracker e aggiungi un'abitudine. Entro un paio di secondi, senza ricaricare, la stessa abitudine deve comparire nella sezione Habit Tracker della Finestra B.

Ricarica la pagina in Finestra A (F5): il gate **non** deve ricomparire (password già salvata in `localStorage` su quel browser) e l'abitudine aggiunta deve essere ancora presente.

- [ ] **Step 8: Commit**

```bash
git add publish/index.html
git commit -m "Wire cross-device sync into the dashboard UI and state lifecycle"
```

---

## Task 5: Verifica offline e pubblicazione

**Files:** nessuna modifica di codice — solo verifica e pubblicazione.

**Interfaces:** nessuna (task di verifica/deploy).

- [ ] **Step 1: Verifica comportamento offline**

Con Finestra A e Finestra B entrambe sbloccate (Task 4 Step 7), nella Finestra A apri DevTools → tab Network → imposta "Offline". Aggiungi un film nella sezione Film & TV: deve comparire subito in locale (nessun errore visibile). Rimetti la rete online in Finestra A. Entro pochi secondi il film deve comparire anche nella Finestra B senza bisogno di alcuna azione manuale (il Firebase SDK invia in automatico le scritture accodate durante l'offline).

- [ ] **Step 2: Verifica che il flusso Excel di Investimenti/Depositi non sia stato rotto**

Nella Finestra A, apri la sezione Investimenti, registra un movimento, premi "Copia per Claude" e verifica che il testo generato sia corretto come prima di questa modifica (comportamento invariato, vedi `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md`).

- [ ] **Step 3: Pulisci i dati di test da Firebase**

Nella console Firebase (Realtime Database → tab Data), elimina il nodo `state` di test creato durante le verifiche, così Marco ed Eugenia partiranno da un primo setup pulito con la password reale che sceglieranno.

- [ ] **Step 4: Chiedi conferma per il push su `main`**

Il push aggiorna il sito pubblico live (`mbn8455.github.io/ENOTIKI`). Chiedi esplicitamente conferma all'utente prima di procedere (coerente con il principio già seguito per il flusso Excel — vedi sezione "Conferma di pubblicazione" nella spec del 12/08).

- [ ] **Step 5: Push**

Dopo conferma dell'utente:

```bash
git push origin main
```

Verifica che `https://mbn8455.github.io/ENOTIKI/index.html` mostri il gate "Password di famiglia" al primo accesso da un browser pulito.
