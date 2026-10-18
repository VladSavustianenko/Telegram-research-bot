import { connect, createServer, type Server, type Socket } from 'node:net';

export type FixtureMode = 'stall' | 'forward';

/**
 * Loopback TCP server for database failure tests. In `stall` mode it accepts
 * connections and never answers (no PostgreSQL handshake). In `forward` mode
 * new connections are proxied to a real server. Mode applies to new
 * connections only. Counts server-side sockets so tests can assert on actual
 * resources rather than on returned statuses.
 */
export class TcpFixture {
  mode: FixtureMode = 'stall';
  /** Accepted client connections since start. */
  accepted = 0;
  private readonly clientSockets = new Set<Socket>();
  private readonly upstreamSockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly forwardTo?: { host: string; port: number },
  ) {}

  static async start(forwardTo?: { host: string; port: number }): Promise<TcpFixture> {
    const server = createServer();
    const fixture = new TcpFixture(server, forwardTo);
    server.on('connection', (socket) => fixture.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return fixture;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture not listening');
    return address.port;
  }

  /** Client connections currently open on the fixture. */
  get openConnections(): number {
    return this.clientSockets.size;
  }

  /** Polls until the open connection count satisfies the predicate. */
  async waitForOpenConnections(predicate: (open: number) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.openConnections)) {
      if (Date.now() > deadline) {
        throw new Error(`open connections still ${this.openConnections} after ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Destroys every socket and stops listening. Safe to call more than once. */
  async close(): Promise<void> {
    for (const socket of [...this.clientSockets, ...this.upstreamSockets]) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: Socket): void {
    this.accepted += 1;
    this.track(this.clientSockets, socket);
    if (this.mode === 'forward' && this.forwardTo) {
      const upstream = connect(this.forwardTo.port, this.forwardTo.host);
      this.track(this.upstreamSockets, upstream);
      socket.pipe(upstream).pipe(socket);
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    } else {
      // Read and discard input; a paused socket would never observe the client closing it.
      socket.resume();
    }
  }

  private track(set: Set<Socket>, socket: Socket): void {
    set.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => set.delete(socket));
  }
}
