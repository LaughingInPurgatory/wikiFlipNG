/**
 * WikiFlip NG — Express front controller.
 *
 * Public:  GET / , /:slug , /search , /media/:slug/:file , /site.css
 * Signed in (any user): /edit , /edit/:slug , /account , POST /pages/*
 * Admin only: /admin/** (page order, branding, users, backup)
 *
 * Every write goes through requireLogin (or requireAdmin) plus requireCsrf,
 * and page writes additionally check ownership with canEditPage().
 */

import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { downloadFilename, exportToTempFile, importFromArchive, MAX_IMPORT_BYTES } from './src/backup.js';

import {
  allPages,
  ancestors,
  canEditPage,
  canManagePage,
  childPages,
  collaboratorCount,
  createUser,
  deletePage,
  deleteUser,
  getMedia,
  getPage,
  getSetting,
  getUser,
  getUserAvatar,
  listUsers,
  mediaFilenames,
  pageCollaborators,
  pageTree,
  pagesByAuthor,
  pagesSharedWith,
  parentOptions,
  putMedia,
  replaceSiteLogo,
  reorderPage,
  sanitizeFilename,
  sanitizeSlug,
  savePage,
  searchPages,
  seedIfEmpty,
  setPageCollaborators,
  setSetting,
  setUserAvatar,
  setUserPassword,
  updateUser,
} from './src/db.js';
import {
  MIN_PASSWORD_LENGTH,
  SqliteSessionStore,
  authenticate,
  clearLoginFailures,
  csrfToken,
  ensureAdminUser,
  hashPassword,
  loadUser,
  loginBlockedFor,
  recordLoginFailure,
  requireAdmin,
  requireCsrf,
  requireLogin,
  sessionSecret,
  verifyPassword,
} from './src/auth.js';
import { renderMarkdown, pageUrl } from './src/markdown.js';
import {
  accountView,
  adminView,
  editorView,
  layout,
  loginView,
  notFoundView,
  pageView,
  searchView,
  userEditView,
} from './src/views.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = Number(process.env.WIKIFLIP_MAX_UPLOAD_MB || 30) * 1024 * 1024;
const MAX_CSS_BYTES = 512_000;

const admin = ensureAdminUser();
seedIfEmpty();
if (admin.generated) {
  console.warn(
    `\n  No WIKIFLIP_ADMIN_PASSWORD set. Generated one for user "${admin.username}":\n` +
      `\n      ${admin.generated}\n\n  Store it now — it is not shown again.\n`
  );
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

/* -------------------------------------------------------- security headers */

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "frame-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'", // the editor sets element styles
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(express.urlencoded({ extended: false, limit: '4mb' }));
app.use(
  session({
    name: 'wikiflip.sid',
    store: new SqliteSessionStore(),
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    },
  })
);
app.use(loadUser);

app.use(
  express.static(path.join(ROOT, 'public'), {
    index: false,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      }
    },
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 25, fieldSize: MAX_CSS_BYTES + 4096 },
});

// Profile pictures are resized to 100×100 in the browser before upload, so this
// only has to be generous enough for someone with scripting disabled.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 15 },
});

// Full-site backups can be larger than a single page upload.
const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 10 },
});

/**
 * Apply a profile-picture change from a multipart form.
 * @returns {{note?: string, error?: string}|null} null when nothing changed
 */
function applyAvatar(req, userId) {
  if (req.body.clear_avatar) {
    setUserAvatar(userId, null, null);
    return { note: 'profile picture removed' };
  }
  if (!req.file?.buffer?.length) return null;

  const kind = sniffUpload(req.file.buffer);
  if (!kind || kind.ext === 'pdf') {
    return { error: 'profile picture must be a PNG, JPEG, GIF or WebP image' };
  }
  setUserAvatar(userId, kind.mime, req.file.buffer);
  return { note: 'profile picture updated' };
}

/* ------------------------------------------------------------ view helpers */

/** Cache-bust local assets by mtime so edits show up without a hard reload. */
function asset(relPath) {
  try {
    const stamp = statSync(path.join(ROOT, 'public', relPath)).mtimeMs;
    return `${relPath}?v=${Math.round(stamp).toString(36)}`;
  } catch {
    return relPath;
  }
}

/** Branding logo URL + mime (custom upload, else bundled /logo.png). */
function brandingLogo() {
  const name = mediaFilenames(null)[0];
  if (name) {
    const media = getMedia('_site', name);
    return {
      url: `/media/_site/${encodeURIComponent(name)}`,
      mime: media?.mime || 'image/png',
    };
  }
  return { url: asset('/logo.png'), mime: 'image/png' };
}

function siteContext(req) {
  const logo = brandingLogo();
  return {
    asset,
    siteTitle: getSetting('site_title', 'WikiFlip'),
    logoUrl: logo.url,
    logoMime: logo.mime,
    customCssVersion: getSetting('custom_css') ? getSetting('custom_css_version', '1') : null,
    tree: pageTree(),
    user: req.user,
    csrf: csrfToken(req),
  };
}

function render(req, res, { status = 200, body, pageTitle, currentSlug = '', isAdmin = false, loadEditor = false, adminScript = null, searchTerm = '', loadAvatarScript = false }) {
  const ctx = siteContext(req);
  // Never let a proxy or the back button cache a signed-in page.
  if (ctx.user) res.setHeader('Cache-Control', 'no-store');
  res
    .status(status)
    .type('html')
    .send(layout({ ...ctx, body, pageTitle, currentSlug, isAdmin, loadEditor, adminScript, searchTerm, loadAvatarScript }));
}

function takeFlash(req) {
  const flash = req.session.flash ?? null;
  if (flash) delete req.session.flash;
  return flash;
}

function flashBack(req, res, url, message, ok = true) {
  req.session.flash = { message, ok };
  req.session.save(() => res.redirect(url));
}

/* ------------------------------------------------------------------ public */

function showPage(req, res, rawSlug) {
  const slug = sanitizeSlug(rawSlug) || 'home';
  const page = getPage(slug);
  if (!page) {
    return render(req, res, {
      status: 404,
      pageTitle: 'Page not found',
      body: notFoundView(slug, Boolean(req.user)),
      currentSlug: slug,
    });
  }

  return render(req, res, {
    pageTitle: page.title,
    currentSlug: page.slug,
    body: pageView({
      page,
      contentHtml: renderMarkdown(page.body, page.slug),
      ancestors: ancestors(page.slug),
      children: childPages(page.slug),
      siteTitle: getSetting('site_title', 'WikiFlip'),
      canEdit: canEditPage(req.user, page),
      canCreate: Boolean(req.user),
      author: page.authorId ? getUser(page.authorId) : null,
      collaborators: pageCollaborators(page.id),
    }),
  });
}

app.get('/', (req, res) => showPage(req, res, req.query.slug ?? 'home'));

app.get('/search', (req, res) => {
  const term = String(req.query.q ?? '').slice(0, 100);
  const results = searchPages(term);
  render(req, res, {
    pageTitle: term ? `Search: ${term}` : 'Search',
    searchTerm: term,
    body: searchView({ term, results }),
  });
});

app.get('/site.css', (req, res) => {
  const css = getSetting('custom_css');
  if (!css) return res.status(404).type('text/plain').send('No custom CSS.');
  res.type('text/css').set('Cache-Control', 'public, max-age=60, must-revalidate').send(css);
});

/** Favicon = branding logo (custom upload or the default logo.png). */
app.get(['/favicon.ico', '/favicon'], (req, res) => {
  const name = mediaFilenames(null)[0];
  if (name) {
    const media = getMedia('_site', name);
    if (media) {
      return res
        .status(200)
        .set({
          'Content-Type': media.mime,
          'Content-Length': String(media.bytes.byteLength),
          'Cache-Control': 'public, max-age=3600, must-revalidate',
        })
        .end(Buffer.from(media.bytes));
    }
  }
  res.set('Cache-Control', 'public, max-age=3600, must-revalidate').sendFile(path.join(ROOT, 'public', 'logo.png'));
});

app.get('/avatar/:username', (req, res) => {
  const avatar = getUserAvatar(req.params.username);
  if (!avatar) return res.status(404).type('text/plain').send('No profile picture.');
  res
    .status(200)
    .set({
      'Content-Type': avatar.avatar_mime || 'image/png',
      'Content-Length': String(avatar.avatar.byteLength),
      'Cache-Control': 'public, max-age=60, must-revalidate',
    })
    .end(Buffer.from(avatar.avatar));
});

app.get('/media/:slug/:file', (req, res) => {
  const media = getMedia(req.params.slug, req.params.file);
  if (!media) return res.status(404).type('text/plain').send('Media not found.');
  res
    .status(200)
    .set({
      'Content-Type': media.mime,
      'Content-Length': String(media.bytes.byteLength),
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': `inline; filename="${sanitizeFilename(req.params.file)}"`,
    })
    .end(Buffer.from(media.bytes));
});

/* ------------------------------------------------------------------- login */

function safeReturn(value, fallback = '/') {
  const target = String(value ?? '');
  return target.startsWith('/') && !target.startsWith('//') ? target : fallback;
}

const homeFor = (user) => (user?.isAdmin ? '/admin' : '/account');

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  render(req, res, {
    pageTitle: 'Sign in',
    body: loginView({
      error: takeFlash(req)?.message ?? '',
      returnTo: safeReturn(req.query.return, ''),
      csrf: csrfToken(req),
    }),
  });
});

app.post('/login', requireCsrf, (req, res) => {
  const ip = req.ip ?? 'unknown';
  const blockedFor = loginBlockedFor(ip);
  const showError = (error, status) =>
    render(req, res, {
      status,
      pageTitle: 'Sign in',
      body: loginView({ error, returnTo: safeReturn(req.body.return, ''), csrf: csrfToken(req) }),
    });

  if (blockedFor > 0) {
    return showError(`Too many failed attempts. Try again in ${Math.ceil(blockedFor / 60)} minute(s).`, 429);
  }

  const user = authenticate(req.body.username, String(req.body.password ?? ''));
  if (!user) {
    recordLoginFailure(ip);
    return showError('Invalid username or password.', 401);
  }

  clearLoginFailures(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).type('text/plain').send('Could not start a session.');
    req.session.uid = user.id;
    req.session.csrf = randomBytes(32).toString('hex');
    req.session.save(() => res.redirect(safeReturn(req.body.return, homeFor(user))));
  });
});

app.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wikiflip.sid', { path: '/' });
    res.redirect('/');
  });
});

/* --------------------------------------------------------- user account page */

app.get('/account', requireLogin, (req, res) => {
  if (req.user.isAdmin) return res.redirect('/admin?tab=users');
  const flash = takeFlash(req);
  render(req, res, {
    pageTitle: 'My account',
    isAdmin: true,
    loadAvatarScript: true,
    body: accountView({
      user: req.user,
      pages: pagesByAuthor(req.user.id),
      sharedPages: pagesSharedWith(req.user.id).map((page) => ({
        ...page,
        author: page.authorId ? getUser(page.authorId) : null,
      })),
      flash: flash?.message ?? '',
      flashOk: flash ? flash.ok !== false : true,
      csrf: csrfToken(req),
    }),
  });
});

app.post('/account', requireLogin, avatarUpload.single('avatar'), requireCsrf, (req, res) => {
  const displayName = String(req.body.display_name ?? '').trim();
  const result = updateUser(req.user.id, { username: req.user.username, displayName });
  if (!result.ok) return flashBack(req, res, '/account', result.error, false);

  const notes = ['Profile saved'];
  let ok = true;
  const avatar = applyAvatar(req, req.user.id);
  if (avatar?.error) {
    notes.push(avatar.error);
    ok = false;
  } else if (avatar?.note) {
    notes.push(avatar.note);
  }

  const next = String(req.body.new_password ?? '');
  if (next !== '') {
    if (next.length < MIN_PASSWORD_LENGTH) {
      return flashBack(req, res, '/account', `New password needs ${MIN_PASSWORD_LENGTH}+ characters.`, false);
    }
    if (next !== String(req.body.confirm_password ?? '')) {
      return flashBack(req, res, '/account', 'The two new passwords do not match.', false);
    }
    if (!verifyPassword(String(req.body.current_password ?? ''), req.user.passwordHash)) {
      return flashBack(req, res, '/account', 'Current password is incorrect.', false);
    }
    setUserPassword(req.user.id, hashPassword(next));
    notes.push('password changed');
  }

  flashBack(req, res, '/account', `${notes.join('; ')}.`, ok);
});

/* ------------------------------------------------------------ page editing */

const editorHandler = (req, res) => {
  const slug = sanitizeSlug(req.params.slug ?? req.query.slug ?? '');
  const existing = slug === '' ? null : getPage(slug);
  if (existing && !canEditPage(req.user, existing)) {
    return res.status(403).type('text/plain').send('This page belongs to someone else.');
  }
  const flash = takeFlash(req);

  const page = existing
    ? { slug: existing.slug, title: existing.title, body: existing.body, parent: existing.parent }
    : {
        slug,
        title: slug === '' ? '' : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        body: '',
        parent: sanitizeSlug(req.query.parent ?? ''),
      };
  if (page.parent !== '' && !getPage(page.parent)) page.parent = '';

  render(req, res, {
    pageTitle: existing ? `Edit: ${existing.title}` : 'New page',
    isAdmin: true,
    loadEditor: true,
    body: editorView({
      isNew: !existing,
      page,
      parentOptions: parentOptions(existing ? existing.slug : ''),
      // Only the owner (or an admin) sees the collaborator panel.
      canManage: Boolean(existing) && canManagePage(req.user, existing),
      collaborators: existing ? pageCollaborators(existing.id) : [],
      candidates: existing && canManagePage(req.user, existing)
        ? listUsers().filter((user) => user.id !== existing.authorId)
        : [],
      flash: flash?.message ?? '',
      flashOk: flash ? flash.ok !== false : true,
      csrf: csrfToken(req),
    }),
  });
};

app.get('/edit', requireLogin, editorHandler);
app.get('/edit/:slug', requireLogin, editorHandler);

app.post('/pages/save', requireLogin, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.body.slug);
  const isNew = String(req.body.is_new ?? '0') === '1';
  const originalSlug = sanitizeSlug(req.body.original_slug ?? '');
  const title = String(req.body.title ?? '').trim();
  const body = String(req.body.content ?? '');

  if (title === '') return res.status(422).json({ success: false, message: 'Title is required.' });
  if (slug === '') return res.status(422).json({ success: false, message: 'A valid URL slug is required.' });
  if (body.length > 2_000_000) return res.status(413).json({ success: false, message: 'Page content is too large.' });

  const existing = getPage(slug);
  if (isNew && existing) {
    return res.status(409).json({ success: false, message: `A page with slug “${slug}” already exists.` });
  }
  if (!isNew) {
    if (originalSlug === '' || slug !== originalSlug) {
      return res.status(409).json({ success: false, message: 'Page slugs cannot be changed after creation.' });
    }
    if (!existing) {
      return res.status(404).json({ success: false, message: 'The page being edited no longer exists.' });
    }
  }
  if (existing && !canEditPage(req.user, existing)) {
    return res.status(403).json({ success: false, message: 'This page belongs to someone else.' });
  }

  const result = savePage({ slug, title, body, parent: req.body.parent, authorId: req.user.id });
  if (!result.ok) return res.status(422).json({ success: false, message: result.error });

  res.json({
    success: true,
    message: 'Page saved successfully.',
    slug,
    view_url: pageUrl(slug),
    edit_url: `/edit/${slug}`,
  });
});

app.post('/pages/upload', requireLogin, upload.single('file'), requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.body.slug);
  if (slug === '') return res.status(422).json({ error: 'Save a URL slug before uploading media.' });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No file uploaded.' });

  const kind = sniffUpload(req.file.buffer);
  if (!kind) {
    return res.status(415).json({ error: 'Only JPEG, PNG, GIF, WebP, and PDF files are allowed.' });
  }

  let page = getPage(slug);
  if (page && !canEditPage(req.user, page)) {
    return res.status(403).json({ error: 'This page belongs to someone else.' });
  }
  if (!page) {
    // Media needs an owning page; create the shell the editor is about to save.
    const created = savePage({
      slug,
      title: String(req.body.title ?? '').trim() || slug,
      parent: req.body.parent,
      body: '',
      authorId: req.user.id,
    });
    if (!created.ok) return res.status(422).json({ error: created.error });
    page = getPage(slug);
  }

  const filename = uniqueFilename(req.file.originalname, kind.ext, mediaFilenames(page.id));
  putMedia(page.id, filename, kind.mime, req.file.buffer);

  res.json({
    location: filename,
    url: `/media/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`,
    type: kind.ext === 'pdf' ? 'pdf' : 'image',
    filename,
  });
});

app.post('/pages/collaborators', requireLogin, requireCsrf, (req, res) => {
  const page = getPage(sanitizeSlug(req.body.slug));
  if (!page) return res.status(404).type('text/plain').send('Page not found.');
  if (!canManagePage(req.user, page)) {
    return res.status(403).type('text/plain').send('Only the page owner can change collaborators.');
  }

  const ids = [].concat(req.body.collaborator ?? []);
  const result = setPageCollaborators(page.id, ids);
  const back = `/edit/${page.slug}`;
  if (!result.ok) return flashBack(req, res, back, result.error, false);
  flashBack(
    req,
    res,
    back,
    result.count === 0 ? 'Collaborators cleared — only you can edit this page.' : `${result.count} collaborator(s) can now edit this page.`
  );
});

app.post('/pages/delete', requireLogin, requireCsrf, (req, res) => {
  const page = getPage(sanitizeSlug(req.body.slug));
  const back = req.user.isAdmin ? '/admin' : '/account';
  if (!page) return flashBack(req, res, back, 'That page no longer exists.', false);
  // Collaborators can edit but not delete — that stays with the owner.
  if (!canManagePage(req.user, page)) {
    return flashBack(req, res, back, 'Only the page owner can delete this page.', false);
  }
  if (!deletePage(page.slug)) {
    return flashBack(req, res, back, 'The home page cannot be deleted.', false);
  }
  flashBack(req, res, back, `Deleted “${page.title}”.`);
});

/* ------------------------------------------------------------------- admin */

app.get('/admin', requireAdmin, (req, res) => {
  const tab = ['branding', 'users', 'backup'].includes(req.query.tab) ? req.query.tab : 'pages';
  const flash = takeFlash(req);
  const customCss = getSetting('custom_css');
  const userSearch = String(req.query.u ?? '').slice(0, 60);

  render(req, res, {
    pageTitle: 'Admin',
    isAdmin: true,
    adminScript: tab === 'pages' ? '/js/admin.js' : null,
    body: adminView({
      tab,
      tree: pageTree(),
      users: tab === 'users' ? listUsers(userSearch) : [],
      userSearch,
      currentUser: req.user,
      authors: authorNames(),
      shared: tab === 'pages' ? collaboratorCounts() : new Map(),
      flash: flash?.message ?? '',
      flashOk: flash ? flash.ok !== false : true,
      site: { title: getSetting('site_title', 'WikiFlip'), hasLogo: mediaFilenames(null).length > 0 },
      cssValue: customCss ?? defaultCss(),
      hasCustomCss: Boolean(customCss),
      logoUrl: siteContext(req).logoUrl,
      csrf: csrfToken(req),
    }),
  });
});

/* ----------------------------------------------------------- backup / restore */

app.post('/admin/backup/export', requireAdmin, requireCsrf, (req, res) => {
  let tempPath;
  try {
    tempPath = exportToTempFile();
    const filename = downloadFilename();
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Content-Length': String(statSync(tempPath).size),
    });
    const stream = createReadStream(tempPath);
    stream.on('close', () => {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* ignore */
      }
    });
    stream.on('error', () => {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* ignore */
      }
      if (!res.headersSent) res.status(500).type('text/plain').send('Export failed.');
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    console.error('backup export failed:', err);
    flashBack(req, res, '/admin?tab=backup', `Export failed: ${err.message}`, false);
  }
});

app.post('/admin/backup/import', requireAdmin, backupUpload.single('backup_file'), requireCsrf, (req, res) => {
  if (!req.file?.buffer?.length) {
    return flashBack(req, res, '/admin?tab=backup', 'Choose a .zip backup file to import.', false);
  }

  const mode = req.body.import_mode === 'merge' ? 'merge' : 'replace';
  const tempPath = path.join(tmpdir(), `wikiflip-upload-${randomBytes(8).toString('hex')}.bin`);
  try {
    writeFileSync(tempPath, req.file.buffer);
    const result = importFromArchive(tempPath, mode, req.file.originalname);
    flashBack(req, res, '/admin?tab=backup', result.message, result.ok);
  } catch (err) {
    console.error('backup import failed:', err);
    flashBack(req, res, '/admin?tab=backup', `Import failed: ${err.message}`, false);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* ignore */
    }
  }
});

/** id → display name, for the author column. */
function authorNames() {
  const names = new Map();
  for (const user of listUsers()) names.set(user.id, user.displayName);
  return names;
}

/** slug → collaborator count, so the admin table can show sharing at a glance. */
function collaboratorCounts() {
  const counts = new Map();
  for (const page of allPages()) {
    const n = collaboratorCount(page.id);
    if (n > 0) counts.set(page.slug, n);
  }
  return counts;
}

app.post('/admin/reorder', requireAdmin, requireCsrf, (req, res) => {
  const slug = sanitizeSlug(req.body.slug);
  const direction = req.body.direction === 'up' ? 'up' : req.body.direction === 'down' ? 'down' : null;
  const ok = Boolean(slug) && direction !== null && reorderPage(slug, direction);
  res.set('Cache-Control', 'no-store').json({ ok, slug, direction });
});

app.post('/admin/branding', requireAdmin, upload.single('logo'), requireCsrf, (req, res) => {
  const notes = [];
  let ok = true;

  setSetting('site_title', String(req.body.site_title ?? '').trim().slice(0, 80) || 'WikiFlip');
  notes.push('Site title saved');

  if (req.body.clear_logo) {
    replaceSiteLogo(null, null, null);
    notes.push('logo reset to default');
  } else if (req.file?.buffer?.length) {
    const kind = sniffUpload(req.file.buffer);
    if (!kind || kind.ext === 'pdf') {
      notes.push('logo upload failed (use PNG, JPEG, GIF, or WebP)');
      ok = false;
    } else {
      replaceSiteLogo(`logo-${randomBytes(3).toString('hex')}.${kind.ext}`, kind.mime, req.file.buffer);
      notes.push('logo updated');
    }
  }

  if (req.body.reset_css) {
    setSetting('custom_css', null);
    notes.push('custom CSS cleared (using default theme)');
  } else if (typeof req.body.custom_css === 'string') {
    const css = req.body.custom_css.replace(/\0/g, '').replace(/\r\n?/g, '\n');
    if (Buffer.byteLength(css) > MAX_CSS_BYTES) {
      notes.push('CSS save failed (max 500 KB)');
      ok = false;
    } else if (css.trim() === '' || css.trim() === defaultCss().trim()) {
      setSetting('custom_css', null);
      notes.push('using default theme CSS');
    } else {
      setSetting('custom_css', css);
      setSetting('custom_css_version', String(Date.now()));
      notes.push('custom CSS saved');
    }
  }

  flashBack(req, res, '/admin?tab=branding', `${notes.join('; ')}.`, ok);
});

/* -------------------------------------------------------- user management */

app.post('/admin/users', requireAdmin, requireCsrf, (req, res) => {
  const password = String(req.body.password ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return flashBack(req, res, '/admin?tab=users', `Password needs ${MIN_PASSWORD_LENGTH}+ characters.`, false);
  }
  const result = createUser({
    username: req.body.username,
    displayName: req.body.display_name,
    passwordHash: hashPassword(password),
    isAdmin: Boolean(req.body.is_admin),
  });
  if (!result.ok) return flashBack(req, res, '/admin?tab=users', result.error, false);
  flashBack(req, res, '/admin?tab=users', `Created user “${sanitizeSlug(req.body.username) || 'user'}”.`);
});

app.get('/admin/users/:id', requireAdmin, (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).type('text/plain').send('User not found.');
  const flash = takeFlash(req);
  render(req, res, {
    pageTitle: `Edit user: ${user.displayName}`,
    isAdmin: true,
    loadAvatarScript: true,
    body: userEditView({
      user,
      pages: pagesByAuthor(user.id),
      isSelf: user.id === req.user.id,
      flash: flash?.message ?? '',
      flashOk: flash ? flash.ok !== false : true,
      csrf: csrfToken(req),
    }),
  });
});

app.post('/admin/users/:id', requireAdmin, avatarUpload.single('avatar'), requireCsrf, (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).type('text/plain').send('User not found.');
  const back = `/admin/users/${user.id}`;

  // An admin cannot drop their own admin rights — that is a one-way lockout.
  const isAdmin = user.id === req.user.id ? true : Boolean(req.body.is_admin);
  const result = updateUser(user.id, {
    username: req.body.username,
    displayName: req.body.display_name,
    isAdmin,
  });
  if (!result.ok) return flashBack(req, res, back, result.error, false);

  const notes = ['User saved'];
  let ok = true;
  const avatar = applyAvatar(req, user.id);
  if (avatar?.error) {
    notes.push(avatar.error);
    ok = false;
  } else if (avatar?.note) {
    notes.push(avatar.note);
  }

  const password = String(req.body.new_password ?? '');
  if (password !== '') {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return flashBack(req, res, back, `Password needs ${MIN_PASSWORD_LENGTH}+ characters.`, false);
    }
    setUserPassword(user.id, hashPassword(password));
    notes.push('password changed');
  }
  flashBack(req, res, back, `${notes.join('; ')}.`, ok);
});

app.post('/admin/users/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).type('text/plain').send('User not found.');
  if (user.id === req.user.id) {
    return flashBack(req, res, '/admin?tab=users', 'You cannot delete your own account.', false);
  }
  const result = deleteUser(user.id);
  flashBack(
    req,
    res,
    '/admin?tab=users',
    result.ok ? `Deleted “${user.username}”; their pages are now admin-owned.` : result.error,
    result.ok
  );
});

/* --------------------------------------------------------- upload plumbing */

/** Trust the bytes, not the client's Content-Type or file extension. */
function sniffUpload(buf) {
  if (buf.length < 12) return null;
  const head = buf.subarray(0, 12);
  const ascii = (start, end) => head.subarray(start, end).toString('latin1');

  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return { mime: 'image/png', ext: 'png' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(0, 6) === 'GIF89a' || ascii(0, 6) === 'GIF87a') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

/** Readable name from the upload, extension from the sniffed type. */
function uniqueFilename(originalName, ext, taken) {
  const base = sanitizeFilename(String(originalName ?? '').replace(/\.[^.]*$/, '')).slice(0, 40) || 'file';
  let name = `${base}.${ext}`;
  while (taken.includes(name)) name = `${base}-${randomBytes(3).toString('hex')}.${ext}`;
  return name;
}

let defaultCssCache = null;
function defaultCss() {
  if (defaultCssCache === null) {
    defaultCssCache = readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  }
  return defaultCssCache;
}

/* ------------------------------------------------------------------- tail */

app.get('/:slug', (req, res) => showPage(req, res, req.params.slug));

app.use((err, req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` });
  }
  console.error('wikiflip:', err?.message ?? err);
  if (res.headersSent) return;
  res.status(500).type('text/plain').send('Something went wrong.');
});

// Tests import the app and bind their own port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`WikiFlip NG on http://localhost:${PORT} (${allPages().length} pages)`);
  });
}

export { app };
