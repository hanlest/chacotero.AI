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
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS || '1024', 10),
  },
  embeddings: {
    // Usar embeddings locales o OpenAI: 'local' o 'openai'
    provider: process.env.EMBEDDING_PROVIDER || 'openai',
    // Modelo local para embeddings (solo si provider = 'local')
    // Opciones recomendadas:
    // - 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' (384 dims, bueno para español)
    // - 'Xenova/sentence-transformers/all-mpnet-base-v2' (768 dims, mejor calidad)
    // - 'Xenova/bge-small-en-v1.5' (384 dims, rápido)
    localModel: process.env.EMBEDDING_LOCAL_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    // Dimensiones del modelo local (debe coincidir con el modelo elegido)
    localDimensions: parseInt(process.env.EMBEDDING_LOCAL_DIMENSIONS || '384', 10),
  },
  whisper: {
    // Tamaño del modelo local: tiny, base, small, medium, large-v2, large-v3
    modelSize: process.env.WHISPER_MODEL_SIZE || 'base',
    // Dispositivo: cpu (siempre cpu en JavaScript, gpu requiere WebGPU)
    device: 'cpu',
  },
  youtube: {
    // Ruta al archivo de credenciales OAuth 2.0 descargado de Google Cloud Console
    // Si es relativa, se resuelve contra STORAGE_PATH
    // Si es absoluta, se usa tal cual
    credentialsPath: (() => {
      const basePath = process.env.STORAGE_PATH || join(__dirname, '../../storage');
      const credentialsPath = process.env.YOUTUBE_CREDENTIALS_PATH || '';
      if (!credentialsPath) return '';
      // Si es ruta absoluta (Windows: C:\ o Linux/Mac: /), usar tal cual
      if (credentialsPath.match(/^[A-Za-z]:/) || credentialsPath.startsWith('/')) {
        return credentialsPath;
      }
      // Eliminar prefijo "storage/" o "storage\" si existe antes de unir
      const normalizedPath = credentialsPath.replace(/^storage[/\\]/, '');
      return join(basePath, normalizedPath);
    })(),
    // Token de acceso OAuth (se genera automáticamente después de la primera autenticación)
    // Si es relativa, se resuelve contra STORAGE_PATH
    tokenPath: (() => {
      const basePath = process.env.STORAGE_PATH || join(__dirname, '../../storage');
      const tokenPath = process.env.YOUTUBE_TOKEN_PATH || 'youtube-token.json';
      // Si es ruta absoluta (Windows: C:\ o Linux/Mac: /), usar tal cual
      if (tokenPath.match(/^[A-Za-z]:/) || tokenPath.startsWith('/')) {
        return tokenPath;
      }
      // Eliminar prefijo "storage/" o "storage\" si existe antes de unir
      const normalizedPath = tokenPath.replace(/^storage[/\\]/, '');
      return join(basePath, normalizedPath);
    })(),
    // ID del canal de YouTube donde se subirán los videos (opcional)
    channelId: process.env.YOUTUBE_CHANNEL_ID || '',
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
    shortBackgroundVideosPath: process.env.SHORT_BACKGROUND_VIDEOS_PATH || join(__dirname, '../../storage/short-backgrounds'),
  },
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexName: process.env.PINECONE_INDEX_NAME || 'chacotero-calls',
    environment: process.env.PINECONE_ENVIRONMENT || '',
    projectId: process.env.PINECONE_PROJECT_ID || '',
    // Umbrales de similitud (0.0-1.0)
    duplicateThreshold: parseFloat(process.env.PINECONE_DUPLICATE_THRESHOLD || '0.98'), // 98% para duplicados
    relatedThreshold: parseFloat(process.env.PINECONE_RELATED_THRESHOLD || '0.90'), // 90% para relacionadas
  },
};

// Log de configuración de umbrales al cargar el módulo
//console.log(`📊 Umbrales de Pinecone cargados:`);
//console.log(`   - Duplicado: >= ${(config.pinecone.duplicateThreshold * 100).toFixed(2)}% (${config.pinecone.duplicateThreshold})`);
//console.log(`   - Relacionada: >= ${(config.pinecone.relatedThreshold * 100).toFixed(2)}% (${config.pinecone.relatedThreshold})`);
//console.log(`   - Variable de entorno PINECONE_RELATED_THRESHOLD: ${process.env.PINECONE_RELATED_THRESHOLD || 'no definida (usando default 0.90)'}`);

// Crear directorios si no existen
Object.values(config.storage).forEach((path) => {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
});

export default config;
