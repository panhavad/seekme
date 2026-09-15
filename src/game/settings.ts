/**
 * Player display settings that live on the device, not in a round.
 *
 * Brightness is a multiplier on the renderer exposure. The range is deliberately
 * narrow: low enough that the maze still feels like night, high enough to play
 * outdoors on a phone, and never so far either way that the game becomes
 * unreadable.
 *
 * The theme is pure decoration - it changes how the maze looks, never how it
 * plays - so an unknown stored value simply falls back to the original temple.
 */

import { THEME_DEFAULT, isThemeKey, type ThemeKey } from '../render/themes';

const BRIGHTNESS_KEY = 'seekme.brightness';
const THEME_KEY = 'seekme.theme';

export const BRIGHTNESS_MIN = 0.8;
export const BRIGHTNESS_MAX = 1.35;
export const BRIGHTNESS_STEP = 0.05;
export const BRIGHTNESS_DEFAULT = 1;

export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return BRIGHTNESS_DEFAULT;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, value));
}

/** 80% .. 135% shown as a friendly percentage. */
export function formatBrightness(value: number): string {
  return `${Math.round(clampBrightness(value) * 100)}%`;
}

export function loadBrightness(): number {
  try {
    const raw = localStorage.getItem(BRIGHTNESS_KEY);
    if (raw === null) return BRIGHTNESS_DEFAULT;
    return clampBrightness(Number.parseFloat(raw));
  } catch {
    return BRIGHTNESS_DEFAULT;
  }
}

export function saveBrightness(value: number): void {
  try {
    localStorage.setItem(BRIGHTNESS_KEY, clampBrightness(value).toFixed(2));
  } catch {
    /* storage blocked - the setting just will not survive a reload */
  }
}

export function loadTheme(): ThemeKey {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isThemeKey(raw) ? raw : THEME_DEFAULT;
  } catch {
    return THEME_DEFAULT;
  }
}

export function saveTheme(key: ThemeKey): void {
  try {
    localStorage.setItem(THEME_KEY, key);
  } catch {
    /* storage blocked - the setting just will not survive a reload */
  }
}
