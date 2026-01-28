import { existsSync, unlink } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import config from '../config/config.js';
import { downloadAudio as youtubeDownloadAudio } from './youtubeService.js';
import { logInfo, logError } from './loggerService.js';

// Almacenar progreso de descargas en memoria
const downloadProgress = new Map();
// Almacenar conexiones SSE activas
const downloadSSEConnections = new Map();

/**
 * Inicializa el progreso de una descarga
 * @param {string} downloadId - ID de la descarga
 * @param {string} youtubeUrl - URL de YouTube
 * @param {string} fileName - Nombre del archivo destino
 */
export function initializeDownloadProgress(downloadId, youtubeUrl, fileName) {
  downloadProgress.set(downloadId, {
    youtubeUrl,
    fileName,
    percent: 0,
    status: 'downloading',
    startTimestamp: Date.now(),
  });
}

/**
 * Actualiza el progreso de una descarga
 * @param {string} downloadId - ID de la descarga
 * @param {object} progressData - Datos de progreso
 */
export function updateDownloadProgress(downloadId, progressData) {
  const current = downloadProgress.get(downloadId);
  if (current) {
    const updated = { ...current, ...progressData };
    downloadProgress.set(downloadId, updated);
    notifyDownloadSSEConnections(downloadId, updated);
  }
}

/**
 * Obtiene el progreso de una descarga
 * @param {string} downloadId - ID de la descarga
 * @returns {object|null} Progreso de la descarga o null si no existe
 */
export function getDownloadProgress(downloadId) {
  return downloadProgress.get(downloadId) || null;
}

/**
 * Registra una conexión SSE para recibir actualizaciones de progreso
 * @param {string} downloadId - ID de la descarga
 * @param {object} res - Response object de Express
 */
export function registerDownloadSSEConnection(downloadId, res) {
  if (!downloadSSEConnections.has(downloadId)) {
    downloadSSEConnections.set(downloadId, []);
  }
  
  const connections = downloadSSEConnections.get(downloadId);
  connections.push(res);
  
  // Enviar estado inicial si existe
  const progress = downloadProgress.get(downloadId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierre
  res.on('close', () => {
    const conns = downloadSSEConnections.get(downloadId);
    if (conns) {
      const index = conns.indexOf(res);
      if (index > -1) {
        conns.splice(index, 1);
      }
      if (conns.length === 0) {
        downloadSSEConnections.delete(downloadId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso de una descarga
 * @param {string} downloadId - ID de la descarga
 * @param {object} progressData - Datos de progreso
 */
export function notifyDownloadSSEConnections(downloadId, progressData) {
  const connections = downloadSSEConnections.get(downloadId);
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
 * Obtiene todas las descargas activas
 * @returns {Array} Array de objetos con información de descargas activas
 */
export function getActiveDownloads() {
  const activeDownloads = [];
  downloadProgress.forEach((progress, downloadId) => {
    if (progress.status === 'downloading' || progress.status === 'processing') {
      activeDownloads.push({
        downloadId,
        ...progress,
      });
    }
  });
  return activeDownloads;
}

/**
 * Descarga audio desde YouTube con seguimiento de progreso SSE
 * @param {string} downloadId - ID único de la descarga
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} fileName - Nombre del archivo destino (sin extensión)
 * @returns {Promise<{success: boolean, audioPath: string}>}
 */
export async function downloadAudioWithProgress(downloadId, youtubeUrl, fileName) {
  try {
    updateDownloadProgress(downloadId, {
      percent: 5,
      status: 'downloading',
      message: 'Iniciando descarga...',
    });
    
    // Crear un callback de progreso personalizado
    // Nota: downloadAudio de youtubeService usa showLogCallback global
    // Necesitamos interceptar el progreso de otra manera
    // Por ahora, simularemos el progreso basado en el tiempo estimado
    
    const startTime = Date.now();
    let lastProgressUpdate = 5;
    
    // Simular progreso mientras se descarga (actualizar cada segundo)
    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      // Estimación: descarga típica toma 30-60 segundos
      // Actualizar progreso gradualmente hasta 90%
      const estimatedDuration = 45; // segundos
      const progress = Math.min(90, 5 + (elapsed / estimatedDuration) * 85);
      
      if (progress > lastProgressUpdate + 5) {
        lastProgressUpdate = Math.floor(progress);
        updateDownloadProgress(downloadId, {
          percent: lastProgressUpdate,
          status: 'downloading',
          message: 'Descargando audio...',
        });
      }
    }, 1000);
    
    // Descargar el audio
    const { audioPath: tempAudioPath, videoId } = await youtubeDownloadAudio(
      youtubeUrl,
      1,
      1,
      null,
      `⬇️  Redescargando audio`
    );
    
    clearInterval(progressInterval);
    
    updateDownloadProgress(downloadId, {
      percent: 95,
      status: 'processing',
      message: 'Guardando archivo...',
    });
    
    // Ruta final donde se guardará el audio
    const finalAudioPath = join(config.storage.callsPath, `${fileName}.mp3`);
    
    // Copiar el audio descargado a la ubicación final
    await copyFile(tempAudioPath, finalAudioPath);
    
    // Eliminar el archivo temporal si es diferente del final
    if (tempAudioPath !== finalAudioPath) {
      try {
        await unlink(tempAudioPath);
      } catch (error) {
        // Ignorar errores al eliminar temporal
        console.warn(`No se pudo eliminar archivo temporal: ${tempAudioPath}`);
      }
    }
    
    // Si existe un backup, también eliminarlo para que se cree uno nuevo si se ajusta el volumen
    const backupPath = join(config.storage.callsPath, `${fileName}_original.mp3`);
    if (existsSync(backupPath)) {
      try {
        await unlink(backupPath);
        await logInfo(`Backup eliminado antes de redescarga: ${backupPath}`);
      } catch (error) {
        // Ignorar errores al eliminar backup
        console.warn(`No se pudo eliminar backup: ${backupPath}`);
      }
    }
    
    updateDownloadProgress(downloadId, {
      percent: 100,
      status: 'completed',
      message: 'Descarga completada',
      audioPath: finalAudioPath,
    });
    
    await logInfo(`Audio redescargado para ${fileName} desde ${youtubeUrl}`);
    
    return {
      success: true,
      audioPath: finalAudioPath,
      videoId,
    };
  } catch (error) {
    updateDownloadProgress(downloadId, {
      status: 'error',
      error: error.message,
      percent: 0,
    });
    await logError(`Error en downloadAudioWithProgress: ${error.message}`);
    throw error;
  }
}
