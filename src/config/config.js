import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  storage: {
    basePath: process.env.STORAGE_PATH || join(__dirname, '../../storage'),
    callsPath: process.env.CALLS_PATH || join(__dirname, '../../storage/calls'),
    tempPath: process.env.TEMP_PATH || join(__dirname, '../../storage/temp'),
  },
};

// Crear directorios si no existen
Object.values(config.storage).forEach((path) => {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
});

export default config;
