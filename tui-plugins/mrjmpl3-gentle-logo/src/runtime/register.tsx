import type { TuiPlugin, TuiSlotContext } from '@opencode-ai/plugin/tui';

import { Logo } from '../ui/Logo.tsx';

export const GENTLE_LOGO_SLOT_ORDER = 100;

export const registerGentleLogoTui: TuiPlugin = async (api) => {
  api.slots.register({
    order: GENTLE_LOGO_SLOT_ORDER,
    slots: {
      home_logo(ctx: TuiSlotContext) {
        return <Logo theme={ctx.theme.current} />;
      },
    },
  });
};
