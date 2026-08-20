# Design: sincronizzazione cross-device dello stato (ENOTIKI dashboard)

Data: 2026-08-20
Stato: approvato dall'utente, in attesa di piano di implementazione

## Contesto

Il sito `mbn8455.github.io/ENOTIKI` (repo `mbn8455/ENOTIKI`, root del branch `main`) è una single-page app statica. Ad oggi (vedi `componentDidMount`/`persist` in `index.html`) l'intero stato dell'app — film, appunti, eventi, habit, investimenti, movimenti, parametri, farmaci, libri, portfolioHistory, depositi — viene letto/scritto solo con `localStorage.setItem("vita-dash-v1", ...)`. `localStorage` è isolato per browser/dispositivo: una modifica fatta su un device non arriva mai su un altro. L'unica eccezione parziale è Investimenti/Depositi, che ha un flusso manuale via Excel (`data/finanze.xlsx` → `scripts/xlsx_to_json.py` → `investimenti.json`/`depositi.json` → commit/push), descritto in `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md`.

Obiettivo di questa fase: tutte le sezioni dell'app si sincronizzano in tempo reale tra i device di Marco ed Eugenia, senza dover passare da un flusso manuale (Excel/chat/commit). Il sito resta statico (GitHub Pages, nessun server da mantenere) e senza build step, coerentemente con l'architettura attuale.

## Architettura

**Backend: Firebase Realtime Database + Firebase Authentication (piano gratuito Spark).**

Scelto rispetto a un backend relazionale (es. Supabase/Postgres) perché lo stato dell'app è già, di fatto, un unico blob JSON (le stesse chiavi oggi scritte da `persist()`) — Realtime Database è pensato esattamente per sincronizzare un albero JSON in tempo reale via WebSocket, con SDK caricabile via `<script>` da CDN (nessun bundler, coerente con come sono già inclusi `_ds_bundle.js`/`image-slot.js`).

Firebase Authentication è usato solo in modalità **anonima**: serve esclusivamente a soddisfare le security rules del database ("solo chi ha una sessione, anche anonima, può leggere/scrivere"), non identifica Marco vs Eugenia come utenti distinti. Il login anonimo avviene in automatico all'avvio, senza alcuna interazione dell'utente.

## Sicurezza: password di famiglia via cifratura client-side

Non viene costruita nessuna vera autenticazione per-utente. La protezione dei dati è **cifratura end-to-end lato client**: l'intero blob di stato viene cifrato con AES-GCM (Web Crypto API, nativa nel browser, nessuna libreria esterna) usando una chiave derivata via PBKDF2 (SHA-256, ~150.000 iterazioni) dalla password di famiglia. Chi legge il nodo Firebase senza conoscere la password vede solo bytes cifrati illeggibili — le security rules restano permissive per chiunque abbia una sessione anonima, ma il contenuto è comunque protetto.

Payload salvato su Firebase (nodo `/state`):
```json
{
  "ciphertext": "<base64>",
  "iv": "<base64, 12 byte, casuale ad ogni scrittura>",
  "salt": "<base64, 16 byte, generato una sola volta dal primo device>",
  "updatedAt": 1755600000000
}
```
`salt` e `iv` non sono segreti (servono a chiunque per calcolare la chiave *se* conosce la password); senza la password derivare la chiave corretta non è fattibile.

**Prima configurazione**: al primo accesso su un device, se non c'è una password salvata localmente, l'app mostra una schermata "Password di famiglia" (campo unico, nessun nome utente). Il device deriva la chiave e:
- se `/state` non esiste ancora su Firebase → è il primo setup in assoluto: il device genera un nuovo `salt`, cifra il proprio stato locale corrente (quello già in `localStorage`, così non si perde la cronologia esistente) e lo pubblica.
- se `/state` esiste già → il device tenta di decifrare il payload esistente con la password inserita. Decifratura riuscita (tag di autenticazione AES-GCM valido) = password corretta, salvata in `localStorage` per gli accessi successivi. Decifratura fallita = password sbagliata, viene richiesta di nuovo senza toccare lo stato locale.

## Flusso dati

1. All'avvio: login anonimo silenzioso; lettura immediata da `localStorage` per un primo render veloce (come oggi); se manca la password locale, mostra il gate descritto sopra.
2. Una volta ottenuta la chiave, l'app si registra come listener realtime sul nodo `/state`. Ad ogni evento in arrivo: decifra, e se `updatedAt` ricevuto è più recente di quello applicato localmente, aggiorna lo stato React-like via lo stesso `setState` già usato ovunque nel componente (i dati appaiono sull'altro device senza reload).
3. `persist()` (il metodo già esistente, chiamato dopo ogni mutazione) continua a scrivere subito su `localStorage` come oggi, e in più schedula — con un debounce di ~800ms per non spammare la rete ad ogni tasto — una scrittura cifrata su `/state` con `updatedAt: Date.now()`.
4. Le sezioni Investimenti/Depositi mantengono invariata la logica attuale di reconciliazione con `investimenti.json`/`depositi.json` e i movimenti locali `synced:false` (flusso Excel, vedi spec del 12/08); il risultato di quella reconciliazione fa comunque parte dello stato che `persist()` sincronizza su Firebase, quindi si propaga agli altri device come qualunque altra modifica, senza attendere che anche loro rifacciano il fetch dei JSON.

**Strategia sui conflitti**: last-write-wins sull'intero blob (confronto per `updatedAt`), non merge campo per campo. Scelta deliberata per semplicità: con due persone che editano in momenti quasi sempre diversi è più che sufficiente; se due modifiche avvengono nello stesso istante su device diversi, vince l'ultima arrivata e l'altra viene sovrascritta. Non c'è versioning/history.

**Offline**: il Firebase JS SDK per Realtime Database mette in coda le scritture mentre il device è offline e le invia alla riconnessione, senza codice aggiuntivo. Nel frattempo l'app resta pienamente utilizzabile leggendo/scrivendo `localStorage` come fa oggi.

## Modifiche a `index.html`

- Aggiunta dei tag `<script>` per Firebase App + Auth + Database (CDN, stesso pattern di `_ds_bundle.js`).
- Nuovo modulo di cifratura (funzioni `deriveKey`, `encryptState`, `decryptState` sopra Web Crypto), nessuna dipendenza esterna.
- Nuova schermata/gate "Password di famiglia", mostrata sopra l'app quando manca la password locale valida.
- `componentDidMount`: dopo l'hydrate da `localStorage` esistente, aggiunta dell'inizializzazione Firebase (login anonimo, sottoscrizione al nodo `/state`).
- `persist()`: invariato nella parte `localStorage`, con l'aggiunta della scrittura debounced su Firebase.

## Setup richiesto (lato utente, fuori dal codice)

Prima dell'implementazione, l'utente deve creare un progetto Firebase gratuito (console.firebase.google.com), abilitare **Authentication → Anonymous** e creare una **Realtime Database** in modalità con regole che richiedano `auth != null` per lettura/scrittura. Il piano di implementazione includerà i passaggi esatti e le credenziali (`apiKey`, `databaseURL`, ecc. — non segrete, sono identificatori pubblici del progetto, la vera protezione è la cifratura) da incollare nel codice.

## Gestione errori

- Password errata: messaggio esplicito, si resta sul gate, nessuna modifica allo stato.
- Firebase irraggiungibile (rete offline, progetto non configurato): l'app funziona comunque in locale via `localStorage` come fa oggi; nessun errore bloccante mostrato all'utente, solo un tentativo di riconnessione in background gestito dall'SDK.

## Verifica

Test manuale su due profili browser distinti (simulando Marco ed Eugenia) con la stessa password: aggiunta/modifica/eliminazione in ogni sezione da un profilo e verifica della comparsa in tempo reale sull'altro; verifica del rifiuto di una password sbagliata; verifica che una modifica fatta offline compaia sull'altro device alla riconnessione.

## Cosa NON cambia

- Interfaccia, layout, framework `_ds`/DCLogic.
- Il flusso Excel per Investimenti/Depositi (`data/finanze.xlsx` → `xlsx_to_json.py` → commit/push) resta com'è: continua a fungere da canale di inserimento dati grezzi e da seed, il layer Firebase si aggiunge sopra senza sostituirlo.
- `libri.json`/`prices.json` restano file statici fetchati come oggi.

## Fuori scope

- Autenticazione per-utente (login individuale per Marco/Eugenia, permessi differenziati).
- Merge automatico campo-per-campo o storicizzazione delle versioni in caso di conflitto.
- Migrazione del flusso Excel di Investimenti/Depositi a scrittura diretta su Firebase (resta come descritto nella spec del 12/08).
