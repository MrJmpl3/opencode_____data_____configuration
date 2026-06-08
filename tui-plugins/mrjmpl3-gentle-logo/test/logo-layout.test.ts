import { describe, expect, it } from 'vitest';

import {
  COMPACT_LOGO_LINES,
  FULL_LOGO_MIN_WIDTH,
  FULL_LOGO_VERTICAL_PADDING,
  ROSE_LOGO_LINES,
  hasRoomForFullLogo,
  selectLogoLines,
} from '../src/domain/logo-layout.ts';

describe('logo layout selection', () => {
  it('selects the full rose logo when the terminal meets the height and width thresholds', () => {
    const dimensions = {
      height: ROSE_LOGO_LINES.length + FULL_LOGO_VERTICAL_PADDING,
      width: FULL_LOGO_MIN_WIDTH,
    };

    expect(hasRoomForFullLogo(dimensions)).toBe(true);
    expect(selectLogoLines(dimensions)).toBe(ROSE_LOGO_LINES);
  });

  it('selects the compact logo when the terminal is too narrow', () => {
    const dimensions = {
      height: ROSE_LOGO_LINES.length + FULL_LOGO_VERTICAL_PADDING,
      width: FULL_LOGO_MIN_WIDTH - 1,
    };

    expect(hasRoomForFullLogo(dimensions)).toBe(false);
    expect(selectLogoLines(dimensions)).toBe(COMPACT_LOGO_LINES);
  });

  it('selects the compact logo when the terminal is too short', () => {
    const dimensions = {
      height: ROSE_LOGO_LINES.length + FULL_LOGO_VERTICAL_PADDING - 1,
      width: FULL_LOGO_MIN_WIDTH,
    };

    expect(hasRoomForFullLogo(dimensions)).toBe(false);
    expect(selectLogoLines(dimensions)).toBe(COMPACT_LOGO_LINES);
  });
});
