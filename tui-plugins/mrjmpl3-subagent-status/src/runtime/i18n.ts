export type Locale = 'en' | 'es';

const translations = {
  en: {
    subagents: 'Subagents',
    active: 'Active',
    recent: 'Recent',
    noSubagentsYet: 'No subagents yet',
    run: 'run',
    done: 'done',
    err: 'err',
    toggleSidebarSection: 'Subagents: Toggle sidebar section',
    toggleSidebarSectionDescription: 'Show or hide the subagent sidebar section',
    showSidebarSection: 'Subagents: Show sidebar section',
    showSidebarSectionDescription: 'Expand the subagent sidebar section',
    commandCategory: 'Subagents',
  },
  es: {
    subagents: 'Subagentes',
    active: 'Activos',
    recent: 'Recientes',
    noSubagentsYet: 'Todavía no hay subagentes',
    run: 'act',
    done: 'listo',
    err: 'err',
    toggleSidebarSection: 'Subagentes: alternar sección lateral',
    toggleSidebarSectionDescription: 'Mostrar u ocultar la sección lateral de subagentes',
    showSidebarSection: 'Subagentes: mostrar sección lateral',
    showSidebarSectionDescription: 'Expandir la sección lateral de subagentes',
    commandCategory: 'Subagentes',
  },
} as const;

export type TranslationKey = keyof (typeof translations)['en'];

let cachedLocale: Locale | undefined;

export function detectSystemLocale(): Locale {
  const envLocale =
    process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const normalized = envLocale.toLowerCase();
  if (normalized.startsWith('es')) return 'es';
  return 'en';
}

export function getLocale(): Locale {
  if (!cachedLocale) cachedLocale = detectSystemLocale();
  return cachedLocale;
}

export function t(key: TranslationKey): string {
  return translations[getLocale()][key] ?? translations.en[key];
}
