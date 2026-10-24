/**
 * Runs `run` as if the page had `<base href={baseHref}>` (the hub's injected base) on the base's
 * origin, for tests in the node environment, which has no document.
 */
export const underBase = <A>(baseHref: string, run: () => A): A => {
  const url = new URL(baseHref);
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => (selector === "base" ? { href: url.href } : null),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: url.origin } },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
};
