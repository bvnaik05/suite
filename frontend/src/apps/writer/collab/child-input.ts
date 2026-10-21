const LENGTH_BYTES = 4

// Splits the server's request to a Node child into its frames, each a u32 little-endian length and
// that many bytes, viewing the input rather than copying it
export function readFrames(input: Buffer): Buffer[] {
  const frames: Buffer[] = []
  for (let at = 0; at < input.length;) {
    const end = at + LENGTH_BYTES + input.readUInt32LE(at)
    frames.push(input.subarray(at + LENGTH_BYTES, end))
    at = end
  }

  return frames
}
