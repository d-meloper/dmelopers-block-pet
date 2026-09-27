/** The recorder preserves modifier press order; native shortcut IDs do not. */
export function shortcutIdentity(value: string): string {
  return value.split('+').map(key => key.trim().toLowerCase()).sort().join('+')
}
