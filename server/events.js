import { EventEmitter } from 'node:events';

export class ChatEvents {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  emit(id, payload) {
    this.emitter.emit(`chat:${id}`, payload);
    this.emitter.emit('history', { id, ...payload });
  }

  subscribe(id, listener) {
    const key = `chat:${id}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  subscribeHistory(listener) {
    this.emitter.on('history', listener);
    return () => this.emitter.off('history', listener);
  }
}
