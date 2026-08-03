/**
 * Import a classic (PHP, flat-file) WikiFlip `pages/` tree into SQLite.
 * Shared by the CLI importer and admin backup restore.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  db,
  getPage,
  putMedia,
  replaceSiteLogo,
  sanitizeFilename,
  sanitizeSlug,
  savePage,
  setSetting,
} from './db.js';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const setCreatedAt = db.prepare('UPDATE pages SET created_at = ? WHERE slug = ?');
const setPosition = db.prepare('UPDATE pages SET position = ? WHERE slug = ?');

/** `# Title` + body → { title, body }. */
export function parseDocument(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const match = /^\s*#\s+(.+?)\s*(?:\n([\s\S]*))?$/.exec(text);
  if (!match) return { title: '', body: text.trim() };
  return { title: match[1].trim(), body: (match[2] ?? '').replace(/^\n+/, '') };
}

/** `<div class="pdf-embed">…file.pdf…</div>` → `[file](file.pdf)`. */
export function convertPdfEmbeds(body) {
  return body.replace(/<div\b[^>]*class="[^"]*pdf-embed[^"]*"[^>]*>[\s\S]*?<\/div>/gi, (block) => {
    const src = /<iframe\b[^>]*\bsrc="([^"#?]+)/i.exec(block);
    if (!src) return '';
    const file = sanitizeFilename(src[1]);
    const label = /title="([^"]*)"/i.exec(block)?.[1] || file.replace(/\.pdf$/i, '');
    return `\n\n[${label}](${file})\n\n`;
  });
}

function readCreatedAt(dir) {
  try {
    const raw = readFileSync(path.join(dir, '.created_at'), 'utf8').trim();
    if (/^\d+$/.test(raw)) return new Date(Number(raw) * 1000);
  } catch {
    /* fall through to mtime */
  }
  try {
    return statSync(path.join(dir, 'content.md')).mtime;
  } catch {
    return new Date();
  }
}

function readOrder(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, '.order.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed.map(sanitizeSlug).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function importDirectory(dir, parentSlug, stats) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const imported = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const childDir = path.join(dir, entry.name);
    let raw;
    try {
      raw = readFileSync(path.join(childDir, 'content.md'), 'utf8');
    } catch {
      continue; // not a page folder
    }

    const slug = sanitizeSlug(entry.name);
    if (slug === '') continue;

    const { title, body } = parseDocument(raw);
    const result = savePage({
      slug,
      title: title || slug,
      body: convertPdfEmbeds(body),
      parent: slug === 'home' ? '' : parentSlug,
    });
    if (!result.ok) {
      stats.skipped.push(`${slug}: ${result.error}`);
      continue;
    }

    const createdAt = readCreatedAt(childDir);
    setCreatedAt.run(createdAt.toISOString().slice(0, 19).replace('T', ' '), slug);
    imported.push({ slug, createdAt: createdAt.getTime() });
    stats.pages += 1;

    const page = getPage(slug);
    for (const file of readdirSync(childDir, { withFileTypes: true })) {
      if (!file.isFile() || file.name.startsWith('.') || file.name === 'content.md') continue;
      const mime = MIME_BY_EXT[path.extname(file.name).toLowerCase()];
      const filename = sanitizeFilename(file.name);
      if (!mime || filename === '') continue;
      putMedia(page.id, filename, mime, readFileSync(path.join(childDir, file.name)));
      stats.media += 1;
    }

    importDirectory(childDir, slug, stats);
  }

  applyOrder(dir, imported);
}

/** Manual order wins; anything unlisted keeps the newest-first default on top. */
function applyOrder(dir, siblings) {
  const order = readOrder(dir);
  const listed = order.filter((slug) => siblings.some((s) => s.slug === slug));
  const unlisted = siblings
    .filter((s) => !listed.includes(s.slug))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => s.slug);
  [...unlisted, ...listed].forEach((slug, index) => setPosition.run(index, slug));
}

function importBranding(pagesDir, stats) {
  const siteDir = path.join(pagesDir, '.site');
  try {
    const settings = JSON.parse(readFileSync(path.join(siteDir, 'settings.json'), 'utf8'));
    if (settings.site_title) {
      setSetting('site_title', String(settings.site_title).slice(0, 80));
      stats.branding.push('site title');
    }
  } catch {
    /* no settings file */
  }

  for (const name of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.gif', 'logo.webp']) {
    try {
      const bytes = readFileSync(path.join(siteDir, name));
      replaceSiteLogo(name, MIME_BY_EXT[path.extname(name).toLowerCase()], bytes);
      stats.branding.push('logo');
      break;
    } catch {
      /* try next */
    }
  }

  try {
    const css = readFileSync(path.join(siteDir, 'custom.css'), 'utf8');
    setSetting('custom_css', css);
    setSetting('custom_css_version', String(Date.now()));
    stats.branding.push('custom CSS');
  } catch {
    /* no custom css */
  }
}

/**
 * Wipe page content (not users or sessions). Used for replace-mode classic import.
 */
export function clearPageContent() {
  db.exec('DELETE FROM page_collaborators; DELETE FROM media; DELETE FROM pages;');
}

/**
 * Import a classic pages/ directory into the live database.
 * @param {string} pagesDir absolute path to a pages tree
 * @param {{ clean?: boolean }} [opts]
 * @returns {{ pages: number, media: number, branding: string[], skipped: string[] }}
 */
export function importPagesTree(pagesDir, opts = {}) {
  if (!statSync(pagesDir).isDirectory()) {
    throw new Error(`Not a directory: ${pagesDir}`);
  }

  if (opts.clean) clearPageContent();

  const stats = { pages: 0, media: 0, branding: [], skipped: [] };
  importDirectory(pagesDir, '', stats);
  importBranding(pagesDir, stats);
  return stats;
}

/** True if dir (recursively) contains at least one content.md page file. */
export function directoryContainsContentMd(dir) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX') continue;
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name === 'content.md') return true;
      if (entry.isDirectory() && !entry.name.startsWith('.')) stack.push(full);
    }
  }
  return false;
}

/**
 * After extracting an archive, locate the classic pages tree root.
 * Prefers a `pages/` folder that contains content.md; falls back to bare trees.
 */
export function findPagesRootOnDisk(extractRoot) {
  const candidates = [];
  const stack = [extractRoot];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
      const full = path.join(current, entry.name);
      if (entry.name === 'pages' && directoryContainsContentMd(full)) {
        candidates.push(full);
      }
      stack.push(full);
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0];
  }

  if (directoryContainsContentMd(extractRoot)) return extractRoot;

  // Single top-level folder (e.g. wikiflip-backup without a pages/ segment)
  for (const entry of readdirSync(extractRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const child = path.join(extractRoot, entry.name);
    if (directoryContainsContentMd(child)) return child;
  }

  return null;
}
