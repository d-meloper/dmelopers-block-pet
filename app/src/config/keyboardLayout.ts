export interface KeyDefinition {
  legend: string
  inputKeys: readonly string[]
  units?: number
}

export const ENGLISH_LEGENDS_BY_INPUT: Readonly<Record<string, string>> = {
  KeyQ: 'Q',
  KeyW: 'W',
  KeyE: 'E',
  KeyR: 'R',
  KeyT: 'T',
  KeyY: 'Y',
  KeyU: 'U',
  KeyI: 'I',
  KeyO: 'O',
  KeyP: 'P',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  KeyZ: 'Z',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyB: 'B',
  KeyN: 'N',
  KeyM: 'M',
}

// These are the app's VK/rdev input identities, not a physical-position overlay.
// BackQuote has no cap; IntlBackslash retains its existing BackSlash contact alias.
export const JAPANESE_LEGENDS_BY_INPUT: Readonly<Record<string, string>> = {
  Num1: 'ぬ',
  Num2: 'ふ',
  Num3: 'あ',
  Num4: 'う',
  Num5: 'え',
  Num6: 'お',
  Num7: 'や',
  Num8: 'ゆ',
  Num9: 'よ',
  Num0: 'わ',
  Minus: 'ほ',
  Equal: 'れ',
  KeyQ: 'た',
  KeyW: 'て',
  KeyE: 'い',
  KeyR: 'す',
  KeyT: 'か',
  KeyY: 'ん',
  KeyU: 'な',
  KeyI: 'に',
  KeyO: 'ら',
  KeyP: 'せ',
  LeftBracket: '゜',
  RightBracket: 'む',
  BackSlash: 'ー',
  KeyA: 'ち',
  KeyS: 'と',
  KeyD: 'し',
  KeyF: 'は',
  KeyG: 'き',
  KeyH: 'く',
  KeyJ: 'ま',
  KeyK: 'の',
  KeyL: 'り',
  SemiColon: 'け',
  Quote: 'へ',
  KeyZ: 'つ',
  KeyX: 'さ',
  KeyC: 'そ',
  KeyV: 'ひ',
  KeyB: 'こ',
  KeyN: 'み',
  KeyM: 'も',
  Comma: 'ね',
  Dot: 'る',
  Slash: 'め',
}

export const KEYBOARD_ROWS: readonly (readonly KeyDefinition[])[] = [
  [
    { legend: 'ESC', inputKeys: ['Escape'] },
    { legend: '1', inputKeys: ['Num1'] },
    { legend: '2', inputKeys: ['Num2'] },
    { legend: '3', inputKeys: ['Num3'] },
    { legend: '4', inputKeys: ['Num4'] },
    { legend: '5', inputKeys: ['Num5'] },
    { legend: '6', inputKeys: ['Num6'] },
    { legend: '7', inputKeys: ['Num7'] },
    { legend: '8', inputKeys: ['Num8'] },
    { legend: '9', inputKeys: ['Num9'] },
    { legend: '0', inputKeys: ['Num0'] },
    { legend: '-', inputKeys: ['Minus'] },
    { legend: '=', inputKeys: ['Equal'] },
    { legend: 'BACK', inputKeys: ['Backspace'], units: 1.75 },
    { legend: 'DEL', inputKeys: ['Delete'] },
  ],
  [
    { legend: 'TAB', inputKeys: ['Tab'], units: 1.5 },
    { legend: 'ㅂ', inputKeys: ['KeyQ'] },
    { legend: 'ㅈ', inputKeys: ['KeyW'] },
    { legend: 'ㄷ', inputKeys: ['KeyE'] },
    { legend: 'ㄱ', inputKeys: ['KeyR'] },
    { legend: 'ㅅ', inputKeys: ['KeyT'] },
    { legend: 'ㅛ', inputKeys: ['KeyY'] },
    { legend: 'ㅕ', inputKeys: ['KeyU'] },
    { legend: 'ㅑ', inputKeys: ['KeyI'] },
    { legend: 'ㅐ', inputKeys: ['KeyO'] },
    { legend: 'ㅔ', inputKeys: ['KeyP'] },
    { legend: '[', inputKeys: ['LeftBracket'] },
    { legend: ']', inputKeys: ['RightBracket'] },
    { legend: '\\', inputKeys: ['BackSlash'], units: 1.25 },
    { legend: 'HOME', inputKeys: ['Home'] },
  ],
  [
    { legend: 'CAPS', inputKeys: ['CapsLock'], units: 1.75 },
    { legend: 'ㅁ', inputKeys: ['KeyA'] },
    { legend: 'ㄴ', inputKeys: ['KeyS'] },
    { legend: 'ㅇ', inputKeys: ['KeyD'] },
    { legend: 'ㄹ', inputKeys: ['KeyF'] },
    { legend: 'ㅎ', inputKeys: ['KeyG'] },
    { legend: 'ㅗ', inputKeys: ['KeyH'] },
    { legend: 'ㅓ', inputKeys: ['KeyJ'] },
    { legend: 'ㅏ', inputKeys: ['KeyK'] },
    { legend: 'ㅣ', inputKeys: ['KeyL'] },
    { legend: ';', inputKeys: ['SemiColon'] },
    { legend: '\'', inputKeys: ['Quote'] },
    { legend: 'ENTER', inputKeys: ['Return'], units: 2 },
    { legend: 'PGUP', inputKeys: ['PageUp'] },
  ],
  [
    { legend: 'SHIFT', inputKeys: ['ShiftLeft'], units: 2.25 },
    { legend: 'ㅋ', inputKeys: ['KeyZ'] },
    { legend: 'ㅌ', inputKeys: ['KeyX'] },
    { legend: 'ㅊ', inputKeys: ['KeyC'] },
    { legend: 'ㅍ', inputKeys: ['KeyV'] },
    { legend: 'ㅠ', inputKeys: ['KeyB'] },
    { legend: 'ㅜ', inputKeys: ['KeyN'] },
    { legend: 'ㅡ', inputKeys: ['KeyM'] },
    { legend: ',', inputKeys: ['Comma'] },
    { legend: '.', inputKeys: ['Dot'] },
    { legend: '/', inputKeys: ['Slash'] },
    { legend: 'SHIFT', inputKeys: ['ShiftRight'], units: 1.5 },
    { legend: '↑', inputKeys: ['UpArrow'] },
    { legend: 'PGDN', inputKeys: ['PageDown'] },
  ],
  [
    { legend: 'CTRL', inputKeys: ['ControlLeft'], units: 1.25 },
    { legend: 'WIN', inputKeys: ['MetaLeft'], units: 1.25 },
    { legend: 'ALT', inputKeys: ['Alt'], units: 1.25 },
    { legend: 'SPACE', inputKeys: ['Space'], units: 6.25 },
    { legend: 'LANG', inputKeys: ['Lang1', 'Hangul', 'AltGr'], units: 1.25 },
    { legend: 'FN', inputKeys: ['Function'], units: 1.25 },
    { legend: '←', inputKeys: ['LeftArrow'] },
    { legend: '↓', inputKeys: ['DownArrow'] },
    { legend: '→', inputKeys: ['RightArrow'] },
  ],
]

export interface KeyboardSelectableKey {
  id: string
  row: number
  column: number
  units: number
  legend: string
  inputKeys: readonly string[]
}

export const KEYBOARD_SELECTABLE_KEYS: readonly KeyboardSelectableKey[] = KEYBOARD_ROWS.flatMap(
  (row, rowIndex) => row.map((key, column) => ({
    id: key.inputKeys[0]!,
    row: rowIndex,
    column,
    units: key.units ?? 1,
    legend: key.legend,
    inputKeys: key.inputKeys,
  })),
)

const SELECTABLE_KEYS_BY_ID = new Map(KEYBOARD_SELECTABLE_KEYS.map(key => [key.id, key]))

const SPECIAL_KEY_LABELS: Readonly<Record<string, readonly [string, string, string]>> = {
  ShiftLeft: ['왼쪽 Shift', 'Left Shift', '左 Shift'],
  ShiftRight: ['오른쪽 Shift', 'Right Shift', '右 Shift'],
  ControlLeft: ['왼쪽 Ctrl', 'Left Ctrl', '左 Ctrl'],
  MetaLeft: ['왼쪽 Win', 'Left Win', '左 Win'],
  Alt: ['왼쪽 Alt', 'Left Alt', '左 Alt'],
  Lang1: ['한/영 · 오른쪽 Alt', 'Language / Right Alt', '言語 / 右 Alt'],
  Function: ['Fn', 'Fn', 'Fn'],
  Backspace: ['Backspace', 'Backspace', 'Backspace'],
  Return: ['Enter', 'Enter', 'Enter'],
  Space: ['Space', 'Space', 'Space'],
  CapsLock: ['Caps Lock', 'Caps Lock', 'Caps Lock'],
  Escape: ['Esc', 'Esc', 'Esc'],
  Delete: ['Delete', 'Delete', 'Delete'],
  PageUp: ['Page Up', 'Page Up', 'Page Up'],
  PageDown: ['Page Down', 'Page Down', 'Page Down'],
}

export function getKeyboardKeyLabel(id: string, language: 'ko' | 'en' | 'ja' = 'en'): string {
  const key = SELECTABLE_KEYS_BY_ID.get(id)
  if (!key) return id
  const special = SPECIAL_KEY_LABELS[id]
  if (special) return special[language === 'ko' ? 0 : language === 'ja' ? 2 : 1]!
  if (language === 'ja') return JAPANESE_LEGENDS_BY_INPUT[id] ?? key.legend
  if (language === 'en') return ENGLISH_LEGENDS_BY_INPUT[id] ?? key.legend
  return key.legend
}

// DOM code identities map to the same caps as native keyboard_contact().
// A physical key that has no model contact deliberately remains unselectable.
const KEY_IDS_BY_DOM_CODE: Readonly<Record<string, string>> = {
  Enter: 'Return',
  NumpadEnter: 'Return',
  BracketLeft: 'LeftBracket',
  BracketRight: 'RightBracket',
  Backslash: 'BackSlash',
  IntlBackslash: 'BackSlash',
  Semicolon: 'SemiColon',
  Period: 'Dot',
  IntlRo: 'Slash',
  AltLeft: 'Alt',
  AltRight: 'Lang1',
  Lang1: 'Lang1',
  Fn: 'Function',
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow',
  ArrowUp: 'UpArrow',
  ArrowDown: 'DownArrow',
}

export function keyboardKeyIdFromCode(code: string): string | undefined {
  const id = KEY_IDS_BY_DOM_CODE[code] ?? (/^Digit\d$/.test(code) ? `Num${code.slice(5)}` : code)
  return SELECTABLE_KEYS_BY_ID.has(id) ? id : undefined
}
