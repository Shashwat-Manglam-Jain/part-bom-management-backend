import express, { type Express, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';

const server: Express = express();
let appInitPromise: Promise<Express> | null = null;

async function getServer(): Promise<Express> {
  if (!appInitPromise) {
    appInitPromise = (async () => {
      const app = await NestFactory.create(
        AppModule,
        new ExpressAdapter(server),
      );

      app.enableCors({
        origin: true,
      });

      await app.init();
      return server;
    })();
  }

  return appInitPromise;
}

export default async function handler(
  req: Request,
  res: Response,
): Promise<void> {
  const appServer = await getServer();
  appServer(req, res);
}
