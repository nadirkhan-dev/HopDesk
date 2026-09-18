/**
 * Which devices are connected right now, and the sessions being relayed between
 * them. Memory only: presence is a fact about open connections, and a restarted
 * server has none.
 */

export interface Connection {
  deviceId: string;
  accountId: string;
  send(message: unknown): void;
  close(code: number, reason: string): void;
}

export interface RelaySession {
  id: string;
  a: Connection;
  b: Connection;
  startedAt: number;
}

export class Presence {
  private readonly online = new Map<string, Connection>();
  private readonly sessions = new Map<string, RelaySession>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers a device, replacing an older connection for the same device. */
  add(connection: Connection): void {
    const existing = this.online.get(connection.deviceId);
    if (existing && existing !== connection) existing.close(4001, 'replaced by a newer connection');
    this.online.set(connection.deviceId, connection);
  }

  remove(connection: Connection): void {
    if (this.online.get(connection.deviceId) === connection) this.online.delete(connection.deviceId);
    for (const session of [...this.sessions.values()]) {
      if (session.a === connection || session.b === connection) this.endSession(session.id, 'peer-disconnected');
    }
  }

  isOnline(deviceId: string): boolean { return this.online.has(deviceId); }
  get(deviceId: string): Connection | undefined { return this.online.get(deviceId); }
  get onlineCount() { return this.online.size; }

  disconnect(deviceId: string, reason: string): void {
    this.online.get(deviceId)?.close(4003, reason);
  }

  /* ------------------------------------------------------------- sessions */

  openSession(id: string, a: Connection, b: Connection): RelaySession {
    const session: RelaySession = { id, a, b, startedAt: this.now() };
    this.sessions.set(id, session);
    return session;
  }

  session(id: string): RelaySession | undefined { return this.sessions.get(id); }

  sessionsOf(connection: Connection): RelaySession[] {
    return [...this.sessions.values()].filter(s => s.a === connection || s.b === connection);
  }

  /** The other end of a session, if this connection is part of it. */
  peer(id: string, connection: Connection): Connection | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.a === connection) return session.b;
    if (session.b === connection) return session.a;
    return null;
  }

  endSession(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const end of [session.a, session.b]) {
      try { end.send({ type: 'session-ended', sessionId: id, reason }); } catch { /* already gone */ }
    }
  }

  get sessionCount() { return this.sessions.size; }
}
