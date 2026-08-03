/**
 * Markdown → HTML.
 *
 * Raw HTML in page bodies is escaped, not sanitised-and-hoped-for: markdown-it
 * runs with `html: false`, so the only tags in the output are the ones this file
 * produces. That removes the whole XSS surface the PHP version tried to patch
 * with regexes.
 *
 * Two rewrites happen on the way out:
 *   - relative media (`photo.png`) → /media/<slug>/photo.png
 *   - a paragraph holding just a link to a page-local PDF → inline PDF viewer
 * Legacy `?slug=x` links keep working and are rewritten to clean URLs.
 */

import MarkdownIt from 'markdown-it';
import { sanitizeFilename, sanitizeSlug } from './db.js';

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf)$/i;

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

export function pageUrl(slug) {
  const clean = sanitizeSlug(slug);
  return clean === '' || clean === 'home' ? '/' : `/${clean}`;
}

export function mediaUrl(slug, filename) {
  return `/media/${encodeURIComponent(sanitizeSlug(slug))}/${encodeURIComponent(filename)}`;
}

/** Page-local media file name, or null when the target is not page media. */
function localMediaFile(href) {
  const url = String(href ?? '').trim();
  if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return null;
  if (url.startsWith('#') || url.startsWith('?') || url.startsWith('/')) return null;

  const [pathPart] = url.split(/[?#]/, 1);
  if (!MEDIA_EXT.test(pathPart)) return null;
  const name = sanitizeFilename(pathPart);
  return name === '' ? null : name;
}

/** Rewrite an href: legacy slug links → clean URL, page media → /media/... */
function resolveHref(href, slug) {
  const url = String(href ?? '').trim();

  const slugLink = /^(?:\/)?(?:index\.php)?\?slug=([a-z0-9-]+)$/i.exec(url);
  if (slugLink) return { href: pageUrl(slugLink[1]), external: false };

  const file = localMediaFile(url);
  if (file) return { href: mediaUrl(slug, file), external: false };

  return { href: url, external: /^https?:\/\//i.test(url) };
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const file = localMediaFile(token.attrGet('src'));
  if (file) token.attrSet('src', mediaUrl(env.slug, file));
  // The default rule builds alt from the token's children; keep that behaviour.
  token.attrSet('alt', self.renderInlineAsText(token.children ?? [], options, env));
  token.attrSet('loading', 'lazy');
  token.attrSet('decoding', 'async');
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const { href, external } = resolveHref(token.attrGet('href'), env.slug);
  token.attrSet('href', href);
  if (external) {
    token.attrSet('rel', 'noopener noreferrer nofollow');
    token.attrSet('target', '_blank');
  }
  return self.renderToken(tokens, idx, options);
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[ch]};`);

/**
 * PDF thumbnail: page one rendered small, click opens the full viewer in the
 * same lightbox images use. The iframe ignores pointer events so the wrapping
 * button always gets the click.
 */
function pdfEmbedHtml(url, label) {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);
  return (
    '<figure class="pdf-embed">' +
    `<button type="button" class="pdf-thumb" data-pdf-src="${safeUrl}" data-pdf-title="${safeLabel}" aria-label="Open PDF: ${safeLabel}">` +
    `<iframe class="pdf-thumb-frame" src="${safeUrl}#toolbar=0&amp;navpanes=0&amp;scrollbar=0&amp;view=Fit&amp;page=1" title="${safeLabel} preview" tabindex="-1" scrolling="no" loading="lazy"></iframe>` +
    '<span class="pdf-thumb-badge" aria-hidden="true">PDF</span>' +
    '</button>' +
    `<figcaption class="pdf-embed-actions"><span class="pdf-embed-name">${safeLabel}</span>` +
    `<a href="${safeUrl}" target="_blank" rel="noopener">Open PDF</a> · ` +
    `<a href="${safeUrl}" download>Download</a></figcaption></figure>`
  );
}

/**
 * A paragraph whose only content is a link to a page-local PDF becomes an
 * inline viewer — this is what the editor's PDF button inserts.
 */
md.core.ruler.push('wikiflip_pdf_embed', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i].type !== 'paragraph_open' || tokens[i + 1].type !== 'inline') continue;
    if (tokens[i + 2].type !== 'paragraph_close') continue;
    const children = tokens[i + 1].children ?? [];
    if (children.length < 2 || children[0].type !== 'link_open') continue;
    if (children[children.length - 1].type !== 'link_close') continue;
    if (children.some((child, n) => n > 0 && n < children.length - 1 && child.type !== 'text')) continue;

    const file = localMediaFile(children[0].attrGet('href'));
    if (!file || !/\.pdf$/i.test(file)) continue;

    const label = children.slice(1, -1).map((child) => child.content).join('') || file;
    const embed = new state.Token('html_block', '', 0);
    embed.content = `${pdfEmbedHtml(mediaUrl(state.env.slug, file), label)}\n`;
    embed.block = true;
    tokens.splice(i, 3, embed);
  }
});

/** Render a page body. `slug` scopes relative media to that page. */
export function renderMarkdown(body, slug) {
  return md.render(String(body ?? ''), { slug: sanitizeSlug(slug) });
}

export { escapeHtml };
