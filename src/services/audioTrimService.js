import ffmpeg from 'fluent-ffmpeg';
import { existsSync, unlink } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';
import { logInfo, logError, logWarn } from './loggerService.js';

// Almacenar progreso de recortes en memoria
const trimProgress = new Map();
// Almacenar conexiones SSE activas
const trimSSEConnections = new Map();
// Almacenar procesos activos para cancelación
const activeTrimProcesses = new Map();

/**
 * Inicializa el progreso de un recorte
 * @param {string} trimId - ID del recorte
 * @param {string} fileName - Nombre del archivo
 * @param {number} startTime - Tiempo de inicio
 * @param {number} endTime - Tiempo de fin
 */
export function initializeTrimProgress(trimId, fileName, startTime, endTime) {
  trimProgress.set(trimId, {
    fileName,
    startTime,
    endTime,
    percent: 0,
    status: 'trimming',
    startTimestamp: Date.now(),
  });
}

/**
 * Actualiza el progreso de un recorte
 * @param {string} trimId - ID del recorte
 * @param {object} progressData - Datos de progreso
 */
export function updateTrimProgress(trimId, progressData) {
  const current = trimProgress.get(trimId);
  if (current) {
    const updated = { ...current, ...progressData };
    trimProgress.set(trimId, updated);
    notifyTrimSSEConnections(trimId, updated);
  }
}

/**
 * Obtiene el progreso de un recorte
 * @param {string} trimId - ID del recorte
 * @returns {object|null} Progreso del recorte o null si no existe
 */
export function getTrimProgress(trimId) {
  return trimProgress.get(trimId) || null;
}

/**
 * Registra una conexión SSE para recibir actualizaciones de progreso
 * @param {string} trimId - ID del recorte
 * @param {object} res - Response object de Express
 */
export function registerTrimSSEConnection(trimId, res) {
  if (!trimSSEConnections.has(trimId)) {
    trimSSEConnections.set(trimId, []);
  }
  
  const connections = trimSSEConnections.get(trimId);
  connections.push(res);
  
  // Enviar estado inicial si existe
  const progress = trimProgress.get(trimId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierre
  res.on('close', () => {
    const conns = trimSSEConnections.get(trimId);
    if (conns) {
      const index = conns.indexOf(res);
      if (index > -1) {
        conns.splice(index, 1);
      }
      if (conns.length === 0) {
        trimSSEConnections.delete(trimId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso de un recorte
 * @param {string} trimId - ID del recorte
 * @param {object} progressData - Datos de progreso
 */
export function notifyTrimSSEConnections(trimId, progressData) {
  const connections = trimSSEConnections.get(trimId);
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
 * Obtiene todos los recortes activos
 * @returns {Array} Array de objetos con información de recortes activos
 */
export function getActiveTrims() {
  const activeTrims = [];
  trimProgress.forEach((progress, trimId) => {
    if (progress.status === 'trimming' || progress.status === 'processing') {
      activeTrims.push({
        trimId,
        ...progress,
      });
    }
  });
  return activeTrims;
}

/**
 * Cancela un recorte activo
 * @param {string} trimId - ID del recorte
 * @returns {boolean} true si se canceló exitosamente
 */
export function cancelTrim(trimId) {
  const process = activeTrimProcesses.get(trimId);
  if (process) {
    try {
      process.kill('SIGTERM');
      activeTrimProcesses.delete(trimId);
      
      const progress = trimProgress.get(trimId);
      if (progress) {
        const cancelledProgress = {
          ...progress,
          status: 'cancelled',
          percent: 0,
        };
        trimProgress.set(trimId, cancelledProgress);
        notifyTrimSSEConnections(trimId, cancelledProgress);
      }
      return true;
    } catch (error) {
      logError(`Error al cancelar recorte ${trimId}: ${error.message}`);
      return false;
    }
  }
  return false;
}

/**
 * Recorta un archivo de audio con seguimiento de progreso SSE
 * @param {string} trimId - ID único del recorte
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @param {number} startTime - Tiempo de inicio en segundos
 * @param {number} endTime - Tiempo de fin en segundos
 * @returns {Promise<{success: boolean, audioPath: string}>}
 */
export async function trimAudioWithProgress(trimId, fileName, startTime, endTime) {
  try {
    // Construir ruta del audio original
    const audioPath = join(config.storage.callsPath, `${fileName}.mp3`);
    
    if (!existsSync(audioPath)) {
      updateTrimProgress(trimId, {
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
    
    updateTrimProgress(trimId, {
      percent: 5,
      status: 'trimming',
      message: 'Iniciando recorte...',
    });
    
    // Recortar el audio usando FFmpeg
    return new Promise((resolve, reject) => {
      const ffmpegProcess = ffmpeg(backupPath)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log(`[trimAudio] FFmpeg iniciado: ${commandLine}`);
          activeTrimProcesses.set(trimId, ffmpegProcess.ffmpegProc);
          updateTrimProgress(trimId, {
            percent: 10,
            status: 'trimming',
            message: 'Procesando audio...',
          });
        })
        .on('progress', (progress) => {
          const percent = Math.min(95, 10 + (progress.percent || 0) * 0.85);
          updateTrimProgress(trimId, {
            percent: Math.round(percent),
            status: 'trimming',
            message: 'Recortando audio...',
          });
        })
        .on('end', async () => {
          console.log(`[trimAudio] Audio recortado exitosamente`);
          activeTrimProcesses.delete(trimId);
          
          // Eliminar el archivo backup _original.mp3 después del recorte
          if (existsSync(backupPath)) {
            try {
              await unlink(backupPath);
              await logInfo(`Backup eliminado después del recorte: ${backupPath}`);
              console.log(`🗑️ Backup eliminado: ${backupPath}`);
            } catch (error) {
              console.warn(`⚠️ No se pudo eliminar el backup: ${backupPath}`, error.message);
              await logWarn(`No se pudo eliminar backup después del recorte: ${backupPath}`);
            }
          }
          
          updateTrimProgress(trimId, {
            percent: 100,
            status: 'completed',
            message: 'Recorte completado',
            audioPath: outputPath,
          });
          
          await logInfo(`Audio recortado para ${fileName} de ${startTime}s a ${endTime}s`);
          
          resolve({
            success: true,
            audioPath: outputPath,
          });
        })
        .on('error', async (err) => {
          console.error(`[trimAudio] Error: ${err.message}`);
          activeTrimProcesses.delete(trimId);
          
          updateTrimProgress(trimId, {
            status: 'error',
            error: err.message,
            percent: 0,
          });
          
          reject(new Error(`Error al recortar audio: ${err.message}`));
        })
        .run();
    });
  } catch (error) {
    updateTrimProgress(trimId, {
      status: 'error',
      error: error.message,
      percent: 0,
    });
    throw error;
  }
}
