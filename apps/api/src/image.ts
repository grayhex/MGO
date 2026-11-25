export function sniffImage(bytes: Uint8Array): 'jpg' | 'png' | 'gif' | 'webp' | null {
  if (bytes.length < 12) return null;
  const matches = (offset: number, signature: readonly number[]) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (matches(0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'gif';
  if (matches(0, [0x52, 0x49, 0x46, 0x46]) && matches(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

export function imageType(ext: NonNullable<ReturnType<typeof sniffImage>>): string {
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}
