/**
 * Every file the page and its stylesheets reference exists in the built site. The site is assembled from public/ and
 * src/ (where `x.ts` becomes `x.js`), so each relative reference is resolved against its location in docs/ and looked up
 * in both trees. Regression: moving the stylesheets into styles/ broke their relative url() references.
 */
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const inSite = (path: string) =>
  existsSync(join(root, 'public', path)) ||
  existsSync(join(root, 'src', path)) ||
  existsSync(join(root, 'src', path.replace(/\.js$/, '.ts')));
const relative = (ref: string) => !/^(?:[a-z]+:|\/\/|#|data:)/i.test(ref);

test('stylesheet url() references resolve', () => {
  const missing: string[] = [];
  for (const name of readdirSync(join(root, 'src/styles'))) {
    const css = readFileSync(join(root, 'src/styles', name), 'utf8');
    for (const [, ref] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g))
      if (relative(ref) && !inSite(posix.normalize(posix.join('styles', ref)))) missing.push(`${name}: ${ref}`);
  }
  expect(missing).toEqual([]);
});

test('page src and href references resolve', () => {
  const html = readFileSync(join(root, 'src/index.html'), 'utf8');
  const missing = [...html.matchAll(/\s(?:src|href|data-src)="([^"]+)"/g)]
    .map(([, ref]) => ref.split(/[?#]/)[0])
    .filter((ref) => ref && relative(ref) && !inSite(posix.normalize(ref)));
  expect(missing).toEqual([]);
});

// Regression: an edited bio ended with a stray `</p>`, which browsers turn into an extra empty paragraph.
test('page paragraphs open and close in pairs, never nested or stray', () => {
  const html = readFileSync(join(root, 'src/index.html'), 'utf8');
  const problems: string[] = [];
  let open = false;
  for (const tag of html.matchAll(/<p[\s>]|<\/p>/g)) {
    const line = html.slice(0, tag.index).split('\n').length;
    if (tag[0] === '</p>') {
      if (!open) problems.push(`stray </p> at line ${line}`);
      open = false;
    } else {
      if (open) problems.push(`<p> inside an open <p> at line ${line}`);
      open = true;
    }
  }
  expect(problems).toEqual([]);
});
