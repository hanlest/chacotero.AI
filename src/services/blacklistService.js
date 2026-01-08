import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import config from '../config/config.js';

// Ruta del archivo de lista negra
const BLACKLIST_FILE = join(config.storage.basePath || 'storage', 'blacklist.json');

/**
 * Asegura que el directorio existe
 */
async function ensureDirectory() {
  const dir = join(config.storage.basePath || 'storage');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Lee la lista negra desde el archivo
 * @returns {Promise<Array<string>>} - Array de videoIds en la lista negra
 */
export async function getBlacklist() {
  try {
    await ensureDirectory();
    
    if (!existsSync(BLACKLIST_FILE)) {
      // Si el archivo no existe, crear uno vacío
      await writeFile(BLACKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    
    const content = await readFile(BLACKLIST_FILE, 'utf-8');
    const blacklist = JSON.parse(content);
    
    // Validar que sea un array
    if (!Array.isArray(blacklist)) {
      // Si no es un array, crear uno nuevo
      await writeFile(BLACKLIST_FILE, JSON.stringify([], null, 2), 'utf-8');
      return [];
    }
    
    return blacklist;
  } catch (error) {
    // Si hay error al leer, retornar array vacío
    console.warn(`Error al leer lista negra: ${error.message}`);
    return [];
  }
}

/**
 * Verifica si un videoId está en la lista negra
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<boolean>} - true si está en la lista negra, false si no
 */
export async function isVideoBlacklisted(videoId) {
  if (!videoId) {
    return false;
  }
  
  const blacklist = await getBlacklist();
  return blacklist.includes(videoId);
}

/**
 * Agrega un videoId a la lista negra
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<void>}
 */
export async function addToBlacklist(videoId) {
  if (!videoId) {
    throw new Error('videoId es requerido');
  }
  
  await ensureDirectory();
  
  const blacklist = await getBlacklist();
  
  // Si ya está en la lista, no hacer nada
  if (blacklist.includes(videoId)) {
    return;
  }
  
  // Agregar a la lista
  blacklist.push(videoId);
  
  // Guardar en el archivo
  await writeFile(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2), 'utf-8');
}

/**
 * Elimina un videoId de la lista negra
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<void>}
 */
export async function removeFromBlacklist(videoId) {
  if (!videoId) {
    throw new Error('videoId es requerido');
  }
  
  await ensureDirectory();
  
  const blacklist = await getBlacklist();
  
  // Filtrar el videoId de la lista
  const filteredBlacklist = blacklist.filter(id => id !== videoId);
  
  // Si no cambió, no hacer nada
  if (filteredBlacklist.length === blacklist.length) {
    return;
  }
  
  // Guardar en el archivo
  await writeFile(BLACKLIST_FILE, JSON.stringify(filteredBlacklist, null, 2), 'utf-8');
}

/**
 * Obtiene toda la lista negra
 * @returns {Promise<Array<string>>} - Array completo de videoIds en la lista negra
 */
export async function getAllBlacklistedVideos() {
  return await getBlacklist();
}
