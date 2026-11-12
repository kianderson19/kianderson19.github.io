// Storage adapters: anything with load() -> object|null and save(object).

export function memoryStorage(initial = null) {
  let data = initial ? structuredClone(initial) : null;
  return {
    load: () => (data ? structuredClone(data) : null),
    save: (obj) => { data = structuredClone(obj); },
  };
}

// Browser / WebView storage. Fails soft (private mode, blocked storage).
export function localStorageStorage(key) {
  return {
    load() {
      try {
        const s = globalThis.localStorage?.getItem(key);
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    },
    save(obj) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(obj));
      } catch {
        /* storage full or blocked: keep playing */
      }
    },
  };
}
