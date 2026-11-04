import { useState, useEffect, useRef } from 'preact/hooks';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f(state));
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

/** Re-render when the selected slice changes (shallow compare of the selector result). */
export function useStore(store, selector = (s) => s) {
  const [, force] = useState(0);
  const sel = useRef(selector); sel.current = selector;
  const last = useRef(selector(store.get()));
  useEffect(() => store.subscribe((s) => {
    const next = sel.current(s);
    if (next !== last.current) { last.current = next; force((n) => n + 1); }
  }), [store]);
  last.current = selector(store.get());
  return last.current;
}
