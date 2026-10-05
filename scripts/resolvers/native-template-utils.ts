/** One checked replacement: source drift must fail generation, not erase a gate. */
export function replaceBlock(text: string, start: string, end: string, replacement: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || text.indexOf(start, from + start.length) >= 0) {
    throw new Error(`Native template anchor drift: ${start}`);
  }
  return text.slice(0, from) + replacement + '\n\n' + text.slice(to);
}
