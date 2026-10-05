import { RESOLVERS } from '../../scripts/resolvers';
import { HOST_PATHS } from '../../scripts/resolvers/types';

/** Resolve only the host-choice seams; preserve structural SECTION tokens. */
export function expandHostSetup(source: string, host: 'claude' | 'codex' = 'claude'): string {
  return source.replace(/\{\{(GBRAIN_(?:HOST_\w+|TOKEN_\w+|CONFIG_LOCATION|SYNC_GUIDANCE))\}\}/g, (_, name) =>
    RESOLVERS[name]({ skillName: 'setup-gbrain', tmplPath: 'setup-gbrain/SKILL.md.tmpl', host, paths: HOST_PATHS[host] }));
}
