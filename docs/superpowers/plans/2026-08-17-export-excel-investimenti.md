# Export Excel per Investimenti Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side "Esporta in Excel" button to the Investimenti page of `publish/index.html` that downloads a personal-backup `.xlsx` (Posizioni, Movimenti, Depositi sheets) built from the current browser state.

**Architecture:** Vendor the SheetJS community-edition "mini" build as a static JS file loaded via `<script>` tag (no CDN, no build step — the site is plain static HTML/JS). A new `exportExcel` method on the React-like app component reads `this.state.investimenti` / `this.state.movimenti` / `this.state.depositi`, builds a 3-sheet workbook with `XLSX.utils`, and triggers `XLSX.writeFile`.

**Tech Stack:** Vanilla JS, the site's existing custom template engine (`_ds_bundle.js`, `{{ }}` bindings, `<sc-if>`/`<sc-for>`), SheetJS `xlsx.mini.min.js` (vendored, MIT license).

## Global Constraints

- Site is 100% static files served by GitHub Pages — no build tools, bundler, or `node_modules` (per `publish/README.md`). Any new dependency must be a vendored static file, not an npm package.
- No CDN dependency at runtime: the SheetJS library file must be committed into the repo and loaded from a relative path.
- This feature must not change the existing "Copia per Claude" publish flow (`copyPerClaude` method, `pendingSyncLabel`, dialogs) in any way.
- Export is a personal backup only — it does not write back to `data/finanze.xlsx` or call any API.
- Movimenti and Depositi sheets each get an extra `Sincronizzato` column (`"Sì"` / `"No"`, derived from the row's `synced` boolean). Posizioni has no such column (positions aren't synced individually).
- Filename must be `finanze-backup-<YYYY-MM-DD>.xlsx` using the existing `toDateStr(new Date())` helper already used elsewhere in `index.html` (see `openDepositoDialog`).
- If `window.XLSX` is not defined when the button is clicked, show exactly: `alert("Impossibile generare il file Excel: libreria non caricata. Ricarica la pagina e riprova.")` — do not throw.
- Follow existing code style in `index.html`: arrow-function class properties (`name = () => {...}`) for handlers, double-quoted strings, `this.setState(update, this.persist)` pattern for anything that touches state (export touches no state, so no `setState` call is needed here).

---

## File Structure

- Create: `publish/vendor/xlsx.mini.min.js` — vendored SheetJS library, defines `window.XLSX`.
- Modify: `publish/index.html`
  - `<head>`/`<helmet>` script includes (around line 13) — add the vendor script tag.
  - Investimenti page header buttons (around line 421-429) — add the new button.
  - App component methods (around line 1388, right after `deleteDeposito`) — add `exportExcel`.

No other files change. No test framework exists in this project for the front-end (only `publish/scripts/test_xlsx_to_json.py`, which is unrelated Python). Verification here is manual, via a local static server and the browser tool, as already used earlier in this project to verify the live site.

---

### Task 1: Vendor SheetJS and load it on the page

**Files:**
- Create: `publish/vendor/xlsx.mini.min.js`
- Modify: `publish/index.html:13` (insert a new line after it)

**Interfaces:**
- Produces: global `window.XLSX` object (SheetJS API: `XLSX.utils.book_new`, `XLSX.utils.json_to_sheet`, `XLSX.utils.book_append_sheet`, `XLSX.writeFile`) available to any script running after this tag, on every page of the site.

- [ ] **Step 1: Download the vendored library**

```bash
curl -sL -o "publish/vendor/xlsx.mini.min.js" "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js"
```

Run from the repo root (`Downloads/Dashboard personale e familiare (3)`). Create the `publish/vendor/` directory first if it doesn't exist.

- [ ] **Step 2: Verify the download**

Run:
```bash
wc -c "publish/vendor/xlsx.mini.min.js"
head -c 80 "publish/vendor/xlsx.mini.min.js"
```
Expected: size close to 279523 bytes (SheetJS 0.20.3 mini build), and the first line starts with `/*! xlsx.js (C) 2013-present SheetJS`. If the file is HTML (starts with `<`) or much smaller, the download failed — stop and re-fetch.

- [ ] **Step 3: Add the script include**

In `publish/index.html`, current lines 12-13:
```html
  <script src="_ds/organic-810e718f-1806-4192-8941-64d874e47e71/_ds_bundle.js"></script>
  <script src="./image-slot.js"></script>
```
Change to:
```html
  <script src="_ds/organic-810e718f-1806-4192-8941-64d874e47e71/_ds_bundle.js"></script>
  <script src="./image-slot.js"></script>
  <script src="./vendor/xlsx.mini.min.js"></script>
```

- [ ] **Step 4: Verify `window.XLSX` loads in the browser**

Start a local static server from the `publish/` folder:
```bash
cd publish && python -m http.server 8765
```
Open `http://localhost:8765/` in the browser tool, then run in the page via the JS execution tool:
```js
typeof window.XLSX === "object" && typeof window.XLSX.writeFile === "function"
```
Expected: `true`.

- [ ] **Step 5: Commit**

```bash
git add "Downloads/Dashboard personale e familiare (3)/publish/vendor/xlsx.mini.min.js" "Downloads/Dashboard personale e familiare (3)/publish/index.html"
git commit -m "Vendor SheetJS for client-side Excel export"
```

---

### Task 2: Add the "Esporta in Excel" button and export logic

**Files:**
- Modify: `publish/index.html:421-429` (button UI)
- Modify: `publish/index.html:1388` (new `exportExcel` method, inserted right after `deleteDeposito`)

**Interfaces:**
- Consumes: `window.XLSX` (from Task 1), `this.state.investimenti` (array of `{nome, tipo, isin, quantita, prezzoCarico, valoreAttuale, rangeMin, rangeMax, quotaMarco, note}`), `this.state.movimenti` (array of `{data, nome, tipo, quantita, prezzo, note, synced}`), `this.state.depositi` (array of `{persona, importo, data, note, synced}`), existing `toDateStr(new Date())` helper.
- Produces: `exportExcel` — a no-argument arrow-function class property, referenced in the template as `{{ exportExcel }}` exactly like the existing `{{ copyPerClaude }}` binding (the template engine resolves handler names directly against instance properties, no need to add `exportExcel` to the `render()` return object — confirmed by how `copyPerClaude` and `openInvestDialog` are already used without appearing in that return object).

- [ ] **Step 1: Add the button**

In `publish/index.html`, current lines 421-424:
```html
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" style="white-space:nowrap;" onClick="{{ copyPerClaude }}">
              Copia per Claude{{ pendingSyncLabel }}
            </button>
```
Change to:
```html
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" style="white-space:nowrap;" onClick="{{ copyPerClaude }}">
              Copia per Claude{{ pendingSyncLabel }}
            </button>
            <button class="btn btn-secondary" style="white-space:nowrap;" onClick="{{ exportExcel }}">
              Esporta in Excel
            </button>
```
(Leave the following `Registra movimento` button untouched.)

- [ ] **Step 2: Add the `exportExcel` method**

In `publish/index.html`, current line 1388:
```js
  deleteDeposito(id) { this.setState({ depositi: this.state.depositi.filter((d) => d.id !== id) }, this.persist); }
```
Change to:
```js
  deleteDeposito(id) { this.setState({ depositi: this.state.depositi.filter((d) => d.id !== id) }, this.persist); }
  exportExcel = () => {
    if (typeof window === "undefined" || !window.XLSX) {
      alert("Impossibile generare il file Excel: libreria non caricata. Ricarica la pagina e riprova.");
      return;
    }
    const posizioniRows = this.state.investimenti.map((i) => ({
      nome: i.nome, tipo: i.tipo, isin: i.isin || "",
      quantita: i.quantita, prezzoCarico: i.prezzoCarico, valoreAttuale: i.valoreAttuale,
      rangeMin: i.rangeMin, rangeMax: i.rangeMax, quotaMarco: i.quotaMarco, note: i.note || ""
    }));
    const movimentiRows = this.state.movimenti.slice().sort((a, b) => a.data.localeCompare(b.data)).map((m) => ({
      data: m.data, nome: m.nome, tipo: m.tipo, quantita: m.quantita, prezzo: m.prezzo,
      note: m.note || "", Sincronizzato: m.synced ? "Sì" : "No"
    }));
    const depositiRows = this.state.depositi.slice().sort((a, b) => a.data.localeCompare(b.data)).map((d) => ({
      persona: d.persona, importo: d.importo, data: d.data, note: d.note || "", Sincronizzato: d.synced ? "Sì" : "No"
    }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(posizioniRows), "Posizioni");
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(movimentiRows), "Movimenti");
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(depositiRows), "Depositi");
    window.XLSX.writeFile(wb, "finanze-backup-" + toDateStr(new Date()) + ".xlsx");
  };
```

- [ ] **Step 3: Verify the button renders**

With the local server from Task 1 still running (or restarted: `cd publish && python -m http.server 8765`), open `http://localhost:8765/`, navigate to the Investimenti page (click the "Investimenti" nav item), then run in the page:
```js
Array.from(document.querySelectorAll("button")).some((b) => b.textContent.trim().startsWith("Esporta in Excel"))
```
Expected: `true`.

- [ ] **Step 4: Verify the workbook content without triggering a real download**

Still on the Investimenti page, run this in the page (it patches `writeFile` to capture the workbook instead of downloading, clicks the real button, then restores the original):
```js
(() => {
  const original = window.XLSX.writeFile;
  let captured = null;
  window.XLSX.writeFile = (wb, filename) => { captured = { wb, filename }; };
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim().startsWith("Esporta in Excel"));
  btn.click();
  window.XLSX.writeFile = original;
  if (!captured) return "FAIL: writeFile not called";
  return JSON.stringify({
    filename: captured.filename,
    sheetNames: captured.wb.SheetNames,
    posizioniHeaders: Object.keys(window.XLSX.utils.sheet_to_json(captured.wb.Sheets["Posizioni"])[0] || {}),
    depositiRowCount: window.XLSX.utils.sheet_to_json(captured.wb.Sheets["Depositi"]).length
  });
})();
```
Expected: a JSON string where `sheetNames` is `["Posizioni", "Movimenti", "Depositi"]`, `filename` matches `finanze-backup-YYYY-MM-DD.xlsx` for today's date, `posizioniHeaders` includes `nome`, `tipo`, `quantita`, `prezzoCarico`, `valoreAttuale`, and `depositiRowCount` is greater than 0 (matches the number of seeded/local deposits visible on the page).

- [ ] **Step 5: Verify a real click produces a real download**

Run in the page (no patching this time):
```js
Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim().startsWith("Esporta in Excel")).click();
```
Check the browser tool's downloads (or console) confirm a file named `finanze-backup-<today>.xlsx` was produced with no thrown errors. Read any console errors with the browser tool's console-reading capability; expect none related to `exportExcel` or `XLSX`.

- [ ] **Step 6: Stop the local server**

Stop the `python -m http.server` process started in Task 1/2.

- [ ] **Step 7: Commit**

```bash
git add "Downloads/Dashboard personale e familiare (3)/publish/index.html"
git commit -m "Add Esporta in Excel button to Investimenti page"
```

---

## Out of scope (confirmed with user during design)

- Publishing this change to the live `mbn8455/ENOTIKI` GitHub Pages site is **not** part of this plan — pushing to the public repo requires explicit user confirmation each time (per standing safety rules), so ask the user after this plan is executed and verified locally, the same way publishing was confirmed earlier in this project.
- No `movimenti.json` file / full cross-device movement history (evaluated and declined during design).
- No changes to `copyPerClaude` or the Excel→JSON publish pipeline (`scripts/xlsx_to_json.py`).
