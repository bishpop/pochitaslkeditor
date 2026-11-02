# Pochita SLK Editor v1.4.0

Static browser-based SLK editor. SLK files are processed locally in your browser; there is no application backend.

## Updates in v1.4.0 — 1:1 SLK model, row/column tools & QoL

- **True 1:1 SLK Row Representation:** Row 1 (Column Headers) and Row 2 (Data Types: `string`, `int`, `float`) are now preserved and displayed directly inside the sheet as Row `1` and Row `2`, matching the exact `Y` coordinates of the `.slk` file and Excel (`A1`, `A2`, `A3`…). Editing Row 1 or Row 2 updates headers and type validation live.
- **Direct Row & Column Management:**
  - Insert new song rows directly above/below (`Ctrl+Enter`) or via the clean inline **"+ Add new row"** bar at the bottom of the sheet.
  - Automatic `.tbm` filename incrementation (e.g. `g1001.tbm` → `g1002.tbm`) and clean default values (`Offset = 0.7`, `NEW = 1`, `USE = 1`, numeric fields reset to `0` instead of copying previous song BPM/Madi values).
  - Duplicate selected row(s) with `Ctrl+Shift+D` (auto-increments TBM codes) or delete song rows.
  - Insert new columns (left/right/end) with custom header, type, and default value, or delete existing columns — all with full `Ctrl+Z` / `Ctrl+Y` Undo/Redo support.
- **Right-Click Context Menu:** Quick access to row/column operations, auto-TBM generation, NEW/USE toggles, and clipboard actions anywhere on the grid.
- **SLK & TBM Quality Tools:**
  - **Check TBM:** Scans the active file for duplicate `.tbm` filenames, duplicate `Artist + Title` combinations, or missing required fields, with one-click jump to the affected row.
  - **Auto-TBM:** Assigns sequential free `.tbm` filenames to all selected rows.
  - **Find & Replace (`Ctrl+H`):** Search and replace text across the entire file or within a specific column.
- **Curated Themes & Excel-tinted Ribbon:** Streamlined to 4 high-contrast themes — **Catppuccin Mocha** (default dark), **Nord** (dark), **Catppuccin Latte** (light), and **Cloud** (light) — with a subtle theme-aware accent tint on the titlebar and ribbon.
- **Selection & Header Fixes:** Fixed pointer drag/autoscroll selection jump on single clicks and sealed sticky column headers against text bleed-through while scrolling.

## Updates in v1.3.0 — spreadsheet workspace

- **Ribbon** (Home / Root & Targets / View) replaces the button rows and the sidebar. File tabs are at the bottom, like Excel / Google Sheets.
- **Virtual grid:** all rows are scrollable (no more pages); only visible rows are rendered, so thousands of rows stay smooth. Column letters + SLK row numbers, resizable columns, optional frozen Artist/Title columns.
- **Position is always visible:** active cell outline, highlighted column letter / row number, optional row+column crosshair, name box (`C12`, type `A1:D9` to jump) and a formula bar.
- **Excel-style keyboard:** Tab/Shift+Tab (wraps rows, Enter returns to the start column), arrows, Ctrl+arrows, Home/End, PageUp/Down, just type to overwrite, F2 / double-click to edit, Enter/Esc, Delete, Backspace, Shift/Ctrl selection, Ctrl+A, Ctrl+D/R fill, Ctrl+C/X/V with TSV (works with Excel/LibreOffice), Ctrl+Z/Y. Press F1 for the full list.
- Number columns are validated on commit; selections show Count / Sum / Avg in the status bar.
- Drag & drop import and a warning before closing with unsaved changes.

## Updates in v1.2.3 – v1.2.5

- **Compact mode** reduces table row height and spacing. The preference is saved in this browser.
- **Filename alignment** notice checks songs represented in both Root and another loaded file, matching by Artist + Title.
- **Root-row sync:** Select one or more Root rows, enable destination files using their **Target** checkboxes, then click **Apply Root row**. It copies shared **Artist, Title, File name, BPM and Offset** values while preserving existing target **Level, NEW and USE** values.

## Repository structure

- `public/` — static website, assets, and vendor libraries.
- `wrangler.jsonc` — Cloudflare Worker static-assets configuration using `public/`.
- `package.json` — Wrangler development dependency.
- `.github/workflows/deploy-pages.yml` — optional GitHub Pages deployment that publishes only `public/`.

## Deploy

- **Cloudflare Workers:** the configured `npx wrangler deploy` command serves files from `public/`.
- **GitHub Pages:** select **Source → GitHub Actions**. The workflow uploads only `public/`.

Repository visibility and website visibility are separate: the deployed website is publicly reachable unless an access restriction is added. Do not commit private `.slk` lists into the repository. Changes remain in memory until exported. Keep backups of original SLKs before production use.