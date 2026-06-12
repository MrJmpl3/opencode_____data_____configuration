import type { Plugin } from '@opencode-ai/plugin';

import { refreshSkillRegistry } from './skill-registry.ts';

const PLUGIN_ID = 'mrjmpl3-skill-registry';

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const output = `[${PLUGIN_ID}] ${message}`;

  if (level === 'error') {
    console.error(output);

    return;
  }

  if (level === 'warn') {
    console.warn(output);

    return;
  }

  console.info(output);
}

export const SkillRegistryPlugin: Plugin = async ({ directory }) => {
  let refreshStarted = false;

  const refreshSkillRegistryOnce = async () => {
    if (refreshStarted) {
      return;
    }

    refreshStarted = true;
    await refreshSkillRegistry(directory, log);
  };

  return {
    'experimental.chat.system.transform': async () => {
      await refreshSkillRegistryOnce();
    },
  };
};

export default SkillRegistryPlugin;
