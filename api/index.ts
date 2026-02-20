import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';

const expressServer = express();
let bootstrapPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const app = await NestFactory.create(
        AppModule,
        new ExpressAdapter(expressServer),
      );

      app.enableCors({
        origin: true,
      });

      await app.init();
    })();
  }

  await bootstrapPromise;
}

export default async function handler(req: any, res: any): Promise<void> {
  await bootstrap();
  expressServer(req, res);
}
