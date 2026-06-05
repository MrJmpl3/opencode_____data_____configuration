import { t } from './i18n.ts';

export type TuiCommandDispose = () => void;

type LegacyCommand = {
  title: string;
  value: string;
  description?: string;
  category?: string;
  onSelect?: () => void;
};

type LegacyCommandApi = {
  register?: (commands: () => LegacyCommand[]) => TuiCommandDispose;
};

type KeymapCommand = {
  name: string;
  title: string;
  description?: string;
  category?: string;
  run: () => void;
};

type KeymapBinding = {
  key: string;
  cmd: string;
};

type KeymapLayer = {
  commands: KeymapCommand[];
  bindings?: KeymapBinding[];
};

type KeymapApi = {
  registerLayer?: (layer: KeymapLayer) => TuiCommandDispose;
};

export type CommandApiShape = {
  keymap?: KeymapApi;
  command?: LegacyCommandApi;
};

type RegisterSubagentCommandsInput = {
  api: CommandApiShape;
  sectionEnabled: () => boolean;
  setSectionEnabled: (enabled: boolean) => void;
};

const TOGGLE_SECTION_COMMAND = 'subagent-statusline.toggle-sidebar-section';
const SHOW_SECTION_COMMAND = 'subagent-statusline.show-sidebar-section';

function createCompositeDispose(disposers: TuiCommandDispose[]): TuiCommandDispose {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;

    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Best-effort cleanup across runtime variants.
      }
    }
  };
}

export function registerSubagentCommands({
  api,
  sectionEnabled,
  setSectionEnabled,
}: RegisterSubagentCommandsInput): TuiCommandDispose {
  const disposers: TuiCommandDispose[] = [];
  const commands: KeymapCommand[] = [
    {
      name: TOGGLE_SECTION_COMMAND,
      title: t('toggleSidebarSection'),
      description: t('toggleSidebarSectionDescription'),
      category: t('commandCategory'),
      run: () => setSectionEnabled(!sectionEnabled()),
    },
    {
      name: SHOW_SECTION_COMMAND,
      title: t('showSidebarSection'),
      description: t('showSidebarSectionDescription'),
      category: t('commandCategory'),
      run: () => setSectionEnabled(true),
    },
  ];

  if (api.keymap?.registerLayer) {
    disposers.push(
      api.keymap.registerLayer({
        commands,
        bindings: [
          {
            key: 'alt+b',
            cmd: SHOW_SECTION_COMMAND,
          },
        ],
      }),
    );
  }

  if (api.command?.register) {
    disposers.push(
      api.command.register(() => [
        {
          title: t('toggleSidebarSection'),
          value: TOGGLE_SECTION_COMMAND,
          description: t('toggleSidebarSectionDescription'),
          category: t('commandCategory'),
          onSelect: () => setSectionEnabled(!sectionEnabled()),
        },
        {
          title: t('showSidebarSection'),
          value: SHOW_SECTION_COMMAND,
          description: t('showSidebarSectionDescription'),
          category: t('commandCategory'),
          onSelect: () => setSectionEnabled(true),
        },
      ]),
    );
  }

  return createCompositeDispose(disposers);
}
