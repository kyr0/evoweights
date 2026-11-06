/**
 * The build's page-zoom transform (scripts/page-zoom.ts). Requirement (owner, 2026-11-06): the site renders at 150 %
 * the way Chrome's ctrl+ renders it. VERIFIED in Chromium 156: media queries ignore CSS zoom, and vw/vh lengths are
 * zoomed twice under it, so breakpoints are scaled and viewport lengths divided.
 */
import { expect, test } from 'bun:test';
import { PAGE_ZOOM, ROOT_CSS, ZOOM_MIN_WIDTH, zoomCss } from '../../scripts/page-zoom.ts';

const FROM = `(min-width: ${ZOOM_MIN_WIDTH}px)`;
const BELOW = `(width < ${ZOOM_MIN_WIDTH}px)`;

test('width breakpoints are scaled from the zoom threshold up and keep their value below it', () => {
  expect(zoomCss('@media (max-width: 800px) { a { b: c } }')).toBe(
    `@media (max-width: 1200px) and ${FROM}, (max-width: 800px) and ${BELOW} { a { b: c } }`,
  );
  expect(zoomCss('@media (min-width:48rem){}')).toBe(
    `@media (min-width:72rem) and ${FROM}, (min-width:48rem) and ${BELOW} {}`,
  );
  // Range syntax of the vendored defuss-shadcn sheets.
  expect(zoomCss('@media (width<=47.99rem){}')).toBe(
    `@media (width<=71.985rem) and ${FROM}, (width<=47.99rem) and ${BELOW} {}`,
  );
});

test('each query of a list is rewritten; queries without a size feature stay as written', () => {
  expect(zoomCss('@media print, (max-width: 10px) {}')).toBe(
    `@media print, (max-width: 15px) and ${FROM}, (max-width: 10px) and ${BELOW} {}`,
  );
  for (const css of ['@media (prefers-reduced-motion: reduce) {}', '@media (hover:none) and (pointer:coarse){}']) {
    expect(zoomCss(css)).toBe(css);
  }
});

test('viewport lengths are divided by the page zoom, wherever they stand in a value', () => {
  expect(zoomCss('h1 { font-size: clamp(44px, 6.2vw, 86px); min-height: 100dvh; margin: -.5vh }')).toBe(
    'h1 { font-size: clamp(44px, calc(6.2vw / var(--page-zoom, 1)), 86px); min-height: calc(100dvh / var(--page-zoom, 1)); margin: calc(-.5vh / var(--page-zoom, 1)) }',
  );
});

test('comments, strings, url() and class names that contain a viewport unit stay as written', () => {
  const css =
    '/* 10vw @media (max-width: 1px) { */ .h-100vh::after { content: "5vw"; background: url(data:image/png;base64,ab+10vw=) }';
  expect(zoomCss(css)).toBe(css);
});

test('height breakpoints scale like widths, and aspect ratios, which zoom leaves unchanged, stay as written', () => {
  expect(zoomCss('@media (max-height: 600px) {}')).toBe(
    `@media (max-height: 900px) and ${FROM}, (max-height: 600px) and ${BELOW} {}`,
  );
  expect(zoomCss('@media (min-aspect-ratio: 16/9) {}')).toBe('@media (min-aspect-ratio: 16/9) {}');
});

test('a negated size query is refused, so the build fails instead of shipping an inverted breakpoint', () => {
  expect(() => zoomCss('@media not all and (max-width: 600px) {}')).toThrow('negated');
});

test('the root stylesheet zooms the page by PAGE_ZOOM from the same threshold the breakpoints use', () => {
  expect(ROOT_CSS).toContain(`@media ${FROM} { :root { --page-zoom: ${PAGE_ZOOM}; } }`);
  expect(ROOT_CSS).toContain('html { zoom: var(--page-zoom); }');
});
