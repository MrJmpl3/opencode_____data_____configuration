import type { TuiPluginModule } from '@opencode-ai/plugin/tui';

import { registerGentleLogoTui } from './src/runtime/register.tsx';

export {
  COMPACT_LOGO_LINES,
  FULL_LOGO_MIN_WIDTH,
  FULL_LOGO_VERTICAL_PADDING,
  ROSE_LOGO_LINES,
  hasRoomForFullLogo,
  selectLogoLines,
} from './src/domain/logo-layout.ts';
export type { TerminalDimensions } from './src/domain/logo-layout.ts';
export { GENTLE_LOGO_SLOT_ORDER, registerGentleLogoTui } from './src/runtime/register.tsx';
export { Logo } from './src/ui/Logo.tsx';
export type { LogoProps } from './src/ui/Logo.tsx';

const plugin: TuiPluginModule & { id: string } = {
  id: 'mrjmpl3-gentle-logo',
  tui: registerGentleLogoTui,
};

export default plugin;
