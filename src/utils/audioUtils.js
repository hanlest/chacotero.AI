import ffmpeg from 'fluent-ffmpeg';
import { join } from 'path';
import { readFile } from 'fs/promises';
import config from '../config/config.js';

/**
 * Función para mostrar log en formato unificado (importada desde videoController)
 */
let showLogCallback = null;

/**
 * Establece el callback para mostrar logs
 * @param {Function} callback - Función callback para mostrar logs
 */
export function setLogCallback(callback) {
  showLogCallback = callback;
}

/**
 * Extrae un segmento de audio de un archivo MP3
 * @param {string} inputPath - Ruta del archivo de audio original
 * @param {number} startTime - Tiempo de inicio en segundos
 * @param {number} endTime - Tiempo de fin en segundos
 * @param {string} outputPath - Ruta donde guardar el segmento
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @param {number} callNumber - Número de llamada actual (opcional)
 * @param {number} totalCalls - Total de llamadas (opcional)
 * @returns {Promise<string>} - Ruta del archivo generado
 */
export async function extractAudioSegment(inputPath, startTime, endTime, outputPath, videoNumber = 1, totalVideos = 1, videoId = '', callNumber = null, totalCalls = null) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent !== undefined && showLogCallback) {
          const processText = callNumber && totalCalls 
            ? `Recortando llamada ${callNumber}/${totalCalls}`
            : 'Recortando audio';
          showLogCallback('✂️', videoNumber, totalVideos, videoId, processText, progress.percent, null);
        }
      })
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`Error al extraer segmento de audio: ${err.message}`));
      })
      .run();
  });
}

/**
 * Convierte un archivo de audio a MP3
 * @param {string} inputPath - Ruta del archivo de entrada
 * @param {string} outputPath - Ruta del archivo de salida
 * @returns {Promise<string>} - Ruta del archivo convertido
 */
export async function convertToMP3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .output(outputPath)
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`Error al convertir audio: ${err.message}`));
      })
      .run();
  });
}

/**
 * Lee un archivo de audio como buffer
 * @param {string} audioPath - Ruta del archivo de audio
 * @returns {Promise<Buffer>} - Buffer del archivo
 */
export async function readAudioFile(audioPath) {
  return await readFile(audioPath);
}
