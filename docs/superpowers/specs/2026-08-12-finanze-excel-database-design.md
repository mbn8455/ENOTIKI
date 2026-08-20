# Design: Excel come database per Investimenti + Depositi (ENOTIKI dashboard)

Data: 2026-08-12
Stato: approvato dall'utente, in attesa di piano di implementazione

## Contesto

Il sito `mbn8455.github.io/ENOTIKI` (repo `mbn8455/ENOTIKI`, root del branch `main`) è una single-page app statica (`index.html`). Oggi la maggior parte dei dati (eventi, habit, appunti, investimenti, depositi, salute, farmaci, film) vive solo nel `localStorage` del browser, inizializzata da array `SEED_*` hardcoded nel JS. Solo `libri.json` e `prices.json` sono file esterni caricati via `fetch()` a runtime e quindi aggiornabili sostituendo il file nel repo.

Obiettivo di questa fase: rendere **Investimenti** e **Depositi** editabili sia tramite un file Excel che funge da database, sia direttamente dal sito — in entrambi i casi l'utente inserisce solo il dato grezzo (comprato/venduto quanto, a che prezzo) e il calcolo (prezzo medio di carico, quantità totale) viene fatto automaticamente, mai a mano. Il flusso "scrivo a Claude in chat" (o incollando il testo trascritto di un vocale Telegram) resta il modo per far confluire tutto nell'Excel/JSON pubblicato, incluso quanto inserito direttamente sul sito.

Le altre sezioni (calendario, habit, appunti, salute) restano fuori scope: verranno affrontate in fasi successive con lo stesso pattern, una volta validato su Investimenti/Depositi.

L'integrazione diretta con un bot Telegram (ascolto automatico dei messaggi, trascrizione vocale, pubblicazione senza intervento umano) è anch'essa fuori scope: per ora l'utente incolla/scrive il contenuto del messaggio direttamente a Claude in una sessione di chat.

## Struttura dati

### File Excel: `data/finanze.xlsx`

Tre fogli:

**Posizioni** — una riga per strumento finanziario:
| colonna | tipo | note |
|---|---|---|
| nome | testo | es. "ETF iShares MSCI World" |
| tipo | testo | ETF / Azioni / Oro / Crypto / Altro |
| isin | testo | opzionale |
| quantita | numero | **derivata**: ricalcolata dallo script sommando i Movimenti dello strumento |
| prezzoCarico | numero | **derivata**: media ponderata calcolata dallo script dai Movimenti |
| valoreAttuale | numero | manuale, tranne per i 3 simboli noti (vedi sotto) sovrascritti da `prices.json` a runtime |
| rangeMin | numero | manuale |
| rangeMax | numero | manuale |
| quotaMarco | numero | percentuale, manuale |
| note | testo | manuale |

**Movimenti** — una riga per ogni acquisto/vendita, registro storico:
| colonna | tipo | note |
|---|---|---|
| data | data (YYYY-MM-DD) | |
| nome | testo | deve corrispondere a un nome in Posizioni; se non esiste, va creata anche la riga Posizioni |
| tipo | testo | "Acquisto" o "Vendita" |
| quantita | numero | sempre positiva; il segno lo determina il campo tipo |
| prezzo | numero | prezzo unitario dell'operazione |
| note | testo | opzionale |

**Depositi** — una riga per ogni versamento:
| colonna | tipo | note |
|---|---|---|
| persona | testo | "Marco" o "Eugenia" |
| importo | numero | |
| data | data (YYYY-MM-DD) | |
| note | testo | opzionale |

### File JSON generati: `investimenti.json`, `depositi.json`

Stesso stile di `libri.json`/`prices.json` (root del sito, oggetto con `generatedAt` + array dati). `investimenti.json` contiene le posizioni con quantita/prezzoCarico già calcolati (i Movimenti non vengono esposti al sito, solo il risultato aggregato).

## Script di conversione

`scripts/xlsx_to_json.py` (eseguito da Claude on-demand, non da CI):
1. Legge `data/finanze.xlsx`.
2. Per ogni strumento in Posizioni, somma i Movimenti corrispondenti (Acquisto positivo, Vendita negativo) per ottenere `quantita` e calcola la media ponderata dei soli Acquisti per `prezzoCarico`.
3. Scrive `quantita`/`prezzoCarico` calcolati di nuovo nel foglio Posizioni (così il file resta leggibile/coerente se aperto in Excel) e genera `investimenti.json`.
4. Genera `depositi.json` dal foglio Depositi.

## Modifiche a `index.html`

### Il dialog "Aggiungi investimento" diventa "Registra movimento"

Oggi il dialog crea sempre una posizione nuova con `quantita`/`prezzoCarico` inseriti a mano (nessuna media, righe duplicate se lo stesso strumento viene aggiunto più volte). Va sostituito con un dialog "Registra movimento": strumento (scelto tra quelli esistenti, o nome nuovo), tipo (Acquisto/Vendita), quantità, prezzo, data, note.

Al salvataggio, la logica JS del sito:
1. Aggiunge il movimento a un array `movimenti` in `localStorage`, con un id locale e `synced: false`.
2. Ricalcola `quantita`/`prezzoCarico` della posizione corrispondente sommando tutti i movimenti noti per quello strumento (stessa formula di media ponderata usata dallo script Python, per coerenza) — sia quelli già arrivati da `investimenti.json` sia i movimenti locali non ancora sincronizzati (`synced: false`), cosicché il sito mostri sempre subito il dato corretto anche prima che Claude pubblichi.

Il dialog Depositi resta invariato (un deposito non ha campi calcolati, solo dati grezzi).

### Bottone "Copia per Claude"

Nelle sezioni Investimenti e Depositi, un bottone genera un testo pronto (es. "12/08: comprate 10 quote di ETF iShares MSCI World a 46€" / "12/08: versati 500€ da Marco") a partire da tutti i movimenti/depositi locali con `synced: false`, da incollare in chat. Al click, quegli elementi vengono marcati `synced: true` in `localStorage` (si assume che l'utente li incollerà a Claude subito dopo).

### Caricamento dati (`componentDidMount`)

Accanto ai `fetch` esistenti per `libri.json`/`prices.json`, aggiungere:
- `fetch("investimenti.json")`: i dati del file (posizioni con quantita/prezzoCarico già calcolati da Claude includendo anche i movimenti sincronizzati dal sito) fanno da base. Sopra a questa base, il sito applica ancora i movimenti locali con `synced: false` rimasti in sospeso (non ancora incollati/pubblicati), così da non perdere temporaneamente ciò che è stato inserito sul sito ma non ancora comunicato a Claude. Il merge con `prices.json` (che sovrascrive `valoreAttuale` solo per i simboli in `SYMBOL_BY_NOME`: i due ETF e Bitcoin) resta invariato.
- `fetch("depositi.json")`: i dati del file fanno da base; eventuali depositi locali con `synced: false` restano in coda sopra alla base, con la stessa logica.

## Flusso di aggiornamento

Due punti di ingresso equivalenti per registrare un movimento/deposito grezzo, entrambi finiscono per essere processati da Claude e pubblicati:

**A. Dal sito** — l'utente usa il dialog "Registra movimento" (o "Aggiungi deposito"); il sito calcola/mostra subito il dato aggiornato in locale. Quando vuole, l'utente preme "Copia per Claude" e incolla il testo generato in chat.

**B. Dall'Excel/chat** — l'utente scrive direttamente a Claude (chat, o testo incollato da un vocale Telegram trascritto) un aggiornamento in linguaggio naturale, es. "comprate 10 quote di MSCI World a 46" o "versati 500€ per Marco il 3 agosto" — senza passare dal sito.

In entrambi i casi, da quel punto in poi:
1. Claude interpreta il messaggio e aggiunge la riga corrispondente su `data/finanze.xlsx` (Movimenti o Depositi; crea anche la riga Posizioni se lo strumento è nuovo).
2. Claude esegue `scripts/xlsx_to_json.py` per rigenerare `investimenti.json`/`depositi.json` (quantita/prezzoCarico ricalcolati dallo script, stessa formula usata lato sito).
3. Claude fa commit delle modifiche (Excel + JSON) e push su `main`. GitHub Pages serve direttamente da `main`, quindi il sito si aggiorna da solo dopo il push, e al prossimo caricamento la posizione locale `synced: false` corrispondente risulta ormai riflessa nel JSON.

### Conferma di pubblicazione

Il push su GitHub è un'azione visibile pubblicamente (aggiorna il sito live), quindi richiede consenso esplicito dell'utente. Per evitare di chiedere conferma ad ogni singolo messaggio, Claude chiede una volta sola all'inizio di ogni sessione di chat se può pubblicare in automatico gli aggiornamenti di quella sessione; se l'utente conferma, i push successivi nella stessa sessione procedono senza ulteriori richieste. In una nuova sessione la domanda viene ripetuta.

## Fuori scope (fasi successive)

- Estensione dello stesso pattern (Excel → JSON → fetch a runtime) alle altre sezioni: Calendario, Habit Tracker, Appunti, Salute (parametri + farmaci), Libri (parzialmente già coperto), Film.
- Bot Telegram che ascolta messaggi/vocali automaticamente e aggiorna il sito senza che l'utente apra una sessione di chat con Claude (richiede hosting, token del bot, trascrizione vocale, e decisioni su come/dove eseguire il polling).
