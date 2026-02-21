import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';

type ServerHandler = (req: unknown, res: unknown) => void;
let appInitPromise: Promise<ServerHandler> | null = null;

async function getServer(): Promise<ServerHandler> {
  if (!appInitPromise) {
    appInitPromise = (async () => {
      const adapter = new ExpressAdapter();
      const app = await NestFactory.create(AppModule, adapter);

      app.enableCors({
        origin: true,
      });

      await app.init();
      return adapter.getInstance() as ServerHandler;
    })();
  }

  return appInitPromise;
}

export default async function handler(
  req: unknown,
  res: unknown,
): Promise<void> {
  const appServer = await getServer();
  appServer(req, res);
}

async function bootstrap(): Promise<void> {
  if (process.env.VERCEL) {
    return;
  }

  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: true,
  });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
