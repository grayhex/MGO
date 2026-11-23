export interface ScreenHint {
  width: number;
  height: number;
  source: string;
}

export function readScreenHints(attributes: Record<string, string>, fileName: string): ScreenHint[] {
  const hints: ScreenHint[] = [];
  const add = (value: string, source: string) => {
    const match = /(?<!\d)(\d{2,4})\s*[x×,]\s*(\d{2,4})(?!\d)/i.exec(value);
    if (!match) return;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width >= 64 && width <= 800 && height >= 64 && height <= 800) hints.push({ width, height, source });
  };
  for (const key of ['Nokia-MIDlet-Original-Display-Size', 'SEMC-Screen-Size', 'MIDxlet-ScreenSize', 'Nokia-MIDlet-Display-Size']) {
    if (attributes[key]) add(attributes[key], `attribute ${key}`);
  }
  add(fileName, 'file name');
  return hints;
}
