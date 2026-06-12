import { describe, expect, it, vi } from 'vitest';

describe('runtime i18n', () => {
  it('detects spanish locale from environment variables', async () => {
    vi.resetModules();
    process.env.LANG = 'es_AR.UTF-8';

    const { detectSystemLocale, t } = await import('../src/runtime/i18n.ts');

    expect(detectSystemLocale()).toBe('es');
    expect(t('subagents')).toBe('Subagentes');
  });

  it('falls back to english for unsupported locales', async () => {
    vi.resetModules();
    process.env.LANG = 'fr_FR.UTF-8';

    const { detectSystemLocale, t } = await import('../src/runtime/i18n.ts');

    expect(detectSystemLocale()).toBe('en');
    expect(t('noSubagentsYet')).toBe('No subagents yet');
    expect(t('err')).toBe('err');
  });
});
