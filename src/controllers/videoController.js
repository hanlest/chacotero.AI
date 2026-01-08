import { v4 as uuidv4 } from 'uuid';
import { downloadAudio, extractVideoId, getPlaylistVideos, getThumbnailUrl } from '../services/youtubeService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { separateCalls } from '../services/callSeparationService.js';
// import { generateMetadata } from '../services/metadataService.js'; // Ya no se usa, los metadatos vienen de la separación de llamadas
import { saveAudioFile, saveTranscriptionFile, saveMinTranscriptionFile, saveMetadataFile, generateMinSRT, downloadThumbnail, sanitizeFilename } from '../services/fileService.js';
import { findCallsByVideoId, isVideoProcessed } from '../services/videoIndexService.js';
import { isVideoBlacklisted } from '../services/blacklistService.js';
import { extractAudioSegment, readAudioFile } from '../utils/audioUtils.js';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import config from '../config/config.js';

/**
 * Gestor de líneas de consola para múltiples videos en paralelo
 * Cada video tiene su propia línea fija que se actualiza en el mismo lugar
 */
class ConsoleLineManager {
  constructor() {
    this.videoBuffers = new Map(); // Map<videoId, string> - Último log de cada video
    this.videoNumbers = new Map(); // Map<videoId, number> - Número del video
    this.videoLineIndex = new Map(); // Map<videoId, number> - Índice de línea absoluto (0-based)
    this.completedVideos = new Set(); // Set de videoIds que han completado su procesamiento
    this.allVideoIds = []; // Array de todos los videoIds en orden de aparición (completados primero, luego activos)
    this.totalLineCount = 0; // Número total de líneas (completados + activos)
  }

  /**
   * Agrega un video activo al final de la lista
   * @param {string} videoId - ID del video
   */
  addActiveVideo(videoId) {
    // Si el video ya está en la lista, no hacer nada
    if (this.allVideoIds.includes(videoId)) {
      return;
    }
    
    // Agregar al final de la lista
    this.allVideoIds.push(videoId);
    this.totalLineCount = this.allVideoIds.length;
    
    // Asignar índice de línea (será el último)
    this.videoLineIndex.set(videoId, this.totalLineCount - 1);
    
    // Inicializar buffer si no existe
    if (!this.videoBuffers.has(videoId)) {
      this.videoBuffers.set(videoId, '');
    }
    
    // Escribir la nueva línea al final (agregar nueva línea en la consola)
    if (typeof process !== 'undefined' && process.stdout) {
      const logText = this.videoBuffers.get(videoId) || '';
      process.stdout.write(logText + '\n');
    }
  }

  /**
   * Marca un video como completado (mantiene su línea visible)
   * @param {string} videoId - ID del video
   */
  markVideoCompleted(videoId) {
    this.completedVideos.add(videoId);
    // El video mantiene su línea, no se elimina
  }

  /**
   * Actualiza el log de un video específico
   * @param {string} videoId - ID del video
   * @param {number} videoNumber - Número del video (1-based)
   * @param {string} logText - Texto del log
   */
  updateVideoLog(videoId, videoNumber, logText) {
    this.videoBuffers.set(videoId, logText);
    this.videoNumbers.set(videoId, videoNumber);
  }

  /**
   * Escribe el log de un video específico en su línea asignada
   * @param {string} videoId - ID del video
   * @param {number} lineIndex - Índice de línea donde escribir (0-based), opcional
   */
  writeVideoLine(videoId, lineIndex = null) {
    if (typeof process !== 'undefined' && process.stdout) {
      // Usar el lineIndex proporcionado, o obtenerlo del videoLineIndex si no se proporciona
      const finalLineIndex = lineIndex !== null && lineIndex !== undefined 
        ? lineIndex 
        : (this.videoLineIndex.get(videoId) ?? this.totalLineCount - 1);
      
      // Si el índice es inválido, no hacer nada
      if (finalLineIndex < 0 || finalLineIndex >= this.totalLineCount) {
        return;
      }
      
      // Calcular cuántas líneas desde el final (donde debería estar el cursor)
      // El cursor debería estar después de todas las líneas
      const linesFromBottom = this.totalLineCount - finalLineIndex;
      
      // Mover hacia arriba desde donde está el cursor (después de todas las líneas)
      // hasta la línea del video que queremos actualizar
      if (linesFromBottom > 0) {
        process.stdout.write(`\x1b[${linesFromBottom}A`);
      }
      
      // Ir al inicio de la línea, limpiar hasta el final de la línea, y escribir
      const logText = this.videoBuffers.get(videoId) || '';
      // Limpiar la línea completa antes de escribir (secuencia ANSI: \x1b[K limpia desde el cursor hasta el final)
      process.stdout.write('\r\x1b[K' + logText);
      
      // Volver a la posición después de todas las líneas
      if (linesFromBottom > 0) {
        process.stdout.write(`\x1b[${linesFromBottom}B`);
      }
    }
  }

  /**
   * Renderiza todas las líneas (completadas y activas)
   */
  renderAll() {
    if (typeof process !== 'undefined' && process.stdout) {
      // Renderizar todas las líneas en orden
      for (let i = 0; i < this.allVideoIds.length; i++) {
        const videoId = this.allVideoIds[i];
        const logText = this.videoBuffers.get(videoId) || '';
        process.stdout.write(logText + '\n');
      }
    }
  }
}

// Instancia global del gestor de líneas
const lineManager = new ConsoleLineManager();

/**
 * Función para mostrar log en formato unificado
 * @param {string} icon - Icono del estado
 * @param {number} current - Número actual
 * @param {number} total - Total
 * @param {string} videoId - ID del video
 * @param {string} processText - Proceso actual
 * @param {number} percent - Porcentaje (0-100)
 * @param {number} elapsedTime - Tiempo transcurrido en segundos
 * @param {number} lineIndex - Índice de línea asignada para el logueo (0-based)
 */
function showLog(icon, current, total, videoId, processText, percent = null, elapsedTime = null, lineIndex = null) {
  // Formatear el número del video con ceros a la izquierda para que tenga el mismo ancho que el total
  const totalDigits = total.toString().length;
  const currentPadded = current.toString().padStart(totalDigits, '0');
  const currentStr = `[${currentPadded}/${total}]`;
  const processStr = percent !== null ? `${processText} ${percent.toFixed(1)}%` : processText;
  const timeStr = elapsedTime !== null ? `${elapsedTime.toFixed(1)}s` : '';
  
  // Detectar si es un proceso completado o ya procesado para aplicar color verde
  const isCompleted = processText.includes('Completado') || processText.includes('Ya procesado');
  // Detectar si es un error para aplicar color rojo
  const isError = processText.includes('Error:') || 
                  processText.includes('Requiere verificación') ||
                  processText.includes('Bloqueado por YouTube') ||
                  processText.includes('autenticación') ||
                  processText.includes('verificación de edad') ||
                  processText.includes('Omitido');
  
  const greenColor = '\x1b[32m'; // ANSI code para verde
  const redColor = '\x1b[31m';   // ANSI code para rojo
  const resetColor = '\x1b[0m';   // ANSI code para resetear color
  
  // Sin índice de línea ni icono al principio
  let logLine;
  if (isCompleted) {
    logLine = `${greenColor}${currentStr} ${videoId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
  } else if (isError) {
    logLine = `${redColor}${currentStr} ${videoId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
  } else {
    logLine = `${currentStr} ${videoId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}`;
  }
  
  // Actualizar el buffer del video
  lineManager.updateVideoLog(videoId, current, logLine);
  // Escribir directamente en la línea asignada del video (usa el índice almacenado)
  lineManager.writeVideoLine(videoId, lineIndex);
}

/**
 * Función interna que procesa un video individual
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @returns {Promise<{videoId: string, processed: boolean, message?: string, calls: Array}>}
 */
async function processSingleVideo(youtubeUrl, videoNumber = 1, totalVideos = 1) {
  const startTime = Date.now();
  let videoId = null;
  
  try {
    if (!youtubeUrl) {
      throw new Error('youtubeUrl es requerido');
    }

    // Extraer videoId
    videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      throw new Error('URL de YouTube no válida');
    }

    // Verificar si el video está en la lista negra
    const isBlacklisted = await isVideoBlacklisted(videoId);
    if (isBlacklisted) {
      showLog('🚫', videoNumber, totalVideos, videoId, 'En lista negra - Saltado', null, null);
      return {
        youtubeUrl,
        videoId,
        processed: false,
        skipped: true,
        reason: 'blacklisted',
        message: 'Video en lista negra',
      };
    }

    // Verificar si el video ya fue procesado
    const alreadyProcessed = await isVideoProcessed(videoId);
    
    if (alreadyProcessed) {
      showLog('⏭️', videoNumber, totalVideos, videoId, 'Verificando...', null, null);
      
      const existingCalls = await findCallsByVideoId(videoId);
      const { writeFile, readFile } = await import('fs/promises');
      
      let thumbnailsChecked = 0;
      let thumbnailsDownloaded = 0;
      let thumbnailsSkipped = 0;
      let needsThumbnailUrl = false;
      
      // PRIMERO: Verificar rápidamente todas las miniaturas sin ejecutar yt-dlp
      for (const call of existingCalls) {
        const callFileName = call.fileName || call.callId;
        const thumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
        const thumbnailExists = existsSync(thumbnailPath);
        const hasThumbnailUrl = call.thumbnailUrl;
        
        // Si la miniatura existe Y ya tiene thumbnailUrl, saltar
        if (thumbnailExists && hasThumbnailUrl) {
          thumbnailsSkipped++;
          continue;
        }
        
        // Si falta miniatura o thumbnailUrl, necesitamos obtener la URL
        if (!thumbnailExists || !hasThumbnailUrl) {
          needsThumbnailUrl = true;
          thumbnailsChecked++;
        }
      }
      
      // SOLO si necesitamos descargar o actualizar, obtener la URL (ejecutar yt-dlp)
      let thumbnailUrl = null;
      if (needsThumbnailUrl) {
        showLog('🖼️', videoNumber, totalVideos, videoId, 'Obteniendo miniatura...', null, null);
        thumbnailUrl = await getThumbnailUrl(videoId);
      }
      
      // SEGUNDO: Procesar solo las que necesitan descarga o actualización
      if (thumbnailUrl) {
        for (const call of existingCalls) {
          let callFileName = call.fileName || call.callId;
          const thumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
          const thumbnailExists = existsSync(thumbnailPath);
          const hasThumbnailUrl = call.thumbnailUrl;
          
          // Si ya está todo completo, saltar
          if (thumbnailExists && hasThumbnailUrl) {
            continue;
          }
          
          // Leer metadata solo si es necesario
          let metadata = null;
          if (!call.fileName || !call.thumbnailUrl) {
            try {
              if (call.metadataFile) {
                const metadataContent = await readFile(call.metadataFile, 'utf-8');
                metadata = JSON.parse(metadataContent);
                callFileName = metadata.fileName || callFileName;
              }
            } catch (error) {
              // Ignorar errores
            }
          }
          
          // Descargar miniatura si no existe
          if (!thumbnailExists) {
            try {
              const finalThumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
              await downloadThumbnail(thumbnailUrl, finalThumbnailPath);
              thumbnailsDownloaded++;
            } catch (error) {
              console.warn(`   ⚠️  No se pudo descargar la miniatura para ${callFileName}: ${error.message}`);
            }
          }
          
          // Actualizar metadatos si falta thumbnailUrl
          if (!hasThumbnailUrl && call.metadataFile) {
            try {
              if (!metadata) {
                const metadataContent = await readFile(call.metadataFile, 'utf-8');
                metadata = JSON.parse(metadataContent);
              }
              if (!metadata.thumbnailUrl) {
                metadata.thumbnailUrl = thumbnailUrl;
                await writeFile(call.metadataFile, JSON.stringify(metadata, null, 2), 'utf-8');
              }
            } catch (error) {
              // Ignorar errores
            }
          }
        }
      }
      
      const elapsedTime = (Date.now() - startTime) / 1000;
      showLog('⏭️', videoNumber, totalVideos, videoId, `Ya procesado (${existingCalls.length} llamadas)`, null, elapsedTime);
      process.stdout.write('\n');
      
      return {
        videoId,
        processed: false,
        message: 'Video ya procesado anteriormente',
        calls: existingCalls.map((call) => ({
          callId: call.callId,
          youtubeVideoId: call.youtubeVideoId,
          title: call.title,
          description: call.description,
          theme: call.theme,
          tags: call.tags,
          date: call.date,
          speakers: call.speakers,
          thumbnailUrl: call.thumbnailUrl || thumbnailUrl,
          audioFile: call.audioFile,
          transcriptionFile: call.transcriptionFile,
          thumbnailFile: existsSync(join(config.storage.callsPath, `${call.fileName || call.callId}.jpg`)) 
            ? join(config.storage.callsPath, `${call.fileName || call.callId}.jpg`) 
            : null,
          metadataFile: call.metadataFile,
        })),
      };
    }

    // Configurar callbacks de log en servicios
    const { setLogCallback: setYoutubeLogCallback } = await import('../services/youtubeService.js');
    const { setLogCallback: setTranscriptionLogCallback } = await import('../services/transcriptionService.js');
    
    setYoutubeLogCallback(showLog);
    setTranscriptionLogCallback(showLog);
    
    // Procesar el video
    // El progreso de descarga se mostrará automáticamente desde youtubeService
    const { audioPath, title: videoTitle, uploadDate } = await downloadAudio(youtubeUrl, videoNumber, totalVideos, videoId);
    
    showLog('🖼️', videoNumber, totalVideos, videoId, 'Obteniendo miniatura...', null, null);
    const thumbnailUrl = await getThumbnailUrl(videoId);

    // 2. Transcribir (verificar si ya existe)
    const transcriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
    
    let transcription, srt, segments, speakers;
    
    if (existsSync(transcriptionPath)) {
      showLog('📄', videoNumber, totalVideos, videoId, 'Cargando transcripción...', null, null);
      // Cargar transcripción existente
      const { readFile } = await import('fs/promises');
      srt = await readFile(transcriptionPath, 'utf-8');
      
      // Reconstruir segments desde el SRT
      segments = parseSRTToSegments(srt);
      
      // Generar transcripción simplificada en memoria (no guardar archivo)
      transcription = generateMinSRT(srt);
      
      speakers = ['Conductor', 'Llamante']; // Valores por defecto
    } else {
      showLog('🎤', videoNumber, totalVideos, videoId, 'Transcribiendo...', null, null);
      const result = await transcribeAudio(audioPath, videoNumber, totalVideos, videoId);
      transcription = result.transcription;
      srt = result.srt;
      segments = result.segments;
      speakers = result.speakers;
      
      // Guardar transcripción del video completo en temp (solo SRT, no _min.txt)
      const { writeFile } = await import('fs/promises');
      await writeFile(transcriptionPath, srt, 'utf-8');
    }

    // 3. Separar llamadas
    const separatedCalls = await separateCalls(segments, srt, videoNumber, totalVideos, videoId);

    // 4. Procesar cada llamada
    const processedCalls = [];
    const totalCalls = separatedCalls.length;

    for (let i = 0; i < separatedCalls.length; i++) {
      const call = separatedCalls[i];
      const callNumber = i + 1;
      const callPercent = (callNumber / totalCalls) * 100;
      
      try {
        showLog('✂️', videoNumber, totalVideos, videoId, `Recortando llamada ${callNumber}/${totalCalls}`, callPercent, null);
        // Usar los metadatos de la primera llamada a la IA (separación de llamadas)
        // La IA ya proporciona: name, age, title, topic, tags, summary
        // Completar solo los campos que faltan: description, theme (de topic), date, speakers
        const metadata = {
          title: call.title || 'Llamada sin título',
          description: call.description || 'Sin descripción disponible', // Descripción breve (2-3 oraciones)
          theme: call.topic || 'General',
          tags: call.tags || [],
          date: uploadDate || new Date().toISOString().split('T')[0],
          name: call.name || null,
          age: call.age || null,
          summary: call.summary || null, // Resumen detallado con todos los puntos (para búsqueda)
          youtubeVideoId: videoId,
          youtubeUrl: youtubeUrl, // URL completa del video original
          speakers: speakers.length > 0 ? speakers : ['Conductor', 'Llamante'],
        };

        // Generar nombre de archivo con formato: [idVideo] - [numero] - [titulo]
        const fileName = `${videoId} - ${callNumber} - ${metadata.title}`;
        const sanitizedFileName = sanitizeFilename(fileName);

        // Extraer segmento de audio directamente a calls (archivo final)
        const callAudioPath = join(config.storage.callsPath, `${sanitizedFileName}.mp3`);
        
        await extractAudioSegment(audioPath, call.start, call.end, callAudioPath, videoNumber, totalVideos, videoId, callNumber, totalCalls);

        // Leer audio como buffer
        const audioBuffer = await readAudioFile(callAudioPath);

        // Generar SRT para esta llamada
        const callSegments = segments.filter(
          (seg) => seg.start >= call.start && seg.end <= call.end
        );
        const callSRT = generateCallSRT(callSegments, call.start);

        // Verificar y descargar miniatura si no existe
        const thumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}.jpg`);
        let finalThumbnailUrl = thumbnailUrl;
        
        if (thumbnailUrl && !existsSync(thumbnailPath)) {
          try {
            await downloadThumbnail(thumbnailUrl, thumbnailPath);
          } catch (error) {
            // Continuar sin miniatura, pero mantener la URL en los metadatos
          }
        }

        // Guardar archivos con el nuevo formato de nombre (usar nombre sanitizado)
        // El audio ya está guardado en callsPath por extractAudioSegment, solo guardar transcripción y metadata
        const savedAudioPath = callAudioPath; // Ya está guardado en callsPath
        const savedTranscriptionPath = await saveTranscriptionFile(sanitizedFileName, callSRT);
        
        const fullMetadata = {
          callId: uuidv4(), // Mantener callId interno para referencias
          callNumber,
          fileName: sanitizedFileName, // Nombre del archivo (sanitizado, usado para guardar archivos)
          thumbnailUrl: finalThumbnailUrl, // URL de la miniatura de YouTube
          ...metadata,
        };
        const savedMetadataPath = await saveMetadataFile(sanitizedFileName, fullMetadata);

        processedCalls.push({
          callId: fullMetadata.callId,
          callNumber,
          fileName: sanitizedFileName,
          youtubeVideoId: videoId,
          youtubeUrl: youtubeUrl,
          title: metadata.title,
          description: metadata.description,
          theme: metadata.theme,
          tags: metadata.tags,
          date: metadata.date,
          name: metadata.name,
          age: metadata.age,
          summary: metadata.summary,
          speakers: metadata.speakers,
          thumbnailUrl: finalThumbnailUrl,
          audioFile: savedAudioPath,
          transcriptionFile: savedTranscriptionPath,
          thumbnailFile: existsSync(thumbnailPath) ? thumbnailPath : null,
          metadataFile: savedMetadataPath,
        });

      } catch (error) {
        // Continuar con la siguiente llamada
      }
    }

    // Eliminar archivos temporales del video completo después de procesar todas las llamadas
    try {
      const originalAudioPath = join(config.storage.tempPath, `${videoId}.mp3`);
      const originalAudioMinPath = join(config.storage.tempPath, `${videoId}_min.mp3`);
      const originalAudioMin2Path = join(config.storage.tempPath, `${videoId}_min2.mp3`);
      const originalTranscriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
      
        if (existsSync(originalAudioPath)) {
          await unlink(originalAudioPath);
        }
        
        if (existsSync(originalAudioMinPath)) {
          await unlink(originalAudioMinPath);
        }
        
        if (existsSync(originalAudioMin2Path)) {
          await unlink(originalAudioMin2Path);
        }
        
        if (existsSync(originalTranscriptionPath)) {
          await unlink(originalTranscriptionPath);
        }
    } catch (error) {
      console.warn('⚠️  Error al eliminar archivos temporales:', error.message);
      // Continuar aunque falle la eliminación
    }

    const elapsedTime = (Date.now() - startTime) / 1000;
    showLog('✅', videoNumber, totalVideos, videoId, `Completado (${processedCalls.length} llamadas)`, null, elapsedTime);
    
    return {
      videoId,
      processed: true,
      calls: processedCalls,
    };
  } catch (error) {
    const elapsedTime = (Date.now() - startTime) / 1000;
    // Asegurar que videoId esté definido para el log
    const videoIdForLog = videoId || extractVideoId(youtubeUrl) || 'N/A';
    
    // Detectar tipo de error para mostrar mensaje corto
    const errorMessage = error.message || '';
    let shortErrorMessage = errorMessage;
    
    if (errorMessage.includes('Sign in to confirm your age') || 
        errorMessage.includes('inappropriate for some users') ||
        errorMessage.includes('autenticación') ||
        errorMessage.includes('verificación de edad') ||
        errorMessage.includes('cookies')) {
      shortErrorMessage = 'Requiere verificación de edad';
    } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      shortErrorMessage = 'Bloqueado por YouTube (403)';
    } else if (errorMessage.length > 50) {
      // Acortar el mensaje de error si es muy largo
      shortErrorMessage = errorMessage.substring(0, 47) + '...';
    }
    
    // Mostrar mensaje corto en el log
    showLog('❌', videoNumber, totalVideos, videoIdForLog, shortErrorMessage, null, elapsedTime);
    
    // Lanzar error con más detalles (para el manejo interno, pero no se muestra en consola)
    const enhancedError = new Error(`Error al procesar video: ${error.message}\nStack: ${error.stack}\nVideoId: ${videoIdForLog}\nURL: ${youtubeUrl}`);
    enhancedError.originalError = error;
    enhancedError.videoId = videoIdForLog;
    enhancedError.youtubeUrl = youtubeUrl;
    throw enhancedError;
  }
}

/**
 * Procesa un video de YouTube y extrae las llamadas
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function processVideo(req, res) {
  try {
    const { youtubeUrl, youtubeUrls } = req.body;

    // Normalizar: convertir youtubeUrl (string) a array si es necesario (retrocompatibilidad)
    // Pero priorizar youtubeUrls si está presente
    let urls = [];
    if (youtubeUrls) {
      // Si viene youtubeUrls, usarlo (puede ser array con uno o más elementos)
      urls = Array.isArray(youtubeUrls) ? youtubeUrls : [youtubeUrls];
    } else if (youtubeUrl) {
      // Retrocompatibilidad: convertir string a array
      urls = [youtubeUrl];
    }

    if (urls.length === 0) {
      return res.status(400).json({
        error: 'youtubeUrls (array) es requerido. Para un solo video, usar: {"youtubeUrls": ["url"]}',
      });
    }

    // Procesar videos en paralelo con límite de concurrencia
    const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_VIDEOS || '3', 10);
    
    // Limpiar la consola antes de comenzar
    if (typeof process !== 'undefined' && process.stdout) {
      process.stdout.write('\x1b[2J\x1b[0f'); // Limpiar pantalla y mover cursor al inicio
    }
    
    console.log('');
    console.log('================================');
    console.log(`Procesando ${urls.length} video(s) de YouTube`);
    console.log(`Procesamiento en paralelo: ${Math.min(maxConcurrency, urls.length)} video(s) simultáneo(s)`);
    console.log('================================');
    console.log('');

    const results = [];
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Función para procesar un video con su índice
    const processVideoWithIndex = async (url, index) => {
      const videoNumber = index + 1;
      const videoId = extractVideoId(url) || 'N/A';

      try {
        // Verificar si el video está en la lista negra
        const isBlacklisted = await isVideoBlacklisted(videoId);
        if (isBlacklisted) {
          const totalDigits = urls.length.toString().length;
          const currentPadded = videoNumber.toString().padStart(totalDigits, '0');
          const greenColor = '\x1b[32m'; // ANSI code para verde
          const resetColor = '\x1b[0m';   // ANSI code para resetear color
          const logLine = `${greenColor}[${currentPadded}/${urls.length}] ${videoId} | 🚫 En lista negra - Saltado${resetColor}`;
          lineManager.updateVideoLog(videoId, videoNumber, logLine);
          lineManager.writeVideoLine(videoId);
          return {
            youtubeUrl: url,
            index,
            processed: false,
            skipped: true,
            reason: 'blacklisted',
            message: 'Video en lista negra',
          };
        }

        // Configurar callbacks de log
        const { setLogCallback: setYoutubeLogCallback } = await import('../services/youtubeService.js');
        const { setLogCallback: setTranscriptionLogCallback } = await import('../services/transcriptionService.js');
        const { setLogCallback: setAudioLogCallback } = await import('../utils/audioUtils.js');
        const { setLogCallback: setCallSeparationLogCallback } = await import('../services/callSeparationService.js');
        
        // Función local para mostrar logs (usa el mismo gestor de líneas)
        const showLogLocal = (icon, current, total, vidId, processText, percent = null, elapsedTime = null, lineIndex = null) => {
          // Formatear el número del video con ceros a la izquierda para que tenga el mismo ancho que el total
          const totalDigits = total.toString().length;
          const currentPadded = current.toString().padStart(totalDigits, '0');
          const currentStr = `[${currentPadded}/${total}]`;
          const processStr = percent !== null ? `${processText} ${percent.toFixed(1)}%` : processText;
          const timeStr = elapsedTime !== null ? `${elapsedTime.toFixed(1)}s` : '';
          
          // Detectar si es un proceso completado o ya procesado para aplicar color verde
          const isCompleted = processText.includes('Completado') || processText.includes('Ya procesado');
          // Detectar si es un error para aplicar color rojo
          const isError = processText.includes('Error:') || 
                          processText.includes('Requiere verificación') ||
                          processText.includes('Bloqueado por YouTube') ||
                          processText.includes('autenticación') ||
                          processText.includes('verificación de edad') ||
                          processText.includes('Omitido');
          
          const greenColor = '\x1b[32m'; // ANSI code para verde
          const redColor = '\x1b[31m';   // ANSI code para rojo
          const resetColor = '\x1b[0m';   // ANSI code para resetear color
          
          // Sin índice de línea ni icono al principio
          let logLine;
          if (isCompleted) {
            logLine = `${greenColor}${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
          } else if (isError) {
            logLine = `${redColor}${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
          } else {
            logLine = `${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}`;
          }
          
          // Actualizar el buffer del video
          lineManager.updateVideoLog(vidId, current, logLine);
          // Escribir directamente en la línea asignada del video (usa el índice almacenado)
          lineManager.writeVideoLine(vidId, lineIndex);
        };
        
        setYoutubeLogCallback(showLogLocal);
        setTranscriptionLogCallback(showLogLocal);
        setAudioLogCallback(showLogLocal);
        setCallSeparationLogCallback(showLogLocal);
        
        const result = await processSingleVideo(url, videoNumber, urls.length);
        
        return {
          youtubeUrl: url,
          index,
          ...result,
        };
      } catch (error) {
        return {
          youtubeUrl: url,
          index,
          processed: false,
          error: error.message,
        };
      }
    };

    // Procesar con pool continuo: cuando un proceso termina, se inicia el siguiente
    // Pero usar chunks para el renderizado (solo mostrar los videos activos)
    const resultMap = new Map(); // Map<index, result>
    let nextIndex = 0;
    const activePromises = new Set();
    let completedCount = 0;
    const activeVideoIds = new Set(); // IDs de videos que están siendo procesados actualmente
    
    // Función para iniciar el siguiente proceso
    const startNext = () => {
      if (nextIndex >= urls.length) return null;
      
      const currentIndex = nextIndex++;
      const url = urls[currentIndex];
      const videoId = extractVideoId(url) || 'N/A';
      
      // Agregar a videos activos y agregar al lineManager
      activeVideoIds.add(videoId);
      lineManager.addActiveVideo(videoId);
      
      const promise = processVideoWithIndex(url, currentIndex)
        .then(result => {
          resultMap.set(currentIndex, result);
          activePromises.delete(promise);
          activeVideoIds.delete(videoId);
          completedCount++;
          
          // Marcar como completado (mantiene su línea visible)
          lineManager.markVideoCompleted(videoId);
          
          // Si está en lista negra, ya se mostró el log, solo continuar
          
          // Iniciar el siguiente proceso
          const nextPromise = startNext();
          if (nextPromise) {
            activePromises.add(nextPromise);
          }
          
          return result;
        })
        .catch(error => {
          activePromises.delete(promise);
          activeVideoIds.delete(videoId);
          resultMap.set(currentIndex, {
            youtubeUrl: url,
            index: currentIndex,
            processed: false,
            error: error.message,
          });
          completedCount++;
          
          // Marcar como completado (mantiene su línea visible)
          lineManager.markVideoCompleted(videoId);
          
          // Iniciar el siguiente proceso incluso si hay error
          const nextPromise = startNext();
          if (nextPromise) {
            activePromises.add(nextPromise);
          }
          
          return null;
        });
      
      activePromises.add(promise);
      return promise;
    };
    
    // Iniciar los primeros N procesos
    for (let i = 0; i < Math.min(maxConcurrency, urls.length); i++) {
      startNext();
    }
    
    // Esperar a que todos los procesos terminen
    // Usar un loop que espera hasta que todos estén completos
    while (completedCount < urls.length) {
      if (activePromises.size > 0) {
        await Promise.race(Array.from(activePromises));
      } else {
        // Si no hay promesas activas pero aún faltan por completar, esperar un poco
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Procesar resultados en orden
    for (let i = 0; i < urls.length; i++) {
      const result = resultMap.get(i);
      if (result) {
        results.push(result);
        
        if (result.processed === true) {
          processedCount++;
        } else if (result.processed === false && result.error) {
          errorCount++;
        } else {
          skippedCount++;
        }
      }
    }

    console.log('');
    console.log('================================');
    console.log('✅ Procesamiento completado');
    console.log('================================');
    console.log(`📊 Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total: ${urls.length}`);
    console.log('');

    return res.json({
      totalVideos: urls.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      results,
    });
  } catch (error) {
    console.error('Error al procesar video(s):', error);
    return res.status(500).json({
      error: 'Error al procesar el video(s)',
      message: error.message,
    });
  }
}

/**
 * Procesa una playlist de YouTube y extrae las llamadas de cada video
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function processPlaylist(req, res) {
  try {
    const { playlistUrl, playlistUrls } = req.body;

    // Soporte para array de URLs o URL única (retrocompatibilidad)
    const urls = playlistUrls || (playlistUrl ? [playlistUrl] : []);

    if (!urls || urls.length === 0) {
      return res.status(400).json({
        error: 'playlistUrl o playlistUrls es requerido',
      });
    }

    // Si es una sola playlist, mantener el formato de respuesta original
    if (urls.length === 1) {
      return await processSinglePlaylist(urls[0], res);
    }

    // Procesar múltiples playlists en secuencia
    console.log('');
    console.log('================================');
    console.log(`Procesando ${urls.length} playlist(s) de YouTube`);
    console.log('================================');
    console.log('');

    const allResults = [];
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalVideos = 0;

    for (let i = 0; i < urls.length; i++) {
      const playlistUrl = urls[i];
      const playlistNumber = i + 1;

      console.log('');
      console.log('================================');
      console.log(`Playlist ${playlistNumber}/${urls.length}`);
      console.log('================================');
      console.log('');

      try {
        const result = await processSinglePlaylist(playlistUrl, null);
        allResults.push({
          playlistUrl,
          ...result,
        });
        
        totalProcessed += result.processed || 0;
        totalSkipped += result.skipped || 0;
        totalErrors += result.errors || 0;
        totalVideos += result.totalVideos || 0;
      } catch (error) {
        console.error(`❌ Error al procesar playlist ${playlistNumber}:`, error.message);
        allResults.push({
          playlistUrl,
          processed: false,
          error: error.message,
        });
        totalErrors++;
      }
    }

    console.log('');
    console.log('================================');
    console.log('✅ Procesamiento de playlists completado');
    console.log('================================');
    console.log(`📊 Resumen total:`);
    console.log(`   - Playlists procesadas: ${urls.length}`);
    console.log(`   - Videos procesados: ${totalProcessed}`);
    console.log(`   - Videos omitidos: ${totalSkipped}`);
    console.log(`   - Videos con error: ${totalErrors}`);
    console.log(`   - Total de videos: ${totalVideos}`);
    console.log('');

    return res.json({
      totalPlaylists: urls.length,
      totalVideos,
      processed: totalProcessed,
      skipped: totalSkipped,
      errors: totalErrors,
      results: allResults,
    });
  } catch (error) {
    console.error('Error al procesar playlist(s):', error);
    return res.status(500).json({
      error: 'Error al procesar la playlist(s)',
      message: error.message,
    });
  }
}

/**
 * Procesa una sola playlist de YouTube (función interna)
 * @param {string} playlistUrl - URL de la playlist de YouTube
 * @param {object} res - Response object (null si se llama internamente)
 * @returns {Promise<object>} - Resultado del procesamiento
 */
async function processSinglePlaylist(playlistUrl, res) {
  try {
    console.log('');
    console.log('================================');
    console.log('Procesando playlist de YouTube');
    console.log('================================');
    console.log('');

    // Obtener lista de videos de la playlist
    const videos = await getPlaylistVideos(playlistUrl);

    if (videos.length === 0) {
      return res.status(400).json({
        error: 'No se encontraron videos en la playlist',
      });
    }

    console.log(`📋 Total de videos en la playlist: ${videos.length}`);
    console.log('');

    const results = [];
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Procesar videos en paralelo con límite de concurrencia
    const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_VIDEOS || '3', 10);
    
    // Limpiar la consola antes de comenzar
    if (typeof process !== 'undefined' && process.stdout) {
      process.stdout.write('\x1b[2J\x1b[0f'); // Limpiar pantalla y mover cursor al inicio
    }
    
    console.log(`⚡ Procesamiento en paralelo: ${Math.min(maxConcurrency, videos.length)} video(s) simultáneo(s)`);
    console.log('');

    // Función para procesar un video con su índice
    const processVideoWithIndex = async (video, index) => {
      const videoNumber = index + 1;
      const startTime = Date.now();

      try {
        // Verificar si el video está en la lista negra
        const isBlacklisted = await isVideoBlacklisted(video.id);
        if (isBlacklisted) {
          const totalDigits = videos.length.toString().length;
          const currentPadded = videoNumber.toString().padStart(totalDigits, '0');
          const greenColor = '\x1b[32m'; // ANSI code para verde
          const resetColor = '\x1b[0m';   // ANSI code para resetear color
          const logLine = `${greenColor}[${currentPadded}/${videos.length}] ${video.id} | 🚫 En lista negra - Saltado${resetColor}`;
          lineManager.updateVideoLog(video.id, videoNumber, logLine);
          lineManager.writeVideoLine(video.id);
          return {
            video: video,
            index,
            processed: false,
            skipped: true,
            reason: 'blacklisted',
            message: 'Video en lista negra',
          };
        }

        // Verificar si el video ya fue procesado
        const alreadyProcessed = await isVideoProcessed(video.id);
        
        if (alreadyProcessed) {
          const existingCalls = await findCallsByVideoId(video.id);
          
          // Verificar y descargar miniaturas (sin logs verbosos)
          const { writeFile, readFile } = await import('fs/promises');
          
          let thumbnailsDownloaded = 0;
          let thumbnailsSkipped = 0;
          let needsThumbnailUrl = false;
          
          // PRIMERO: Verificar rápidamente todas las miniaturas sin ejecutar yt-dlp
          for (const call of existingCalls) {
            const callFileName = call.fileName || call.callId;
            const thumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
            const thumbnailExists = existsSync(thumbnailPath);
            const hasThumbnailUrl = call.thumbnailUrl;
            
            if (thumbnailExists && hasThumbnailUrl) {
              thumbnailsSkipped++;
              continue;
            }
            
            if (!thumbnailExists || !hasThumbnailUrl) {
              needsThumbnailUrl = true;
            }
          }
          
          // SOLO si necesitamos descargar o actualizar, obtener la URL
          let thumbnailUrl = null;
          if (needsThumbnailUrl) {
            thumbnailUrl = await getThumbnailUrl(video.id);
          }
          
          // SEGUNDO: Procesar solo las que necesitan descarga o actualización
          if (thumbnailUrl) {
            for (const call of existingCalls) {
              let callFileName = call.fileName || call.callId;
              const thumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
              const thumbnailExists = existsSync(thumbnailPath);
              const hasThumbnailUrl = call.thumbnailUrl;
              
              if (thumbnailExists && hasThumbnailUrl) {
                continue;
              }
              
              let metadata = null;
              if (!call.fileName || !call.thumbnailUrl) {
                try {
                  if (call.metadataFile) {
                    const metadataContent = await readFile(call.metadataFile, 'utf-8');
                    metadata = JSON.parse(metadataContent);
                    callFileName = metadata.fileName || callFileName;
                  }
                } catch (error) {
                  // Ignorar errores
                }
              }
              
              if (!thumbnailExists) {
                try {
                  const finalThumbnailPath = join(config.storage.callsPath, `${callFileName}.jpg`);
                  await downloadThumbnail(thumbnailUrl, finalThumbnailPath);
                  thumbnailsDownloaded++;
                } catch (error) {
                  // Ignorar errores silenciosamente
                }
              }
              
              if (!hasThumbnailUrl && call.metadataFile) {
                try {
                  if (!metadata) {
                    const metadataContent = await readFile(call.metadataFile, 'utf-8');
                    metadata = JSON.parse(metadataContent);
                  }
                  if (!metadata.thumbnailUrl) {
                    metadata.thumbnailUrl = thumbnailUrl;
                    await writeFile(call.metadataFile, JSON.stringify(metadata, null, 2), 'utf-8');
                  }
                } catch (error) {
                  // Ignorar errores
                }
              }
            }
          }
          
          const duration = (Date.now() - startTime) / 1000;
          const lineIndex = lineManager.videoLineIndex.get(video.id) ?? 0;
          // Formatear el número del video con ceros a la izquierda
          const totalDigits = videos.length.toString().length;
          const videoNumberPadded = videoNumber.toString().padStart(totalDigits, '0');
          // Aplicar color verde para "Ya procesado"
          const greenColor = '\x1b[32m';
          const resetColor = '\x1b[0m';
          const logLine = `${greenColor}[${videoNumberPadded}/${videos.length}] ${video.id} | Ya procesado (${existingCalls.length} llamadas) | ${duration.toFixed(1)}s${resetColor}`;
          lineManager.updateVideoLog(video.id, videoNumber, logLine);
          lineManager.writeVideoLine(video.id, lineIndex);
          
          return {
            videoId: video.id,
            videoTitle: video.title,
            index,
            processed: false,
            message: 'Video ya procesado anteriormente',
            calls: existingCalls.map((call) => {
              const callFileName = call.fileName || call.callId;
              return {
                callId: call.callId,
                youtubeVideoId: call.youtubeVideoId,
                title: call.title,
                description: call.description,
                theme: call.theme,
                tags: call.tags,
                date: call.date,
                speakers: call.speakers,
                thumbnailUrl: call.thumbnailUrl || thumbnailUrl,
                audioFile: call.audioFile,
                transcriptionFile: call.transcriptionFile,
                thumbnailFile: existsSync(join(config.storage.callsPath, `${callFileName}.jpg`)) 
                  ? join(config.storage.callsPath, `${callFileName}.jpg`) 
                  : null,
                metadataFile: call.metadataFile,
              };
            }),
          };
        }

        // Configurar callbacks de log
        const { setLogCallback: setYoutubeLogCallback } = await import('../services/youtubeService.js');
        const { setLogCallback: setTranscriptionLogCallback } = await import('../services/transcriptionService.js');
        const { setLogCallback: setAudioLogCallback } = await import('../utils/audioUtils.js');
        const { setLogCallback: setCallSeparationLogCallback } = await import('../services/callSeparationService.js');
        
        // Función local para mostrar logs (usa el mismo gestor de líneas)
        const showLogLocal = (icon, current, total, vidId, processText, percent = null, elapsedTime = null, lineIndex = null) => {
          // Formatear el número del video con ceros a la izquierda para que tenga el mismo ancho que el total
          const totalDigits = total.toString().length;
          const currentPadded = current.toString().padStart(totalDigits, '0');
          const currentStr = `[${currentPadded}/${total}]`;
          const processStr = percent !== null ? `${processText} ${percent.toFixed(1)}%` : processText;
          const timeStr = elapsedTime !== null ? `${elapsedTime.toFixed(1)}s` : '';
          
          // Detectar si es un proceso completado o ya procesado para aplicar color verde
          const isCompleted = processText.includes('Completado') || processText.includes('Ya procesado');
          // Detectar si es un error para aplicar color rojo
          const isError = processText.includes('Error:') || 
                          processText.includes('Requiere verificación') ||
                          processText.includes('Bloqueado por YouTube') ||
                          processText.includes('autenticación') ||
                          processText.includes('verificación de edad') ||
                          processText.includes('Omitido');
          
          const greenColor = '\x1b[32m'; // ANSI code para verde
          const redColor = '\x1b[31m';   // ANSI code para rojo
          const resetColor = '\x1b[0m';   // ANSI code para resetear color
          
          // Sin índice de línea ni icono al principio
          let logLine;
          if (isCompleted) {
            logLine = `${greenColor}${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
          } else if (isError) {
            logLine = `${redColor}${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}${resetColor}`;
          } else {
            logLine = `${currentStr} ${vidId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}`;
          }
          
          // Actualizar el buffer del video
          lineManager.updateVideoLog(vidId, current, logLine);
          // Escribir directamente en la línea asignada del video (usa el índice almacenado)
          lineManager.writeVideoLine(vidId, lineIndex);
        };
        
        setYoutubeLogCallback(showLogLocal);
        setTranscriptionLogCallback(showLogLocal);
        setAudioLogCallback(showLogLocal);
        setCallSeparationLogCallback(showLogLocal);
        
        // Procesar el video
        const result = await processSingleVideo(video.url, videoNumber, videos.length);
        
        return {
          videoId: video.id,
          videoTitle: video.title,
          index,
          ...result,
        };
      } catch (error) {
        // Detectar tipo de error para mensaje más claro
        let errorMessage = error.message;
        let shouldSkip = false;
        
        if (error.message.includes('autenticación') || error.message.includes('cookies') || 
            error.message.includes('Sign in to confirm your age') ||
            error.message.includes('inappropriate for some users')) {
          errorMessage = 'Video requiere autenticación (verificación de edad) - Omitido';
          shouldSkip = true;
        } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
          errorMessage = 'Video bloqueado por YouTube (403) - Omitido';
          shouldSkip = true;
        }
        
        const duration = (Date.now() - startTime) / 1000;
        const lineIndex = lineManager.videoLineIndex.get(video.id) ?? 0;
        // Formatear el número del video con ceros a la izquierda
        const totalDigits = videos.length.toString().length;
        const videoNumberPadded = videoNumber.toString().padStart(totalDigits, '0');
        // Aplicar color rojo a los errores
        const redColor = '\x1b[31m';   // ANSI code para rojo
        const resetColor = '\x1b[0m';   // ANSI code para resetear color
        const logLine = `${redColor}[${videoNumberPadded}/${videos.length}] ${video.id} | Error: ${errorMessage} | ${duration.toFixed(1)}s${resetColor}`;
        lineManager.updateVideoLog(video.id, videoNumber, logLine);
        lineManager.writeVideoLine(video.id, lineIndex);
        
        return {
          videoId: video.id,
          videoTitle: video.title,
          index,
          processed: false,
          skipped: shouldSkip,
          error: errorMessage,
        };
      }
    };

    // Procesar con pool continuo: cuando un proceso termina, se inicia el siguiente
    // Pero usar chunks para el renderizado (solo mostrar los videos activos)
    const resultMap = new Map(); // Map<index, result>
    let nextIndex = 0;
    const activePromises = new Set();
    let completedCount = 0;
    const activeVideoIds = new Set(); // IDs de videos que están siendo procesados actualmente
    
    // Función para iniciar el siguiente proceso
    const startNext = () => {
      if (nextIndex >= videos.length) return null;
      
      const currentIndex = nextIndex++;
      const video = videos[currentIndex];
      
      // Agregar a videos activos y agregar al lineManager
      activeVideoIds.add(video.id);
      lineManager.addActiveVideo(video.id);
      
      const promise = processVideoWithIndex(video, currentIndex)
        .then(result => {
          resultMap.set(currentIndex, result);
          activePromises.delete(promise);
          activeVideoIds.delete(video.id);
          completedCount++;
          
          // Marcar como completado (mantiene su línea visible)
          lineManager.markVideoCompleted(video.id);
          
          // Si está en lista negra, ya se mostró el log, solo continuar
          
          // Iniciar el siguiente proceso
          const nextPromise = startNext();
          if (nextPromise) {
            activePromises.add(nextPromise);
          }
          
          return result;
        })
        .catch(error => {
          activePromises.delete(promise);
          activeVideoIds.delete(video.id);
          resultMap.set(currentIndex, {
            video: video,
            index: currentIndex,
            processed: false,
            error: error.message || 'Error desconocido',
          });
          completedCount++;
          
          // Marcar como completado (mantiene su línea visible)
          lineManager.markVideoCompleted(video.id);
          
          // Iniciar el siguiente proceso incluso si hay error
          const nextPromise = startNext();
          if (nextPromise) {
            activePromises.add(nextPromise);
          }
          
          return null;
        });
      
      activePromises.add(promise);
      return promise;
    };
    
    // Iniciar los primeros N procesos
    for (let i = 0; i < Math.min(maxConcurrency, videos.length); i++) {
      startNext();
    }
    
    // Esperar a que todos los procesos terminen
    // Usar un loop que espera hasta que todos estén completos
    while (completedCount < videos.length) {
      if (activePromises.size > 0) {
        await Promise.race(Array.from(activePromises));
      } else {
        // Si no hay promesas activas pero aún faltan por completar, esperar un poco
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Procesar resultados en orden
    for (let i = 0; i < videos.length; i++) {
      const result = resultMap.get(i);
      if (result) {
        results.push(result);
        
        if (result.processed === true) {
          processedCount++;
        } else if (result.processed === false && result.error) {
          errorCount++;
        } else {
          skippedCount++;
        }
      }
    }

    console.log('');
    console.log('================================');
    console.log('✅ Procesamiento completado');
    console.log('================================');
    console.log(`📊 Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total: ${videos.length}`);
    console.log('');

    // Agrupar resultados por estado
    const processedVideos = results.filter(r => r.processed === true);
    const skippedByErrorVideos = results.filter(r => 
      r.processed === false && 
      r.skipped === true && 
      r.error && 
      r.message !== 'Video ya procesado anteriormente'
    );
    const errorVideos = results.filter(r => r.processed === false && !r.skipped && r.error);
    const allErrorVideos = [...skippedByErrorVideos, ...errorVideos];

    const result = {
      playlistUrl,
      totalVideos: videos.length,
      processed: processedCount,
      skipped: skippedCount,
      errors: errorCount,
      summary: {
        processed: processedVideos.map(v => ({
          videoId: v.videoId,
          videoTitle: v.videoTitle,
          callsCount: v.calls ? v.calls.length : 0,
        })),
        errors: allErrorVideos.map(v => ({
          videoId: v.videoId,
          videoTitle: v.videoTitle,
          error: v.error || 'Error desconocido',
        })),
      },
      results,
    };

    // Si se pasó res, responder con HTTP, si no, retornar el resultado
    if (res) {
      return res.json(result);
    }
    return result;
  } catch (error) {
    console.error('Error al procesar playlist:', error);
    if (res) {
      return res.status(500).json({
        error: 'Error al procesar la playlist',
        message: error.message,
      });
    }
    throw error;
  }
}

/**
 * Parsea un archivo SRT y reconstruye los segments
 * @param {string} srtContent - Contenido del archivo SRT
 * @returns {Array} - Array de segments con start, end y text
 */
function parseSRTToSegments(srtContent) {
  const segments = [];
  const lines = srtContent.split('\n');
  
  let currentSegment = null;
  let segmentText = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Número de secuencia
    if (/^\d+$/.test(line)) {
      if (currentSegment) {
        currentSegment.text = segmentText.join(' ');
        segments.push(currentSegment);
      }
      currentSegment = { text: '' };
      segmentText = [];
      continue;
    }
    
    // Timestamp
    const timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (timestampMatch) {
      const startHours = parseInt(timestampMatch[1]);
      const startMinutes = parseInt(timestampMatch[2]);
      const startSeconds = parseInt(timestampMatch[3]);
      const startMs = parseInt(timestampMatch[4]);
      const endHours = parseInt(timestampMatch[5]);
      const endMinutes = parseInt(timestampMatch[6]);
      const endSeconds = parseInt(timestampMatch[7]);
      const endMs = parseInt(timestampMatch[8]);
      
      currentSegment.start = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
      currentSegment.end = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;
      continue;
    }
    
    // Texto del segmento
    if (line.length > 0 && currentSegment) {
      segmentText.push(line);
    }
  }
  
  // Agregar el último segmento
  if (currentSegment && segmentText.length > 0) {
    currentSegment.text = segmentText.join(' ');
    segments.push(currentSegment);
  }
  
  return segments;
}

/**
 * Genera SRT para una llamada específica ajustando los timestamps
 * @param {Array} segments - Segmentos de la llamada
 * @param {number} offset - Offset de tiempo en segundos
 * @returns {string} - Contenido SRT
 */
function generateCallSRT(segments, offset) {
  let srt = '';
  
  segments.forEach((segment, index) => {
    const startTime = formatSRTTime(segment.start - offset);
    const endTime = formatSRTTime(segment.end - offset);
    
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
  if (seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}
