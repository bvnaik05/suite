export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function randomHex(byteCount: number) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(byteCount))
  return hex(randomBytes)
}
