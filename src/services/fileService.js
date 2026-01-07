import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';

/**
 * Sanitiza un nombre de archivo removiendo caracteres inválidos
 * @param {string} filename - Nombre de archivo a sanitizar
 * @returns {string} - Nombre de archivo sanitizado
 */
export function sanitizeFilename(filename) {
  // Remover caracteres inválidos para nombres de archivo en Windows/Linux/Mac
  // Permitir: letras, números, espacios, guiones, guiones bajos, puntos
  return filename
    .replace(/[<>:"/\\|?*]/g, '') // Remover caracteres inválidos
    .replace(/\s+/g, ' ') // Normalizar espacios múltiples
    .trim() // Remover espacios al inicio/fin
    .substring(0, 200); // Limitar longitud (evitar nombres muy largos)
}

/**
 * Guarda un archivo de audio MP3
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @param {Buffer} audioBuffer - Buffer del audio
 * @returns {Promise<string>} - Ruta del archivo guardado
 */
export async function saveAudioFile(fileName, audioBuffer) {
  const sanitizedFileName = sanitizeFilename(fileName);
  const filePath = join(config.storage.callsPath, `${sanitizedFileName}.mp3`);
  await writeFile(filePath, audioBuffer);
  return filePath;
}

/**
 * Guarda una transcripción en formato SRT
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @param {string} srtContent - Contenido SRT
 * @returns {Promise<string>} - Ruta del archivo guardado
 */
export async function saveTranscriptionFile(fileName, srtContent) {
  const sanitizedFileName = sanitizeFilename(fileName);
  const filePath = join(config.storage.callsPath, `${sanitizedFileName}.srt`);
  await writeFile(filePath, srtContent, 'utf-8');
  return filePath;
}

/**
 * Genera una versión simplificada del SRT (solo texto, sin números ni timestamps)
 * @param {string} srtContent - Contenido SRT completo
 * @returns {string} - Contenido SRT simplificado
 */
export function generateMinSRT(srtContent) {
  const lines = srtContent.split('\n');
  const textLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Saltar líneas vacías, números de secuencia y timestamps
    if (line === '' || /^\d+$/.test(line) || /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}$/.test(line)) {
      continue;
    }
    
    // Agregar líneas de texto
    if (line.length > 0) {
      textLines.push(line);
    }
  }
  
  return textLines.join('\n');
}

/**
 * Guarda una transcripción en formato SRT simplificado (_min)
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @param {string} srtContent - Contenido SRT completo
 * @returns {Promise<string>} - Ruta del archivo guardado
 */
export async function saveMinTranscriptionFile(fileName, srtContent) {
  const minSrtContent = generateMinSRT(srtContent);
  const sanitizedFileName = sanitizeFilename(fileName);
  const filePath = join(config.storage.callsPath, `${sanitizedFileName}_min.txt`);
  await writeFile(filePath, minSrtContent, 'utf-8');
  return filePath;
}

/**
 * Guarda metadatos en formato JSON
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @param {object} metadata - Objeto con metadatos
 * @returns {Promise<string>} - Ruta del archivo guardado
 */
export async function saveMetadataFile(fileName, metadata) {
  const sanitizedFileName = sanitizeFilename(fileName);
  const filePath = join(config.storage.callsPath, `${sanitizedFileName}.json`);
  const jsonContent = JSON.stringify(metadata, null, 2);
  await writeFile(filePath, jsonContent, 'utf-8');
  return filePath;
}

/**
 * Lee un archivo de metadatos
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @returns {Promise<object>} - Metadatos parseados
 */
export async function readMetadataFile(fileName) {
  const sanitizedFileName = sanitizeFilename(fileName);
  const filePath = join(config.storage.callsPath, `${sanitizedFileName}.json`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content);
}
