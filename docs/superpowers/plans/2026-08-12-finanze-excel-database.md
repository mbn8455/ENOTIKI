# Excel Database per Investimenti/Depositi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire i dati hardcoded/localStorage di Investimenti e Depositi con un file Excel (`data/finanze.xlsx`) come database, generare `investimenti.json`/`depositi.json` da esso, far leggere questi file al sito, e permettere l'inserimento di movimenti/depositi sia da Excel/chat sia direttamente dal sito con calcolo automatico del prezzo medio di carico.

**Architecture:** Uno script Python (`scripts/xlsx_to_json.py`, openpyxl) legge tre fogli di `data/finanze.xlsx` (Posizioni, Movimenti, Depositi), calcola quantità/prezzo medio di carico per ogni posizione sommando i movimenti (media ponderata, gestisce anche le vendite), e genera `investimenti.json`/`depositi.json` nello stile già usato da `libri.json`/`prices.json`. Il sito (`index.html`, single-file, framework proprietario "DCLogic") viene esteso per caricare questi due JSON al mount, riconciliarli con eventuali movimenti inseriti localmente e non ancora sincronizzati, e per registrare nuovi movimenti/depositi con la stessa logica di calcolo (mirror in JavaScript della funzione Python).

**Tech Stack:** Python 3.14 + openpyxl (script di conversione, testato con pytest), JavaScript vanilla dentro `index.html` (nessun bundler/framework aggiuntivo — il sito è già un file statico auto-contenuto).

## Global Constraints

- Nessuna dipendenza nuova lato sito: `index.html` resta un file statico senza build step, come documentato in `README.md`.
- Lo script di conversione è eseguito manualmente (da Claude, on-demand), non da CI: il workflow `.github/workflows/main.yml` esistente è vuoto e resta fuori scope.
- `investimenti.json`/`depositi.json` seguono lo stesso formato (`generatedAt` + array) di `libri.json`/`prices.json`.
- `prices.json` continua a sovrascrivere `valoreAttuale` solo per i simboli in `SYMBOL_BY_NOME` (i due ETF e Bitcoin) — non toccare questa logica.
- Ogni push su `main` è un'azione pubblica: va chiesta conferma esplicita all'utente (una volta per sessione, come da spec), mai eseguita in automatico senza che l'utente l'abbia autorizzata in quella sessione.
- Riferimento: `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md` per tutte le decisioni di design già approvate.

---

## Mappa dei file

- Create: `data/finanze.xlsx` — il database Excel (3 fogli: Posizioni, Movimenti, Depositi).
- Create: `scripts/xlsx_to_json.py` — script di conversione Excel → JSON, con la funzione di calcolo del prezzo medio.
- Create: `scripts/test_xlsx_to_json.py` — test pytest per lo script.
- Create: `scripts/seed_finanze_xlsx.py` — script one-off che crea `data/finanze.xlsx` a partire dai dati oggi hardcoded nel sito (`SEED_INVEST`/`SEED_DEPOSITI`).
- Create: `investimenti.json`, `depositi.json` — generati dallo script, root del sito.
- Modify: `index.html` — stato, logica di calcolo, dialog, fetch, bottone "Copia per Claude".
- Modify: `README.md` — documenta il nuovo workflow.

---

### Task 1: Funzione di calcolo del prezzo medio di carico (Python, TDD)

**Files:**
- Create: `scripts/xlsx_to_json.py`
- Test: `scripts/test_xlsx_to_json.py`

**Interfaces:**
- Produces: `apply_movimento(quantita: float, costo_totale: float, movimento: dict) -> tuple[float, float]` — dato lo stato corrente (quantità, costo totale investito) e un movimento (`{"tipo": "Acquisto"|"Vendita", "quantita": float, "prezzo": float}`), restituisce la nuova coppia `(quantita, costo_totale)`.
- Produces: `compute_posizione(base: dict, movimenti: list[dict]) -> dict` — dato un dict base (con almeno `nome`) e la lista completa di movimenti (di tutti gli strumenti, filtrata internamente per `nome`), restituisce `base` con `quantita` e `prezzoCarico` calcolati (arrotondati a 6 decimali). Se la quantità risultante è 0, `prezzoCarico` è 0.
- Produces: costanti `POSIZIONI_HEADERS = ["nome", "tipo", "isin", "quantita", "prezzoCarico", "valoreAttuale", "rangeMin", "rangeMax", "quotaMarco", "note"]`, `MOVIMENTI_HEADERS = ["data", "nome", "tipo", "quantita", "prezzo", "note"]`, `DEPOSITI_HEADERS = ["persona", "importo", "data", "note"]`.

- [ ] **Step 1: Scrivi i test per `apply_movimento` e `compute_posizione`**

Crea `scripts/test_xlsx_to_json.py`:

```python
import pytest

import xlsx_to_json as x2j


def test_apply_movimento_singolo_acquisto():
    quantita, costo = x2j.apply_movimento(0, 0, {"tipo": "Acquisto", "quantita": 10, "prezzo": 5})
    assert quantita == 10
    assert costo == 50


def test_apply_movimento_due_acquisti_media_ponderata():
    quantita, costo = x2j.apply_movimento(0, 0, {"tipo": "Acquisto", "quantita": 100, "prezzo": 10})
    quantita, costo = x2j.apply_movimento(quantita, costo, {"tipo": "Acquisto", "quantita": 50, "prezzo": 16})
    assert quantita == 150
    assert costo == pytest.approx(100 * 10 + 50 * 16)


def test_apply_movimento_vendita_riduce_quantita_mantiene_prezzo_medio():
    quantita, costo = x2j.apply_movimento(0, 0, {"tipo": "Acquisto", "quantita": 100, "prezzo": 10})
    quantita, costo = x2j.apply_movimento(quantita, costo, {"tipo": "Vendita", "quantita": 40, "prezzo": 20})
    assert quantita == 60
    assert costo == pytest.approx(600)  # prezzo medio resta 10, tolti 40*10 di costo


def test_apply_movimento_vendita_totale_azzera_costo():
    quantita, costo = x2j.apply_movimento(0, 0, {"tipo": "Acquisto", "quantita": 10, "prezzo": 5})
    quantita, costo = x2j.apply_movimento(quantita, costo, {"tipo": "Vendita", "quantita": 10, "prezzo": 8})
    assert quantita == 0
    assert costo == pytest.approx(0)


def test_compute_posizione_media_ponderata_su_due_acquisti():
    base = {"nome": "ETF Test", "tipo": "ETF", "isin": "", "valoreAttuale": 10, "rangeMin": 0, "rangeMax": 0, "quotaMarco": 50, "note": ""}
    movimenti = [
        {"nome": "ETF Test", "tipo": "Acquisto", "quantita": 100, "prezzo": 10},
        {"nome": "ETF Test", "tipo": "Acquisto", "quantita": 50, "prezzo": 16},
        {"nome": "Altro Strumento", "tipo": "Acquisto", "quantita": 999, "prezzo": 1},
    ]
    result = x2j.compute_posizione(base, movimenti)
    assert result["nome"] == "ETF Test"
    assert result["quantita"] == 150
    assert result["prezzoCarico"] == pytest.approx((100 * 10 + 50 * 16) / 150)


def test_compute_posizione_quantita_zero_prezzo_carico_zero():
    base = {"nome": "ETF Vuoto", "tipo": "ETF", "isin": "", "valoreAttuale": 10, "rangeMin": 0, "rangeMax": 0, "quotaMarco": 50, "note": ""}
    result = x2j.compute_posizione(base, [])
    assert result["quantita"] == 0
    assert result["prezzoCarico"] == 0
```

- [ ] **Step 2: Esegui i test e verifica che falliscano (il modulo non esiste ancora)**

Run: `cd scripts && python -m pytest test_xlsx_to_json.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'xlsx_to_json'`

- [ ] **Step 3: Crea `scripts/xlsx_to_json.py` con le sole funzioni di calcolo**

```python
#!/usr/bin/env python3
"""Rigenera investimenti.json e depositi.json a partire da data/finanze.xlsx."""
import datetime
import json
import pathlib
import re
import sys

import openpyxl

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
XLSX_PATH = REPO_ROOT / "data" / "finanze.xlsx"
INVESTIMENTI_JSON = REPO_ROOT / "investimenti.json"
DEPOSITI_JSON = REPO_ROOT / "depositi.json"

POSIZIONI_HEADERS = ["nome", "tipo", "isin", "quantita", "prezzoCarico", "valoreAttuale", "rangeMin", "rangeMax", "quotaMarco", "note"]
MOVIMENTI_HEADERS = ["data", "nome", "tipo", "quantita", "prezzo", "note"]
DEPOSITI_HEADERS = ["persona", "importo", "data", "note"]


def apply_movimento(quantita, costo_totale, movimento):
    if movimento["tipo"] == "Acquisto":
        quantita += movimento["quantita"]
        costo_totale += movimento["quantita"] * movimento["prezzo"]
    elif movimento["tipo"] == "Vendita":
        if quantita > 0:
            prezzo_medio = costo_totale / quantita
            costo_totale -= prezzo_medio * movimento["quantita"]
        quantita -= movimento["quantita"]
    return quantita, costo_totale


def compute_posizione(base, movimenti):
    quantita, costo_totale = 0.0, 0.0
    for m in movimenti:
        if m["nome"] != base["nome"]:
            continue
        quantita, costo_totale = apply_movimento(quantita, costo_totale, m)
    prezzo_carico = costo_totale / quantita if quantita > 0 else 0.0
    return {**base, "quantita": round(quantita, 6), "prezzoCarico": round(prezzo_carico, 6)}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `cd scripts && python -m pytest test_xlsx_to_json.py -v`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add scripts/xlsx_to_json.py scripts/test_xlsx_to_json.py
git commit -m "Add weighted-average cost calculation for Excel-driven investments"
```

---

### Task 2: Lettura workbook e generazione JSON (I/O dello script)

**Files:**
- Modify: `scripts/xlsx_to_json.py`
- Test: `scripts/test_xlsx_to_json.py`

**Interfaces:**
- Consumes: `apply_movimento`, `compute_posizione`, `POSIZIONI_HEADERS`, `MOVIMENTI_HEADERS`, `DEPOSITI_HEADERS`, `XLSX_PATH`, `INVESTIMENTI_JSON`, `DEPOSITI_JSON` da Task 1.
- Produces: `load_workbook_data(xlsx_path) -> tuple[Workbook, list[dict], list[dict], list[dict]]` (posizioni, movimenti, depositi — con `data` già convertita in stringa `YYYY-MM-DD`).
- Produces: `slugify(nome: str) -> str`.
- Produces: `build_investimenti_json(posizioni_computed: list[dict]) -> dict`, `build_depositi_json(depositi: list[dict]) -> dict`.
- Produces: `main() -> None` — legge `XLSX_PATH`, scrive i due file JSON e riscrive quantita/prezzoCarico nel foglio Posizioni del workbook stesso.

- [ ] **Step 1: Aggiungi il test di integrazione (workbook di prova in `tmp_path`)**

Aggiungi in fondo a `scripts/test_xlsx_to_json.py`:

```python
import datetime
import json

import openpyxl


def _build_test_workbook(path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    ws_pos = wb.create_sheet("Posizioni")
    ws_pos.append(x2j.POSIZIONI_HEADERS)
    ws_pos.append(["ETF Test", "ETF", "IE000000", 0, 0, 12.0, 8.0, 15.0, 50, "Nota"])
    ws_mov = wb.create_sheet("Movimenti")
    ws_mov.append(x2j.MOVIMENTI_HEADERS)
    ws_mov.append([datetime.date(2026, 1, 1), "ETF Test", "Acquisto", 10, 5, ""])
    ws_mov.append([datetime.date(2026, 2, 1), "ETF Test", "Acquisto", 10, 7, ""])
    ws_dep = wb.create_sheet("Depositi")
    ws_dep.append(x2j.DEPOSITI_HEADERS)
    ws_dep.append(["Marco", 1000, datetime.date(2026, 1, 5), "Nota deposito"])
    wb.save(path)


def test_load_workbook_data_converte_date_in_stringa(tmp_path):
    xlsx_path = tmp_path / "finanze.xlsx"
    _build_test_workbook(xlsx_path)
    wb, posizioni, movimenti, depositi = x2j.load_workbook_data(xlsx_path)
    assert posizioni[0]["nome"] == "ETF Test"
    assert movimenti[0]["data"] == "2026-01-01"
    assert depositi[0]["data"] == "2026-01-05"


def test_main_genera_json_e_riscrive_workbook(tmp_path, monkeypatch):
    xlsx_path = tmp_path / "finanze.xlsx"
    _build_test_workbook(xlsx_path)
    investimenti_json = tmp_path / "investimenti.json"
    depositi_json = tmp_path / "depositi.json"
    monkeypatch.setattr(x2j, "XLSX_PATH", xlsx_path)
    monkeypatch.setattr(x2j, "INVESTIMENTI_JSON", investimenti_json)
    monkeypatch.setattr(x2j, "DEPOSITI_JSON", depositi_json)

    x2j.main()

    inv_data = json.loads(investimenti_json.read_text(encoding="utf-8"))
    assert inv_data["investimenti"][0]["nome"] == "ETF Test"
    assert inv_data["investimenti"][0]["quantita"] == 20
    assert inv_data["investimenti"][0]["prezzoCarico"] == pytest.approx(6.0)
    assert inv_data["investimenti"][0]["id"] == "fin-etf-test"

    dep_data = json.loads(depositi_json.read_text(encoding="utf-8"))
    assert dep_data["depositi"][0]["persona"] == "Marco"
    assert dep_data["depositi"][0]["importo"] == 1000
    assert dep_data["depositi"][0]["id"] == "dep-1"

    wb_after = openpyxl.load_workbook(xlsx_path)
    ws_pos = wb_after["Posizioni"]
    assert ws_pos.cell(row=2, column=4).value == 20
    assert ws_pos.cell(row=2, column=5).value == pytest.approx(6.0)
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `cd scripts && python -m pytest test_xlsx_to_json.py -v`
Expected: FAIL su `test_load_workbook_data_converte_date_in_stringa` e `test_main_genera_json_e_riscrive_workbook` con `AttributeError` (le funzioni non esistono ancora)

- [ ] **Step 3: Implementa `load_workbook_data`, `slugify`, `build_investimenti_json`, `build_depositi_json`, `main`**

Aggiungi in fondo a `scripts/xlsx_to_json.py`:

```python
def _iso_date(value):
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.strftime("%Y-%m-%d")
    return str(value) if value is not None else ""


def _sheet_rows(ws, headers):
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row[0] is None:
            continue
        rows.append(dict(zip(headers, row)))
    return rows


def load_workbook_data(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path)
    posizioni = _sheet_rows(wb["Posizioni"], POSIZIONI_HEADERS)
    movimenti = _sheet_rows(wb["Movimenti"], MOVIMENTI_HEADERS)
    depositi = _sheet_rows(wb["Depositi"], DEPOSITI_HEADERS)
    for m in movimenti:
        m["data"] = _iso_date(m["data"])
    for d in depositi:
        d["data"] = _iso_date(d["data"])
    return wb, posizioni, movimenti, depositi


def slugify(nome):
    return re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-")


def _write_computed_posizioni(wb, posizioni_computed):
    ws = wb["Posizioni"]
    by_nome = {p["nome"]: p for p in posizioni_computed}
    for row_idx in range(2, ws.max_row + 1):
        nome = ws.cell(row=row_idx, column=1).value
        if nome is None:
            continue
        p = by_nome.get(nome)
        if not p:
            continue
        ws.cell(row=row_idx, column=4).value = p["quantita"]
        ws.cell(row=row_idx, column=5).value = p["prezzoCarico"]


def build_investimenti_json(posizioni_computed):
    return {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "investimenti": [
            {
                "id": "fin-" + slugify(p["nome"]),
                "nome": p["nome"],
                "tipo": p["tipo"],
                "isin": p["isin"] or "",
                "quantita": p["quantita"],
                "prezzoCarico": p["prezzoCarico"],
                "valoreAttuale": p["valoreAttuale"],
                "rangeMin": p["rangeMin"],
                "rangeMax": p["rangeMax"],
                "quotaMarco": p["quotaMarco"],
                "note": p["note"] or "",
            }
            for p in posizioni_computed
        ],
    }


def build_depositi_json(depositi):
    return {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "depositi": [
            {
                "id": "dep-" + str(i),
                "persona": d["persona"],
                "importo": d["importo"],
                "data": d["data"],
                "note": d["note"] or "",
            }
            for i, d in enumerate(depositi, start=1)
        ],
    }


def main():
    wb, posizioni, movimenti, depositi = load_workbook_data(XLSX_PATH)
    posizioni_computed = [compute_posizione(p, movimenti) for p in posizioni]
    _write_computed_posizioni(wb, posizioni_computed)
    wb.save(XLSX_PATH)
    INVESTIMENTI_JSON.write_text(
        json.dumps(build_investimenti_json(posizioni_computed), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    DEPOSITI_JSON.write_text(
        json.dumps(build_depositi_json(depositi), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Scritti {INVESTIMENTI_JSON.name} ({len(posizioni_computed)} posizioni) e {DEPOSITI_JSON.name} ({len(depositi)} depositi).")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `cd scripts && python -m pytest test_xlsx_to_json.py -v`
Expected: PASS (8 test)

- [ ] **Step 5: Commit**

```bash
git add scripts/xlsx_to_json.py scripts/test_xlsx_to_json.py
git commit -m "Add Excel-to-JSON conversion for investimenti/depositi"
```

---

### Task 3: Crea `data/finanze.xlsx` con i dati storici e genera i JSON iniziali

**Files:**
- Create: `scripts/seed_finanze_xlsx.py`
- Create: `data/finanze.xlsx` (generato dallo script)
- Create: `investimenti.json`, `depositi.json` (generati da `xlsx_to_json.py`)

**Interfaces:**
- Consumes: `POSIZIONI_HEADERS`, `MOVIMENTI_HEADERS`, `DEPOSITI_HEADERS`, `XLSX_PATH` da `scripts/xlsx_to_json.py` (Task 1/2).

I dati storici da riportare sono quelli oggi hardcoded in `index.html` (`SEED_INVEST` righe 966-972, `SEED_DEPOSITI` righe 959-964). Ogni posizione viene bootstrappata con un unico movimento "Acquisto" che riproduce la quantità/prezzo di carico attuali, datato 2026-08-12 (data di questa migrazione), così lo storico riparte da qui in avanti.

- [ ] **Step 1: Crea `scripts/seed_finanze_xlsx.py`**

```python
#!/usr/bin/env python3
"""Crea il workbook iniziale data/finanze.xlsx a partire dai dati storici del sito."""
import datetime
import pathlib

import openpyxl

import xlsx_to_json as x2j

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
XLSX_PATH = REPO_ROOT / "data" / "finanze.xlsx"

POSIZIONI_SEED = [
    ("ETF iShares MSCI World", "ETF", "IE00B4L5Y983", 45.2, 42, 50, 50, "PAC mensile, orizzonte 15+ anni"),
    ("ETF Vanguard FTSE All-World", "ETF", "IE00BK5BQT80", 99.8, 90, 110, 40, ""),
    ("Azioni Enel", "Azioni", "IT0003128367", 6.85, 6, 7.5, 100, "Dividendo interessante"),
    ("Oro fisico (lingotti)", "Oro", "", 2050, 1900, 2200, 50, "Copertura patrimoniale"),
    ("Bitcoin", "Crypto", "", 58000, 45000, 70000, 70, ""),
]

MOVIMENTI_SEED_BOOTSTRAP = [
    ("ETF iShares MSCI World", 120, 38.5),
    ("ETF Vanguard FTSE All-World", 60, 95),
    ("Azioni Enel", 200, 6.1),
    ("Oro fisico (lingotti)", 3, 1850),
    ("Bitcoin", 0.15, 42000),
]

DEPOSITI_SEED = [
    ("Marco", 8000, datetime.date(2026, 2, 10), "Bonus annuale"),
    ("Eugenia", 6000, datetime.date(2026, 2, 15), ""),
    ("Marco", 4000, datetime.date(2026, 5, 3), ""),
    ("Eugenia", 5390, datetime.date(2026, 6, 20), "Tredicesima"),
]

BOOTSTRAP_DATE = datetime.date(2026, 8, 12)


def main():
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    ws_pos = wb.create_sheet("Posizioni")
    ws_pos.append(x2j.POSIZIONI_HEADERS)
    for nome, tipo, isin, valore_attuale, range_min, range_max, quota_marco, note in POSIZIONI_SEED:
        ws_pos.append([nome, tipo, isin, 0, 0, valore_attuale, range_min, range_max, quota_marco, note])

    ws_mov = wb.create_sheet("Movimenti")
    ws_mov.append(x2j.MOVIMENTI_HEADERS)
    for nome, quantita, prezzo in MOVIMENTI_SEED_BOOTSTRAP:
        ws_mov.append([BOOTSTRAP_DATE, nome, "Acquisto", quantita, prezzo, "Saldo iniziale importato dal sito"])

    ws_dep = wb.create_sheet("Depositi")
    ws_dep.append(x2j.DEPOSITI_HEADERS)
    for persona, importo, data, note in DEPOSITI_SEED:
        ws_dep.append([persona, importo, data, note])

    XLSX_PATH.parent.mkdir(parents=True, exist_ok=True)
    wb.save(XLSX_PATH)
    print(f"Creato {XLSX_PATH}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Esegui lo script di seed**

Run: `cd scripts && python seed_finanze_xlsx.py`
Expected: stampa `Creato .../data/finanze.xlsx`, il file esiste con 3 fogli (Posizioni, Movimenti, Depositi)

- [ ] **Step 3: Genera i JSON iniziali dal workbook appena creato**

Run: `cd scripts && python xlsx_to_json.py`
Expected: stampa `Scritti investimenti.json (5 posizioni) e depositi.json (4 depositi).`; i due file compaiono nella root del repo

- [ ] **Step 4: Verifica manualmente i valori generati**

Run: `python -c "import json; d = json.load(open('investimenti.json')); [print(p['nome'], p['quantita'], p['prezzoCarico']) for p in d['investimenti']]"`
Expected output (5 righe): valori identici a quelli hardcoded oggi in `SEED_INVEST` (es. `ETF iShares MSCI World 120 38.5`, `Bitcoin 0.15 42000`, ecc.) — conferma che la migrazione non ha alterato i dati esistenti.

- [ ] **Step 5: Commit**

```bash
git add data/finanze.xlsx investimenti.json depositi.json scripts/seed_finanze_xlsx.py
git commit -m "Seed data/finanze.xlsx and generate initial investimenti/depositi JSON"
```

---

### Task 4: `index.html` — stato, calcolo e caricamento dati (logica, senza markup)

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `investimenti.json` (`{generatedAt, investimenti: [{id, nome, tipo, isin, quantita, prezzoCarico, valoreAttuale, rangeMin, rangeMax, quotaMarco, note}]}`), `depositi.json` (`{generatedAt, depositi: [{id, persona, importo, data, note}]}`) da Task 3.
- Produces: metodo `applyMovimento(pos, movimento)` sulla classe `Component` — mirror JS di `apply_movimento`/`compute_posizione` lato Python, usato sia da `addMovimento` sia dal caricamento iniziale.
- Produces: metodi `addMovimento`, `addDeposito` (aggiornato), `copyPerClaude` sulla classe `Component`.
- Produces: nuovi campi di stato: `movimenti: []`, `newMovNome`, `newMovTipo`, `newMovQuantita`, `newMovPrezzo`, `newMovData`, `newMovNote`, `newMovTipoStrumento`, `newMovIsin`, `newMovValore`, `newMovRangeMin`, `newMovRangeMax`, `newMovQuotaMarco`, `copyFeedback`.

Questo task modifica solo la logica (stato + metodi + `componentDidMount` + `persist`); il markup dei dialog viene aggiornato nel Task 5. Fino alla fine del Task 5 il sito non sarà nello stato finale visualizzabile — è normale, i due task vanno eseguiti in sequenza prima di verificare nel browser (Task 6).

- [ ] **Step 1: Aggiungi i nuovi campi di stato**

In `index.html`, trova questa riga nel blocco `state = {...}` della classe `Component` (contiene `investDialogOpen: false, newInvNome: ""`):

```js
    investimenti: [], investDialogOpen: false, newInvNome: "", newInvTipo: "ETF", newInvIsin: "", newInvQuantita: "", newInvPrezzo: "", newInvValore: "", newInvRangeMin: "", newInvRangeMax: "", newInvQuotaMarco: "50", newInvNote: "",
    parametri: [], farmaci: [], saluteFilter: "Tutti",
    portfolioHistory: [],
    depositi: [], depositoDialogOpen: false, newDepositoPersona: "Marco", newDepositoImporto: "", newDepositoData: "", newDepositoNote: "",
```

Sostituiscila con:

```js
    investimenti: [], movimenti: [], investDialogOpen: false,
    newMovNome: "", newMovTipo: "Acquisto", newMovQuantita: "", newMovPrezzo: "", newMovData: "", newMovNote: "",
    newMovTipoStrumento: "ETF", newMovIsin: "", newMovValore: "", newMovRangeMin: "", newMovRangeMax: "", newMovQuotaMarco: "50",
    parametri: [], farmaci: [], saluteFilter: "Tutti",
    portfolioHistory: [],
    depositi: [], depositoDialogOpen: false, newDepositoPersona: "Marco", newDepositoImporto: "", newDepositoData: "", newDepositoNote: "",
    copyFeedback: "",
```

- [ ] **Step 2: Restaura `movimenti` da `localStorage` in `componentDidMount`**

Trova (dentro `componentDidMount`, blocco di restore da `localStorage`):

```js
          depositi: data.depositi || SEED_DEPOSITI,
```

Sostituiscila con:

```js
          depositi: (data.depositi || SEED_DEPOSITI).map((d) => ({ synced: true, ...d })),
          movimenti: data.movimenti || [],
```

- [ ] **Step 3: Aggiungi `applyMovimento` come metodo della classe**

Trova il metodo `buildAllocationPie() {` e aggiungi subito prima (stesso livello di indentazione dei metodi della classe):

```js
  applyMovimento(pos, movimento) {
    let quantita = pos.quantita || 0;
    let costoTotale = (pos.quantita || 0) * (pos.prezzoCarico || 0);
    if (movimento.tipo === "Acquisto") {
      quantita += movimento.quantita;
      costoTotale += movimento.quantita * movimento.prezzo;
    } else if (movimento.tipo === "Vendita") {
      if (quantita > 0) {
        const prezzoMedio = costoTotale / quantita;
        costoTotale -= prezzoMedio * movimento.quantita;
      }
      quantita -= movimento.quantita;
    }
    const prezzoCarico = quantita > 0 ? costoTotale / quantita : 0;
    return { ...pos, quantita, prezzoCarico };
  }
```

- [ ] **Step 4: Sostituisci `addInvest` con `addMovimento`**

Trova:

```js
  openInvestDialog = () => this.setState({ investDialogOpen: true, newInvNome: "", newInvTipo: "ETF", newInvIsin: "", newInvQuantita: "", newInvPrezzo: "", newInvValore: "", newInvRangeMin: "", newInvRangeMax: "", newInvQuotaMarco: "50", newInvNote: "" });
  closeInvestDialog = () => this.setState({ investDialogOpen: false });
  addInvest = () => {
    if (!this.state.newInvNome.trim()) return;
    const entry = {
      id: this.nextId++, nome: this.state.newInvNome.trim(), tipo: this.state.newInvTipo, isin: this.state.newInvIsin.trim(),
      quantita: parseFloat(this.state.newInvQuantita) || 0, prezzoCarico: parseFloat(this.state.newInvPrezzo) || 0,
      valoreAttuale: parseFloat(this.state.newInvValore) || 0,
      rangeMin: parseFloat(this.state.newInvRangeMin) || 0, rangeMax: parseFloat(this.state.newInvRangeMax) || 0,
      quotaMarco: Math.max(0, Math.min(100, parseFloat(this.state.newInvQuotaMarco) || 0)),
      note: this.state.newInvNote.trim()
    };
    this.setState({ investimenti: [entry, ...this.state.investimenti], investDialogOpen: false }, this.persist);
  };
```

Sostituiscila con:

```js
  openInvestDialog = () => this.setState({
    investDialogOpen: true, newMovNome: "", newMovTipo: "Acquisto", newMovQuantita: "", newMovPrezzo: "", newMovData: "", newMovNote: "",
    newMovTipoStrumento: "ETF", newMovIsin: "", newMovValore: "", newMovRangeMin: "", newMovRangeMax: "", newMovQuotaMarco: "50"
  });
  closeInvestDialog = () => this.setState({ investDialogOpen: false });
  addMovimento = () => {
    const nome = this.state.newMovNome.trim();
    const quantita = parseFloat(this.state.newMovQuantita);
    const prezzo = parseFloat(this.state.newMovPrezzo);
    if (!nome || !(quantita > 0) || !(prezzo >= 0)) return;
    const movimento = {
      id: this.nextId++, nome, tipo: this.state.newMovTipo, quantita, prezzo,
      data: this.state.newMovData || toDateStr(new Date()), note: this.state.newMovNote.trim(), synced: false
    };
    const existing = this.state.investimenti.find((i) => i.nome === nome);
    const base = existing || {
      id: this.nextId++, nome, tipo: this.state.newMovTipoStrumento, isin: this.state.newMovIsin.trim(),
      quantita: 0, prezzoCarico: 0, valoreAttuale: parseFloat(this.state.newMovValore) || 0,
      rangeMin: parseFloat(this.state.newMovRangeMin) || 0, rangeMax: parseFloat(this.state.newMovRangeMax) || 0,
      quotaMarco: Math.max(0, Math.min(100, parseFloat(this.state.newMovQuotaMarco) || 0)), note: ""
    };
    const updated = this.applyMovimento(base, movimento);
    const investimenti = existing
      ? this.state.investimenti.map((i) => i.nome === nome ? updated : i)
      : [updated, ...this.state.investimenti];
    this.setState({ movimenti: [movimento, ...this.state.movimenti], investimenti, investDialogOpen: false }, this.persist);
  };
```

- [ ] **Step 5: Aggiungi `synced: false` in `addDeposito`**

Trova:

```js
  addDeposito = () => {
    if (!this.state.newDepositoImporto || !(parseFloat(this.state.newDepositoImporto) > 0)) return;
    const entry = { id: this.nextId++, persona: this.state.newDepositoPersona, importo: parseFloat(this.state.newDepositoImporto), data: this.state.newDepositoData || toDateStr(new Date()), note: this.state.newDepositoNote.trim() };
    this.setState({ depositi: [entry, ...this.state.depositi], depositoDialogOpen: false }, this.persist);
  };
```

Sostituiscila con:

```js
  addDeposito = () => {
    if (!this.state.newDepositoImporto || !(parseFloat(this.state.newDepositoImporto) > 0)) return;
    const entry = { id: this.nextId++, persona: this.state.newDepositoPersona, importo: parseFloat(this.state.newDepositoImporto), data: this.state.newDepositoData || toDateStr(new Date()), note: this.state.newDepositoNote.trim(), synced: false };
    this.setState({ depositi: [entry, ...this.state.depositi], depositoDialogOpen: false }, this.persist);
  };
  copyPerClaude = () => {
    const pendingMov = this.state.movimenti.filter((m) => m.synced === false);
    const pendingDep = this.state.depositi.filter((d) => d.synced === false);
    const lines = [];
    pendingMov.forEach((m) => lines.push(
      m.data + ": " + (m.tipo === "Acquisto" ? "comprate" : "vendute") + " " + m.quantita + " quote di " + m.nome + " a " + m.prezzo + "€" + (m.note ? " (" + m.note + ")" : "")
    ));
    pendingDep.forEach((d) => lines.push(
      d.data + ": versati " + d.importo + "€ da " + d.persona + (d.note ? " (" + d.note + ")" : "")
    ));
    const text = lines.length ? lines.join("\n") : "Nessun aggiornamento da sincronizzare.";
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    const movimenti = this.state.movimenti.map((m) => pendingMov.includes(m) ? { ...m, synced: true } : m);
    const depositi = this.state.depositi.map((d) => pendingDep.includes(d) ? { ...d, synced: true } : d);
    this.setState({ movimenti, depositi, copyFeedback: text }, this.persist);
  };
```

- [ ] **Step 6: Aggiungi `movimenti` a `persist()`**

Trova:

```js
  persist = () => {
    try { localStorage.setItem("vita-dash-v1", JSON.stringify({ film: this.state.film, appunti: this.state.appunti, events: this.state.events, habits: this.state.habits, investimenti: this.state.investimenti, parametri: this.state.parametri, farmaci: this.state.farmaci, libri: this.state.libri, portfolioHistory: this.state.portfolioHistory, depositi: this.state.depositi, nextId: this.nextId })); } catch (e) {}
  };
```

Sostituiscila con:

```js
  persist = () => {
    try { localStorage.setItem("vita-dash-v1", JSON.stringify({ film: this.state.film, appunti: this.state.appunti, events: this.state.events, habits: this.state.habits, investimenti: this.state.investimenti, movimenti: this.state.movimenti, parametri: this.state.parametri, farmaci: this.state.farmaci, libri: this.state.libri, portfolioHistory: this.state.portfolioHistory, depositi: this.state.depositi, nextId: this.nextId })); } catch (e) {}
  };
```

- [ ] **Step 7: Aggiungi il fetch di `investimenti.json`/`depositi.json` in `componentDidMount`, con riconciliazione dei movimenti locali non sincronizzati**

Trova (il blocco `fetch("prices.json")` in `componentDidMount`):

```js
    fetch("prices.json").then((r) => r.json()).then((data) => {
      const prices = (data && data.prices) || {};
      this.setState({
        investimenti: this.state.investimenti.map((inv) => {
          const sym = SYMBOL_BY_NOME[inv.nome];
          const fresh = sym && prices[sym];
          if (!fresh || fresh.currency !== "EUR") return inv;
          return { ...inv, valoreAttuale: fresh.value, prezzoAggiornatoAl: fresh.asOf };
        })
      }, this.persist);
    }).catch(() => {});
```

Aggiungi subito prima di questo blocco (così `investimenti.json` viene applicato prima di `prices.json`, che deve restare l'ultimo a sovrascrivere `valoreAttuale`):

```js
    fetch("investimenti.json").then((r) => r.json()).then((data) => {
      const base = (data && data.investimenti) || [];
      this.setState((prev) => {
        const byName = {};
        base.forEach((b) => { byName[b.nome] = { ...b }; });
        const merged = Object.values(byName);
        prev.investimenti.forEach((local) => { if (!byName[local.nome]) merged.push(local); });
        const pending = prev.movimenti.filter((m) => m.synced === false);
        pending.forEach((m) => {
          const idx = merged.findIndex((i) => i.nome === m.nome);
          if (idx >= 0) {
            merged[idx] = this.applyMovimento(merged[idx], m);
          } else {
            const blank = { id: "local-" + m.nome, nome: m.nome, tipo: "Altro", isin: "", quantita: 0, prezzoCarico: 0, valoreAttuale: 0, rangeMin: 0, rangeMax: 0, quotaMarco: 50, note: "" };
            merged.push(this.applyMovimento(blank, m));
          }
        });
        return { investimenti: merged };
      }, this.persist);
    }).catch(() => {});
    fetch("depositi.json").then((r) => r.json()).then((data) => {
      const base = ((data && data.depositi) || []).map((d) => ({ ...d, synced: true }));
      this.setState((prev) => {
        const baseIds = new Set(base.map((b) => b.id));
        const localOnly = prev.depositi.filter((d) => !baseIds.has(d.id) && d.synced === false);
        return { depositi: [...base, ...localOnly] };
      }, this.persist);
    }).catch(() => {});
```

- [ ] **Step 8: Salva il file e verifica che sia ancora JavaScript valido**

Run: `python -c "import re,sys; s=open('index.html',encoding='utf-8').read(); import subprocess; print('script tags:', s.count('<script'))"`

Poi estrai ed esegui una sintassi-check dello script inline con Node se disponibile, altrimenti apri il file in un editor e verifica manualmente che le parentesi graffe del blocco `state = {...}` e dei metodi aggiunti siano bilanciate (nessun editor automatico qui esegue JS — la verifica reale avviene nel browser al Task 6).

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "Add investimenti/depositi.json fetch and average-cost calculation to the site"
```

---

### Task 5: `index.html` — dialog "Registra movimento" e bottone "Copia per Claude" (markup)

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `addMovimento`, `copyPerClaude`, `applyMovimento`, i campi di stato `newMov*`/`copyFeedback` da Task 4.
- Produces: bindings nel metodo `renderVals()` per i nuovi campi (`newMovNome`, `onNewMovNomeChange`, ecc.) e per `copyPerClaude`/`copyFeedback`/`pendingSyncCount`.

- [ ] **Step 1: Sostituisci il markup del dialog investimenti**

Trova (blocco `<sc-if value="{{ investDialogOpen }}"` fino al relativo `</sc-if>` di chiusura — contiene `<div class="dialog-title">Nuova posizione</div>` e i campi `newInvNome`/`newInvQuantita`/ecc.):

```html
  <sc-if value="{{ investDialogOpen }}" hint-placeholder-val="{{ false }}">
    <div class="dialog-backdrop" style="overflow-y:auto;padding:24px 0;align-items:flex-start;" onClick="{{ closeInvestDialog }}">
      <div class="dialog" style="max-height:calc(100vh - 48px);overflow-y:auto;" onClick="{{ stopProp }}">
        <div class="dialog-title">Nuova posizione</div>
        <div class="field">
          <label>Nome titolo/ETF</label>
          <input class="input" type="text" value="{{ newInvNome }}" onChange="{{ onNewInvNomeChange }}" placeholder="Es. ETF Vanguard FTSE All-World">
        </div>
        <div class="field">
          <label>Tipo</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <sc-for list="{{ investTipoOptions }}" as="t" hint-placeholder-count="5">
              <button style="{{ t.style }}" onClick="{{ t.onClick }}">{{ t.label }}</button>
            </sc-for>
          </div>
        </div>
        <div class="field">
          <label>ISIN (opzionale)</label>
          <input class="input" type="text" value="{{ newInvIsin }}" onChange="{{ onNewInvIsinChange }}" placeholder="Es. IE00BK5BQT80">
        </div>
        <div class="field">
          <label>Quantità</label>
          <input class="input" type="number" value="{{ newInvQuantita }}" onChange="{{ onNewInvQuantitaChange }}" placeholder="0">
        </div>
        <div class="field">
          <label>Prezzo di carico</label>
          <input class="input" type="number" value="{{ newInvPrezzo }}" onChange="{{ onNewInvPrezzoChange }}" placeholder="0.00">
        </div>
        <div class="field">
          <label>Valore attuale</label>
          <input class="input" type="number" value="{{ newInvValore }}" onChange="{{ onNewInvValoreChange }}" placeholder="0.00">
        </div>
        <div class="field" style="display:flex;gap:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;margin-bottom:5px;">Range atteso min</label>
            <input class="input" type="number" value="{{ newInvRangeMin }}" onChange="{{ onNewInvRangeMinChange }}" placeholder="0.00">
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;margin-bottom:5px;">Range atteso max</label>
            <input class="input" type="number" value="{{ newInvRangeMax }}" onChange="{{ onNewInvRangeMaxChange }}" placeholder="0.00">
          </div>
        </div>
        <div class="field">
          <label>Quota versata da Marco (%) — a Eugenia il {{ newInvQuotaEugeniaLabel }}</label>
          <input class="input" type="number" min="0" max="100" value="{{ newInvQuotaMarco }}" onChange="{{ onNewInvQuotaMarcoChange }}" placeholder="50">
        </div>
        <div class="field">
          <label>Note (opzionale)</label>
          <textarea class="input" value="{{ newInvNote }}" onChange="{{ onNewInvNoteChange }}" placeholder="Motivazione, strategia..."></textarea>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" onClick="{{ closeInvestDialog }}">Annulla</button>
          <button class="btn btn-primary" disabled="{{ newInvInvalid }}" onClick="{{ addInvest }}">Aggiungi</button>
        </div>
      </div>
    </div>
  </sc-if>
```

Sostituiscila con:

```html
  <sc-if value="{{ investDialogOpen }}" hint-placeholder-val="{{ false }}">
    <div class="dialog-backdrop" style="overflow-y:auto;padding:24px 0;align-items:flex-start;" onClick="{{ closeInvestDialog }}">
      <div class="dialog" style="max-height:calc(100vh - 48px);overflow-y:auto;" onClick="{{ stopProp }}">
        <div class="dialog-title">Registra movimento</div>
        <div class="field">
          <label>Strumento</label>
          <input class="input" type="text" value="{{ newMovNome }}" onChange="{{ onNewMovNomeChange }}" placeholder="Es. ETF Vanguard FTSE All-World">
        </div>
        <div class="field">
          <label>Tipo movimento</label>
          <div style="display:flex;gap:8px;">
            <button style="{{ movTipoAcquistoStyle }}" onClick="{{ setMovTipoAcquisto }}">Acquisto</button>
            <button style="{{ movTipoVenditaStyle }}" onClick="{{ setMovTipoVendita }}">Vendita</button>
          </div>
        </div>
        <div class="field">
          <label>Quantità</label>
          <input class="input" type="number" value="{{ newMovQuantita }}" onChange="{{ onNewMovQuantitaChange }}" placeholder="0">
        </div>
        <div class="field">
          <label>Prezzo operazione</label>
          <input class="input" type="number" value="{{ newMovPrezzo }}" onChange="{{ onNewMovPrezzoChange }}" placeholder="0.00">
        </div>
        <div class="field">
          <label>Data</label>
          <input class="input" type="date" value="{{ newMovData }}" onChange="{{ onNewMovDataChange }}">
        </div>
        <div class="field">
          <label>Note (opzionale)</label>
          <input class="input" type="text" value="{{ newMovNote }}" onChange="{{ onNewMovNoteChange }}" placeholder="Es. PAC mensile">
        </div>
        <p class="text-muted" style="font-size:12px;">I campi sotto contano solo se lo strumento è nuovo (non ancora presente nell'elenco posizioni).</p>
        <div class="field">
          <label>Tipo strumento (se nuovo)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <sc-for list="{{ investTipoOptions }}" as="t" hint-placeholder-count="5">
              <button style="{{ t.style }}" onClick="{{ t.onClick }}">{{ t.label }}</button>
            </sc-for>
          </div>
        </div>
        <div class="field">
          <label>ISIN (se nuovo, opzionale)</label>
          <input class="input" type="text" value="{{ newMovIsin }}" onChange="{{ onNewMovIsinChange }}" placeholder="Es. IE00BK5BQT80">
        </div>
        <div class="field">
          <label>Valore attuale (se nuovo)</label>
          <input class="input" type="number" value="{{ newMovValore }}" onChange="{{ onNewMovValoreChange }}" placeholder="0.00">
        </div>
        <div class="field" style="display:flex;gap:10px;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;margin-bottom:5px;">Range atteso min (se nuovo)</label>
            <input class="input" type="number" value="{{ newMovRangeMin }}" onChange="{{ onNewMovRangeMinChange }}" placeholder="0.00">
          </div>
          <div style="flex:1;">
            <label style="display:block;font-size:12px;margin-bottom:5px;">Range atteso max (se nuovo)</label>
            <input class="input" type="number" value="{{ newMovRangeMax }}" onChange="{{ onNewMovRangeMaxChange }}" placeholder="0.00">
          </div>
        </div>
        <div class="field">
          <label>Quota versata da Marco % (se nuovo)</label>
          <input class="input" type="number" min="0" max="100" value="{{ newMovQuotaMarco }}" onChange="{{ onNewMovQuotaMarcoChange }}" placeholder="50">
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" onClick="{{ closeInvestDialog }}">Annulla</button>
          <button class="btn btn-primary" disabled="{{ newMovInvalid }}" onClick="{{ addMovimento }}">Registra</button>
        </div>
      </div>
    </div>
  </sc-if>
```

- [ ] **Step 2: Aggiungi il bottone "Copia per Claude" e il riquadro di feedback nella sezione Investimenti**

Trova (subito dopo l'header "Investimenti" con il bottone "Aggiungi"):

```html
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;">
          <h1 style="margin:0;">Investimenti</h1>
          <button class="btn btn-primary" style="white-space:nowrap;" onClick="{{ openInvestDialog }}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
            Aggiungi
          </button>
        </div>
```

Sostituiscila con:

```html
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
          <h1 style="margin:0;">Investimenti</h1>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary" style="white-space:nowrap;" onClick="{{ copyPerClaude }}">
              Copia per Claude{{ pendingSyncLabel }}
            </button>
            <button class="btn btn-primary" style="white-space:nowrap;" onClick="{{ openInvestDialog }}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
              Registra movimento
            </button>
          </div>
        </div>
        <sc-if value="{{ hasCopyFeedback }}" hint-placeholder-val="{{ false }}">
          <div class="card elev-sm" style="margin-bottom:16px;padding:16px;">
            <div class="card-kicker" style="margin-bottom:8px;">Testo pronto per la chat con Claude</div>
            <textarea class="input" readonly style="min-height:80px;font-size:13px;">{{ copyFeedback }}</textarea>
          </div>
        </sc-if>
```

- [ ] **Step 3: Aggiungi i nuovi bindings in `renderVals()`**

Trova (il blocco che contiene `investDialogOpen: this.state.investDialogOpen, closeInvestDialog: ...` fino a `investTipoOptions: [...]`):

```js
      investDialogOpen: this.state.investDialogOpen, closeInvestDialog: this.closeInvestDialog, openInvestDialog: this.openInvestDialog, addInvest: this.addInvest,
      newInvNome: this.state.newInvNome, onNewInvNomeChange: (e) => this.setState({ newInvNome: e.target.value }),
      newInvIsin: this.state.newInvIsin, onNewInvIsinChange: (e) => this.setState({ newInvIsin: e.target.value }),
      newInvQuantita: this.state.newInvQuantita, onNewInvQuantitaChange: (e) => this.setState({ newInvQuantita: e.target.value }),
      newInvPrezzo: this.state.newInvPrezzo, onNewInvPrezzoChange: (e) => this.setState({ newInvPrezzo: e.target.value }),
      newInvValore: this.state.newInvValore, onNewInvValoreChange: (e) => this.setState({ newInvValore: e.target.value }),
      newInvNote: this.state.newInvNote, onNewInvNoteChange: (e) => this.setState({ newInvNote: e.target.value }),
      newInvRangeMin: this.state.newInvRangeMin, onNewInvRangeMinChange: (e) => this.setState({ newInvRangeMin: e.target.value }),
      newInvRangeMax: this.state.newInvRangeMax, onNewInvRangeMaxChange: (e) => this.setState({ newInvRangeMax: e.target.value }),
      newInvQuotaMarco: this.state.newInvQuotaMarco, onNewInvQuotaMarcoChange: (e) => this.setState({ newInvQuotaMarco: e.target.value }),
      newInvQuotaEugeniaLabel: Math.max(0, 100 - (parseFloat(this.state.newInvQuotaMarco) || 0)) + "%",
      newInvInvalid: !this.state.newInvNome.trim(),
      investTipoOptions: ["ETF", "Azioni", "Oro", "Crypto", "Altro"].map((t) => ({ label: t, style: this.chipStyle(this.state.newInvTipo === t), onClick: () => this.setState({ newInvTipo: t }) })),
```

Sostituiscila con:

```js
      investDialogOpen: this.state.investDialogOpen, closeInvestDialog: this.closeInvestDialog, openInvestDialog: this.openInvestDialog, addMovimento: this.addMovimento,
      newMovNome: this.state.newMovNome, onNewMovNomeChange: (e) => this.setState({ newMovNome: e.target.value }),
      movTipoAcquistoStyle: this.chipStyle(this.state.newMovTipo === "Acquisto"), movTipoVenditaStyle: this.chipStyle(this.state.newMovTipo === "Vendita"),
      setMovTipoAcquisto: () => this.setState({ newMovTipo: "Acquisto" }), setMovTipoVendita: () => this.setState({ newMovTipo: "Vendita" }),
      newMovQuantita: this.state.newMovQuantita, onNewMovQuantitaChange: (e) => this.setState({ newMovQuantita: e.target.value }),
      newMovPrezzo: this.state.newMovPrezzo, onNewMovPrezzoChange: (e) => this.setState({ newMovPrezzo: e.target.value }),
      newMovData: this.state.newMovData, onNewMovDataChange: (e) => this.setState({ newMovData: e.target.value }),
      newMovNote: this.state.newMovNote, onNewMovNoteChange: (e) => this.setState({ newMovNote: e.target.value }),
      newMovIsin: this.state.newMovIsin, onNewMovIsinChange: (e) => this.setState({ newMovIsin: e.target.value }),
      newMovValore: this.state.newMovValore, onNewMovValoreChange: (e) => this.setState({ newMovValore: e.target.value }),
      newMovRangeMin: this.state.newMovRangeMin, onNewMovRangeMinChange: (e) => this.setState({ newMovRangeMin: e.target.value }),
      newMovRangeMax: this.state.newMovRangeMax, onNewMovRangeMaxChange: (e) => this.setState({ newMovRangeMax: e.target.value }),
      newMovQuotaMarco: this.state.newMovQuotaMarco, onNewMovQuotaMarcoChange: (e) => this.setState({ newMovQuotaMarco: e.target.value }),
      newMovInvalid: !this.state.newMovNome.trim() || !(parseFloat(this.state.newMovQuantita) > 0) || !(parseFloat(this.state.newMovPrezzo) >= 0),
      investTipoOptions: ["ETF", "Azioni", "Oro", "Crypto", "Altro"].map((t) => ({ label: t, style: this.chipStyle(this.state.newMovTipoStrumento === t), onClick: () => this.setState({ newMovTipoStrumento: t }) })),
      copyPerClaude: this.copyPerClaude,
      copyFeedback: this.state.copyFeedback, hasCopyFeedback: !!this.state.copyFeedback,
      pendingSyncLabel: (() => {
        const n = this.state.movimenti.filter((m) => m.synced === false).length + this.state.depositi.filter((d) => d.synced === false).length;
        return n > 0 ? " (" + n + ")" : "";
      })(),
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Replace investment dialog with movement entry and add Copia per Claude"
```

---

### Task 6: Verifica manuale nel browser

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Avvia un server statico locale nella cartella del sito**

Run: `python -m http.server 8000` (dalla root del repo, quella con `index.html`)
Expected: `Serving HTTP on :: port 8000`

- [ ] **Step 2: Apri il sito nel browser Claude e naviga a Investimenti**

Usa `preview_start` con `{"url": "http://localhost:8000/index.html"}`, poi `computer` per navigare alla sezione "Investimenti" dal menu.
Expected: le 5 posizioni seed sono visibili con gli stessi valori di prima (quantità/prezzo di carico invariati rispetto a `SEED_INVEST`).

- [ ] **Step 3: Registra un secondo acquisto su una posizione esistente**

Clicca "Registra movimento", inserisci Strumento "ETF iShares MSCI World", Tipo "Acquisto", Quantità 10, Prezzo 46, Data odierna, conferma.
Expected: la card "ETF iShares MSCI World" mostra ora Quantità 130 e Prezzo di carico ricalcolato a `(120*38.5 + 10*46) / 130 ≈ 39.08`.

- [ ] **Step 4: Registra un movimento su uno strumento nuovo**

Clicca "Registra movimento", Strumento "Azioni Test Nuovo", Tipo "Acquisto", Quantità 5, Prezzo 20, Tipo strumento "Azioni", conferma.
Expected: appare una nuova card "Azioni Test Nuovo" con Quantità 5, Prezzo di carico 20.

- [ ] **Step 5: Usa "Copia per Claude" e verifica il testo generato**

Clicca "Copia per Claude".
Expected: appare il riquadro "Testo pronto per la chat con Claude" con due righe (una per ciascun movimento registrato ai passi 3-4), e il badge accanto al bottone sparisce (contatore torna a 0).

- [ ] **Step 6: Verifica la persistenza dopo un reload**

Ricarica la pagina (`navigate` sullo stesso URL).
Expected: le due posizioni modificate/aggiunte ai passi 3-4 sono ancora presenti con gli stessi valori (i movimenti locali, ora `synced: true`, restano applicati sopra alla base di `investimenti.json` anche dopo il fetch).

- [ ] **Step 7: Ferma il server locale**

Usa `preview_stop` sul serverId ottenuto al passo 1.

---

### Task 7: Aggiorna README.md e commit finale

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Aggiungi una sezione al README che documenta il nuovo workflow**

Aggiungi in fondo a `README.md`:

```markdown

## Investimenti e Depositi: database Excel

`data/finanze.xlsx` è il database per le sezioni Investimenti e Depositi (fogli Posizioni, Movimenti, Depositi). Per aggiornare il sito dopo una modifica manuale del file Excel (o dopo aver registrato movimenti/depositi dal sito e usato "Copia per Claude"):

```bash
cd scripts
python xlsx_to_json.py
```

Questo rigenera `investimenti.json` e `depositi.json` nella root del sito. Poi commit + push su `main`: GitHub Pages pubblica automaticamente.

Vedi `docs/superpowers/specs/2026-08-12-finanze-excel-database-design.md` per i dettagli del design.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the Excel-based finanze data workflow"
```

- [ ] **Step 3: Riepiloga all'utente cosa è stato fatto e chiedi conferma prima di eseguire `git push`**

Il push su `main` aggiorna il sito pubblico — non va eseguito senza che l'utente lo confermi esplicitamente in questa sessione (vedi `## Conferma di pubblicazione` nello spec). Chiedi conferma, poi esegui `git push origin main` solo dopo un sì esplicito.
