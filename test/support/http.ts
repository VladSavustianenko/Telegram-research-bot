import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';

/** Typed access to the Nest HTTP server for supertest. */
export function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}
