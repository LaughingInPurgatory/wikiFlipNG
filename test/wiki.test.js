/**
 * Smoke tests for the parts that would silently rot: storage tree/order rules,
 * markdown rewriting (media, wiki links, PDF embeds), XSS escaping, password
 * hashing, and the HTTP surface including auth + CSRF enforcement.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workdir = mkdtempSync(path.join(tmpdir(), 'wikiflip-test-'));
process.env.WIKIFLIP_DB = path.join(workdir, 'test.db');
process.env.WIKIFLIP_ADMIN_USER = 'tester';
process.env.WIKIFLIP_ADMIN_PASSWORD = 'correct horse battery';
process.env.WIKIFLIP_SESSION_SECRET = 'test-secret-value-not-random';
process.env.PORT = '0';

const db = await import('../src/db.js');
const { renderMarkdown } = await import('../src/markdown.js');
const { hashPassword, verifyPassword } = await import('../src/auth.js');
const { app } = await import('../server.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
});

test('slug and filename sanitising strips traversal and junk', () => {
  assert.equal(db.sanitizeSlug('  Hello World!  '), 'hello-world');
  assert.equal(db.sanitizeSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(db.sanitizeFilename('../../../etc/passwd'), 'passwd');
  assert.equal(db.sanitizeFilename('sub/dir/photo.png'), 'photo.png');
  assert.equal(db.sanitizeFilename('..'), '');
});

test('tree, ordering, reparenting and delete-promotes-children', () => {
  db.savePage({ slug: 'parent', title: 'Parent' });
  db.savePage({ slug: 'first', title: 'First', parent: 'parent' });
  db.savePage({ slug: 'second', title: 'Second', parent: 'parent' });

  // Newest sibling sits on top until reordered.
  assert.deepEqual(db.childPages('parent').map((p) => p.slug), ['second', 'first']);
  assert.equal(db.reorderPage('second', 'down'), true);
  assert.deepEqual(db.childPages('parent').map((p) => p.slug), ['first', 'second']);
  assert.equal(db.reorderPage('first', 'up'), false, 'cannot move past the top');

  assert.deepEqual(db.ancestors('first').map((p) => p.slug), ['parent']);

  // Cycles are refused.
  const cycle = db.savePage({ slug: 'parent', title: 'Parent', parent: 'first' });
  assert.equal(cycle.ok, false);

  db.deletePage('parent');
  assert.equal(db.getPage('parent'), null);
  assert.equal(db.getPage('first').parent, '', 'orphans are promoted, not deleted');
  db.deletePage('first');
  db.deletePage('second');
});

test('markdown: media, wiki links, PDF embeds, and escaped HTML', () => {
  const html = renderMarkdown(
    'Text with ![shot](photo.png) and [old link](?slug=guides).\n\n' +
      '[Handbook](handbook.pdf)\n\n' +
      '<script>alert(1)</script>\n\n' +
      '[External](https://example.com)\n',
    'my-page'
  );

  assert.match(html, /src="\/media\/my-page\/photo\.png"/);
  assert.match(html, /href="\/guides"/);
  assert.match(html, /alt="shot"/, 'alt text survives the custom image rule');
  assert.match(html, /class="pdf-embed"/);
  // PDF renders as a clickable thumbnail card, full view comes from the lightbox.
  assert.match(html, /<button type="button" class="pdf-thumb" data-pdf-src="\/media\/my-page\/handbook\.pdf"/);
  assert.match(html, /iframe class="pdf-thumb-frame" src="\/media\/my-page\/handbook\.pdf#toolbar=0/);
  assert.match(html, /class="pdf-embed-name">Handbook</);
  assert.doesNotMatch(html, /<script>/, 'raw HTML must be escaped, never emitted');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);

  // javascript: URLs never become links — markdown-it's validator refuses them,
  // so the source stays inert text.
  const dangerous = renderMarkdown('[x](javascript:alert(1))', 'p');
  assert.doesNotMatch(dangerous, /<a\b/);
  assert.doesNotMatch(dangerous, /href=/);
});

test('scrypt hashes verify and reject', () => {
  const hash = hashPassword('s3cret-passphrase');
  assert.equal(verifyPassword('s3cret-passphrase', hash), true);
  assert.equal(verifyPassword('s3cret-passphras', hash), false);
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
});

test('public pages render and unknown slugs 404', async () => {
  db.savePage({ slug: 'public-page', title: 'Public Page', body: 'Hello **world**.' });
  const ok = await fetch(`${base}/public-page`);
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /Public Page/);
  assert.match(body, /<strong>world<\/strong>/);
  assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);

  const missing = await fetch(`${base}/no-such-page`);
  assert.equal(missing.status, 404);
});

const CSRF_RE = /data-csrf="([a-f0-9]+)"/;

/** Log in the way a browser does; returns the session cookie and its CSRF token. */
async function signIn(username = 'tester', password = 'correct horse battery') {
  const loginPage = await fetch(`${base}/login`);
  const firstCookie = loginPage.headers.get('set-cookie').split(';')[0];
  const loginCsrf = CSRF_RE.exec(await loginPage.text())[1];

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: firstCookie },
    body: new URLSearchParams({ username, password, csrf_token: loginCsrf }),
    redirect: 'manual',
  });
  assert.equal(login.status, 302, `login failed for ${username}`);

  const cookie = (login.headers.get('set-cookie') ?? firstCookie).split(';')[0];
  const landing = await fetch(`${base}${login.headers.get('location')}`, { headers: { cookie } });
  assert.equal(landing.status, 200);
  return { cookie, csrf: CSRF_RE.exec(await landing.text())[1] };
}

/** POST form-encoded as a signed-in browser would (arrays → repeated keys). */
function post(url, cookie, fields, redirect = 'manual') {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      cookie,
    },
    body,
    redirect,
  });
}

test('admin routes require a session, and writes require a CSRF token', async () => {
  const guarded = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(guarded.status, 302);
  assert.match(guarded.headers.get('location'), /^\/login/);

  const saveAttempt = await post('/pages/save', '', { slug: 'evil', title: 'Evil', is_new: '1' });
  assert.equal(saveAttempt.status, 401);
  assert.equal(db.getPage('evil'), null);

  const loginPage = await fetch(`${base}/login`);
  const cookie = loginPage.headers.get('set-cookie').split(';')[0];
  const csrf = CSRF_RE.exec(await loginPage.text())[1];

  const badPassword = await post('/login', cookie, {
    username: 'tester',
    password: 'wrong',
    csrf_token: csrf,
  });
  assert.equal(badPassword.status, 401);

  // A valid session without the token still cannot write.
  const session = await signIn();
  const noToken = await post('/pages/save', session.cookie, {
    slug: 'csrf-test',
    title: 'CSRF',
    is_new: '1',
  });
  assert.equal(noToken.status, 403);
  assert.equal(db.getPage('csrf-test'), null);

  const saved = await post('/pages/save', session.cookie, {
    slug: 'csrf-test',
    title: 'CSRF',
    is_new: '1',
    content: 'saved',
    csrf_token: session.csrf,
  });
  assert.equal(saved.status, 200);
  assert.equal(db.getPage('csrf-test').body, 'saved');
});

test('uploads are sniffed, stored, and rendered back into the page', async () => {
  const { cookie, csrf } = await signIn();

  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.alloc(32), // enough bytes to look like a real file
  ]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

  const put = async (bytes, name, type) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    form.append('slug', 'upload-target');
    form.append('title', 'Upload Target');
    form.append('csrf_token', csrf);
    const res = await fetch(`${base}/pages/upload`, { method: 'POST', headers: { cookie }, body: form });
    return { status: res.status, body: await res.json() };
  };

  // The page is created on first upload so the media has an owner.
  const image = await put(png, 'My Photo.png', 'image/png');
  assert.equal(image.status, 200);
  assert.equal(image.body.location, 'My-Photo.png');

  const doc = await put(pdf, 'handbook.pdf', 'application/pdf');
  assert.equal(doc.status, 200);
  assert.equal(doc.body.type, 'pdf');

  // A disguised script is rejected on content, not on its name.
  const evil = await put(Buffer.from('<?php system($_GET["c"]); ?>            '), 'shell.png', 'image/png');
  assert.equal(evil.status, 415);

  db.savePage({
    slug: 'upload-target',
    title: 'Upload Target',
    body: '![shot](My-Photo.png)\n\n[Handbook](handbook.pdf)\n',
  });
  const html = await (await fetch(`${base}/upload-target`)).text();
  assert.match(html, /<img src="\/media\/upload-target\/My-Photo\.png"/);
  assert.match(html, /data-pdf-src="\/media\/upload-target\/handbook\.pdf"/);
  assert.equal((await fetch(`${base}/media/upload-target/My-Photo.png`)).status, 200);
});

test('users own their pages: they can edit their own and nobody else’s', async () => {
  const boss = await signIn();

  // Admin creates a normal user through the admin UI.
  const created = await post('/admin/users', boss.cookie, {
    username: 'writer',
    display_name: 'Wanda Writer',
    password: 'writer-password',
    csrf_token: boss.csrf,
  });
  assert.equal(created.status, 302);
  const writer = db.getUserByName('writer');
  assert.equal(writer.isAdmin, false);

  const hers = await signIn('writer', 'writer-password');

  // /account is the user's home; /admin and admin-only writes are closed to them.
  assert.equal((await fetch(`${base}/account`, { headers: { cookie: hers.cookie } })).status, 200);
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie: hers.cookie } })).status, 403);
  const reorder = await post('/admin/reorder', hers.cookie, {
    slug: 'home',
    direction: 'down',
    csrf_token: hers.csrf,
  });
  assert.equal(reorder.status, 403);
  const branding = await post('/admin/branding', hers.cookie, {
    site_title: 'Hijacked',
    csrf_token: hers.csrf,
  });
  assert.equal(branding.status, 403);
  assert.notEqual(db.getSetting('site_title', 'WikiFlip'), 'Hijacked');

  // Her own page: create, then edit.
  const mine = await post('/pages/save', hers.cookie, {
    slug: 'wandas-notes',
    title: "Wanda's Notes",
    is_new: '1',
    content: 'First draft.',
    csrf_token: hers.csrf,
  });
  assert.equal(mine.status, 200);
  assert.equal(db.getPage('wandas-notes').authorId, writer.id);

  const edited = await post('/pages/save', hers.cookie, {
    slug: 'wandas-notes',
    original_slug: 'wandas-notes',
    title: "Wanda's Notes",
    is_new: '0',
    content: 'Second draft.',
    csrf_token: hers.csrf,
  });
  assert.equal(edited.status, 200);
  assert.equal(db.getPage('wandas-notes').body, 'Second draft.');

  // Someone else's page (admin-owned): editor is closed, save and delete refused.
  assert.equal((await fetch(`${base}/edit/home`, { headers: { cookie: hers.cookie } })).status, 403);
  const stolen = await post('/pages/save', hers.cookie, {
    slug: 'home',
    original_slug: 'home',
    title: 'Defaced',
    is_new: '0',
    content: 'nope',
    csrf_token: hers.csrf,
  });
  assert.equal(stolen.status, 403);
  assert.notEqual(db.getPage('home').title, 'Defaced');

  await post('/pages/delete', hers.cookie, { slug: 'home', csrf_token: hers.csrf });
  assert.ok(db.getPage('home'), 'home page survived a non-owner delete');

  // The admin can edit anything, including her page.
  const adminEdit = await post('/pages/save', boss.cookie, {
    slug: 'wandas-notes',
    original_slug: 'wandas-notes',
    title: 'Wanda’s Notes (edited by admin)',
    is_new: '0',
    content: 'Admin passed through.',
    csrf_token: boss.csrf,
  });
  assert.equal(adminEdit.status, 200);
  assert.equal(db.getPage('wandas-notes').authorId, writer.id, 'ownership does not transfer on edit');

  // She can delete her own page.
  const removed = await post('/pages/delete', hers.cookie, {
    slug: 'wandas-notes',
    csrf_token: hers.csrf,
  });
  assert.equal(removed.status, 302);
  assert.equal(db.getPage('wandas-notes'), null);
});

test('collaborators can edit a shared page but not delete it or change the list', async () => {
  const boss = await signIn();

  // Two users: one owns the page, the other is invited to it.
  for (const [username, name] of [['owner', 'Olive Owner'], ['helper', 'Hal Helper']]) {
    const created = await post('/admin/users', boss.cookie, {
      username,
      display_name: name,
      password: `${username}-password`,
      csrf_token: boss.csrf,
    });
    assert.equal(created.status, 302);
  }
  const helper = db.getUserByName('helper');
  const olive = await signIn('owner', 'owner-password');
  const hal = await signIn('helper', 'helper-password');

  const created = await post('/pages/save', olive.cookie, {
    slug: 'shared-page',
    title: 'Shared Page',
    is_new: '1',
    content: 'Owner draft.',
    csrf_token: olive.csrf,
  });
  assert.equal(created.status, 200);

  // Before being invited, Hal is locked out.
  assert.equal((await fetch(`${base}/edit/shared-page`, { headers: { cookie: hal.cookie } })).status, 403);

  // Hal cannot invite himself.
  const selfInvite = await post('/pages/collaborators', hal.cookie, {
    slug: 'shared-page',
    collaborator: String(helper.id),
    csrf_token: hal.csrf,
  });
  assert.equal(selfInvite.status, 403);
  assert.equal(db.pageCollaborators(db.getPage('shared-page').id).length, 0);

  // The owner invites him.
  const invite = await post('/pages/collaborators', olive.cookie, {
    slug: 'shared-page',
    collaborator: String(helper.id),
    csrf_token: olive.csrf,
  });
  assert.equal(invite.status, 302);
  const shared = db.getPage('shared-page');
  assert.deepEqual(db.pageCollaborators(shared.id).map((u) => u.username), ['helper']);
  assert.equal(db.collaboratorCount(shared.id), 1);

  // Now he can open and save it — but ownership stays with Olive.
  assert.equal((await fetch(`${base}/edit/shared-page`, { headers: { cookie: hal.cookie } })).status, 200);
  const edited = await post('/pages/save', hal.cookie, {
    slug: 'shared-page',
    original_slug: 'shared-page',
    title: 'Shared Page',
    is_new: '0',
    content: 'Helper edit.',
    csrf_token: hal.csrf,
  });
  assert.equal(edited.status, 200);
  assert.equal(db.getPage('shared-page').body, 'Helper edit.');
  assert.equal(db.getPage('shared-page').authorId, db.getUserByName('owner').id);

  // It shows up on his account page as shared with him.
  assert.deepEqual(db.pagesSharedWith(helper.id).map((p) => p.slug), ['shared-page']);
  const account = await (await fetch(`${base}/account`, { headers: { cookie: hal.cookie } })).text();
  assert.match(account, /Shared with me/);
  assert.match(account, /Shared Page/);

  // He still cannot delete it, nor edit the collaborator list.
  await post('/pages/delete', hal.cookie, { slug: 'shared-page', csrf_token: hal.csrf });
  assert.ok(db.getPage('shared-page'), 'a collaborator must not be able to delete the page');
  const relist = await post('/pages/collaborators', hal.cookie, { slug: 'shared-page', csrf_token: hal.csrf });
  assert.equal(relist.status, 403);
  assert.equal(db.collaboratorCount(shared.id), 1, 'the list is unchanged');

  // The byline names the collaborator.
  const html = await (await fetch(`${base}/shared-page`)).text();
  assert.match(html, /article-byline-with">with Hal Helper</);

  // Removing him revokes access again.
  const cleared = await post('/pages/collaborators', olive.cookie, {
    slug: 'shared-page',
    csrf_token: olive.csrf,
  });
  assert.equal(cleared.status, 302);
  assert.equal(db.collaboratorCount(shared.id), 0);
  assert.equal((await fetch(`${base}/edit/shared-page`, { headers: { cookie: hal.cookie } })).status, 403);

  // An admin can manage anyone's list, and the owner is never added to it.
  const adminSet = await post('/pages/collaborators', boss.cookie, {
    slug: 'shared-page',
    collaborator: [String(helper.id), String(db.getUserByName('owner').id)],
    csrf_token: boss.csrf,
  });
  assert.equal(adminSet.status, 302);
  assert.deepEqual(db.pageCollaborators(shared.id).map((u) => u.username), ['helper']);

  // Deleting the collaborator's account drops the grant with it.
  assert.equal(db.deleteUser(helper.id).ok, true);
  assert.equal(db.collaboratorCount(shared.id), 0);

  db.deletePage('shared-page');
  db.deleteUser(db.getUserByName('owner').id);
});

test('profile pictures upload, serve, show on the author’s pages, and clear', async () => {
  const session = await signIn();
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(24, 7)]);

  const send = async (fields) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value instanceof Buffer) form.append('avatar', new Blob([value], { type: 'image/gif' }), 'me.gif');
      else form.append(key, value);
    }
    form.append('csrf_token', session.csrf);
    const res = await fetch(`${base}/account`, {
      method: 'POST',
      headers: { cookie: session.cookie },
      body: form,
      redirect: 'manual',
    });
    return res.status;
  };

  // The signed-in admin lands on /admin, so post their profile through /account.
  assert.equal(await send({ display_name: 'Tester Admin', avatar: gif }), 302);
  const admin = db.getUserByName('tester');
  assert.equal(admin.hasAvatar, true);
  assert.equal(admin.avatarUrl, '/avatar/tester');

  const served = await fetch(`${base}/avatar/tester`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/gif');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), gif);
  assert.equal((await fetch(`${base}/avatar/nobody`)).status, 404);

  // Listing users must not drag blobs into memory.
  const listed = db.listUsers().find((u) => u.username === 'tester');
  assert.equal(listed.hasAvatar, true);
  assert.equal(listed.avatar, undefined, 'avatar bytes must not be selected for list views');

  // The picture shows on a page this user created.
  db.savePage({ slug: 'authored-page', title: 'Authored Page', authorId: admin.id });
  const html = await (await fetch(`${base}/authored-page`)).text();
  assert.match(html, /class="avatar" src="\/avatar\/tester"/);
  assert.match(html, /article-byline-name">Tester Admin</);

  // A page with no author shows no byline avatar.
  db.savePage({ slug: 'orphan-page', title: 'Orphan Page' });
  const orphan = await (await fetch(`${base}/orphan-page`)).text();
  assert.doesNotMatch(orphan, /article-byline/);

  // A PDF is not a profile picture.
  assert.equal(
    await send({ display_name: 'Tester Admin', avatar: Buffer.from('%PDF-1.4 not an image ') }),
    302
  );
  assert.equal(db.getUserByName('tester').hasAvatar, true, 'the old picture survives a bad upload');

  assert.equal(await send({ display_name: 'Tester Admin', clear_avatar: '1' }), 302);
  assert.equal(db.getUserByName('tester').hasAvatar, false);
  assert.equal((await fetch(`${base}/avatar/tester`)).status, 404);

  db.deletePage('authored-page');
  db.deletePage('orphan-page');
});

test('booting again neither regenerates nor announces a password', async () => {
  const { ensureAdminUser } = await import('../src/auth.js');
  const before = db.getUserByName('tester');

  const again = ensureAdminUser();
  assert.equal(again.generated, null, 'an existing admin must not get a new password');
  assert.equal(db.getUserByName('tester').id, before.id);

  // The environment password is authoritative, so logging in still works.
  const session = await signIn();
  assert.match(session.csrf, /^[a-f0-9]{64}$/);
});

test('the last admin cannot be demoted or deleted', () => {
  const admin = db.getUserByName('tester');
  assert.equal(db.adminCount(), 1);
  assert.equal(db.updateUser(admin.id, { isAdmin: false }).ok, false);
  assert.equal(db.deleteUser(admin.id).ok, false);
  assert.equal(db.getUser(admin.id).isAdmin, true);
});

test('deleting a user keeps their pages as admin-owned', () => {
  const hash = hashPassword('temporary-password');
  const { id } = db.createUser({ username: 'tempuser', displayName: 'Temp', passwordHash: hash });
  db.savePage({ slug: 'temp-page', title: 'Temp Page', authorId: id });
  assert.equal(db.pagesByAuthor(id).length, 1);

  assert.equal(db.deleteUser(id).ok, true);
  assert.equal(db.getUser(id), null);
  assert.equal(db.getPage('temp-page').authorId, null, 'page survives, now admin-owned');
  db.deletePage('temp-page');
});

test('reserved slugs cannot be taken by a page', () => {
  for (const slug of ['login', 'admin', 'account', 'search', 'media']) {
    assert.equal(db.savePage({ slug, title: 'Nope' }).ok, false, `${slug} was allowed`);
    assert.equal(db.getPage(slug), null);
  }
});

test('search finds pages by title and body', async () => {
  db.savePage({ slug: 'kettle-guide', title: 'Kettle Guide', body: 'How to descale a kettle with vinegar.' });
  db.savePage({ slug: 'toaster-guide', title: 'Toaster Guide', body: 'Crumb tray maintenance.' });

  assert.deepEqual(db.searchPages('kettle').map((p) => p.slug), ['kettle-guide']);
  assert.deepEqual(db.searchPages('vinegar').map((p) => p.slug), ['kettle-guide']);
  assert.deepEqual(db.searchPages('%').map((p) => p.slug), [], 'wildcards are escaped, not matched');
  assert.deepEqual(db.searchPages('k'), [], 'one character is too short to search');

  // Assert on the results list only — the sidebar nav lists every page.
  const html = await (await fetch(`${base}/search?q=crumb`)).text();
  const resultsList = /<ul class="search-results">([\s\S]*?)<\/ul>/.exec(html)[1];
  assert.match(resultsList, /Toaster Guide/);
  assert.doesNotMatch(resultsList, /Kettle Guide/);

  db.deletePage('kettle-guide');
  db.deletePage('toaster-guide');
});

test('backup export/import round-trips pages and accepts classic zip backups', async () => {
  const { exportToTempFile, importFromArchive } = await import('../src/backup.js');
  const { createZip } = await import('../src/zip.js');
  const { writeFileSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');

  db.savePage({ slug: 'backup-alpha', title: 'Backup Alpha', body: 'original alpha body' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  db.putMedia(db.getPage('backup-alpha').id, 'shot.png', 'image/png', png);
  db.setSetting('site_title', 'Backup Lab');

  const archive = exportToTempFile();
  assert.ok(archive.endsWith('.zip'));
  const archiveBytes = readFileSync(archive);
  assert.ok(archiveBytes.length > 100);
  assert.equal(archiveBytes[0], 0x50); // P
  assert.equal(archiveBytes[1], 0x4b); // K

  // Mutate after export — replace import should undo this.
  db.savePage({ slug: 'backup-alpha', title: 'Backup Alpha', body: 'mutated' });
  db.savePage({ slug: 'backup-only-live', title: 'Live Only', body: 'should vanish on replace' });
  assert.equal(db.getPage('backup-alpha').body, 'mutated');

  const restored = importFromArchive(archive, 'replace');
  assert.equal(restored.ok, true, restored.message);
  assert.equal(db.getPage('backup-alpha').body, 'original alpha body');
  assert.equal(db.getPage('backup-only-live'), null, 'replace wipes pages absent from the backup');
  assert.equal(db.getSetting('site_title', ''), 'Backup Lab');
  assert.ok(db.getMedia('backup-alpha', 'shot.png'), 'media returns with the page');
  rmSync(archive, { force: true });

  // Classic PHP-style pages/ tree inside a ZIP (original WikiFlip layout).
  // Include an empty directory marker the way many ZIP tools write `.site`.
  const classicZip = pathMod.join(tmpdir(), `classic-${process.pid}.zip`);
  writeFileSync(
    classicZip,
    createZip({
      'wikiflip-backup/manifest.json': `${JSON.stringify({ format: 'wikiflip-content-backup', version: 1 })}\n`,
      'wikiflip-backup/pages/.site': Buffer.alloc(0),
      'wikiflip-backup/pages/imported-guide/content.md':
        '# Imported Guide\n\nFrom a classic WikiFlip backup.\n',
      'wikiflip-backup/pages/.site/settings.json': JSON.stringify({ site_title: 'Classic Restored' }),
    })
  );

  const classicImport = importFromArchive(classicZip, 'merge', 'classic-backup.zip');
  assert.equal(classicImport.ok, true, classicImport.message);
  assert.equal(db.getPage('imported-guide')?.title, 'Imported Guide');
  assert.equal(db.getSetting('site_title', ''), 'Classic Restored');
  assert.equal(db.getPage('backup-alpha')?.title, 'Backup Alpha');

  rmSync(classicZip, { force: true });

  // HTTP: export requires admin + CSRF; download is a zip stream.
  const session = await signIn();
  const noAuth = await fetch(`${base}/admin/backup/export`, { method: 'POST', redirect: 'manual' });
  assert.equal(noAuth.status, 302);

  const exportRes = await fetch(`${base}/admin/backup/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
    },
    body: new URLSearchParams({ csrf_token: session.csrf }),
  });
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get('content-disposition') || '', /\.zip/);
  assert.match(exportRes.headers.get('content-type') || '', /zip/i);
  const bytes = Buffer.from(await exportRes.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  const backupTab = await fetch(`${base}/admin?tab=backup`, { headers: { cookie: session.cookie } });
  assert.equal(backupTab.status, 200);
  const tabHtml = await backupTab.text();
  assert.match(tabHtml, /Download backup/);
  assert.match(tabHtml, /admin\/backup\/import/);
  assert.match(tabHtml, /\.zip/);
  assert.match(tabHtml, /action="\/logout"/, 'admin pages expose log out');

  db.deletePage('backup-alpha');
  db.deletePage('imported-guide');
});

test('media comes back from the database and unknown files 404', async () => {
  const page = db.getPage('public-page');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  db.putMedia(page.id, 'pixel.png', 'image/png', png);

  const res = await fetch(`${base}/media/public-page/pixel.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);

  // Another page cannot reach this page's media, and traversal goes nowhere.
  db.savePage({ slug: 'other-page', title: 'Other' });
  assert.equal((await fetch(`${base}/media/other-page/pixel.png`)).status, 404);
  assert.equal((await fetch(`${base}/media/public-page/..%2F..%2Fserver.js`)).status, 404);
});
