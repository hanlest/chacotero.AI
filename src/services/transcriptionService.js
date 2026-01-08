import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { statSync, existsSync, unlinkSync } from 'fs';
import { basename, join, dirname } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import config from '../config/config.js';

/**
 * Formatea tiempo en segundos a formato legible (segundos, minutos o horas)
 * @param {number} seconds - Tiempo en segundos
 * @returns {string} - Tiempo formateado (ej: "45.23s", "1.25min", "1.50h")
 */
function formatTime(seconds) {
  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  } else if (seconds < 3600) {
    const minutes = seconds / 60;
    return `${minutes.toFixed(2)}min`;
  } else {
    const hours = seconds / 3600;
    return `${hours.toFixed(2)}h`;
  }
}

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

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
 * Comprime un archivo de audio para reducir su tamaño
 * @param {string} inputPath - Ruta del archivo original
 * @param {string} outputPath - Ruta donde guardar el archivo comprimido
 * @returns {Promise<string>} - Ruta del archivo comprimido
 */
async function compressAudio(inputPath, outputPath, videoNumber = 1, totalVideos = 1, videoId = '') {
  return new Promise((resolve, reject) => {
    // Calcular bitrate objetivo para que el archivo sea aproximadamente 20MB
    const stats = statSync(inputPath);
    const originalSizeMB = stats.size / (1024 * 1024);
    const targetSizeMB = 20; // Objetivo: 20MB para dejar margen
    const targetBitrate = Math.max(32, Math.min(128, Math.floor((targetSizeMB / originalSizeMB) * 128)));
    
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(targetBitrate)
      .audioChannels(1) // Mono para reducir tamaño
      .audioFrequency(16000) // 16kHz es suficiente para transcripción
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent !== undefined && showLogCallback) {
          showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', progress.percent, null);
        }
      })
      .on('end', () => {
        if (showLogCallback) {
          showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', 100, null);
        }
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`Error al comprimir audio: ${err.message}`));
      })
      .run();
  });
}

/**
 * Transcribe un archivo de audio usando Whisper
 * @param {string} audioPath - Ruta del archivo de audio
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @returns {Promise<{transcription: string, srt: string, segments: Array}>}
 */
export async function transcribeAudio(audioPath, videoNumber = 1, totalVideos = 1, videoId = '') {
  // Verificar API key
  if (!config.openai.apiKey || config.openai.apiKey.trim() === '') {
    throw new Error('OPENAI_API_KEY no está configurada o está vacía. Verifica tu archivo .env');
  }

  let audioToTranscribe = audioPath;
  let compressedAudioPath = null;

  try {
    // Obtener tamaño del archivo para estimar tiempo
    const stats = statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    // Si el archivo es mayor a 25MB, comprimirlo
    if (fileSizeMB > 25) {
      // Crear ruta para el archivo comprimido
      const dir = dirname(audioPath);
      const baseName = basename(audioPath, '.mp3');
      compressedAudioPath = join(dir, `${baseName}_min.mp3`);
      
      // Verificar si el audio comprimido ya existe
      if (existsSync(compressedAudioPath)) {
        audioToTranscribe = compressedAudioPath;
        
        // Verificar el tamaño del archivo comprimido
        const compressedStats = statSync(compressedAudioPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        
        if (compressedSizeMB > 25) {
          // Si aún es muy grande, intentar con la versión más comprimida
          const moreCompressedPath = join(dir, `${baseName}_min2.mp3`);
          if (existsSync(moreCompressedPath)) {
            audioToTranscribe = moreCompressedPath;
            compressedAudioPath = moreCompressedPath;
          } else {
            if (showLogCallback) {
              showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', null, null);
            }
            audioToTranscribe = await compressAudio(audioPath, moreCompressedPath, videoNumber, totalVideos, videoId);
            compressedAudioPath = moreCompressedPath;
          }
        }
      } else {
        if (showLogCallback) {
          showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', null, null);
        }
        // Comprimir el audio
        audioToTranscribe = await compressAudio(audioPath, compressedAudioPath, videoNumber, totalVideos, videoId);
        
        // Verificar el tamaño del archivo comprimido
        const compressedStats = statSync(compressedAudioPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        
        if (compressedSizeMB > 25) {
          // Si aún es muy grande, comprimir más agresivamente
          const moreCompressedPath = join(dir, `${baseName}_min2.mp3`);
          audioToTranscribe = await compressAudio(audioPath, moreCompressedPath, videoNumber, totalVideos, videoId);
          compressedAudioPath = moreCompressedPath;
        }
      }
    }
    
    // Obtener tamaño del archivo a transcribir (puede ser el comprimido)
    const finalStats = statSync(audioToTranscribe);
    const finalSizeMB = finalStats.size / (1024 * 1024);
    
    let transcription;
    try {
      // Leer el archivo completo como buffer (necesario para File API)
      const audioBuffer = await readFile(audioToTranscribe);
      const fileName = basename(audioToTranscribe);
      
      // Crear un objeto File para la API de OpenAI
      // En Node.js 18+, File está disponible globalmente
      let file;
      if (typeof File !== 'undefined') {
        file = new File([audioBuffer], fileName, { 
          type: 'audio/mpeg',
          lastModified: stats.mtimeMs
        });
      } else {
        // Fallback: usar el buffer directamente (puede funcionar en algunas versiones)
        file = audioBuffer;
        file.name = fileName;
        file.type = 'audio/mpeg';
      }

      // Transcribir con Whisper con timeout y reintentos
      const startTime = Date.now();
      let lastUpdate = Date.now();
      
      // Estimar tiempo de transcripción basado en el tamaño del archivo
      // Whisper procesa aproximadamente 1MB por segundo (estimación conservadora)
      let estimatedDuration = Math.max(30, finalSizeMB * 1.5); // Mínimo 30s, o 1.5s por MB
      let lastElapsed = 0;
      
      // Función auxiliar para detectar errores de conexión
      const isConnectionError = (error) => {
        const errorMessage = error.message || '';
        const errorCode = error.code || '';
        return (
          errorMessage.includes('Connection error') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('network') ||
          errorMessage.includes('fetch failed') ||
          errorCode === 'ECONNREFUSED' ||
          errorCode === 'ECONNRESET' ||
          errorCode === 'ETIMEDOUT' ||
          errorCode === 'ENOTFOUND'
        );
      };
      
      // Sistema de reintentos para errores de conexión
      const maxRetries = 3;
      let retryCount = 0;
      let progressInterval = null;
      
      while (retryCount <= maxRetries) {
        try {
          // Simular progreso mientras transcribe
          progressInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            
            // Ajustar dinámicamente la estimación si está tomando más tiempo del esperado
            // Si han pasado más de 10 segundos y el progreso estimado sería > 100%, ajustar la duración estimada
            if (elapsed > 10 && (elapsed / estimatedDuration) * 100 > 90) {
              // Ajustar la duración estimada para que el progreso sea más realista
              // Usar una función logarítmica para que el progreso avance más lentamente cuando se acerca al final
              estimatedDuration = elapsed / 0.95; // Ajustar para que el progreso esté en ~95% cuando ha pasado este tiempo
            }
            
            // Calcular progreso con función logarítmica para que avance más rápido al inicio y más lento al final
            // Esto hace que el progreso sea más realista visualmente
            const linearProgress = Math.min(0.99, (elapsed / estimatedDuration));
            // Aplicar curva logarítmica suave para que el progreso no se estanque
            const estimatedProgress = Math.min(99, linearProgress * 100);
            
            if (showLogCallback && Date.now() - lastUpdate > 500) {
              const statusText = retryCount > 0 ? `Transcribiendo (reintento ${retryCount})` : 'Transcribiendo';
              showLogCallback('🎤', videoNumber, totalVideos, videoId, statusText, estimatedProgress, elapsed);
              lastUpdate = Date.now();
              lastElapsed = elapsed;
            }
          }, 500);
          
          transcription = await Promise.race([
            openai.audio.transcriptions.create({
              file: file,
              model: 'whisper-1',
              response_format: 'verbose_json',
              language: 'es', // Español
              timestamp_granularities: ['segment'],
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout: La transcripción tardó más de 5 minutos')), 300000)
            )
          ]);
          
          // Éxito: salir del bucle de reintentos
          break;
        } catch (apiError) {
          // Limpiar intervalo de progreso
          if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
          }
          
          // Si es un error de conexión y aún tenemos reintentos disponibles
          if (isConnectionError(apiError) && retryCount < maxRetries) {
            retryCount++;
            const delay = Math.min(5000 * retryCount, 15000); // Backoff exponencial: 5s, 10s, 15s
            
            if (showLogCallback) {
              showLogCallback('🎤', videoNumber, totalVideos, videoId, `Error de conexión. Reintentando en ${delay/1000}s... (${retryCount}/${maxRetries})`, null, null);
            }
            
            // Esperar antes de reintentar
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Reiniciar el tiempo de inicio para el nuevo intento
            startTime = Date.now();
            lastUpdate = Date.now();
            continue; // Reintentar
          }
          
          // Si no es un error de conexión o se agotaron los reintentos, lanzar el error
          // Mejorar mensajes de error
          if (isConnectionError(apiError)) {
            throw new Error('Error de conexión con la API de OpenAI después de varios intentos. Verifica tu conexión a internet y que la API key sea válida.');
          } else if (apiError.message.includes('401') || apiError.message.includes('Unauthorized')) {
            throw new Error('API key de OpenAI inválida. Verifica tu OPENAI_API_KEY en el archivo .env');
          } else if (apiError.message.includes('429') || apiError.message.includes('rate limit')) {
            throw new Error('Límite de tasa excedido. Espera un momento antes de intentar de nuevo.');
          } else if (apiError.message.includes('413') || apiError.message.includes('too large')) {
            throw new Error('El archivo de audio es demasiado grande para la API de Whisper.');
          } else {
            throw new Error(`Error en la API de OpenAI: ${apiError.message}`);
          }
        }
      }
      
      // Limpiar intervalo de progreso si aún está activo
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      
      const elapsed = (Date.now() - startTime) / 1000;
      if (showLogCallback) {
        showLogCallback('🎤', videoNumber, totalVideos, videoId, 'Transcribiendo', 100, elapsed);
      }
    } catch (apiError) {
      
      // Limpiar archivo comprimido si existe y hay error
      // if (compressedAudioPath && existsSync(compressedAudioPath)) {
      //   try {
      //     unlinkSync(compressedAudioPath);
      //   } catch (e) {
      //     // Ignorar errores de limpieza
      //   }
      // }
      
      // Re-lanzar el error (ya fue procesado en el bloque anterior)
      throw apiError;
    }

    // Generar formato SRT
    const srt = generateSRT(transcription.segments || []);

    // Identificar speakers (si está disponible)
    const speakers = identifySpeakers(transcription.segments || []);

    // Limpiar archivo comprimido temporal después de la transcripción exitosa
    // if (compressedAudioPath && existsSync(compressedAudioPath)) {
    //   try {
    //     unlinkSync(compressedAudioPath);
    //     console.log('   🗑️  Archivo comprimido temporal eliminado');
    //   } catch (e) {
    //     // Ignorar errores de limpieza
    //   }
    // }

    return {
      transcription: transcription.text,
      srt,
      segments: transcription.segments || [],
      speakers,
    };
  } catch (error) {
    // Limpiar archivo comprimido si hay error
    // if (compressedAudioPath && existsSync(compressedAudioPath)) {
    //   try {
    //     unlinkSync(compressedAudioPath);
    //   } catch (e) {
    //     // Ignorar errores de limpieza
    //   }
    // }
    // Si el error ya tiene un mensaje descriptivo, usarlo; si no, agregar contexto
    if (error.message.includes('Error en transcripción') || error.message.includes('Error en la API')) {
      throw error;
    }
    throw new Error(`Error en transcripción: ${error.message}`);
  }
}

/**
 * Genera formato SRT a partir de segmentos
 * @param {Array} segments - Segmentos de la transcripción
 * @returns {string} - Contenido SRT
 */
function generateSRT(segments) {
  let srt = '';
  
  segments.forEach((segment, index) => {
    const startTime = formatSRTTime(segment.start);
    const endTime = formatSRTTime(segment.end);
    
    srt += `${index + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${segment.text.trim()}\n\n`;
  });
  
  return srt;
}

/**
 * Formatea tiempo en formato SRT (HH:MM:SS,mmm)
 * @param {number} seconds - Tiempo en segundos
 * @returns {string} - Tiempo formateado
 */
function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

/**
 * Identifica speakers en la transcripción
 * Nota: Whisper no identifica speakers directamente, pero podemos inferir
 * basándonos en patrones de diálogo
 * @param {Array} segments - Segmentos de la transcripción
 * @returns {Array<string>} - Lista de speakers identificados
 */
function identifySpeakers(segments) {
  // Whisper no tiene identificación de speakers nativa
  // Por ahora retornamos un array genérico
  // En el futuro se podría usar diarización de audio
  const speakers = new Set();
  
  // Intentar identificar por patrones comunes
  segments.forEach(segment => {
    const text = segment.text.toLowerCase();
    
    // Patrones que indican conductor/locutor
    if (text.includes('bienvenido') || text.includes('hola') || 
        text.includes('cuéntame') || text.includes('dime')) {
      speakers.add('Conductor');
    }
    
    // Si no hay patrones claros, asumir dos speakers
    if (speakers.size === 0) {
      speakers.add('Speaker 1');
      speakers.add('Speaker 2');
    }
  });
  
  return Array.from(speakers).length > 0 
    ? Array.from(speakers) 
    : ['Conductor', 'Llamante'];
}
