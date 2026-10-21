// Minimal stand-in for next/headers cookies()/headers() used by unit tests.
export interface SetCall {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

export function createCookieJar() {
  const values = new Map<string, string>();
  const sets: SetCall[] = [];
  const store = {
    get: (name: string) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    has: (name: string) => values.has(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      values.set(name, value);
      sets.push({ name, value, options });
    },
    delete: (name: string) => {
      values.delete(name);
    },
  };
  return { values, sets, store };
}
