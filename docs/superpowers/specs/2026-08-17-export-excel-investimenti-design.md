# Design: Export Excel per Investimenti (ENOTIKI dashboard)

Data: 2026-08-17
Stato: approvato dall'utente, in attesa di piano di implementazione

## Contesto

Il sito `mbn8455.github.io/ENOTIKI` (repo `mbn8455/ENOTIKI`) ha una sezione Investimenti (vedi `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md`) dove l'utente registra movimenti (acquisti/vendite) e depositi tramite i dialog "Registra movimento" e "Aggiungi deposito". Questi dati vivono in `localStorage` del browser (array `investimenti`, `movimenti`, `depositi` nello state React) finché non vengono comunicati a Claude (bottone "Copia per Claude") per essere pubblicati su `data/finanze.xlsx` / `investimenti.json` / `depositi.json`.

L'utente conferma che continuerà a inserire i dati sempre tramite i dialog del sito (nessuna modifica necessaria a quel flusso) e vuole in aggiunta un modo per scaricare un backup personale in Excel dei propri dati direttamente dal sito, senza passare da Claude.

## Obiettivo

Un bottone "Esporta in Excel" nella pagina Investimenti che genera e scarica un file `.xlsx` con lo stato attuale, interamente lato client (il sito è statico, nessun backend).

**Scopo del file**: backup personale per l'utente. Non è pensato per essere ricaricato automaticamente al posto di `data/finanze.xlsx` nel repo (quel flusso resta "Copia per Claude" → Claude aggiorna Excel/JSON → commit/push).

## Libreria

Il sito non usa build tool/bundler (solo file statici serviti da GitHub Pages). Per generare un vero file `.xlsx` multi-foglio lato client si vendorizza [SheetJS](https://sheetjs.com) community edition, build "mini" (~273KB, MIT license), come file statico:

- `vendor/xlsx.mini.min.js`

Caricato con un tag `<script>` in `index.html`, accanto agli altri script statici (`support.js`, `image-slot.js`, `_ds_bundle.js`). Nessuna dipendenza da CDN a runtime: il file vive nel repo.

## Comportamento del bottone

Aggiunto nell'header della pagina Investimenti (`index.html`, vicino a "Copia per Claude" e "Registra movimento").

Al click, un nuovo metodo `exportExcel()` sull'app React:

1. Costruisce 3 fogli dallo stato React corrente, stessa struttura colonne di `data/finanze.xlsx`:

   **Posizioni** (da `this.state.investimenti`): nome, tipo, isin, quantita, prezzoCarico, valoreAttuale, rangeMin, rangeMax, quotaMarco, note.

   **Movimenti** (da `this.state.movimenti`, ordinati per data crescente): data, nome, tipo, quantita, prezzo, note, **Sincronizzato** (Sì/No, da `synced`).

   **Depositi** (da `this.state.depositi`, ordinati per data crescente): persona, importo, data, note, **Sincronizzato** (Sì/No, da `synced`).

2. Genera il workbook con SheetJS e lo scarica con `XLSX.writeFile(wb, "finanze-backup-<YYYY-MM-DD di oggi>.xlsx")` — download nativo del browser, nessuna chiamata di rete.

### Limite noto (accettato dall'utente)

Il foglio Movimenti nell'export riflette solo i movimenti registrati **da questo browser** tramite il dialog "Registra movimento". Se in passato un aggiornamento è stato comunicato a Claude direttamente in chat senza passare dal sito, quel movimento puntuale non compare come riga nel foglio Movimenti esportato (il suo effetto aggregato è comunque incluso nel foglio Posizioni, che riflette sempre `investimenti.json` pubblicato). Dato che da ora in poi l'input avviene sempre dal sito, lo storico locale diventerà via via completo.

## Gestione errori

Se `window.XLSX` non è definito al momento del click (es. il file `vendor/xlsx.mini.min.js` non si è caricato per problemi di rete al primo load del sito), `exportExcel()` mostra `alert("Impossibile generare il file Excel: libreria non caricata. Ricarica la pagina e riprova.")` invece di fallire silenziosamente o lanciare un'eccezione non gestita.

## Fuori scope

- Reimportare il file esportato nel repo / sostituire `data/finanze.xlsx` (resta un processo manuale via Claude se l'utente lo desidera in futuro).
- Foglio Movimenti con storico completo indipendente dal browser (richiederebbe pubblicare anche `movimenti.json`, valutato e scartato per ora — vedi conversazione di design).
- Export di altre sezioni del sito (Calendario, Habit, Appunti, Salute, Libri, Film): resta specifico a Investimenti/Depositi.
