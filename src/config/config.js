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
  whisper: {
    // Tamaño del modelo local: tiny, base, small, medium, large-v2, large-v3
    modelSize: process.env.WHISPER_MODEL_SIZE || 'base',
    // Dispositivo: cpu (siempre cpu en JavaScript, gpu requiere WebGPU)
    device: 'cpu',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'development',
  },
  storage: {
    basePath: process.env.STORAGE_PATH || join(__dirname, '../../storage'),
    callsPath: process.env.CALLS_PATH || join(__dirname, '../../storage/calls'),
    tempPath: process.env.TEMP_PATH || join(__dirname, '../../storage/temp'),
    logsPath: process.env.LOGS_PATH || join(__dirname, '../../storage/logs'),
  },
};

// Crear directorios si no existen
Object.values(config.storage).forEach((path) => {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
});

export default config;
