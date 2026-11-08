/**
 * Verdict for the context-restore-fragment-match E2E: which checkpoint did the
 * agent restore? The evidence is the agent's own report (top-level assistant
 * text plus the final result), never tool output. Restore has to inspect the
 * candidates to find the one whose title matches, so every checkpoint body can
 * appear in Bash or Read output without being the restored context.
 */
export interface FragmentRestoreRun {
  output?: string;
  transcript?: any[];
}

export function agentReport(result: FragmentRestoreRun): string {
  const parts: string[] = [];
  for (const event of result.transcript || []) {
    if (event?.type !== 'assistant' || event.parent_tool_use_id) continue;
    for (const block of event.message?.content || []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (result.output) parts.push(result.output);
  return parts.join('\n');
}

export function fragmentRestoreVerdict(
  result: FragmentRestoreRun,
  markers: { restored: string; others: string[] },
): { loadedTarget: boolean; didNotLoadOthers: boolean } {
  const report = agentReport(result);
  return {
    loadedTarget: report.includes(markers.restored),
    didNotLoadOthers: markers.others.every((marker) => !report.includes(marker)),
  };
}
