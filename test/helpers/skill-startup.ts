/**
 * What a skill has in context once it starts, in reading order: its SKILL.md
 * with, for a tier 2+ skill, the shared preamble file (`sections/preamble.md`
 * beside it) spliced in after the "Shared preamble (load first)" pointer,
 * which requires that Read before the start command runs
 * (scripts/resolvers/preamble-hoist.ts). Tests that assert preamble rules are
 * in context, or where they sit, read this instead of SKILL.md alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHARED_POINTER_HEADING = '## Shared preamble (load first)';
/** Mirrors SHARED_PREAMBLE_FILE in scripts/resolvers/preamble-hoist.ts without importing the resolvers. */
export const SHARED_PREAMBLE_FILE = 'preamble.md';

export function readSkillStartup(skillMd: string): string {
  const skill = fs.readFileSync(skillMd, 'utf-8');
  const pointer = skill.indexOf(`\n${SHARED_POINTER_HEADING}\n`);
  if (pointer < 0) return skill;
  const next = skill.indexOf('\n## ', pointer + SHARED_POINTER_HEADING.length + 2);
  const at = next < 0 ? skill.length : next + 1;
  const shared = fs.readFileSync(path.join(path.dirname(skillMd), 'sections', SHARED_PREAMBLE_FILE), 'utf-8');
  return `${skill.slice(0, at)}${shared}\n${skill.slice(at)}`;
}

const VARIANT_NOTES = [
  'Only these subsections replace the shared ones; the rest of this section is shared.',
  'Only these subsections replace the shared ones or, under a new heading, add to its end; the rest of this section is shared.',
];

/** Split markdown at one heading level outside code fences; parts are trimmed. */
function splitAt(text: string, marker: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    } else if (!fence && line.startsWith(marker) && current.some(l => l.trim())) {
      parts.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }
  if (current.some(l => l.trim())) parts.push(current.join('\n').trim());
  return parts;
}

const headingOf = (section: string) => section.split('\n', 1)[0]!;

/** The shared file's `## ` sections, without its generated header and id heading. */
export function readSharedSections(skillMd: string): string[] {
  const shared = fs.readFileSync(path.join(path.dirname(skillMd), 'sections', SHARED_PREAMBLE_FILE), 'utf-8');
  const title = /^# gstack shared preamble [0-9a-f]{12}\n/m.exec(shared);
  if (!title) throw new Error(`skill-startup: no shared preamble heading beside ${skillMd}`);
  return splitAt(shared.slice(title.index + title[0].length), '## ');
}

/**
 * The text a tier 2+ skill effectively follows, laid out as one file: the
 * pointer section is replaced by the shared sections, each with this skill's
 * same-heading section (or, for a cut-down variant, its replacement
 * and added subsections) applied, and those overriding sections leave their own place.
 * Every preamble section then appears once with the text the skill used to
 * inline; only the grouping differs. SKILL.md without a pointer is returned as is.
 */
export function readSkillEffective(skillMd: string): string {
  const skill = fs.readFileSync(skillMd, 'utf-8');
  const pointer = skill.indexOf(`\n${SHARED_POINTER_HEADING}\n`);
  if (pointer < 0) return skill;
  const shared = readSharedSections(skillMd);
  const sharedHeadings = new Set(shared.map(headingOf));
  const chunks = rawChunks(skill.slice(pointer + 1));
  const overrides = new Map<string, string>();
  const kept = chunks.slice(1).filter(chunk => {
    const heading = headingOf(chunk);
    if (!sharedHeadings.has(heading)) return true;
    overrides.set(heading, chunk.trim());
    return false;
  });
  const effective = shared.map(section => {
    const override = overrides.get(headingOf(section));
    if (!override) return section;
    if (!VARIANT_NOTES.some(note => override.includes(note))) return override;
    const replacements = new Map(splitAt(override, '### ').slice(1).map(part => [headingOf(part), part]));
    const parts = splitAt(section, '### ');
    const sharedHeads = new Set(parts.map(headingOf));
    const added = [...replacements.values()].filter(part => !sharedHeads.has(headingOf(part)));
    return [...parts.map(part => replacements.get(headingOf(part)) ?? part), ...added].join('\n\n');
  });
  return `${skill.slice(0, pointer + 1)}${effective.join('\n\n')}\n\n${kept.join('')}`;
}

/** Split at `## ` headings outside code fences, keeping every byte: the chunks concatenate to the input. */
function rawChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let fence: string | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    } else if (!fence && line.startsWith('## ') && current) {
      chunks.push(current);
      current = '';
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}
