/**
 * HTML templates. Plain template literals — every interpolation goes through
 * esc() unless it is already-rendered page HTML.
 *
 * No inline <script> or <style> anywhere: the CSP forbids them, so behaviour
 * lives in /js/*.js and per-page values arrive via data-* attributes.
 */

import { MIN_PASSWORD_LENGTH } from './auth.js';
import { escapeHtml as esc, pageUrl } from './markdown.js';

const attr = (name, value) => (value === '' || value === null || value === undefined ? '' : ` ${name}="${esc(value)}"`);
const stamp = (value) => (value ? String(value).slice(0, 16) : '—');

/** CSRF-backed log out control for admin / account page headers. */
function logoutButton(csrf) {
  return `<form method="post" action="/logout" class="inline-form panel-logout-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <button type="submit" class="btn btn-ghost">Log out</button>
  </form>`;
}

const ICON_GEAR =
  '<svg class="sidenav-icon-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="3"/>' +
  '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 ' +
  '1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 ' +
  '1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 ' +
  '4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 ' +
  '0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 ' +
  '2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';

const ICON_LOGOUT =
  '<svg class="sidenav-icon-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M10 3a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3v-3a1 1 0 1 1 2 ' +
  '0v4a1 1 0 0 1-1 1H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h4zm5.3 5.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 1 ' +
  '1-1.4-1.4L17.58 14H10a1 1 0 1 1 0-2h7.58l-2.28-2.3a1 1 0 0 1 0-1.4z"/></svg>';

function navTree(nodes, currentSlug, isAdmin, depth = 0, rendered = new Set()) {
  let html = '';
  for (const node of nodes) {
    if (rendered.has(node.slug)) continue;
    rendered.add(node.slug);

    const children = node.children.filter((child) => !rendered.has(child.slug));
    const isActive = !isAdmin && node.slug === currentSlug;
    const branchActive = !isAdmin && !isActive && branchContains(node, currentSlug);
    const classes = [depth === 0 ? 'nav-category' : 'nav-subpage'];
    if (isActive) classes.push('is-current');
    if (branchActive) classes.push('has-active-child');
    if (children.length) {
      classes.push('has-children', isActive || branchActive ? 'is-expanded' : 'is-collapsed');
    }

    html += `<li class="${esc(classes.join(' '))}"${children.length ? attr('data-nav-branch', node.slug) : ''}>
      <a${isActive ? ' class="is-active"' : ''}${children.length ? ` aria-expanded="${isActive || branchActive ? 'true' : 'false'}"` : ''} href="${esc(pageUrl(node.slug))}">${esc(node.title)}</a>
      ${children.length ? `<ul class="sidenav-subnav">${navTree(children, currentSlug, isAdmin, depth + 1, rendered)}</ul>` : ''}
    </li>`;
  }
  return html;
}

function branchContains(node, currentSlug) {
  if (node.slug === currentSlug) return true;
  return (node.children ?? []).some((child) => branchContains(child, currentSlug));
}

/**
 * @param {object} ctx  { pageTitle, siteTitle, logoUrl, customCssVersion, tree,
 *                        currentSlug, isAdmin, user, csrf, loadEditor, body, searchTerm }
 */
export function layout(ctx) {
  const title = ctx.pageTitle && ctx.pageTitle !== ctx.siteTitle
    ? `${ctx.pageTitle} · ${ctx.siteTitle}`
    : ctx.siteTitle;
  const user = ctx.user ?? null;
  const gearHref = user ? (user.isAdmin ? '/admin' : '/account') : '/login';
  const gearLabel = user ? (user.isAdmin ? 'Admin' : `My account (${user.displayName})`) : 'Sign in';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="icon" href="${esc(ctx.logoUrl)}"${ctx.logoMime ? ` type="${esc(ctx.logoMime)}"` : ''} sizes="any">
<link rel="apple-touch-icon" href="${esc(ctx.logoUrl)}">
<link rel="stylesheet" href="${esc(ctx.asset('/css/style.css'))}">
${ctx.customCssVersion ? `<link rel="stylesheet" href="/site.css?v=${esc(ctx.customCssVersion)}">` : ''}
${ctx.loadEditor ? `<link rel="stylesheet" href="/vendor/toastui/toastui-editor.min.css">
<link rel="stylesheet" href="/vendor/toastui/toastui-editor-dark.min.css">` : ''}
</head>
<body class="${ctx.isAdmin ? 'is-admin' : 'is-public'}"${attr('data-csrf', ctx.csrf)}>
<div class="app-shell">
  <button type="button" class="menu-toggle" id="menuToggle" aria-label="Open navigation" aria-controls="siteSidenav" aria-expanded="false">☰</button>
  <div class="sidenav-backdrop" id="sidenavBackdrop" hidden></div>

  <aside class="sidenav" id="siteSidenav" aria-label="Site">
    <a class="brand" href="/">
      <img class="brand-logo" src="${esc(ctx.logoUrl)}" alt="" width="120" height="120">
      <h1>${esc(ctx.siteTitle)}</h1>
    </a>

    <ul class="sidenav-nav">
      ${ctx.tree.length
        ? navTree(ctx.tree, ctx.currentSlug, ctx.isAdmin)
        : `<li><a href="${user ? '/edit' : '/login'}">Create a page…</a></li>`}
    </ul>

    <form class="sidenav-search" method="get" action="/search" role="search">
      <label class="sr-only" for="siteSearch">Search pages</label>
      <input type="search" id="siteSearch" name="q" placeholder="Search pages…" maxlength="100"
             autocomplete="off"${attr('value', ctx.searchTerm ?? '')}>
      <button type="submit" class="sidenav-search-btn" aria-label="Search">${ICON_SEARCH}</button>
    </form>

    <div class="sidenav-actions" role="toolbar" aria-label="Account actions">
      <a class="sidenav-icon-btn${ctx.isAdmin ? ' is-active' : ''}" href="${gearHref}" title="${esc(gearLabel)}" aria-label="${esc(gearLabel)}">
        ${ICON_GEAR}
      </a>
      ${user ? `<a class="sidenav-icon-btn" href="/edit" title="New page" aria-label="New page">
        <span class="sidenav-icon-plus" aria-hidden="true">+</span>
      </a>
      <form method="post" action="/logout" class="sidenav-logout-form">
        <input type="hidden" name="csrf_token" value="${esc(ctx.csrf)}">
        <button type="submit" class="sidenav-icon-btn" title="Log out (${esc(user.username)})" aria-label="Log out">
          ${ICON_LOGOUT}
        </button>
      </form>` : ''}
    </div>

    <footer class="site-footer sidenav-footer">
      <p>wikiFlipNG &copy; 2026 Laughing In Purgatory</p>
    </footer>
  </aside>

  <main class="wiki-container" id="main">
${ctx.body}
  </main>
</div>
<script src="${esc(ctx.asset('/js/site.js'))}" defer></script>
${ctx.loadAvatarScript ? `<script src="${esc(ctx.asset('/js/avatar.js'))}" defer></script>` : ''}
${ctx.adminScript ? `<script src="${esc(ctx.asset(ctx.adminScript))}" defer></script>` : ''}
${ctx.loadEditor ? `<script src="/vendor/toastui/toastui-editor-all.min.js" defer></script>
<script src="${esc(ctx.asset('/js/editor.js'))}" defer></script>` : ''}
</body>
</html>`;
}

/* ------------------------------------------------------------------ public */

/** Round profile picture, or the user's initial when they have not set one. */
export function avatar(user, { size = 100, className = '' } = {}) {
  if (!user) return '';
  const classes = `avatar${className ? ` ${className}` : ''}`;
  const style = size === 100 ? '' : ` style="width:${size}px;height:${size}px"`;
  if (user.avatarUrl) {
    return `<img class="${classes}" src="${esc(user.avatarUrl)}" alt="${esc(user.displayName)}" width="${size}" height="${size}" loading="lazy"${style}>`;
  }
  const initial = (user.displayName || user.username || '?').trim().charAt(0).toUpperCase();
  return `<span class="${classes} avatar-initial" aria-hidden="true"${style}>${esc(initial)}</span>`;
}

export function pageView({ page, contentHtml, ancestors, children, siteTitle, canEdit, canCreate, author, collaborators = [] }) {
  const fmt = (value) => {
    if (!value) return '';
    const date = new Date(`${String(value).replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  const createdLabel = fmt(page.createdAt);
  const updatedLabel = fmt(page.updatedAt);
  const metaBits = [];
  if (children.length) {
    metaBits.push(`${children.length} sub-page${children.length === 1 ? '' : 's'}`);
  }
  if (createdLabel) metaBits.push(`Created ${createdLabel}`);
  if (updatedLabel && updatedLabel !== createdLabel) metaBits.push(`Updated ${updatedLabel}`);
  else if (updatedLabel && !createdLabel) metaBits.push(`Updated ${updatedLabel}`);
  const meta = metaBits.join(' · ');

  const byline = author
    ? `<footer class="article-byline">
        ${avatar(author)}
        <div class="article-byline-text">
          <span class="article-byline-name">${esc(author.displayName)}</span>
          ${collaborators.length ? `<span class="article-byline-with">with ${collaborators.map((c) => esc(c.displayName)).join(', ')}</span>` : ''}
          ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
        </div>
      </footer>`
    : meta
      ? `<p class="article-meta meta">${esc(meta)}</p>`
      : '';

  return `<div class="wiki-reading-layout">
  <article class="content-body wiki-article card">
    ${ancestors.length ? `<nav class="breadcrumb" aria-label="Breadcrumb">
      ${ancestors.map((crumb) => `<a href="${esc(pageUrl(crumb.slug))}">${esc(crumb.title)}</a><span class="breadcrumb-sep" aria-hidden="true">/</span>`).join('\n      ')}
      <span class="breadcrumb-current">${esc(page.title)}</span>
    </nav>` : ''}

    <header class="article-header">
      <div class="article-kicker"><span aria-hidden="true"></span>${esc(siteTitle)} guide</div>
      <h1>${esc(page.title)}</h1>
    </header>

    <div class="wiki-article-content">
${contentHtml}
    </div>

    ${byline}

    ${children.length ? `<section class="subpage-list" aria-label="Sub-pages">
      <h2>In this section</h2>
      <ul>
        ${children.map((child) => `<li><a href="${esc(pageUrl(child.slug))}"><span>${esc(child.title)}</span></a></li>`).join('\n        ')}
      </ul>
    </section>` : ''}

    ${canEdit || canCreate ? `<p class="article-actions">
      ${canEdit ? `<a class="btn btn-primary" href="/edit/${esc(page.slug)}">Edit page</a>` : ''}
      ${canCreate ? `<a class="btn btn-ghost" href="/edit?parent=${encodeURIComponent(page.slug)}">+ Sub-page</a>` : ''}
    </p>` : ''}
  </article>
</div>`;
}

export function notFoundView(slug, loggedIn) {
  return `<article class="content-body wiki-article card">
  <h1>404 — Page not found</h1>
  <p>No page exists at <code>${esc(slug)}</code>.</p>
  <p><a href="/">Go home</a>${loggedIn ? ` · <a href="/edit?slug=${encodeURIComponent(slug)}">Create this page</a>` : ''}</p>
</article>`;
}

/** Plain-text preview around the first match. */
function snippet(body, term) {
  const text = String(body ?? '').replace(/[#*`>_[\]()!]/g, ' ').replace(/\s+/g, ' ').trim();
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return text.slice(0, 160);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 180)}${text.slice(start + 180) ? '…' : ''}`;
}

export function searchView({ term, results }) {
  return `<article class="content-body wiki-article card">
  <header class="article-header">
    <div class="article-kicker"><span aria-hidden="true"></span>Search</div>
    <h1>${term ? `Results for “${esc(term)}”` : 'Search'}</h1>
    <p class="meta">${term.trim().length < 2
      ? 'Type at least two characters in the sidebar search box.'
      : `${results.length} page${results.length === 1 ? '' : 's'} matched`}</p>
  </header>

  ${results.length ? `<ul class="search-results">
    ${results.map((page) => `<li>
      <a class="search-result-title" href="${esc(pageUrl(page.slug))}">${esc(page.title)}</a>
      <p class="search-result-snippet">${esc(snippet(page.body, term))}</p>
    </li>`).join('\n    ')}
  </ul>` : term.trim().length >= 2 ? '<p class="empty-state">Nothing matched. Try a shorter term.</p>' : ''}
</article>`;
}

export function loginView({ error, returnTo, csrf }) {
  return `<section class="admin-panel card login-panel">
  <div class="panel-header"><h2>Sign in</h2></div>
  ${error ? `<div class="save-status is-error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/login" class="login-form" autocomplete="on">
    <input type="hidden" name="return" value="${esc(returnTo)}">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autofocus autocomplete="username" maxlength="32">
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" maxlength="200">
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Sign in</button>
      <a class="btn btn-ghost" href="/">← Back to wiki</a>
    </div>
  </form>
</section>`;
}

/* -------------------------------------------------------------- my account */

function myPagesTable(pages, csrf) {
  if (pages.length === 0) return '<p class="empty-state">You have not created any pages yet.</p>';
  return `<table class="pages-table">
  <thead><tr><th>Title</th><th>Slug</th><th>Updated</th><th>Actions</th></tr></thead>
  <tbody>
    ${pages.map((page) => `<tr>
      <td><strong>${esc(page.title)}</strong></td>
      <td><code>${esc(page.slug)}</code></td>
      <td>${esc(stamp(page.updatedAt))}</td>
      <td class="actions">
        <a href="${esc(pageUrl(page.slug))}">View</a>
        <a href="/edit/${esc(page.slug)}">Edit</a>
        ${page.slug === 'home' ? '' : `<form method="post" action="/pages/delete" class="inline-form" data-confirm="Delete “${esc(page.title)}”? Sub-pages move up one level.">
          <input type="hidden" name="csrf_token" value="${esc(csrf)}">
          <input type="hidden" name="slug" value="${esc(page.slug)}">
          <button type="submit" class="link-danger">Delete</button>
        </form>`}
      </td>
    </tr>`).join('\n    ')}
  </tbody>
</table>`;
}

/**
 * Profile-picture field. The browser rescales the chosen file to 100×100 before
 * upload (see /js/avatar.js); the server keeps whatever bytes arrive, bounded.
 */
function avatarField(user) {
  return `<div class="form-group">
    <label for="avatar">Profile picture</label>
    <div class="logo-preview-row">
      ${avatar(user, { className: 'avatar-preview' })}
      <div>
        <input type="file" id="avatar" name="avatar" accept="image/png,image/jpeg,image/gif,image/webp" data-avatar-input>
        <small class="hint">Any size — it is scaled to 100×100. Shown on the pages you create.</small>
        ${user.hasAvatar ? '<label class="checkbox-inline"><input type="checkbox" name="clear_avatar" value="1"> Remove profile picture</label>' : ''}
      </div>
    </div>
  </div>`;
}

function passwordFields({ requireCurrent }) {
  return `${requireCurrent ? `<div class="form-group">
    <label for="current_password">Current password</label>
    <input type="password" id="current_password" name="current_password" autocomplete="current-password" maxlength="200">
    <small class="hint">Only needed when setting a new password.</small>
  </div>` : ''}
  <div class="form-group">
    <label for="new_password">New password</label>
    <input type="password" id="new_password" name="new_password" autocomplete="new-password" maxlength="200" minlength="${MIN_PASSWORD_LENGTH}">
    <small class="hint">Leave empty to keep the current password. Minimum ${MIN_PASSWORD_LENGTH} characters.</small>
  </div>
  ${requireCurrent ? `<div class="form-group">
    <label for="confirm_password">Confirm new password</label>
    <input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" maxlength="200">
  </div>` : ''}`;
}

/** Pages owned by someone else that this user was invited to edit. */
function sharedPagesTable(pages) {
  if (pages.length === 0) {
    return '<p class="empty-state">Nobody has added you as a collaborator yet.</p>';
  }
  return `<table class="pages-table">
  <thead><tr><th>Title</th><th>Owner</th><th>Updated</th><th>Actions</th></tr></thead>
  <tbody>
    ${pages.map((page) => `<tr>
      <td><strong>${esc(page.title)}</strong></td>
      <td class="user-cell">${page.author ? `${avatar(page.author, { size: 28 })}${esc(page.author.displayName)}` : '<span class="muted">admin</span>'}</td>
      <td>${esc(stamp(page.updatedAt))}</td>
      <td class="actions">
        <a href="${esc(pageUrl(page.slug))}">View</a>
        <a href="/edit/${esc(page.slug)}">Edit</a>
      </td>
    </tr>`).join('\n    ')}
  </tbody>
</table>`;
}

export function accountView({ user, pages, sharedPages = [], flash, flashOk, csrf }) {
  return `<section class="admin-panel card">
  <div class="panel-header">
    <h2>My account</h2>
    <div class="panel-header-actions">
      <a class="btn btn-primary" href="/edit">+ New page</a>
      ${logoutButton(csrf)}
    </div>
  </div>

  ${flash ? `<div class="save-status ${flashOk ? 'is-success' : 'is-error'}" role="status">${esc(flash)}</div>` : ''}

  <h3 class="admin-section-title">Profile</h3>
  <form method="post" action="/account" enctype="multipart/form-data" class="branding-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <div class="branding-grid">
      <div>
        <div class="form-group">
          <label for="display_name">Display name</label>
          <input type="text" id="display_name" name="display_name" required value="${esc(user.displayName)}" maxlength="80">
          <small class="hint">Signed in as <code>${esc(user.username)}</code> — only an admin can change your username.</small>
        </div>
        ${avatarField(user)}
      </div>
      <div>${passwordFields({ requireCurrent: true })}</div>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Save profile</button>
    </div>
  </form>

  <h3 class="admin-section-title">My pages</h3>
  <p class="hint admin-hint">
    You can edit and delete the pages you created, and invite collaborators to them from the editor.
  </p>
  ${myPagesTable(pages, csrf)}

  <h3 class="admin-section-title">Shared with me</h3>
  <p class="hint admin-hint">
    Pages someone else owns and added you to. You can edit them; only the owner can delete them
    or change who else has access.
  </p>
  ${sharedPagesTable(sharedPages)}
</section>`;
}

/* ------------------------------------------------------------------- admin */

function adminTreeRows(nodes, depth, parentSlug, collapsed, csrf, authors, shared) {
  return nodes
    .map((node, index) => {
      const hasChildren = node.children.length > 0;
      const author = node.authorId ? authors.get(node.authorId) : null;
      const sharedWith = shared.get(node.slug) ?? 0;
      const row = `<tr class="admin-tree-row ${depth === 0 ? 'is-top' : 'is-nested'}${hasChildren ? ' has-children' : ''}${collapsed ? ' is-collapsed-row' : ''}"
    data-depth="${depth}" data-slug="${esc(node.slug)}" data-parent="${esc(parentSlug)}"${collapsed ? ' hidden' : ''}>
  <td class="admin-tree-title"${depth ? ` style="padding-left: ${(0.65 + depth * 1.1).toFixed(2)}rem"` : ''}>
    ${hasChildren
      ? `<button type="button" class="tree-toggle" aria-expanded="false" data-toggle-children="${esc(node.slug)}" title="Expand / collapse">▸</button>`
      : '<span class="tree-toggle-spacer" aria-hidden="true"></span>'}
    <strong>${esc(node.title)}</strong>
    ${hasChildren
      ? `<span class="badge-category">${node.children.length} sub</span>`
      : depth === 0 ? '<span class="badge-category muted">top-level</span>' : ''}
  </td>
  <td><code>${esc(node.slug)}</code></td>
  <td>${author ? esc(author) : '<span class="muted">admin</span>'}${sharedWith ? ` <span class="badge-category" title="Shared with ${sharedWith} collaborator(s)">+${sharedWith}</span>` : ''}</td>
  <td>${esc(stamp(node.updatedAt))}</td>
  <td class="actions admin-tree-actions">
    <button type="button" class="btn-icon reorder-btn" data-direction="up" title="Move up" aria-label="Move up"${index === 0 ? ' disabled' : ''}>↑</button>
    <button type="button" class="btn-icon reorder-btn" data-direction="down" title="Move down" aria-label="Move down"${index === nodes.length - 1 ? ' disabled' : ''}>↓</button>
    <a href="${esc(pageUrl(node.slug))}">View</a>
    <a href="/edit/${esc(node.slug)}">Edit</a>
    <a href="/edit?parent=${encodeURIComponent(node.slug)}">+ Sub</a>
    ${node.slug === 'home' ? '' : `<form method="post" action="/pages/delete" class="inline-form" data-confirm="Delete this page?${hasChildren ? ' Sub-pages move up one level.' : ''}">
      <input type="hidden" name="csrf_token" value="${esc(csrf)}">
      <input type="hidden" name="slug" value="${esc(node.slug)}">
      <button type="submit" class="link-danger">Delete</button>
    </form>`}
  </td>
</tr>`;
      return row + (hasChildren ? adminTreeRows(node.children, depth + 1, node.slug, true, csrf, authors, shared) : '');
    })
    .join('\n');
}

function usersPanel({ users, userSearch, currentUser, csrf }) {
  return `<div class="admin-tab-panel" role="tabpanel" aria-labelledby="tab-users" id="panel-users">
  <p class="hint admin-hint">
    Users can create pages and edit or delete <strong>their own</strong> pages. Admins can edit every
    page and are the only ones who can reorder pages or change branding.
  </p>

  <form method="get" action="/admin" class="user-search-form" role="search">
    <input type="hidden" name="tab" value="users">
    <label class="sr-only" for="userSearch">Search users</label>
    <input type="search" id="userSearch" name="u" value="${esc(userSearch)}" placeholder="Search users…" maxlength="60" autocomplete="off">
    <button type="submit" class="btn btn-ghost">Search</button>
    ${userSearch ? '<a class="btn btn-ghost" href="/admin?tab=users">Clear</a>' : ''}
  </form>

  ${users.length === 0
    ? '<p class="empty-state">No users matched.</p>'
    : `<table class="pages-table">
    <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Pages</th><th>Actions</th></tr></thead>
    <tbody>
      ${users.map((user) => `<tr>
        <td class="user-cell">${avatar(user, { size: 32 })}<strong>${esc(user.displayName)}</strong>${user.id === currentUser.id ? ' <span class="badge-category">you</span>' : ''}</td>
        <td><code>${esc(user.username)}</code></td>
        <td>${user.isAdmin ? '<span class="badge-category">admin</span>' : '<span class="badge-category muted">user</span>'}</td>
        <td>${user.pageCount}</td>
        <td class="actions">
          <a href="/admin/users/${user.id}">Edit</a>
          ${user.id === currentUser.id ? '' : `<form method="post" action="/admin/users/${user.id}/delete" class="inline-form" data-confirm="Delete ${esc(user.username)}? Their ${user.pageCount} page(s) become admin-owned.">
            <input type="hidden" name="csrf_token" value="${esc(csrf)}">
            <button type="submit" class="link-danger">Delete</button>
          </form>`}
        </td>
      </tr>`).join('\n      ')}
    </tbody>
  </table>`}

  <h3 class="admin-section-title">Add a user</h3>
  <form method="post" action="/admin/users" class="branding-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <div class="branding-grid">
      <div class="form-group">
        <label for="new_username">Username</label>
        <input type="text" id="new_username" name="username" required pattern="[a-z0-9._-]{3,32}"
               title="3–32 characters: a-z, 0-9, dot, underscore, hyphen" maxlength="32" autocomplete="off">
        <small class="hint">Lowercase letters, numbers, <code>. _ -</code></small>
      </div>
      <div class="form-group">
        <label for="new_display_name">Display name</label>
        <input type="text" id="new_display_name" name="display_name" maxlength="80" autocomplete="off">
        <small class="hint">Defaults to the username.</small>
      </div>
      <div class="form-group">
        <label for="new_user_password">Password</label>
        <input type="password" id="new_user_password" name="password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="200" autocomplete="new-password">
        <small class="hint">Minimum ${MIN_PASSWORD_LENGTH} characters.</small>
      </div>
      <div class="form-group">
        <label>Permissions</label>
        <label class="checkbox-inline">
          <input type="checkbox" name="is_admin" value="1"> Administrator (full access to all pages, order and branding)
        </label>
      </div>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Create user</button>
    </div>
  </form>
</div>`;
}

export function adminView({ tab, tree, users, userSearch, currentUser, authors, shared = new Map(), flash, flashOk, site, cssValue, hasCustomCss, logoUrl, csrf }) {
  const pagesPanel = `<div class="admin-tab-panel" role="tabpanel" aria-labelledby="tab-pages" id="panel-pages">
  <p class="hint admin-hint">
    Use <strong>↑ / ↓</strong> to reorder pages among siblings (sidebar follows this order).
    Categories with sub-pages start <strong>collapsed</strong> — click ▸ to expand.
  </p>
  ${tree.length === 0
    ? '<p class="empty-state">No pages yet. Create your first page to get started.</p>'
    : `<table class="pages-table admin-tree-table">
    <thead><tr><th>Title</th><th>Slug</th><th>Author</th><th>Updated</th><th>Actions</th></tr></thead>
    <tbody id="adminPageTree" data-reorder-url="/admin/reorder">
${adminTreeRows(tree, 0, '', false, csrf, authors, shared)}
    </tbody>
  </table>`}
</div>`;

  const brandingPanel = `<div class="admin-tab-panel" role="tabpanel" aria-labelledby="tab-branding" id="panel-branding">
  <form method="post" action="/admin/branding" enctype="multipart/form-data" class="branding-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">

    <h3 class="admin-section-title">Site identity</h3>
    <div class="branding-grid">
      <div class="form-group">
        <label for="site_title">Title under logo</label>
        <input type="text" id="site_title" name="site_title" required value="${esc(site.title)}" maxlength="80" placeholder="WikiFlip">
        <small class="hint">Shown in the sidebar under the logo image.</small>
      </div>
      <div class="form-group">
        <label for="logo">Logo image</label>
        <div class="logo-preview-row">
          <img class="logo-preview" src="${esc(logoUrl)}" alt="Current logo">
          <div>
            <input type="file" id="logo" name="logo" accept="image/png,image/jpeg,image/gif,image/webp">
            <small class="hint">PNG, JPEG, GIF, or WebP. Leave empty to keep current.</small>
            ${site.hasLogo ? '<label class="checkbox-inline"><input type="checkbox" name="clear_logo" value="1"> Reset to default logo</label>' : ''}
          </div>
        </div>
      </div>
    </div>

    <h3 class="admin-section-title">Custom CSS</h3>
    <p class="hint admin-hint">
      Paste or edit CSS to override the default theme. The box is prefilled with
      <strong>${hasCustomCss ? 'your saved custom CSS' : 'the current default stylesheet'}</strong>
      as a reference. Saved CSS is loaded <em>after</em> the bundled theme, so later rules win.
      Reset (or save the original default unchanged) to drop the override.
    </p>
    <div class="form-group css-editor-group">
      <div class="css-editor-meta">
        <label for="custom_css">Stylesheet</label>
        <span class="css-status ${hasCustomCss ? 'is-custom' : 'is-default'}">
          ${hasCustomCss ? 'Using custom CSS' : 'Showing default (not yet saved as override)'}
        </span>
      </div>
      <textarea id="custom_css" name="custom_css" class="css-editor" rows="22" spellcheck="false" autocomplete="off">${esc(cssValue)}</textarea>
      <small class="hint">Max ~500 KB. Admin-only — saved CSS is served as-is to visitors.</small>
      ${hasCustomCss ? '<label class="checkbox-inline"><input type="checkbox" name="reset_css" value="1"> Reset CSS to default (discard custom file)</label>' : ''}
    </div>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Save branding</button>
      <a class="btn btn-ghost" href="/admin?tab=branding">Cancel</a>
    </div>
  </form>
</div>`;

  const backupPanel = `<div class="admin-tab-panel" role="tabpanel" aria-labelledby="tab-backup" id="panel-backup">
  <h3 class="admin-section-title">Export</h3>
  <p class="hint admin-hint">
    Download a <strong>.zip</strong> of the whole wiki: pages, media, accounts,
    collaborators, and branding (title, logo, custom CSS). The archive is a consistent SQLite
    snapshot — restore it later from this tab, or keep a copy off-site.
  </p>
  <form method="post" action="/admin/backup/export" class="backup-export-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Download backup .zip</button>
    </div>
  </form>

  <h3 class="admin-section-title">Import</h3>
  <p class="hint admin-hint">
    Restore from a WikiFlip NG <code>.zip</code> backup, or from an original PHP WikiFlip
    content backup (<code>.zip</code> with a <code>pages/</code> tree).
    <strong>Replace</strong> wipes current content first (NG backups also restore accounts);
    <strong>Merge</strong> overlays matching pages and keeps the rest.
    Max size ~100&nbsp;MB.
  </p>
  <form method="post" action="/admin/backup/import" enctype="multipart/form-data" class="backup-import-form"
        data-confirm="Import will change live wiki content. Continue?">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">

    <div class="form-group">
      <label for="backup_file">Backup file (.zip)</label>
      <input type="file" id="backup_file" name="backup_file" required
             accept=".zip,application/zip,application/x-zip-compressed">
    </div>

    <div class="form-group">
      <label>Import mode</label>
      <div class="radio-stack">
        <label class="checkbox-inline">
          <input type="radio" name="import_mode" value="replace" checked>
          Replace all content (recommended for full restore)
        </label>
        <label class="checkbox-inline">
          <input type="radio" name="import_mode" value="merge">
          Merge into existing content
        </label>
      </div>
    </div>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Import backup</button>
    </div>
  </form>
</div>`;

  const panels = {
    pages: pagesPanel,
    users: usersPanel({ users, userSearch, currentUser, csrf }),
    branding: brandingPanel,
    backup: backupPanel,
  };

  return `<section class="admin-panel card">
  <div class="panel-header">
    <h2>Admin</h2>
    <div class="panel-header-actions">
      ${tab === 'pages' ? '<a class="btn btn-primary" href="/edit">+ New page</a>' : ''}
      ${logoutButton(csrf)}
    </div>
  </div>

  <nav class="admin-tabs" role="tablist" aria-label="Admin sections">
    <a role="tab" class="admin-tab${tab === 'pages' ? ' is-active' : ''}" href="/admin?tab=pages" aria-selected="${tab === 'pages'}" id="tab-pages">Pages &amp; categories</a>
    <a role="tab" class="admin-tab${tab === 'users' ? ' is-active' : ''}" href="/admin?tab=users" aria-selected="${tab === 'users'}" id="tab-users">Users</a>
    <a role="tab" class="admin-tab${tab === 'branding' ? ' is-active' : ''}" href="/admin?tab=branding" aria-selected="${tab === 'branding'}" id="tab-branding">Branding</a>
    <a role="tab" class="admin-tab${tab === 'backup' ? ' is-active' : ''}" href="/admin?tab=backup" aria-selected="${tab === 'backup'}" id="tab-backup">Backup/Restore</a>
  </nav>

  ${flash ? `<div class="save-status ${flashOk ? 'is-success' : 'is-error'}" role="status">${esc(flash)}</div>` : ''}

  ${panels[tab] ?? pagesPanel}
</section>`;
}

export function userEditView({ user, pages, isSelf, flash, flashOk, csrf }) {
  return `<section class="admin-panel card">
  <div class="panel-header">
    <h2>${isSelf ? 'My account' : `Edit user: ${esc(user.displayName)}`}</h2>
    <div class="panel-header-actions">
      <a class="btn btn-ghost" href="/admin?tab=users">← All users</a>
      ${logoutButton(csrf)}
    </div>
  </div>

  ${flash ? `<div class="save-status ${flashOk ? 'is-success' : 'is-error'}" role="status">${esc(flash)}</div>` : ''}

  <form method="post" action="/admin/users/${user.id}" enctype="multipart/form-data" class="branding-form">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <div class="branding-grid">
      <div>
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required value="${esc(user.username)}"
                 pattern="[a-z0-9._-]{3,32}" title="3–32 characters: a-z, 0-9, dot, underscore, hyphen" maxlength="32">
        </div>
        <div class="form-group">
          <label for="display_name">Display name</label>
          <input type="text" id="display_name" name="display_name" required value="${esc(user.displayName)}" maxlength="80">
        </div>
      </div>
      <div>
        ${avatarField(user)}
        ${passwordFields({ requireCurrent: false })}
      </div>
      <div class="form-group">
        <label>Permissions</label>
        ${isSelf
          ? '<p class="hint">You are an administrator. Promote another admin first if you want to step down.</p>'
          : `<label class="checkbox-inline">
          <input type="checkbox" name="is_admin" value="1"${user.isAdmin ? ' checked' : ''}> Administrator
        </label>
        <small class="hint">Admins can edit every page, reorder categories and change branding.</small>`}
      </div>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Save user</button>
      ${isSelf ? '' : `<button type="submit" class="btn btn-ghost link-danger" form="deleteUserForm">Delete user</button>`}
    </div>
  </form>

  ${isSelf ? '' : `<form method="post" action="/admin/users/${user.id}/delete" id="deleteUserForm"
        data-confirm="Delete ${esc(user.username)}? Their ${pages.length} page(s) become admin-owned.">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
  </form>`}

  <h3 class="admin-section-title">Pages by ${esc(user.displayName)}</h3>
  ${pages.length === 0
    ? '<p class="empty-state">No pages yet.</p>'
    : `<table class="pages-table">
    <thead><tr><th>Title</th><th>Slug</th><th>Updated</th><th>Actions</th></tr></thead>
    <tbody>
      ${pages.map((page) => `<tr>
        <td><strong>${esc(page.title)}</strong></td>
        <td><code>${esc(page.slug)}</code></td>
        <td>${esc(stamp(page.updatedAt))}</td>
        <td class="actions"><a href="${esc(pageUrl(page.slug))}">View</a> <a href="/edit/${esc(page.slug)}">Edit</a></td>
      </tr>`).join('\n      ')}
    </tbody>
  </table>`}
</section>`;
}

/**
 * Collaborator picker — a separate form from the content editor, so granting
 * access is one plain POST and never rides along with a draft save.
 */
function collaboratorPanel({ page, collaborators, candidates, csrf }) {
  const current = new Set(collaborators.map((user) => user.id));
  return `<section class="admin-editor card collaborator-panel">
  <h3 class="admin-section-title">Collaborators</h3>
  <p class="hint admin-hint">
    Anyone ticked here can edit this page. You stay the owner: only you (and admins) can delete it
    or change this list. Admins can already edit every page.
  </p>

  ${candidates.length === 0
    ? '<p class="empty-state">No other accounts yet — add users in the admin area first.</p>'
    : `<form method="post" action="/pages/collaborators">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <input type="hidden" name="slug" value="${esc(page.slug)}">
    <ul class="collaborator-list">
      ${candidates.map((user) => `<li>
        <label class="checkbox-inline">
          <input type="checkbox" name="collaborator" value="${user.id}"${current.has(user.id) ? ' checked' : ''}>
          ${avatar(user, { size: 28 })}
          <span class="collaborator-name">${esc(user.displayName)}</span>
          <code>${esc(user.username)}</code>
          ${user.isAdmin ? '<span class="badge-category">admin</span>' : ''}
        </label>
      </li>`).join('\n      ')}
    </ul>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary">Save collaborators</button>
      <span class="hint">${collaborators.length
        ? `Currently shared with ${collaborators.map((user) => esc(user.displayName)).join(', ')}.`
        : 'Not shared with anyone yet.'}</span>
    </div>
  </form>`}
</section>`;
}

export function editorView({ isNew, page, parentOptions, canManage = false, collaborators = [], candidates = [], flash = '', flashOk = true, csrf }) {
  return `<section class="admin-editor card">
  <div class="panel-header">
    <h2>${isNew ? 'Create page' : 'Edit page'}</h2>
    <a class="btn btn-ghost" href="/">← Back to wiki</a>
  </div>

  ${flash ? `<div class="save-status ${flashOk ? 'is-success' : 'is-error'}" role="status">${esc(flash)}</div>` : ''}

  <form id="editForm" action="/pages/save" method="POST" data-is-new="${isNew ? '1' : '0'}">
    <input type="hidden" name="csrf_token" value="${esc(csrf)}">
    <input type="hidden" name="is_new" value="${isNew ? '1' : '0'}">
    ${isNew ? '' : `<input type="hidden" name="original_slug" value="${esc(page.slug)}">`}
    <textarea id="contentMarkdown" name="content" hidden>${esc(page.body)}</textarea>

    <div class="form-group">
      <label for="pageTitle">Page title</label>
      <input type="text" id="pageTitle" name="title" required value="${esc(page.title)}" placeholder="Display name" autocomplete="off" maxlength="200">
    </div>

    <div class="form-group">
      <label for="pageSlug">URL slug</label>
      <input type="text" id="pageSlug" name="slug" required value="${esc(page.slug)}" placeholder="url-friendly-name"
             pattern="[a-z0-9]+(?:-[a-z0-9]+)*" title="Lowercase letters, numbers, and hyphens only"${isNew ? '' : ' readonly'}>
      <small class="hint">${isNew
        ? 'Auto-filled from the title; needed before uploading images/PDFs.'
        : 'Slug is fixed after creation.'}</small>
    </div>

    <div class="form-group">
      <label for="pageParent">Parent page</label>
      ${page.slug === 'home'
        ? '<input type="hidden" name="parent" value=""><p class="hint">Home is always a top-level page.</p>'
        : `<select id="pageParent" name="parent">
        <option value=""${page.parent === '' ? ' selected' : ''}>— None (top-level) —</option>
        ${parentOptions.map((opt) => `<option value="${esc(opt.slug)}"${page.parent === opt.slug ? ' selected' : ''}>${esc(opt.label)}</option>`).join('\n        ')}
      </select>
      <small class="hint">Nested pages become sub-pages. Uploaded media belongs to this page.</small>`}
    </div>

    <div class="form-group">
      <label>Content (Markdown)</label>
      <div id="mdEditor" class="md-editor-host"></div>
    </div>

    <div class="form-actions">
      <button type="submit" class="btn btn-primary" id="saveBtn">Save changes</button>
      ${isNew ? '' : `<a class="btn btn-ghost" href="${esc(pageUrl(page.slug))}">View page</a>
      <a class="btn btn-ghost" href="/edit?parent=${encodeURIComponent(page.slug)}">+ Sub-page</a>`}
    </div>
  </form>
</section>
${canManage ? collaboratorPanel({ page, collaborators, candidates, csrf }) : ''}`;
}
