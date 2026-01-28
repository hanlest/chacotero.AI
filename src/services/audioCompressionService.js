import ffmpeg from 'fluent-ffmpeg';
import { existsSync, unlink } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';
import { logInfo, logError, logWarn } from './loggerService.js';

// Almacenar progreso de compresiones en memoria
const compressionProgress = new Map();
// Almacenar conexiones SSE activas
const compressionSSEConnections = new Map();
// Almacenar procesos activos para cancelación
const activeCompressionProcesses = new Map();

/**
 * Inicializa el progreso de una compresión
 * @param {string} compressionId - ID de la compresión
 * @param {string} fileName - Nombre del archivo
 */
export function initializeCompressionProgress(compressionId, fileName) {
  compressionProgress.set(compressionId, {
    fileName,
    percent: 0,
    status: 'compressing',
    startTimestamp: Date.now(),
  });
}

/**
 * Actualiza el progreso de una compresión
 * @param {string} compressionId - ID de la compresión
 * @param {object} progressData - Datos de progreso
 */
export function updateCompressionProgress(compressionId, progressData) {
  const current = compressionProgress.get(compressionId);
  if (current) {
    const updated = { ...current, ...progressData };
    compressionProgress.set(compressionId, updated);
    notifyCompressionSSEConnections(compressionId, updated);
  }
}

/**
 * Obtiene el progreso de una compresión
 * @param {string} compressionId - ID de la compresión
 * @returns {object|null} Progreso de la compresión o null si no existe
 */
export function getCompressionProgress(compressionId) {
  return compressionProgress.get(compressionId) || null;
}

/**
 * Registra una conexión SSE para recibir actualizaciones de progreso
 * @param {string} compressionId - ID de la compresión
 * @param {object} res - Response object de Express
 */
export function registerCompressionSSEConnection(compressionId, res) {
  if (!compressionSSEConnections.has(compressionId)) {
    compressionSSEConnections.set(compressionId, []);
  }
  
  const connections = compressionSSEConnections.get(compressionId);
  connections.push(res);
  
  // Enviar estado inicial si existe
  const progress = compressionProgress.get(compressionId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierre
  res.on('close', () => {
    const conns = compressionSSEConnections.get(compressionId);
    if (conns) {
      const index = conns.indexOf(res);
      if (index > -1) {
        conns.splice(index, 1);
      }
      if (conns.length === 0) {
        compressionSSEConnections.delete(compressionId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso de una compresión
 * @param {string} compressionId - ID de la compresión
 * @param {object} progressData - Datos de progreso
 */
export function notifyCompressionSSEConnections(compressionId, progressData) {
  const connections = compressionSSEConnections.get(compressionId);
  if (connections && connections.length > 0) {
    const message = `data: ${JSON.stringify(progressData)}\n\n`;
    connections.forEach((res) => {
      try {
        res.write(message);
      } catch (error) {
        // Ignorar errores de conexión cerrada
      }
    });
  }
}

/**
 * Obtiene todas las compresiones activas
 * @returns {Array} Array de objetos con información de compresiones activas
 */
export function getActiveCompressions() {
  const activeCompressions = [];
  compressionProgress.forEach((progress, compressionId) => {
    if (progress.status === 'compressing' || progress.status === 'processing') {
      activeCompressions.push({
        compressionId,
        ...progress,
      });
    }
  });
  return activeCompressions;
}

/**
 * Cancela una compresión activa
 * @param {string} compressionId - ID de la compresión
 * @returns {boolean} true si se canceló exitosamente
 */
export function cancelCompression(compressionId) {
  const process = activeCompressionProcesses.get(compressionId);
  if (process) {
    try {
      process.kill('SIGTERM');
      activeCompressionProcesses.delete(compressionId);
      
      const progress = compressionProgress.get(compressionId);
      if (progress) {
        const cancelledProgress = {
          ...progress,
          status: 'cancelled',
          percent: 0,
        };
        compressionProgress.set(compressionId, cancelledProgress);
        notifyCompressionSSEConnections(compressionId, cancelledProgress);
      }
      return true;
    } catch (error) {
      logError(`Error al cancelar compresión ${compressionId}: ${error.message}`);
      return false;
    }
  }
  return false;
}

/**
 * Comprime dinámicamente un archivo de audio con seguimiento de progreso SSE
 * @param {string} compressionId - ID único de la compresión
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @returns {Promise<{success: boolean, audioPath: string}>}
 */
export async function compressAudioWithProgress(compressionId, fileName) {
  try {
    // Construir ruta del audio original
    const audioPath = join(config.storage.callsPath, `${fileName}.mp3`);
    
    if (!existsSync(audioPath)) {
      updateCompressionProgress(compressionId, {
        status: 'error',
        error: 'Archivo de audio no encontrado',
      });
      throw new Error('Archivo de audio no encontrado');
    }
    
    // Crear ruta para el backup del original
    const backupPath = join(config.storage.callsPath, `${fileName}_original.mp3`);
    const outputPath = join(config.storage.callsPath, `${fileName}.mp3`);
    
    // Si no existe backup, crear uno
    if (!existsSync(backupPath)) {
      await copyFile(audioPath, backupPath);
      await logInfo(`Backup creado: ${backupPath}`);
    }
    
    updateCompressionProgress(compressionId, {
      percent: 5,
      status: 'compressing',
      message: 'Iniciando compresión dinámica...',
    });
    
    // Comprimir dinámicamente el audio usando FFmpeg con acompressor
    // Esto reduce los picos altos y aumenta las partes bajas
    return new Promise((resolve, reject) => {
      const ffmpegProcess = ffmpeg(backupPath)
        .audioFilters('acompressor=threshold=0.089:ratio=9:attack=200:release=1000')
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log(`[compressAudio] FFmpeg iniciado: ${commandLine}`);
          activeCompressionProcesses.set(compressionId, ffmpegProcess.ffmpegProc);
          updateCompressionProgress(compressionId, {
            percent: 10,
            status: 'compressing',
            message: 'Procesando audio...',
          });
        })
        .on('progress', (progress) => {
          const percent = Math.min(95, 10 + (progress.percent || 0) * 0.85);
          updateCompressionProgress(compressionId, {
            percent: Math.round(percent),
            status: 'compressing',
            message: 'Comprimiendo dinámicamente...',
          });
        })
        .on('end', async () => {
          console.log(`[compressAudio] Audio comprimido exitosamente`);
          activeCompressionProcesses.delete(compressionId);
          
          // Eliminar el archivo backup _original.mp3 después de la compresión
          if (existsSync(backupPath)) {
            try {
              await unlink(backupPath);
              await logInfo(`Backup eliminado después de la compresión: ${backupPath}`);
              console.log(`🗑️ Backup eliminado: ${backupPath}`);
            } catch (error) {
              console.warn(`⚠️ No se pudo eliminar el backup: ${backupPath}`, error.message);
              await logWarn(`No se pudo eliminar backup después de la compresión: ${backupPath}`);
            }
          }
          
          updateCompressionProgress(compressionId, {
            percent: 100,
            status: 'completed',
            message: 'Compresión completada',
            audioPath: outputPath,
          });
          
          await logInfo(`Audio comprimido dinámicamente para ${fileName}`);
          
          resolve({
            success: true,
            audioPath: outputPath,
          });
        })
        .on('error', async (err) => {
          console.error(`[compressAudio] Error: ${err.message}`);
          activeCompressionProcesses.delete(compressionId);
          
          updateCompressionProgress(compressionId, {
            status: 'error',
            error: err.message,
            percent: 0,
          });
          
          reject(new Error(`Error al comprimir audio: ${err.message}`));
        })
        .run();
    });
  } catch (error) {
    updateCompressionProgress(compressionId, {
      status: 'error',
      error: error.message,
      percent: 0,
    });
    throw error;
  }
}
