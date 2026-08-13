/**
 * Returns an ArrayBuffer containing exactly `view` and safe to hand to an async API.
 *
 * Whole fixed buffers are already exact and can be reused. Subviews must be copied so bytes
 * outside the view never escape; shared/resizable storage must be copied so another actor or
 * a resize cannot change what the consumer sees after this function returns.
 */
export function exactArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer;
  const plainArrayBuffer =
    buffer instanceof ArrayBuffer && Object.getPrototypeOf(buffer) === ArrayBuffer.prototype;
  const resizable =
    plainArrayBuffer &&
    (buffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true;
  if (
    plainArrayBuffer &&
    !resizable &&
    view.byteOffset === 0 &&
    view.byteLength === buffer.byteLength
  ) {
    return buffer;
  }

  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}
