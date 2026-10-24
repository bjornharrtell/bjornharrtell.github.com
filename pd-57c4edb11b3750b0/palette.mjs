// The ABI exposes Rust u16 words in little-endian wasm memory. Disk pack fields are big endian.
export function paletteRgb(buffer, ptr, count = 32) {
  const view = new DataView(buffer);
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const word = view.getUint16(ptr + i * 2, true);
    rgb[i * 3] = ((word >> 8) & 0xF) * 17;
    rgb[i * 3 + 1] = ((word >> 4) & 0xF) * 17;
    rgb[i * 3 + 2] = (word & 0xF) * 17;
  }
  return rgb;
}

// EHB halves the original four-bit DAC components before expanding them to eight bits.
export function ehbPaletteRgb(buffer, ptr, count = 32) {
  const rgb = new Uint8Array(count * 6);
  rgb.set(paletteRgb(buffer, ptr, count));
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const word = view.getUint16(ptr + i * 2, true);
    rgb[(i + count) * 3] = ((word >> 9) & 7) * 17;
    rgb[(i + count) * 3 + 1] = ((word >> 5) & 7) * 17;
    rgb[(i + count) * 3 + 2] = ((word >> 1) & 7) * 17;
  }
  return rgb;
}

// ABI words32..36 are the separate header/separator raster colours, encoded as indices64..68.
export function rasterPaletteRgb(buffer, ptr) {
  const rgb = new Uint8Array(69 * 3);
  rgb.set(ehbPaletteRgb(buffer, ptr));
  rgb.set(paletteRgb(buffer, ptr + 64, 5), 64 * 3);
  return rgb;
}
