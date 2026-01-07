import ffmpeg from 'fluent-ffmpeg';
import { join } from 'path';
import { readFile } from 'fs/promises';
import config from '../config/config.js';

/**
 * Muestra una barra de progreso para la extracción de audio
 * @param {number} percent - Porcentaje de progreso
 */
function showExtractionProgressBar(percent, callNumber, totalCalls) {
  const barLength = 50; // Barra de progreso
  // Asegurar que percent esté entre 0 y 100
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clampedPercent / 100) * barLength);
  const empty = Math.max(0, barLength - filled);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percentStr = clampedPercent.toFixed(1).padStart(5, ' ');
  const callInfo = callNumber && totalCalls ? ` | Llamada ${callNumber}/${totalCalls}` : '';
  process.stdout.write(`\r✂️  [${bar}] ${percentStr}%${callInfo}`);
}

/**
 * Extrae un segmento de audio de un archivo MP3
 * @param {string} inputPath - Ruta del archivo de audio original
 * @param {number} startTime - Tiempo de inicio en segundos
 * @param {number} endTime - Tiempo de fin en segundos
 * @param {string} outputPath - Ruta donde guardar el segmento
 * @param {number} callNumber - Número de llamada actual (opcional)
 * @param {number} totalCalls - Total de llamadas (opcional)
 * @returns {Promise<string>} - Ruta del archivo generado
 */
export async function extractAudioSegment(inputPath, startTime, endTime, outputPath, callNumber = null, totalCalls = null) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent !== undefined) {
          showExtractionProgressBar(progress.percent, callNumber, totalCalls);
        }
      })
      .on('end', () => {
        // Completar y limpiar la barra de progreso
        const bar = '█'.repeat(50);
        const callInfo = callNumber && totalCalls ? ` | Llamada ${callNumber}/${totalCalls}` : '';
        process.stdout.write(`\r✂️  [${bar}] 100.0%${callInfo}`);
        // Limpiar la línea completamente
        process.stdout.write('\r' + ' '.repeat(150) + '\r');
        resolve(outputPath);
      })
      .on('error', (err) => {
        // Limpiar la barra de progreso en caso de error
        process.stdout.write('\r' + ' '.repeat(150) + '\r');
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
