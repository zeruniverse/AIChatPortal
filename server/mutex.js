export class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async runExclusive(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}
