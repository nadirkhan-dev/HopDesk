/**
 * Two connected MessageLink ends in one process. Messages go through
 * JSON.stringify/parse and are delivered asynchronously, like a socket.
 * `tap(direction, message)` may return a modified message or null to drop it,
 * which is how the tests play a man in the middle.
 */
export function linkPair(tap = (_dir, m) => m) {
  const make = (name) => ({
    name, closed: false, peer: null, handler: () => {}, closeHandlers: [], closeError: undefined,
    send(message) {
      if (this.closed) return;
      const wire = JSON.stringify(message);
      setImmediate(() => {
        if (this.peer.closed) return;
        const delivered = tap(name, JSON.parse(wire));
        if (delivered !== null) this.peer.handler(delivered);
      });
    },
    onMessage(h) { this.handler = h; },
    onClose(h) { this.closeHandlers.push(h); },
    close(error) {
      if (this.closed) return;
      this.closed = true;
      this.closeError = error;
      for (const h of this.closeHandlers) h(error);
      setImmediate(() => this.peer.close());
    },
  });
  const viewer = make('viewer→host');
  const host = make('host→viewer');
  viewer.peer = host; host.peer = viewer;
  return { viewer, host };
}
