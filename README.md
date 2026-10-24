# Pochita SLK Editor v1.2.2 — Cloudflare Workers static assets

This is a static, browser-only SLK editor prepared for the current Cloudflare Workers Builds flow. It does not use a backend. Uploaded SLK files are processed in the visitor's browser.

## Repository layout

- `wrangler.jsonc` configures this Worker to serve the files in `public/` as static assets.
- `package.json` declares Wrangler for repeatable deployments.
- `public/` contains the complete website: `index.html`, CSS, JavaScript, local vendor libraries, manifest and icons.

## Cloudflare setup

Connect this private GitHub repository to Cloudflare Workers Builds, then use:

- Project name: `pochitaslkeditor` (must match `wrangler.jsonc`)
- Build command: leave blank
- Deploy command: `npx wrangler deploy`
- Preview command: leave the default shown by Cloudflare
- Root directory: blank

The static assets directory is already configured in `wrangler.jsonc`, so do not set a separate output directory in the Worker wizard. Click Deploy after these files have been pushed to the repository's `main` branch.

## Privacy note

The GitHub repository can stay private. The deployed website URL is public unless you protect it separately with Cloudflare Access. Static HTML, CSS and browser JavaScript delivered to visitors can be inspected by those visitors. Do not put secrets or private SLK files in `public/`.
