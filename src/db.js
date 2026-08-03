/**
 * SQLite storage for pages, media blobs and site settings.
 *
 * Everything the wiki owns lives in one file (WIKIFLIP_DB, default data/wiki.db):
 * page bodies as Markdown text, uploads as BLOBs, branding in a key/value table.
 * Nothing is ever written into the web root, so there is no path to a writable
 * file that the server would also serve or execute.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DB_PATH = process.env.WIKIFLIP_DB || path.join(process.cwd(), 'data', 'wiki.db');

if (DB_PATH !== ':memory:') {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pages (
    id         INTEGER PRIMARY KEY,
    slug       TEXT    NOT NULL UNIQUE,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL DEFAULT '',
    parent_id  INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent_id, position);

  -- Extra editors for one page. The author keeps ownership: only they (and
  -- admins) can change this list or delete the page.
  CREATE TABLE IF NOT EXISTS page_collaborators (
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS page_collaborators_user ON page_collaborators(user_id);

  -- page_id NULL = site-level asset (the branding logo)
  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY,
    page_id    INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    filename   TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    bytes      BLOB    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS media_page_file ON media(page_id, filename);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    data    TEXT    NOT NULL,
    expires INTEGER NOT NULL
  );
`);

const columns = (table) => db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name);

// Page ownership arrived after the first release; NULL means admin-owned.
if (!columns('pages').includes('author_id')) {
  db.exec('ALTER TABLE pages ADD COLUMN author_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// Profile pictures: 100×100 blobs stored on the account itself.
if (!columns('users').includes('avatar')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
  db.exec('ALTER TABLE users ADD COLUMN avatar_mime TEXT');
}

/** Paths the app itself owns — a page may never take one of these slugs. */
export const RESERVED_SLUGS = new Set([
  'admin', 'login', 'logout', 'account', 'edit', 'media', 'search', 'avatar',
  'site', 'css', 'js', 'vendor', 'assets', 'pages', 'api', 'logo',
]);

/** Lowercase, hyphen-only slug. Never trusted from the client without this. */
export function sanitizeSlug(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function slugify(title) {
  return sanitizeSlug(title) || `page-${Date.now().toString(36)}`;
}

/** Filenames are stored flat per page; keep them boring and traversal-proof. */
export function sanitizeFilename(value) {
  const base = path.basename(String(value ?? '').replace(/\\/g, '/'));
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return clean === '' || clean === '.' ? '' : clean;
}

const USER_COLUMNS =
  'id, username, display_name, password_hash, is_admin, created_at, (avatar IS NOT NULL) AS has_avatar';

/** Login names: lowercase, no spaces, safe in a URL and in a log line. */
export function sanitizeUsername(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '')
    .slice(0, 32);
}

const q = {
  bySlug: db.prepare('SELECT * FROM pages WHERE slug = ?'),
  byId: db.prepare('SELECT * FROM pages WHERE id = ?'),
  all: db.prepare('SELECT * FROM pages ORDER BY position ASC, id DESC'),
  byAuthor: db.prepare('SELECT * FROM pages WHERE author_id = ? ORDER BY created_at DESC'),
  search: db.prepare(
    "SELECT * FROM pages WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' " +
      "ORDER BY (title LIKE ? ESCAPE '\\') DESC, updated_at DESC LIMIT 50"
  ),
  topPosition: db.prepare('SELECT MIN(position) AS pos FROM pages WHERE parent_id IS ?'),
  insert: db.prepare(
    'INSERT INTO pages (slug, title, body, parent_id, position, author_id) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  update: db.prepare(
    "UPDATE pages SET title = ?, body = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  setPosition: db.prepare('UPDATE pages SET position = ? WHERE id = ?'),
  promoteChildren: db.prepare('UPDATE pages SET parent_id = ? WHERE parent_id = ?'),
  delete: db.prepare('DELETE FROM pages WHERE id = ?'),
  siblings: db.prepare(
    'SELECT id, slug, position FROM pages WHERE parent_id IS ? ORDER BY position ASC, id DESC'
  ),
  mediaGet: db.prepare(
    'SELECT m.mime, m.bytes FROM media m LEFT JOIN pages p ON p.id = m.page_id WHERE m.filename = ? AND (p.slug = ? OR (? = \'_site\' AND m.page_id IS NULL))'
  ),
  mediaNames: db.prepare('SELECT filename FROM media WHERE page_id IS ? ORDER BY filename'),
  mediaPut: db.prepare(
    'INSERT INTO media (page_id, filename, mime, bytes) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(page_id, filename) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes'
  ),
  mediaDeleteSite: db.prepare('DELETE FROM media WHERE page_id IS NULL'),
  settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingSet: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  settingDelete: db.prepare('DELETE FROM settings WHERE key = ?'),

  // Never `SELECT *` on users — that would drag the avatar blob into every render.
  userById: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`),
  userByName: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`),
  usersAll: db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY is_admin DESC, username ASC`),
  usersSearch: db.prepare(
    `SELECT ${USER_COLUMNS} FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' ` +
      'ORDER BY is_admin DESC, username ASC'
  ),
  avatarGet: db.prepare('SELECT avatar, avatar_mime FROM users WHERE username = ? AND avatar IS NOT NULL'),
  avatarSet: db.prepare('UPDATE users SET avatar = ?, avatar_mime = ? WHERE id = ?'),

  collabList: db.prepare(
    'SELECT u.id, u.username, u.display_name, u.password_hash, u.is_admin, u.created_at, ' +
      '(u.avatar IS NOT NULL) AS has_avatar ' +
      'FROM page_collaborators c JOIN users u ON u.id = c.user_id ' +
      'WHERE c.page_id = ? ORDER BY u.display_name COLLATE NOCASE'
  ),
  collabIs: db.prepare('SELECT 1 FROM page_collaborators WHERE page_id = ? AND user_id = ?'),
  collabCount: db.prepare('SELECT COUNT(*) AS n FROM page_collaborators WHERE page_id = ?'),
  collabClear: db.prepare('DELETE FROM page_collaborators WHERE page_id = ?'),
  collabAdd: db.prepare('INSERT OR IGNORE INTO page_collaborators (page_id, user_id) VALUES (?, ?)'),
  sharedWith: db.prepare(
    'SELECT p.* FROM page_collaborators c JOIN pages p ON p.id = c.page_id ' +
      'WHERE c.user_id = ? ORDER BY p.updated_at DESC'
  ),
  userInsert: db.prepare(
    'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
  ),
  userUpdate: db.prepare('UPDATE users SET username = ?, display_name = ?, is_admin = ? WHERE id = ?'),
  userSetPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  userDelete: db.prepare('DELETE FROM users WHERE id = ?'),
  adminCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
  pageCountByAuthor: db.prepare('SELECT COUNT(*) AS n FROM pages WHERE author_id = ?'),
};

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const toPage = (row) =>
  row
    ? {
        id: row.id,
        slug: row.slug,
        title: row.title,
        body: row.body,
        parentId: row.parent_id,
        position: row.position,
        authorId: row.author_id ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const toUser = (row) =>
  row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        passwordHash: row.password_hash,
        isAdmin: row.is_admin === 1,
        hasAvatar: row.has_avatar === 1,
        avatarUrl: row.has_avatar === 1 ? `/avatar/${encodeURIComponent(row.username)}` : null,
        createdAt: row.created_at,
      }
    : null;

export function getPage(slug) {
  const page = toPage(q.bySlug.get(sanitizeSlug(slug)));
  if (page) page.parent = page.parentId === null ? '' : (toPage(q.byId.get(page.parentId))?.slug ?? '');
  return page;
}

export function allPages() {
  return q.all.all().map(toPage);
}

/** Nested [{...page, children: [...]}] in sidebar order. */
export function pageTree() {
  const pages = allPages();
  const byId = new Map(pages.map((p) => [p.id, { ...p, children: [] }]));
  const roots = [];
  for (const page of pages) {
    const node = byId.get(page.id);
    const parent = page.parentId !== null ? byId.get(page.parentId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function childPages(slug) {
  const page = getPage(slug);
  if (!page) return [];
  return q.siblings.all(page.id).map((row) => toPage(q.byId.get(row.id)));
}

/** Root → parent chain for breadcrumbs. */
export function ancestors(slug) {
  const chain = [];
  const seen = new Set();
  let page = getPage(slug);
  while (page && page.parentId !== null && !seen.has(page.parentId)) {
    seen.add(page.parentId);
    page = toPage(q.byId.get(page.parentId));
    if (!page) break;
    chain.unshift(page);
  }
  return chain;
}

export function isDescendantOf(candidateSlug, ancestorSlug) {
  const target = sanitizeSlug(ancestorSlug);
  if (target === '' || target === sanitizeSlug(candidateSlug)) return true;
  return ancestors(candidateSlug).some((p) => p.slug === target);
}

/** Parent dropdown options: whole tree minus the page itself and its descendants. */
export function parentOptions(forSlug = '') {
  const skip = sanitizeSlug(forSlug);
  const out = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (skip !== '' && (node.slug === skip || isDescendantOf(node.slug, skip))) continue;
      out.push({ slug: node.slug, label: `${'— '.repeat(depth)}${node.title}` });
      walk(node.children, depth + 1);
    }
  };
  walk(pageTree(), 0);
  return out;
}

/**
 * Create or update a page. Returns { ok, error }.
 * Slugs are immutable after creation (same contract as the PHP version).
 * `authorId` is only applied when creating — ownership never changes on edit.
 */
export function savePage({ slug, title, body = '', parent = '', authorId = null }) {
  const pageSlug = sanitizeSlug(slug);
  if (pageSlug === '') return { ok: false, error: 'A valid URL slug is required.' };
  if (RESERVED_SLUGS.has(pageSlug)) {
    return { ok: false, error: `“${pageSlug}” is reserved by the app — pick another slug.` };
  }

  const pageTitle = String(title ?? '').trim().slice(0, 200) || pageSlug;
  const parentSlug = pageSlug === 'home' ? '' : sanitizeSlug(parent);
  const existing = getPage(pageSlug);

  let parentId = null;
  if (parentSlug !== '') {
    if (parentSlug === pageSlug) return { ok: false, error: 'A page cannot be its own parent.' };
    const parentPage = getPage(parentSlug);
    if (!parentPage) return { ok: false, error: 'Selected parent page does not exist.' };
    if (existing && isDescendantOf(parentSlug, pageSlug)) {
      return { ok: false, error: 'Cannot move a page under one of its own sub-pages.' };
    }
    parentId = parentPage.id;
  }

  transaction(() => {
    if (existing) {
      q.update.run(pageTitle, String(body ?? ''), parentId, existing.id);
      if (existing.parentId !== parentId) q.setPosition.run(nextTopPosition(parentId), existing.id);
    } else {
      q.insert.run(
        pageSlug,
        pageTitle,
        String(body ?? ''),
        parentId,
        nextTopPosition(parentId),
        authorId
      );
    }
  });
  return { ok: true, slug: pageSlug };
}

/** Pages a user created, newest first. */
export function pagesByAuthor(userId) {
  return q.byAuthor.all(userId).map(toPage);
}

/**
 * May this user change the page's content? Admins, the author, and anyone on
 * the page's collaborator list.
 */
export function canEditPage(user, page) {
  if (!user || !page) return false;
  if (canManagePage(user, page)) return true;
  return q.collabIs.get(page.id, user.id) !== undefined;
}

/**
 * Ownership-level actions — deleting the page and editing its collaborator
 * list. Collaborators deliberately cannot do either.
 */
export function canManagePage(user, page) {
  if (!user || !page) return false;
  return user.isAdmin || (page.authorId !== null && page.authorId === user.id);
}

/** Users granted edit access to this page (excludes the author and admins). */
export function pageCollaborators(pageId) {
  return q.collabList.all(pageId).map(toUser);
}

export function collaboratorCount(pageId) {
  return q.collabCount.get(pageId).n;
}

/**
 * Replace a page's collaborator list. The author is never listed (they already
 * own it) and unknown ids are dropped.
 */
export function setPageCollaborators(pageId, userIds) {
  const page = toPage(q.byId.get(pageId));
  if (!page) return { ok: false, error: 'Page not found.' };

  const wanted = [...new Set((userIds ?? []).map(Number).filter(Number.isInteger))]
    .filter((id) => id !== page.authorId && getUser(id) !== null);

  transaction(() => {
    q.collabClear.run(page.id);
    for (const id of wanted) q.collabAdd.run(page.id, id);
  });
  return { ok: true, count: wanted.length };
}

/** Pages someone else owns but this user may edit. */
export function pagesSharedWith(userId) {
  return q.sharedWith.all(Number(userId)).map(toPage);
}

/** Title/body substring search, title matches first. */
export function searchPages(term) {
  const needle = String(term ?? '').trim();
  if (needle.length < 2) return [];
  const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return q.search.all(like, like, like).map(toPage);
}

/** New (and newly moved) pages sit above their siblings until reordered. */
function nextTopPosition(parentId) {
  const min = q.topPosition.get(parentId)?.pos;
  return (min === null || min === undefined ? 0 : min) - 1;
}

export function deletePage(slug) {
  const page = getPage(slug);
  if (!page || page.slug === 'home') return false;
  transaction(() => {
    q.promoteChildren.run(page.parentId, page.id);
    q.delete.run(page.id);
  });
  return true;
}

/** Swap a page with its previous/next sibling. */
export function reorderPage(slug, direction) {
  const page = getPage(slug);
  if (!page || (direction !== 'up' && direction !== 'down')) return false;

  const siblings = q.siblings.all(page.parentId);
  const index = siblings.findIndex((s) => s.id === page.id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= siblings.length) return false;

  transaction(() => {
    siblings.forEach((sibling, i) => {
      let pos = i;
      if (i === index) pos = target;
      else if (i === target) pos = index;
      q.setPosition.run(pos, sibling.id);
    });
  });
  return true;
}

export function putMedia(pageId, filename, mime, bytes) {
  q.mediaPut.run(pageId, filename, mime, bytes);
}

/** @returns {{mime: string, bytes: Uint8Array}|null} */
export function getMedia(slug, filename) {
  const name = sanitizeFilename(filename);
  if (name === '') return null;
  const scope = slug === '_site' ? '_site' : sanitizeSlug(slug);
  if (scope === '') return null;
  return q.mediaGet.get(name, scope, scope) ?? null;
}

export function mediaFilenames(pageId) {
  return q.mediaNames.all(pageId).map((row) => row.filename);
}

export function replaceSiteLogo(filename, mime, bytes) {
  transaction(() => {
    q.mediaDeleteSite.run();
    if (bytes) q.mediaPut.run(null, filename, mime, bytes);
  });
}

/* -------------------------------------------------------------------- users */

export function getUser(id) {
  return toUser(q.userById.get(Number(id)));
}

export function getUserByName(username) {
  return toUser(q.userByName.get(sanitizeUsername(username)));
}

/** All users, or those matching a username/display-name substring. */
export function listUsers(search = '') {
  const needle = String(search ?? '').trim();
  const rows = needle === ''
    ? q.usersAll.all()
    : q.usersSearch.all(...Array(2).fill(`%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`));
  return rows.map(toUser).map((user) => ({ ...user, pageCount: q.pageCountByAuthor.get(user.id).n }));
}

export function adminCount() {
  return q.adminCount.get().n;
}

/** @returns {{ok: boolean, error?: string, id?: number}} */
export function createUser({ username, displayName, passwordHash, isAdmin = false }) {
  const name = sanitizeUsername(username);
  if (name.length < 3) return { ok: false, error: 'Username needs 3+ characters (a-z, 0-9, . _ -).' };
  if (getUserByName(name)) return { ok: false, error: `User “${name}” already exists.` };
  const info = q.userInsert.run(
    name,
    String(displayName ?? '').trim().slice(0, 80) || name,
    passwordHash,
    isAdmin ? 1 : 0
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/**
 * Update username, display name and admin flag. The last admin cannot be
 * demoted, so the wiki can never lock everyone out of the admin area.
 */
export function updateUser(id, { username, displayName, isAdmin }) {
  const user = getUser(id);
  if (!user) return { ok: false, error: 'User not found.' };

  const name = sanitizeUsername(username ?? user.username);
  if (name.length < 3) return { ok: false, error: 'Username needs 3+ characters (a-z, 0-9, . _ -).' };
  const clash = getUserByName(name);
  if (clash && clash.id !== user.id) return { ok: false, error: `User “${name}” already exists.` };

  const admin = isAdmin === undefined ? user.isAdmin : Boolean(isAdmin);
  if (user.isAdmin && !admin && adminCount() <= 1) {
    return { ok: false, error: 'This is the only admin — promote someone else first.' };
  }

  q.userUpdate.run(name, String(displayName ?? user.displayName).trim().slice(0, 80) || name, admin ? 1 : 0, user.id);
  return { ok: true };
}

export function setUserPassword(id, passwordHash) {
  q.userSetPassword.run(passwordHash, Number(id));
}

/** Store (or, with null bytes, clear) a profile picture. */
export function setUserAvatar(id, mime, bytes) {
  q.avatarSet.run(bytes ?? null, bytes ? mime : null, Number(id));
}

/** @returns {{avatar: Uint8Array, avatar_mime: string}|null} */
export function getUserAvatar(username) {
  return q.avatarGet.get(sanitizeUsername(username)) ?? null;
}

/** Their pages survive as admin-owned (author_id → NULL via the foreign key). */
export function deleteUser(id) {
  const user = getUser(id);
  if (!user) return { ok: false, error: 'User not found.' };
  if (user.isAdmin && adminCount() <= 1) {
    return { ok: false, error: 'The only admin cannot be deleted.' };
  }
  q.userDelete.run(user.id);
  return { ok: true };
}

/* ----------------------------------------------------------------- settings */

export function getSetting(key, fallback = null) {
  return q.settingGet.get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  if (value === null) q.settingDelete.run(key);
  else q.settingSet.run(key, String(value));
}

/** First-run content so a fresh volume is not an empty wiki. */
export function seedIfEmpty() {
  if (q.all.all().length > 0) return false;
  savePage({
    slug: 'guides',
    title: 'Guides',
    body:
      'This top-level page is a **category**. Sub-pages in this section appear in the sidebar and in the list below.\n\n' +
      'Create more from Admin with *+ Sub-page*, or edit any page and choose a parent.\n',
  });
  savePage({
    slug: 'sample-page',
    title: 'Welcome to WikiFlip',
    parent: 'guides',
    body:
      '## What is WikiFlip?\n\nWikiFlip is a lightweight knowledge base. Pages are written in **Markdown** and stored in a single SQLite database.\n\n' +
      '## Features\n\n- WYSIWYG + Markdown editing\n- Categories with nested sub-pages\n- Images and PDFs stored in the database, served through one guarded route\n- deep-indigo glass theme\n\n' +
      '## Getting started\n\nOpen **Admin** to create a top-level page or nest a sub-page under one.\n',
  });
  savePage({
    slug: 'home',
    title: 'Home',
    body:
      '## Your wiki, ready to flip\n\nThis is the default home page. Top-level pages act as **categories** — open Guides below for an example with sub-pages.\n\n' +
      '[Browse Guides →](/guides)\n',
  });
  return true;
}
