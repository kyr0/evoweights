/**
 * Builds the deployable site into docs/ (GitHub Pages serves that folder of the default branch): the static files of public/, the non-TypeScript sources of src/ (page, styles,
 * shader) and the TypeScript of src/ compiled 1:1 by tsc. docs/ holds build output only and is recreated on every build. Modules stay unbundled, so every module keeps its own URL and
 * workers resolve site files through `src/shared/site.ts` exactly as in development.
 *
 * Why not a bundler: VERIFIED: the page starts three dedicated workers (play, bench, training) and two of those start nested
 * workers (training lanes, inference lanes), each by URL through `moduleUrl` in `src/shared/site.ts`. A 1:1 emit keeps those
 * URLs the same under `bun test`, `make start` and GitHub Pages without bundler-specific worker syntax, and the shipped JS
 * stays readable next to its source.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const docs = join(root, 'docs');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function log(level: string, message: string): void {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

rmSync(docs, { recursive: true, force: true });
cpSync(join(root, 'public'), docs, { recursive: true });

const sources = files(join(root, 'src'));
const collisions: string[] = [];
for (const source of sources) {
  if (source.endsWith('.ts')) continue;
  const target = join(docs, relative(join(root, 'src'), source));
  if (existsSync(target)) collisions.push(relative(root, source));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}
for (const source of sources.filter((s) => s.endsWith('.ts'))) {
  const target = join(docs, relative(join(root, 'src'), source)).replace(/\.ts$/, '.js');
  if (existsSync(target)) collisions.push(relative(root, source));
}
if (collisions.length) {
  log('ERROR', `src/ and public/ both provide: ${collisions.join(', ')}`);
  process.exit(1);
}

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (tsc.exitCode !== 0) {
  log('ERROR', `tsc exited with ${tsc.exitCode}`);
  process.exit(tsc.exitCode ?? 1);
}
const emitted = sources.filter((s) => s.endsWith('.ts')).length;
log('INFO', `built docs/ files=${files(docs).length} modules=${emitted}`);
