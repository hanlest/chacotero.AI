import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';

/**
 * Busca todas las llamadas asociadas a un videoId de YouTube
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<Array>} - Array de objetos con metadatos de llamadas
 */
export async function findCallsByVideoId(videoId) {
  const calls = [];
  
  try {
    const metadataDir = config.storage.callsPath;
    const files = await readdir(metadataDir);
    
    // Filtrar solo archivos JSON
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    // Leer cada archivo y buscar coincidencias
    for (const file of jsonFiles) {
      try {
        const filePath = join(metadataDir, file);
        const content = await readFile(filePath, 'utf-8');
        const metadata = JSON.parse(content);
        
        // Verificar si el videoId coincide
        if (metadata.youtubeVideoId === videoId) {
          const callId = file.replace('.json', '');
          // Construir rutas basadas en el fileName del metadata
          const baseFileName = metadata.fileName || callId;
          calls.push({
            callId,
            ...metadata,
            metadataFile: filePath,
            audioFile: join(config.storage.callsPath, `${baseFileName}.mp3`),
            transcriptionFile: join(config.storage.callsPath, `${baseFileName}.srt`),
          });
        }
      } catch (error) {
        // Ignorar archivos corruptos o con errores
        console.warn(`Error al leer archivo ${file}:`, error.message);
      }
    }
  } catch (error) {
    // Si el directorio no existe, retornar array vacío
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  
  return calls;
}

/**
 * Verifica si un video ya fue procesado
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<boolean>} - true si el video ya fue procesado
 */
export async function isVideoProcessed(videoId) {
  const calls = await findCallsByVideoId(videoId);
  return calls.length > 0;
}
