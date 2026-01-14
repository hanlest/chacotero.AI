import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import config from '../config/config.js';

/**
 * Extrae el ID de la playlist de una URL de YouTube
 * @param {string} playlistUrl - URL de la playlist de YouTube
 * @returns {string|null} - ID de la playlist o null si no es válida
 */
export function extractPlaylistId(playlistUrl) {
  if (!playlistUrl) {
    return null;
  }

  // Patrones para extraer el ID de la playlist
  const patterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,  // ?list=PLxxxxx o &list=PLxxxxx
    /^([a-zA-Z0-9_-]+)$/,          // Solo el ID
  ];

  for (const pattern of patterns) {
    const match = playlistUrl.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Obtiene la ruta del archivo índice para una playlist
 * @param {string} playlistId - ID de la playlist
 * @returns {string} - Ruta del archivo índice
 */
function getPlaylistIndexPath(playlistId) {
  return join(config.storage.basePath, `playlist_${playlistId}_index.json`);
}

/**
 * Carga el índice de videos procesados de una playlist
 * @param {string} playlistId - ID de la playlist
 * @returns {Promise<Set<string>>} - Set con los IDs de videos procesados
 */
export async function loadPlaylistIndex(playlistId) {
  if (!playlistId) {
    return new Set();
  }

  const indexPath = getPlaylistIndexPath(playlistId);
  
  try {
    if (!existsSync(indexPath)) {
      return new Set();
    }

    const content = await readFile(indexPath, 'utf-8');
    const data = JSON.parse(content);
    return new Set(data.videoIds || []);
  } catch (error) {
    // Si hay error al leer, retornar Set vacío
    console.warn(`⚠️  Error al leer índice de playlist ${playlistId}:`, error.message);
    return new Set();
  }
}

/**
 * Guarda el índice de videos procesados de una playlist
 * @param {string} playlistId - ID de la playlist
 * @param {Set<string>} videoIds - Set con los IDs de videos procesados
 */
export async function savePlaylistIndex(playlistId, videoIds) {
  if (!playlistId) {
    return;
  }

  const indexPath = getPlaylistIndexPath(playlistId);
  const data = {
    playlistId,
    videoIds: Array.from(videoIds),
    lastUpdated: new Date().toISOString(),
  };

  try {
    await writeFile(indexPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`⚠️  Error al guardar índice de playlist ${playlistId}:`, error.message);
  }
}

/**
 * Agrega un videoId al índice de una playlist
 * @param {string} playlistId - ID de la playlist
 * @param {string} videoId - ID del video de YouTube
 */
export async function addVideoToPlaylistIndex(playlistId, videoId) {
  if (!playlistId || !videoId) {
    return;
  }

  const index = await loadPlaylistIndex(playlistId);
  if (!index.has(videoId)) {
    index.add(videoId);
    await savePlaylistIndex(playlistId, index);
  }
}

/**
 * Verifica si un video está en el índice de una playlist
 * @param {string} playlistId - ID de la playlist
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<boolean>} - true si el video está en el índice
 */
export async function isVideoInPlaylistIndex(playlistId, videoId) {
  if (!playlistId || !videoId) {
    return false;
  }

  const index = await loadPlaylistIndex(playlistId);
  return index.has(videoId);
}

/**
 * Elimina el archivo índice de una playlist
 * @param {string} playlistId - ID de la playlist
 */
export async function deletePlaylistIndex(playlistId) {
  if (!playlistId) {
    return;
  }

  const indexPath = getPlaylistIndexPath(playlistId);
  
  try {
    if (existsSync(indexPath)) {
      await unlink(indexPath);
      console.log(`🗑️  Índice de playlist ${playlistId} eliminado`);
    }
  } catch (error) {
    console.warn(`⚠️  Error al eliminar índice de playlist ${playlistId}:`, error.message);
  }
}

/**
 * Sincroniza el índice de una playlist con los videos procesados
 * Busca todos los videos procesados que pertenecen a la playlist
 * @param {string} playlistId - ID de la playlist
 * @param {Array<string>} videoIds - Array de IDs de videos de la playlist
 */
export async function syncPlaylistIndex(playlistId, videoIds) {
  if (!playlistId || !videoIds || videoIds.length === 0) {
    return;
  }

  // Importar aquí para evitar dependencia circular
  const { findCallsByVideoId } = await import('./videoIndexService.js');
  
  const processedVideoIds = new Set();
  
  // Verificar cada video de la playlist
  for (const videoId of videoIds) {
    const calls = await findCallsByVideoId(videoId);
    if (calls.length > 0) {
      processedVideoIds.add(videoId);
    }
  }
  
  // Guardar el índice actualizado
  await savePlaylistIndex(playlistId, processedVideoIds);
  
  return processedVideoIds;
}
