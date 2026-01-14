import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../src/config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Chacotero.AI API',
      version: '1.0.0',
      description: 'API para procesar videos de YouTube, extraer audio, transcribir y separar llamadas',
    },
    servers: [
      {
        url: `http://localhost:${config.server.port}`,
        description: 'Servidor de desarrollo',
      },
    ],
    components: {
      schemas: {
        Call: {
          type: 'object',
          properties: {
            callId: {
              type: 'string',
              description: 'ID único de la llamada',
              example: '123e4567-e89b-12d3-a456-426614174000',
            },
            youtubeVideoId: {
              type: 'string',
              description: 'ID del video de YouTube',
              example: 'dQw4w9WgXcQ',
            },
            title: {
              type: 'string',
              description: 'Título de la llamada',
              example: 'Llamada sobre experiencias personales',
            },
            description: {
              type: 'string',
              description: 'Descripción breve del contenido',
              example: 'Una persona comparte su experiencia personal sobre un tema específico.',
            },
            theme: {
              type: 'string',
              description: 'Tema principal de la llamada',
              example: 'Experiencias personales',
            },
            tags: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Tags que identifican el contenido',
              example: ['experiencia', 'personal', 'radio'],
            },
            date: {
              type: 'string',
              format: 'date',
              description: 'Fecha de la llamada',
              example: '2024-01-15',
            },
            speakers: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Personas que hablan en la llamada',
              example: ['Conductor', 'Llamante'],
            },
            audioFile: {
              type: 'string',
              description: 'Ruta del archivo de audio MP3',
              example: 'storage/audio/123e4567-e89b-12d3-a456-426614174000.mp3',
            },
            transcriptionFile: {
              type: 'string',
              description: 'Ruta del archivo de transcripción SRT',
              example: 'storage/transcriptions/123e4567-e89b-12d3-a456-426614174000.srt',
            },
            metadataFile: {
              type: 'string',
              description: 'Ruta del archivo de metadatos JSON',
              example: 'storage/metadata/123e4567-e89b-12d3-a456-426614174000.json',
            },
          },
        },
        ProcessVideoRequest: {
          type: 'object',
          required: ['youtubeUrl'],
          properties: {
            youtubeUrl: {
              type: 'string',
              description: 'URL del video de YouTube',
              example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            },
          },
        },
        ProcessVideoResponse: {
          type: 'object',
          properties: {
            videoId: {
              type: 'string',
              description: 'ID del video de YouTube',
            },
            processed: {
              type: 'boolean',
              description: 'Indica si el video fue procesado ahora (true) o ya existía (false)',
            },
            message: {
              type: 'string',
              description: 'Mensaje informativo (solo presente si processed es false)',
            },
            calls: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Call',
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Mensaje de error',
            },
            message: {
              type: 'string',
              description: 'Detalles adicionales del error',
            },
          },
        },
      },
    },
  },
  apis: [join(projectRoot, 'src/routes/*.js'), join(projectRoot, 'src/controllers/*.js')],
};

const swaggerSpec = swaggerJsdoc(options);

export { swaggerSpec, swaggerUi };
