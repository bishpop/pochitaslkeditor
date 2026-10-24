# Pochita SLK Editor v1.2.5

Static browser-based SLK editor. SLK files are processed locally in your browser; there is no application backend.

## Updates in v1.2.3

- **Compact mode** reduces table row height, toolbars, tabs, sidebar spacing, and margins. The preference is saved in this browser.
- Spreadsheet navigation: **Tab / Shift+Tab** moves to the next/previous cell with row wrapping; **arrow keys** move between cells; **F2** or **Enter** starts editing; **Enter** while editing saves and moves down. **Ctrl+C / Ctrl+V** copies or pastes one cell if browser clipboard access is permitted.
- **Ctrl+Z / Ctrl+Y** undo/redo recorded cell edits, NEW/USE bulk changes, Root-row sync, and new entries during the current session. History is cleared when the workspace is cleared.
- The small **Filename alignment** notice checks only songs represented in both Root and another loaded file, matching by Artist + Title. Extra entries unique to any file are intentionally ignored. The notice can be dismissed.
- The confusing per-field sync panel was removed. Select the Root row, enable destination files using their **Target** checkboxes in the sidebar, then click **Apply Root row to Targets**. It copies the shared **Artist, Title, File name, BPM and Offset** values. Existing target **Level, NEW and USE** values are preserved. New target rows receive `NEW = 1` and `USE = 1`, with the selected target Level.

## Repository structure

- `public/` — static website, assets, and vendor libraries.
- `wrangler.jsonc` — Cloudflare Worker static-assets configuration using `public/`.
- `package.json` — Wrangler development dependency.
- `.github/workflows/deploy-pages.yml` — optional GitHub Pages deployment that publishes only `public/`.

## Deploy

- **Cloudflare Workers:** the configured `npx wrangler deploy` command serves files from `public/`.
- **GitHub Pages:** select **Source → GitHub Actions**. The workflow uploads only `public/`.

Repository visibility and website visibility are separate: the deployed website is publicly reachable unless an access restriction is added. Do not commit private `.slk` lists into the repository. Changes remain in memory until exported. Keep backups of original SLKs before production use.


## Updates in v1.2.5

- Compact mode now tightens spacing without reducing font sizes; table cell editors have fixed geometry to prevent column resizing while editing.
- New entry is available at the bottom-left of the table footer. New Artist and Title fields start blank; NEW and USE start at 1 and remain editable.
- Added persistent color palettes: Matcha (default), Polarlight, Lavendel, Glut, Tiefsee, Kirschblüten, Graphit, Aurora, Sonnenuntergang, Wald, Mokka, Nord, Mitternacht & Gold, Cyber, Crimson, Ozean, OLED, Warm Dark, Soft Night, Lavender Mist and Paper.


## Updates in v1.2.5

- Replaced the native theme dropdown with a theme gallery popup. Each card shows a miniature editor preview; clicking applies the theme.
- Added explicit high-contrast styling for tables, form fields, dropdown options, buttons, navigation, and modals across all palettes. Existing Bright skin and Night skin are retained; Matcha remains the default.
- Replaced the wide Last page label with a fixed-width `>|` control so it cannot overflow in Compact mode.
