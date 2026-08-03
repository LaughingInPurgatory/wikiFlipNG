/**
 * Full-site backup / restore as .zip archives.
 *
 * NG archive layout:
 *   wikiflip-backup/manifest.json   { format: "wikiflip-ng-backup", version: 1, … }
 *   wikiflip-backup/wiki.db         consistent SQLite snapshot (VACUUM INTO)
 *
 * Classic WikiFlip archives (PHP ContentBackup) are also accepted on import:
 *   wikiflip-backup/manifest.json   { format: "wikiflip-content-backup", … }
 *   wikiflip-backup/pages/…         flat-file tree with content.md
 *
 * ZIP create/extract is pure JS (src/zip.js) — no system zip/unzip/tar required.
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { db, getSetting } from './db.js';
import { findPagesRootOnDisk, importPagesTree } from './content-import.js';
import { createZip, extractZip } from './zip.js';

export const NG_FORMAT = 'wikiflip-ng-backup';
export const CLASSIC_FORMAT = 'wikiflip-content-backup';
export const FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const ARCHIVE_ROOT = 'wikiflip-backup';

function workDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function sqlLiteral(filePath) {
  return `'${String(filePath).replace(/'/g, "''")}'`;
}

/** Suggested download filename: {site}-backup-YYYYMMDD-HHMMSS.zip */
export function downloadFilename() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const title = getSetting('site_title', 'WikiFlip');
  const slug =
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'wikiflip';
  return `${slug}-backup-${stamp}.zip`;
}

/**
 * Build a .zip of the live database. Returns a temp file path; caller must unlink.
 */
export function exportToTempFile() {
  const work = workDir('wikiflip-export-');
  const bundle = path.join(work, ARCHIVE_ROOT);
  mkdirSync(bundle, { recursive: true });

  const dbSnap = path.join(bundle, 'wiki.db');
  db.exec(`VACUUM INTO ${sqlLiteral(dbSnap)}`);

  const manifest = {
    format: NG_FORMAT,
    version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    site_title: getSetting('site_title', 'WikiFlip'),
    generator: 'WikiFlip NG',
    archive: 'zip',
  };
  writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const out = path.join(tmpdir(), `wikiflip-export-${randomBytes(6).toString('hex')}.zip`);
  try {
    const files = {
      [`${ARCHIVE_ROOT}/manifest.json`]: readFileSync(path.join(bundle, 'manifest.json')),
      [`${ARCHIVE_ROOT}/wiki.db`]: readFileSync(dbSnap),
    };
    writeFileSync(out, createZip(files));
    if (!existsSync(out) || statSync(out).size === 0) {
      throw new Error('Export produced an empty ZIP archive.');
    }
    return out;
  } catch (err) {
    try {
      rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    removeTree(work);
  }
}

/**
 * Import a backup archive (NG or classic WikiFlip ZIP).
 * @param {string} archivePath
 * @param {'replace'|'merge'} mode
 * @param {string|null} [originalName]
 * @returns {{ ok: boolean, message: string, mode?: string, pages?: number, media?: number }}
 */
export function importFromArchive(archivePath, mode = 'replace', originalName = null) {
  mode = mode === 'merge' ? 'merge' : 'replace';

  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
    return { ok: false, message: 'Uploaded file is not readable.' };
  }

  const size = statSync(archivePath).size;
  if (size < 20) {
    return { ok: false, message: 'Uploaded file is empty or too small to be a valid archive.' };
  }
  if (size > MAX_IMPORT_BYTES) {
    const mb = Math.floor(MAX_IMPORT_BYTES / 1024 / 1024);
    return { ok: false, message: `Archive is too large (max ${mb} MB).` };
  }

  if (!isZipArchive(archivePath, originalName)) {
    return {
      ok: false,
      message: 'Unrecognized archive. Use a .zip WikiFlip backup.',
    };
  }

  const work = workDir('wikiflip-import-');
  try {
    let entries;
    try {
      entries = extractZip(readFileSync(archivePath));
    } catch (err) {
      return { ok: false, message: `Could not extract ZIP: ${err.message}` };
    }

    materializeZipEntries(entries, work);

    const ngDb = findNgDatabase(work);
    if (ngDb) return restoreFromNgDatabase(ngDb, mode);

    const pagesRoot = findPagesRootOnDisk(work);
    if (!pagesRoot) {
      return {
        ok: false,
        message: 'Archive does not look like a WikiFlip backup (no wiki.db or pages/content.md found).',
      };
    }

    const stats = importPagesTree(pagesRoot, { clean: mode === 'replace' });
    return {
      ok: true,
      message:
        mode === 'replace'
          ? `Import complete (replaced site). Restored ${stats.pages} page(s), ${stats.media} media file(s).`
          : `Import complete (merged). Applied ${stats.pages} page(s), ${stats.media} media file(s).`,
      mode,
      pages: stats.pages,
      media: stats.media,
    };
  } catch (err) {
    return { ok: false, message: `Import failed: ${err.message}` };
  } finally {
    removeTree(work);
  }
}

function isZipArchive(filePath, originalName) {
  const name = String(originalName || path.basename(filePath)).toLowerCase();
  if (name.endsWith('.zip')) return true;
  try {
    const magic = readFileSync(filePath).subarray(0, 4);
    return magic[0] === 0x50 && magic[1] === 0x4b; // PK
  } catch {
    return false;
  }
}

/** Write extracted zip paths under destRoot (paths already zip-slip safe). */
function materializeZipEntries(entries, destRoot) {
  for (const [rel, data] of entries) {
    const target = path.join(destRoot, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function isSqliteFile(filePath) {
  try {
    const head = readFileSync(filePath).subarray(0, 16).toString('utf8');
    return head.startsWith('SQLite format 3');
  } catch {
    return false;
  }
}

function findNgDatabase(extractRoot) {
  const preferred = path.join(extractRoot, ARCHIVE_ROOT, 'wiki.db');
  if (existsSync(preferred) && isSqliteFile(preferred)) return preferred;

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
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== '__MACOSX') stack.push(full);
      else if (entry.isFile() && entry.name === 'wiki.db' && isSqliteFile(full)) return full;
    }
  }
  return null;
}

function bakColumns(table) {
  try {
    return db
      .prepare(`PRAGMA bak.table_info(${table})`)
      .all()
      .map((row) => row.name);
  } catch {
    return [];
  }
}

function mainColumns(table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function sharedColumns(table) {
  const bak = new Set(bakColumns(table));
  return mainColumns(table).filter((c) => bak.has(c));
}

function copyTableReplace(table) {
  const cols = sharedColumns(table);
  if (!bakColumns(table).length) {
    db.exec(`DELETE FROM ${table}`);
    return;
  }
  if (!cols.length) return;
  const list = cols.join(', ');
  db.exec(`DELETE FROM ${table}`);
  db.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM bak.${table}`);
}

function restoreFromNgDatabase(backupDbPath, mode) {
  const staged = path.join(tmpdir(), `wikiflip-ng-restore-${randomBytes(6).toString('hex')}.db`);
  copyFileSync(backupDbPath, staged);

  let probe;
  try {
    probe = new DatabaseSync(staged, { readOnly: true });
    const hasPages = probe
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pages'")
      .get();
    if (!hasPages) {
      return { ok: false, message: 'Backup database is missing the pages table.' };
    }
  } catch (err) {
    return { ok: false, message: `Could not open backup database: ${err.message}` };
  } finally {
    try {
      probe?.close();
    } catch {
      /* ignore */
    }
  }

  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE ${sqlLiteral(staged)} AS bak`);
    db.exec('BEGIN');

    try {
      if (mode === 'replace') {
        // Full restore of content + accounts + branding. Sessions are left alone
        // so the current admin request can still finish and flash a result.
        for (const table of ['page_collaborators', 'media', 'pages', 'settings', 'users']) {
          copyTableReplace(table);
        }
      } else {
        mergeFromBackup();
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      try {
        db.exec('DETACH DATABASE bak');
      } catch {
        /* ignore */
      }
      db.exec('PRAGMA foreign_keys = ON');
    }

    const pages = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
    const media = db.prepare('SELECT COUNT(*) AS n FROM media').get().n;
    return {
      ok: true,
      message:
        mode === 'replace'
          ? `Import complete (replaced site). Restored ${pages} page(s), ${media} media file(s), and accounts.`
          : `Import complete (merged). Database now has ${pages} page(s), ${media} media file(s).`,
      mode,
      pages,
      media,
    };
  } catch (err) {
    return { ok: false, message: `Import failed: ${err.message}` };
  } finally {
    rmSync(staged, { force: true });
  }
}

function mergeFromBackup() {
  if (bakColumns('users').length) {
    const cols = sharedColumns('users').filter((c) => c !== 'id');
    if (cols.length) {
      const list = cols.map((c) => `b.${c}`).join(', ');
      db.exec(
        `INSERT INTO users (${cols.join(', ')})
         SELECT ${list}
         FROM bak.users b
         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username = b.username)`
      );
    }
  }

  if (bakColumns('settings').length) {
    const cols = sharedColumns('settings');
    if (cols.length) {
      const list = cols.join(', ');
      db.exec(
        `INSERT INTO settings (${list}) SELECT ${list} FROM bak.settings
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
    }
  }

  if (!bakColumns('pages').length) return;

  const pageRows = db.prepare('SELECT * FROM bak.pages ORDER BY id ASC').all();
  const idMap = new Map();

  const insert = db.prepare(
    `INSERT INTO pages (slug, title, body, parent_id, position, author_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE pages SET title = ?, body = ?, position = ?, updated_at = ? WHERE id = ?`
  );
  const bySlug = db.prepare('SELECT id FROM pages WHERE slug = ?');
  const setParent = db.prepare('UPDATE pages SET parent_id = ? WHERE id = ?');
  const setAuthor = db.prepare('UPDATE pages SET author_id = ? WHERE id = ?');

  const bakUsers = bakColumns('users').length
    ? db.prepare('SELECT id, username FROM bak.users').all()
    : [];
  const liveByName = db.prepare('SELECT id, username FROM users').all();
  const nameToLiveId = new Map(liveByName.map((u) => [u.username, u.id]));
  const bakIdToName = new Map(bakUsers.map((u) => [u.id, u.username]));

  for (const row of pageRows) {
    const existing = bySlug.get(row.slug);
    if (existing) {
      update.run(row.title, row.body, row.position, row.updated_at || row.created_at, existing.id);
      idMap.set(row.id, existing.id);
    } else {
      const result = insert.run(
        row.slug,
        row.title,
        row.body ?? '',
        row.position ?? 0,
        row.created_at || null,
        row.updated_at || null
      );
      idMap.set(row.id, Number(result.lastInsertRowid));
    }
  }

  for (const row of pageRows) {
    const liveId = idMap.get(row.id);
    if (!liveId) continue;
    if (row.parent_id != null && idMap.has(row.parent_id)) {
      setParent.run(idMap.get(row.parent_id), liveId);
    }
    if (row.author_id != null) {
      const uname = bakIdToName.get(row.author_id);
      const liveAuthor = uname ? nameToLiveId.get(uname) : null;
      if (liveAuthor) setAuthor.run(liveAuthor, liveId);
    }
  }

  if (bakColumns('media').length) {
    const mediaRows = db.prepare('SELECT * FROM bak.media').all();
    const put = db.prepare(
      `INSERT INTO media (page_id, filename, mime, bytes, created_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))
       ON CONFLICT(page_id, filename) DO UPDATE SET
         mime = excluded.mime, bytes = excluded.bytes`
    );
    const delSite = db.prepare('DELETE FROM media WHERE page_id IS NULL AND filename = ?');
    const putSite = db.prepare(
      `INSERT INTO media (page_id, filename, mime, bytes, created_at)
       VALUES (NULL, ?, ?, ?, COALESCE(?, datetime('now')))`
    );

    for (const row of mediaRows) {
      if (row.page_id == null) {
        delSite.run(row.filename);
        putSite.run(row.filename, row.mime, row.bytes, row.created_at || null);
      } else if (idMap.has(row.page_id)) {
        put.run(idMap.get(row.page_id), row.filename, row.mime, row.bytes, row.created_at || null);
      }
    }
  }

  if (bakColumns('page_collaborators').length) {
    const rows = db.prepare('SELECT page_id, user_id FROM bak.page_collaborators').all();
    const add = db.prepare(
      'INSERT OR IGNORE INTO page_collaborators (page_id, user_id) VALUES (?, ?)'
    );
    for (const row of rows) {
      const livePage = idMap.get(row.page_id);
      const uname = bakIdToName.get(row.user_id);
      const liveUser = uname ? nameToLiveId.get(uname) : null;
      if (livePage && liveUser) add.run(livePage, liveUser);
    }
  }
}
