# WikiFlip NG

WikiFlip NG is a small Markdown wiki for home labs, private networks, and local
projects. It is the same kind of site as the original PHP
[WikiFlip](https://github.com/LaughingInPurgatory/wikiFlip), rebuilt on Node.js
with **all content in a single SQLite database** and a much tighter security
posture.

It includes:

- Nested pages and categories, with expandable sidebar navigation
- A Markdown editor with a WYSIWYG mode (Toast UI, bundled — no CDN)
- Image thumbnails that open full size in a lightbox
- PDF thumbnails that open a full viewer in the same lightbox
- Multiple accounts: admins run the wiki; users write and own their own pages
- Per-page collaborator lists — invite others to edit a page you own
- Profile pictures (scaled to 100×100) on pages each author created
- Full-text-ish search from the bottom of the sidebar
- Newest-created-first ordering, with manual reordering per category
- Site branding (title, logo, custom CSS) from the admin area
- Full backup and restore as a ZIP archive (including import of original
  WikiFlip ZIP backups)
- The same deep-indigo glass theme as the original
- A ready-to-run Docker image published to GitHub Container Registry

## Security note

The original WikiFlip was explicit that it was for private use only. This
rewrite is built the other way round: content lives in SQLite (not under the web
root), uploads are sniffed by magic bytes and stored as BLOBs, user HTML is never
rendered, sessions and CSRF are enforced, and the container runs as non-root with
a read-only root filesystem.

It is still a small wiki. Put it behind TLS and set `TRUST_PROXY=1` if anything
outside your trusted network can reach it.

## The quickest way to start

The easiest option is Docker. The published image is:

```text
ghcr.io/laughinginpurgatory/wikiflipng:latest
```

From the repository directory, run:

```bash
docker compose up -d
```

Then open [http://localhost:8080/](http://localhost:8080/).

On the first run — with no password configured — the app prints a generated
admin password once:

```bash
docker compose logs wiki | grep -A 2 Generated
```

Sign in from the gear button at the bottom of the sidebar (`/login`). The
default username is `admin` unless you set `WIKIFLIP_ADMIN_USER`.

The same compose file works with Dockhand, Portainer, or another stack manager.
The wiki database lives on the `wiki_data` volume.

### If Docker says `unauthorized`

The GitHub Container Registry package may still be private even when the GitHub
repository is public. In GitHub, open the **wikiflipng** package under the
[LaughingInPurgatory packages](https://github.com/LaughingInPurgatory?tab=packages),
choose **Package settings**, and change its visibility to **Public**. Then retry
the deployment.

### Run the image directly

```bash
docker run -d --name wikiflip-ng \
  -p 8080:3000 \
  -e WIKIFLIP_ADMIN_USER=admin \
  -v wiki_data:/app/data \
  ghcr.io/laughinginpurgatory/wikiflipng:latest
```

To keep the database in a folder on the host instead of a named volume:

```bash
docker run -d --name wikiflip-ng \
  -p 8080:3000 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/laughinginpurgatory/wikiflipng:latest
```

The container listens on port `3000`; the examples map that to `8080` on the host.

To choose your own password instead of a generated one:

```bash
docker run -d --name wikiflip-ng \
  -p 8080:3000 \
  -e WIKIFLIP_ADMIN_PASSWORD='something long' \
  -v wiki_data:/app/data \
  ghcr.io/laughinginpurgatory/wikiflipng:latest
```

## Using the wiki

Open the home page to read the wiki. Sign in to create and edit pages; admins
also get the full admin area.

When creating or editing a page:

1. Set its title — the URL slug is filled in from it and is fixed after creation.
2. Choose a parent page if it belongs inside a category.
3. Write in Markdown or switch to the WYSIWYG editor.
4. Insert images by pasting or dragging; insert PDFs with the **PDF** toolbar
   button.

Images appear as smaller thumbnails. A paragraph that is only a link to a page
PDF becomes a PDF thumbnail card. Click either to open the full view; close with
the close button, a click outside, or `Escape`.

On browsers without an inline PDF viewer (notably iOS Safari), the card shows
**Open PDF** / **Download** instead of a live preview.

Click a category in the sidebar to expand or collapse its sub-pages. Pages in
each category are newest-created-first until you move them with the admin
**↑ / ↓** buttons, which saves a manual order for those siblings.

## Accounts and permissions

There are two roles — admin and user — plus a per-page collaborator list. The
gear button opens login, then either the admin area or your account page.

| | Admin | Owner | Collaborator |
|---|---|---|---|
| Create pages | ✓ | ✓ | ✓ |
| Edit page content | any page | own pages | shared pages |
| Delete a page | ✓ | ✓ | — |
| Change collaborators | ✓ | ✓ | — |
| Reorder pages | ✓ | — | — |
| Branding and CSS | ✓ | — | — |
| Manage users | ✓ | — | — |
| Own name, password, picture | ✓ | ✓ | ✓ |

Admins manage accounts under **Admin → Users**. The last remaining admin cannot
be demoted or deleted. Deleting a user keeps their pages (they become
admin-owned).

Users get `/account` for profile settings and their own pages. Pages remember who
created them; an admin editing someone else's page leaves the author (and byline)
intact.

### Collaborators

Open a page in the editor (as owner or admin) and use the **Collaborators**
panel to tick who may also edit it. Collaborators can change content only — not
delete the page or edit the list. Shared pages appear under **Shared with me** on
the account page.

### Profile pictures

Any common image type works. The browser centre-crops and rescales to 100×100
before upload. The picture appears in the byline on pages that user created.

## Backup and restore

Admins get a **Backup** tab at `/admin?tab=backup`:

- **Export** downloads a `.zip` with a consistent SQLite snapshot of the whole
  site (pages, media, accounts, collaborators, branding).
- **Import** restores those NG zip backups, and also accepts original PHP
  WikiFlip content backups (`.zip` with a `pages/` tree).

**Replace** wipes current content first (NG backups also restore accounts).
**Merge** overlays matching pages and keeps the rest. Max upload size is about
100 MB.

You can still copy `data/wiki.db` yourself if you prefer a raw file backup.

## Importing an existing WikiFlip

To load an old flat-file `pages/` tree into SQLite (outside the Backup tab):

```bash
npm run import -- /path/to/old/wikiFlip/pages
```

Add `--clean` to clear existing pages and media first. Titles, bodies, nesting,
order, creation dates, media, and branding (title, logo, custom CSS) come across.
Old `<div class="pdf-embed">` blocks become plain Markdown links, which render as
PDF viewers again.

## Configuration

| Variable | Purpose |
|----------|---------|
| `WIKIFLIP_ADMIN_USER` | Admin username (default `admin`) |
| `WIKIFLIP_ADMIN_PASSWORD` | Plain-text password, hashed at boot (min 8 characters) |
| `WIKIFLIP_ADMIN_PASSWORD_HASH` | scrypt hash — `npm run hash-password -- 'pw'` |
| `WIKIFLIP_DB` | Database path (default `./data/wiki.db`, or `/app/data/wiki.db` in Docker) |
| `PORT` | HTTP port (default `3000`) |
| `WIKIFLIP_MAX_UPLOAD_MB` | Upload limit in megabytes (default `30`) |
| `TRUST_PROXY` | Express trust-proxy value when behind a reverse proxy |
| `WIKIFLIP_SESSION_SECRET` | Optional fixed session secret (otherwise stored in the database) |

See `.env.example`. Prefer a password hash over a plain-text password in
production environments.

To generate a scrypt hash:

```bash
npm run hash-password -- 'your-password'
```

## Run without Docker

You need Node.js 24 or newer.

```bash
npm install
npm start
```

Open [http://localhost:3000/](http://localhost:3000/). Useful commands:

```bash
npm run dev     # restart on file changes
npm test        # storage, markdown, auth, HTTP, uploads, backup
```

## Docker and GitHub Actions

The image is built from `node:24-alpine` and listens on container port `3000`.
GitHub Actions:

- Builds the image for pull requests
- Publishes `latest` to GHCR when changes are pushed to `main`
- Publishes versioned images for `v*` tags

Useful Docker commands:

```bash
docker compose pull                # Download the latest published image
docker compose up -d               # Start the wiki
docker compose logs -f wiki        # Follow app logs
docker compose down                # Stop the wiki but keep its volume
docker run --rm -p 8080:3000 ghcr.io/laughinginpurgatory/wikiflipng:latest
```

To build from source instead of pulling:

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

Your `wiki_data` volume (or host `data/` folder) is the wiki. Back it up regularly
before upgrading or removing containers — or use the admin Backup tab.

## What changed from the PHP WikiFlip

| Area | Original | WikiFlip NG |
|------|----------|-------------|
| Content storage | Files under the web root | SQLite rows; web root is read-only at runtime |
| Uploads | Written into page folders | BLOBs; type from magic-byte sniffing |
| Media access | Paths from request input | Database lookup by slug + filename |
| Markdown | Partial HTML allowed | User HTML escaped; only the app emits tags |
| Accounts | One shared admin login | Per-user accounts, roles, collaborators |
| Passwords | Default `admin`/`password` in config | No default; generated or set by you |
| Container | Apache + PHP, writable root | Node user, read-only FS, data volume only |

Two deliberate feature changes:

- **SVG logos are not accepted** (PNG, JPEG, GIF, WebP are).
- **Raw HTML in page bodies is escaped**, not rendered. PDF embeds come from a
  plain Markdown link to a PDF file.

## Project layout

```text
wikiFlipNG/
├── Dockerfile
├── docker-compose.yaml
├── docker-compose.build.yaml
├── .github/workflows/docker.yml
├── server.js                 # Routes, permissions, security headers, uploads
├── src/db.js                 # SQLite schema and queries
├── src/auth.js               # Passwords, roles, sessions, CSRF
├── src/markdown.js           # Markdown → HTML, media and PDF embeds
├── src/views.js              # HTML templates (no inline script — CSP)
├── src/import.js             # CLI importer for a classic pages/ tree
├── src/content-import.js     # Shared classic import logic
├── src/backup.js             # ZIP export / import
├── src/zip.js                # Minimal ZIP create / extract
├── public/                   # CSS, client JS, bundled editor assets
├── test/wiki.test.js         # Smoke tests
└── data/wiki.db              # Created at runtime; mount this in Docker
```

## License

Public repository. All rights reserved unless otherwise noted.
