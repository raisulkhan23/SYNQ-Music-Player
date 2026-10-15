/**
 * Installing browser globals for a happy-dom test.
 *
 * `globalThis.navigator = win.navigator` is the obvious line, and it is what
 * these tests used to do — until the suite moved off Bun's runner and onto
 * vitest, which runs on plain Node. Node 21+ defines `navigator` on the global
 * object as an accessor with NO setter, so the assignment throws
 * `Cannot set property navigator of #<Object> which has only a getter` while
 * the globals are still being set up. The whole file then fails with an error
 * that names Node's internals rather than anything about SYNQ.
 *
 * `navigator` is the only such global here (checked against the Node 24 global
 * descriptors: `window`, `document`, `location`, `localStorage`, `Audio` and
 * the rest are either absent or writable), but the helper is generic because
 * the next Node release is free to make another one read-only.
 *
 * A plain `Object.defineProperty` is enough — these globals are configurable —
 * and it keeps the property writable, so a test can replace it again later.
 */
export function setGlobal(name, value) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  if (existing && !existing.writable && !existing.set) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
    return value;
  }
  globalThis[name] = value;
  return value;
}

/** The same, for a whole map of globals at once. */
export function setGlobals(globals) {
  for (const [name, value] of Object.entries(globals)) setGlobal(name, value);
  return globals;
}
