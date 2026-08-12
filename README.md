# Pubblicazione su github.com/mbn8455 — cartella "Enotiki"

Questa cartella (`Enotiki/`) contiene il sito statico della dashboard, pronto per essere caricato su un repository dell'account `mbn8455`.

## Cosa fare
1. Crea un nuovo repository su `github.com/mbn8455` (es. `enotiki` o `vita-dashboard`, a scelta) — oppure usa un repo esistente.
2. Copia tutto il contenuto di questa cartella `Enotiki/` nella root del repository (o in una sottocartella `Enotiki/` del repo, se preferisci tenerla separata da altri progetti):
   - `index.html`
   - `support.js`
   - `image-slot.js`
   - `libri.json`
   - `prices.json`
   - `libri/` (66 pagine HTML linkate dai libri)
   - `_ds/organic-810e718f-1806-4192-8941-64d874e47e71/styles.css`
   - `_ds/organic-810e718f-1806-4192-8941-64d874e47e71/_ds_bundle.js`
3. Commit e push su `main`.
4. Abilita GitHub Pages (Settings → Pages → Source: `main`, root o `/Enotiki` a seconda di dove hai messo i file).
5. Verifica il sito all'URL risultante (es. `https://mbn8455.github.io/<repo>/` o `https://mbn8455.github.io/<repo>/Enotiki/`).

## Note tecniche
- `index.html` è auto-descrittivo: al caricamento fa `fetch(location.href)` per leggersi da sé — nessuna build necessaria.
- `index.html` carica anche `libri.json` e `prices.json` con `fetch()` relativo — devono restare nella stessa cartella di `index.html`.
- Tutti i file sono statici: nessun bundler, nessun `node_modules`.
