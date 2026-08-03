/**
 * CLI: import a classic (PHP, flat-file) WikiFlip `pages/` tree into SQLite.
 *
 *   npm run import -- ../wikiFlip/wikiFlip/pages [--clean]
 */

import { statSync } from 'node:fs';
import path from 'node:path';

import { importPagesTree } from './content-import.js';

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run import -- <path/to/old/pages> [--clean]');
  process.exit(1);
}

const pagesDir = path.resolve(source);
if (!statSync(pagesDir).isDirectory()) {
  console.error(`Not a directory: ${pagesDir}`);
  process.exit(1);
}

const clean = process.argv.includes('--clean');
const stats = importPagesTree(pagesDir, { clean });
if (clean) console.log('Cleared existing pages and media.');

console.log(
  `Imported ${stats.pages} page(s), ${stats.media} media file(s)` +
    (stats.branding.length ? `, branding: ${stats.branding.join(', ')}` : '') +
    '.'
);
if (stats.skipped.length) {
  for (const line of stats.skipped) console.warn(`  ! skipped ${line}`);
}
