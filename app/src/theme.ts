/**
 * Forced dark. The app does not follow the system theme.
 *
 * The reference is a key fob or an e-stop panel, not a consumer smart-home
 * app: this is a control surface for heavy machinery that happens to live on
 * a phone. One appearance, always, so the screen is never a surprise when it
 * is opened in a dark car at night -- which is the real usage context.
 */
/**
 * The brand amber, sampled from logo.png rather than eyeballed.
 *
 * The logo is the fixed point -- it lands on the home screen and the splash,
 * where nothing can adjust it -- so the theme follows it. Two ambers a few
 * percent apart read as a mistake rather than as a palette, which is exactly
 * how the earlier #E8A33D was spotted next to the icon.
 */
const AMBER = '#EA971F';

export const colors = {
  background: '#0B0D0F',
  surface: '#16191D',
  border: '#2A2F36',
  text: '#F4F6F8',
  textDim: '#98A2AE',

  /**
   * The button is amber, not green.
   *
   * Green would imply "open" and red "closed", and this system does not know
   * the position -- a red/green vocabulary would state something untrue about
   * heavy machinery. Amber reads as "armed, act deliberately", which is
   * exactly right for a control that starts a gate moving.
   */
  action: AMBER,
  /** The same step darker the previous pressed state was: roughly 82%. */
  actionPressed: '#C67C16',
  actionDisabled: '#3A3B38',

  ok: '#5FB878',
  // Deliberately the same value, not a near-miss: a warning amber sitting a
  // few percent off the brand amber would look like a rendering fault.
  warn: AMBER,
  danger: '#E5544B',
} as const;

/** Heavy, large, and readable at a glance from a car. */
export const type = {
  hero: { fontSize: 34, fontWeight: '800' },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 16, fontWeight: '500' },
  small: { fontSize: 13, fontWeight: '500' },
  mono: { fontSize: 12, fontWeight: '500' },
} as const;

export const space = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32,
} as const;
