/**
 * The rule families of the static tier, in the order they run. Each family
 * module exports one `run(ctx, r)` that reads the context and reports by rule
 * id (lib/design-lint/rules/ids.ts). Add a family here, nowhere else, and
 * before `component`: it reconciles against what the stylesheet families
 * already reported (a Tailwind tell on a line type or chrome named, an emoji
 * tile assets saw), so it reads their findings and must run after them.
 */
import type { LintContext } from '../context';
import type { Reporter } from '../report';
import { run as runColor } from './color';
import { run as runType } from './type';
import { run as runStructure } from './structure';
import { run as runChrome } from './chrome';
import { run as runMotion } from './motion';
import { run as runAssets } from './assets';
import { run as runFinish } from './finish';
import { run as runComponent } from './component';
import { run as runCopy } from './copy';

export type RuleRunner = (ctx: LintContext, r: Reporter) => void;

export interface RuleFamily { name: string; run: RuleRunner }

export const FAMILIES: RuleFamily[] = [
  { name: 'color', run: runColor },
  { name: 'type', run: runType },
  { name: 'structure', run: runStructure },
  { name: 'chrome', run: runChrome },
  { name: 'motion', run: runMotion },
  { name: 'assets', run: runAssets },
  { name: 'finish', run: runFinish },
  { name: 'component', run: runComponent },
  { name: 'copy', run: runCopy },
];

