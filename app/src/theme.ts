/**
 * Forced dark. The app does not follow the system theme.
 *
 * The reference is a key fob or an e-stop panel, not a consumer smart-home
 * app: this is a control surface for heavy machinery that happens to live on
 * a phone. One appearance, always, so the screen is never a surprise when it
 * is opened in a dark car at night -- which is the real usage context.
 */
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
  action: '#E8A33D',
  actionPressed: '#C4862B',
  actionDisabled: '#3A3B38',

  ok: '#5FB878',
  warn: '#E8A33D',
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
