export class Emitter {
  #handlers = new Map();

  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Set());
    this.#handlers.get(name).add(fn);
    return () => this.#handlers.get(name)?.delete(fn);
  }

  emit(name, ...args) {
    for (const fn of this.#handlers.get(name) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`handler for "${name}" failed`, err);
      }
    }
  }
}
