/**
 * The lint context: one page with the stylesheets it links (and anything
 * they @import), or one directory of component files. Rules read it, the
 * caches on it memoise the shared indexes.
 */
import { buildStyleIndex, declValue, fontPxOf, mergeBySelector, stylesFor, trackingEmOf, type CssDecl, type CssRule, type MergedRule, type StyleIndex, type Tokens } from './css';
import type { Doc } from './html';

export interface CssFile {
  file: string;
  raw: string;
}

/** Project-wide facts shared across a directory of components, so a focus ring in globals.css counts for Hero.tsx. */
export interface SharedStyles {
  focus: boolean;
  active: boolean;
  disabled: boolean;
  reducedMotion: boolean;
}

export interface LintContext {
  /** The page file, or the directory for a group of components. */
  key: string;
  rules: CssRule[];
  tokens: Tokens;
  docs: Doc[];
  cssFiles: CssFile[];
  /** Every stylesheet's text joined, for regex questions. */
  allCss: string;
  scope: 'page' | 'component';
  /** The visitor's job (book, buy, subscribe, …) when the caller named one. */
  job: string | null;
  /** A stylesheet-only context whose rules are all tokens: nothing to lint but the tokens. */
  tokensOnly: boolean;
  shared: SharedStyles | null;
  /** Tokens visible to Tailwind utilities in components: the project's merged tokens. */
  twTokens: Tokens | null;
  cache: Record<string, unknown>;
}

export function memo<T>(ctx: LintContext, key: string, make: () => T): T {
  if (!(key in ctx.cache)) ctx.cache[key] = make();
  return ctx.cache[key] as T;
}

export const mergedRules = (ctx: LintContext): MergedRule[] => memo(ctx, 'merged', () => mergeBySelector(ctx.rules));

export const styleIndex = (ctx: LintContext): StyleIndex => memo(ctx, 'styleIndex', () => buildStyleIndex(ctx.rules));

/** Declarations applying to an element by its class attribute and tag; restingOnly drops state and pseudo-element rules. */
export const styleFor = (ctx: LintContext, classAttr: string | null | undefined, tag: string, restingOnly = false): CssDecl[] =>
  stylesFor(styleIndex(ctx), classAttr, tag, restingOnly);

export const valueOf = (ctx: LintContext, decls: CssDecl[], prop: string): string | null => declValue(decls, prop, ctx.tokens);

export const fontPx = (ctx: LintContext, decls: CssDecl[]): number | null => fontPxOf(decls, ctx.tokens);

export const trackingEm = (ctx: LintContext, decls: CssDecl[], px: number | null): number | null => trackingEmOf(decls, ctx.tokens, px);

