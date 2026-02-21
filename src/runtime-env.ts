import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILE_CANDIDATES = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend/.env'),
  resolve(__dirname, '..', '.env'),
];

let envLoadAttempted = false;

export function ensureDatabaseUrlLoaded(): void {
  if (envLoadAttempted || process.env.DATABASE_URL) {
    envLoadAttempted = true;
    return;
  }

  for (const envFilePath of ENV_FILE_CANDIDATES) {
    if (!existsSync(envFilePath)) {
      continue;
    }

    process.loadEnvFile(envFilePath);

    if (process.env.DATABASE_URL) {
      envLoadAttempted = true;
      return;
    }
  }

  envLoadAttempted = true;
}
