import type { TemplateContext } from './types';
import { generateCodexNativeReview } from './codex-native-review';
import { replaceBlock } from './native-template-utils';

/** Preserve the current phase gates and criteria; replace only external transport. */
export function adaptAutoplan(text: string, ctx: TemplateContext, source: string): string {
  if (ctx.host !== 'codex') return text;

  if (source.endsWith('SKILL.md.tmpl')) {
    text = replaceBlock(text, '## Filesystem Boundary — {{OUTSIDE_LABEL}} Prompts', '## Phase 0: Intake',
      `## Native reviewer boundary

${generateCodexNativeReview(ctx, 'autoplan phase review')}
Autoplan owns reading the full methodology and every referenced carved section.
Only reviewers receive bounded read-only packets. Context separation does not prove
provider diversity. Record reviewer identity, actual model when available, packet
scope/revision, completed or failed coverage, disposition and owner.

Auto-decisions apply only within the operator's existing delegated scope. New access,
cost, disclosure, installation, irreversible action or native approval remains a real
human gate; do not queue it until after the action. An unavailable required review
stays pending unless explicitly waived. Optional voices may degrade with a visible gap.`);

    const preflight = '{{OUTSIDE_PREFLIGHT:autoplan}}';
    if (!text.includes(preflight) || text.indexOf(preflight) !== text.lastIndexOf(preflight)) {
      throw new Error('Autoplan native preflight anchor drift');
    }
    text = text.replace(preflight, `Inspect the native fresh-context dispatch and waiting tools advertised in this
session. Preserve the selected model and effort; omit reviewer overrides unless
selected by authorised routing. Do not probe or invoke an external CLI on Codex.
Check the existing codex_reviews switch: disabled skips the additional reviewer B
and records that gap; the primary native reviewer remains required. A fresh context
is not cross-model proof. Use each phase's approved snapshot and bounded packet.
Timeout, failed dispatch, or missing final output is review_not_run, never clean.`);
    text = text.replaceAll('{{NATIVE_LABEL}}', 'Primary native reviewer')
      .replaceAll('{{OUTSIDE_LABEL}}', 'Native reviewer B')
      .replaceAll('{{OUTSIDE_PROVIDER}}', 'native-context')
      .replaceAll('Claude Code disagreements', 'Native reviewer B disagreements')
      .replaceAll('the outside reviewer', 'Native reviewer B')
      .replaceAll('outside reviewer', 'Native reviewer B')
      .replace('On Claude Code, enter through a native `Read` of the installed phase driver,\n   then use native `Read` for its methodology ranges.',
        'On Codex, use the advertised native read tool for the installed phase driver,\n   then use that same supported read path for its methodology ranges.')
      .replace('`nativePrompt` is the file\'s review body, not the Agent prompt. Resume at the first incomplete gate.',
        '`nativePrompt` is the reviewer body, not the worker task wrapper. Send it through the advertised native API. Resume at the first incomplete gate.');
    return text;
  }

  const match = source.match(/\/(ceo|design|dx|eng)-phase\.md\.tmpl$/);
  if (!match) return text;
  const phase = match[1];
  const invocation = '{{OUTSIDE_INVOCATION:autoplan}}';
  const provenance = `{{OUTSIDE_PROVENANCE:${phase}}}`;
  if (text.indexOf(invocation) < 0 || text.indexOf(invocation) !== text.lastIndexOf(invocation)) {
    throw new Error(`Autoplan ${phase} native dispatch anchor drift`);
  }
  if (text.indexOf(provenance) < 0 || text.indexOf(provenance) !== text.lastIndexOf(provenance)) {
    throw new Error(`Autoplan ${phase} native provenance anchor drift`);
  }

  const phaseTitle = phase.toUpperCase();
  text = text.replaceAll('{{OUTSIDE_LABEL}}', 'Native reviewer B')
    .replaceAll('{{OUTSIDE_PROVIDER}}', 'native-context')
    .replaceAll(' (via Bash):', ':')
    .replace(/Outside prompt: inline the full contents of <[A-Z_]+_INPUT> and context below \(Write tool\)\./,
      'Prepare a bounded reviewer B packet with the complete approved phase snapshot and the context below. Exclude the conversation and unrelated/private material.');

  text = text.replaceAll('{{NATIVE_LABEL}}', 'Primary native reviewer')
    .replaceAll('Codex (in-host)', 'Primary native reviewer')
    .replaceAll('Claude Code: set Agent `run_in_background: false` if its schema exposes it.',
      "Codex: use the session's advertised native worker API; keep the task handle and await terminal completion before moving on.")
    .replaceAll('Codex: set Agent `run_in_background: false` if its schema exposes it.',
      "Codex: use the session's advertised native worker API; keep the task handle and await terminal completion before moving on.")
    .replace(/\*\*Primary native reviewer ([^\n]+) subagent\*\* \((?:via Agent tool|native tool)\):/g,
      '**Primary native reviewer $1 review** (advertised native fresh-context API):')
    .replaceAll(/Claude Code: set Agent `run_in_background: false` if its schema exposes it\.\n\s*Other hosts: foreground; await completion when supported\./g,
      'Use only the advertised native worker API. Preserve the main model and effort; when the API is `collaboration.spawn_agent`, set `fork_turns: "none"` and omit unselected overrides. Wait for actual terminal completion.')
    .replaceAll('Send its `nativeDispatchPrompt`\n  verbatim as the Agent prompt: ONLY/FINAL tool call this response.',
      'Send the complete `nativeDispatchPrompt` verbatim through the advertised native worker API. Do not treat prompt construction or a launch handle as completion.')
    .replaceAll('Keep native Reads enabled. Child first Reads `nativePromptPath` to EOF:\n  all criteria + plan; no summaries or prior reviews.',
      'Use the advertised native read tool to read `nativePromptPath` completely before review. Preserve all criteria and plan text; do not use summaries or prior reviews.')
    .replaceAll('**Native completion barrier:** Async (`isAsync: true` / `status: "async_launched"): ',
      '**Native completion barrier:** use the advertised native completion/status mechanism: ')
    .replaceAll('**Native completion barrier:** Async (`isAsync: true` / `status: "async_launched"):','**Native completion barrier:** use the advertised native completion/status mechanism:')
    .replaceAll('Claude Code: end response immediately: "Waiting for <agent ID>."',
      'Wait through the advertised native completion/status mechanism; do not continue this phase before terminal completion.')
    .replaceAll('Other hosts await that ID. Then outside → this phase\'s review ONLY.',
      'Await actual terminal completion. Then reviewer B → this phase\'s review ONLY.')
    .replaceAll('Then outside → this phase\'s review ONLY.',
      'Then reviewer B → this phase\'s review ONLY.')
    .replaceAll('the outside reviewer', 'Native reviewer B')
    .replaceAll('outside reviewer', 'Native reviewer B')
    .replaceAll('Claude Code', 'Codex');

  text = text.replace(invocation, `Dispatch a second fresh native Codex reviewer for the ${phase} challenge.
Use the advertised API and native wait mechanism; if collaboration.spawn_agent is
available, set fork_turns: "none". Preserve the main model and effort, and do not
launch a duplicate or switch providers.

${generateCodexNativeReview(ctx, `autoplan ${phase} challenge`)}

Supply the approved snapshot and the complete phase-specific reviewer criteria below.
The primary reviewer stays independent: reviewer B may receive only the explicitly
approved prior-phase findings named in this phase. Wait for actual final output before
consensus. Failure, timeout, refusal or missing completion is review_not_run, not a
zero-finding sample.`);
  text = text.replace(provenance, `Record reviewer B as a native Codex context with its actual model identity
when available, exact packet/snapshot scope, result, disposition and gaps. Context
separation is not cross-model evidence. A failed or unavailable reviewer is
review_not_run, never clean.`);

  text = text.replace(/\*\*Native reviewer B ([^*\n]+)\*\*:/g, '**Native reviewer B — $1:**')
    .replaceAll('models agree', 'native reviewers agree')
    .replaceAll('both models', 'both native reviewers')
    .replaceAll('Both models', 'Both native reviewers')
    .replaceAll('models lack', 'reviewers lack')
    .replaceAll('Consensus = both completed subagent + outside;', 'Consensus = both completed native reviewers;')
    .replaceAll('primary cannot replace outside.', 'primary cannot replace reviewer B.')
    .replaceAll('Outside disabled/unavailable:', 'Reviewer B disabled/unavailable:')
    .replaceAll('outside reviewer', 'reviewer B')
    .replaceAll('outside voice', 'reviewer B');

  if (text.includes('{{OUTSIDE_INVOCATION:') || text.includes('{{OUTSIDE_PROVENANCE:')) {
    throw new Error(`Autoplan ${phase} retained an external provider macro`);
  }
  if (!text.includes(`{{SECTION:phase-close}}`) || !text.includes('Required execution checklist')) {
    throw new Error(`Autoplan ${phase} native adaptation lost phase closure or acceptance checklist`);
  }
  return text;
}
