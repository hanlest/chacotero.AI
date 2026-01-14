import { v4 as uuidv4 } from 'uuid';
import { downloadAudio, extractVideoId, getPlaylistVideos, getThumbnailUrl, checkAgeRestriction } from '../services/youtubeService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { separateCalls, generateThumbnailScene, generateTitle } from '../services/callSeparationService.js';
// import { generateMetadata } from '../services/metadataService.js'; // Ya no se usa, los metadatos vienen del procesamiento de datos
import { saveAudioFile, saveTranscriptionFile, saveMinTranscriptionFile, saveMetadataFile, readMetadataFile, generateMinSRT, downloadThumbnail, sanitizeFilename } from '../services/fileService.js';
import { findCallsByVideoId, isVideoProcessed } from '../services/videoIndexService.js';
import { isVideoBlacklisted, addToBlacklist } from '../services/blacklistService.js';
import { extractAudioSegment, readAudioFile } from '../utils/audioUtils.js';
import { generateThumbnailImage, setLogCallback as setImageLogCallback } from '../services/imageGenerationService.js';
import { extractPlaylistId, loadPlaylistIndex, addVideoToPlaylistIndex, deletePlaylistIndex, syncPlaylistIndex, isVideoInPlaylistIndex } from '../services/playlistIndexService.js';
import { logInfo, logError, logVideoProgress, logVideoError, logWarn, logDebug } from '../services/loggerService.js';
import { unlink, readdir, stat, rmdir, mkdir, copyFile } from 'fs/promises';
import { existsSync, createReadStream, createWriteStream, readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import archiver from 'archiver';
import config from '../config/config.js';
import { generateVideoFromAudio } from '../services/videoGenerationService.js';

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
  
  // Guardar en archivo de log (sin colores ANSI)
  const logMessage = `${currentStr} ${videoId} | ${processStr}${timeStr ? ` | ${timeStr}` : ''}`;
  if (isError) {
    logVideoError(videoId, processStr).catch(err => {
      // Silenciar errores de logging para no interrumpir el flujo
    });
  } else {
    logVideoProgress(videoId, processStr, percent, elapsedTime).catch(err => {
      // Silenciar errores de logging para no interrumpir el flujo
    });
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
async function processSingleVideo(youtubeUrl, videoNumber = 1, totalVideos = 1, transcriptionSource = 'YOUTUBE', imageConfig = null, downloadOriginalThumbnail = true, saveProcessingPrompt = false, saveImagePrompt = false) {
  // Compresión de audio fija al 50%
  const audioCompression = 50;
  const startTime = Date.now();
  let videoId = null;
  
  // Asegurar que los parámetros estén definidos
  const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
  const shouldSaveImagePrompt = saveImagePrompt !== undefined ? Boolean(saveImagePrompt) : false;
  
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
    setImageLogCallback(showLog);
    
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
      const sourceLabel = transcriptionSource === 'YOUTUBE' ? 'Obteniendo transcripción de YouTube...' : 
                          transcriptionSource === 'WHISPER-LOCAL' ? 'Transcribiendo (local)...' : 
                          'Transcribiendo...';
      showLog('🎤', videoNumber, totalVideos, videoId, sourceLabel, null, null);
      const result = await transcribeAudio(audioPath, videoNumber, totalVideos, videoId, youtubeUrl, transcriptionSource, audioCompression);
      transcription = result.transcription;
      srt = result.srt;
      segments = result.segments;
      speakers = result.speakers;
      
      // Guardar transcripción del video completo en temp (solo SRT, no _min.txt)
      const { writeFile } = await import('fs/promises');
      await writeFile(transcriptionPath, srt, 'utf-8');
    }

    // 3. Procesar datos
    const processingPromptPath = shouldSaveProcessingPrompt ? join(config.storage.callsPath, `${videoId}_processing_prompt.txt`) : null;
    
    console.log(`[${videoNumber}/${totalVideos}] ${videoId} | Iniciando separateCalls...`);
    await logInfo(`Video ${videoId}: Iniciando procesamiento de datos (separateCalls)`);
    console.log(`[${videoNumber}/${totalVideos}] ${videoId} | Parámetros - segments: ${segments ? segments.length : 'null'}, srt length: ${srt ? srt.length : 'null'}, savePrompt: ${shouldSaveProcessingPrompt}`);
    await logInfo(`Video ${videoId}: Parámetros separateCalls - segments: ${segments ? segments.length : 'null'}, srt length: ${srt ? srt.length : 'null'}, savePrompt: ${shouldSaveProcessingPrompt}`);
    
    const separateCallsStart = Date.now();
    let separatedCalls;
    try {
      separatedCalls = await separateCalls(segments, srt, videoNumber, totalVideos, videoId, shouldSaveProcessingPrompt, processingPromptPath);
      const separateCallsDuration = ((Date.now() - separateCallsStart) / 1000).toFixed(2);
      //console.log(`[${videoNumber}/${totalVideos}] ${videoId} | ✅ separateCalls completado (${separateCallsDuration}s) - calls: ${separatedCalls ? separatedCalls.length : 'null'}`);
      await logInfo(`Video ${videoId}: separateCalls completado (${separateCallsDuration}s) - calls: ${separatedCalls ? separatedCalls.length : 'null'}`);
      
      // Verificar si las llamadas tienen metadatos
      if (separatedCalls && separatedCalls.length > 0) {
        const firstCall = separatedCalls[0];
        //console.log(`[${videoNumber}/${totalVideos}] ${videoId} | Verificando metadatos de la primera llamada...`);
        //console.log(`[${videoNumber}/${totalVideos}] ${videoId} | - title: ${firstCall.title || 'NO'}`);
        //console.log(`[${videoNumber}/${totalVideos}] ${videoId} | - topic: ${firstCall.topic || 'NO'}`);
        //console.log(`[${videoNumber}/${totalVideos}] ${videoId} | - thumbnailScene: ${firstCall.thumbnailScene ? 'SÍ' : 'NO'}`);
        await logInfo(`Video ${videoId}: Primera llamada - title: ${firstCall.title || 'NO'}, topic: ${firstCall.topic || 'NO'}, thumbnailScene: ${firstCall.thumbnailScene ? 'SÍ' : 'NO'}`);
      }
    } catch (error) {
      const separateCallsDuration = ((Date.now() - separateCallsStart) / 1000).toFixed(2);
      console.log(`[${videoNumber}/${totalVideos}] ${videoId} | ❌ ERROR en separateCalls (${separateCallsDuration})}`);
      await logError(`Video ${videoId}: ERROR en separateCalls (${separateCallsDuration}s): ${error.message}`);
      await logError(`Video ${videoId}: Stack: ${error.stack}`);
      throw error; // Re-lanzar el error para que se maneje arriba
    }

    // 4. Procesar cada llamada
    const processedCalls = [];
    const totalCalls = separatedCalls.length;

    for (let i = 0; i < separatedCalls.length; i++) {
      const call = separatedCalls[i];
      const callNumber = i + 1;
      const callPercent = (callNumber / totalCalls) * 100;
      
      try {
        showLog('✂️', videoNumber, totalVideos, videoId, `Recortando llamada ${callNumber}/${totalCalls}`, callPercent, null);
        // Usar los metadatos de la primera llamada a la IA (procesamiento de datos)
        // La IA ya proporciona: name, age, title, topic, tags, summary, thumbnail
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
          thumbnailScene: call.thumbnailScene || null, // Escena para la miniatura generada por la IA
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

        // Descargar miniatura original de YouTube si está disponible
        const originalThumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}_original.jpg`);
        let finalThumbnailUrl = thumbnailUrl;
        let originalThumbnailExists = false;
        
        if (downloadOriginalThumbnail && thumbnailUrl && !existsSync(originalThumbnailPath)) {
          try {
            await downloadThumbnail(thumbnailUrl, originalThumbnailPath);
            originalThumbnailExists = existsSync(originalThumbnailPath);
          } catch (error) {
            console.warn(`⚠️  No se pudo descargar miniatura original: ${error.message}`);
          }
        } else if (existsSync(originalThumbnailPath)) {
          originalThumbnailExists = true;
        }
        
        // Generar imagen miniatura con DALL-E basada en el resumen
        const generatedThumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}_generated.jpg`);
        let generatedImagePath = null;
        const imagePromptPath = shouldSaveImagePrompt ? join(config.storage.callsPath, `${sanitizedFileName}_image_prompt.txt`) : null;
        
        if (imageConfig && imageConfig.generate) {
          try {
            // Generar imagen usando DALL-E con la configuración proporcionada
            generatedImagePath = await generateThumbnailImage(
              metadata,
              generatedThumbnailPath,
              videoNumber,
              totalVideos,
              videoId,
              callNumber,
              totalCalls,
              imageConfig,
              shouldSaveImagePrompt,
              imagePromptPath
            );
          } catch (error) {
            console.warn(`⚠️  No se pudo generar imagen para ${sanitizedFileName}: ${error.message}`);
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
          originalThumbnailPath: originalThumbnailExists ? originalThumbnailPath : null, // Ruta de la miniatura original de YouTube
          generatedThumbnailPath: generatedImagePath && existsSync(generatedImagePath) ? generatedImagePath : null, // Ruta de la imagen generada con IA
          generatedThumbnail: generatedImagePath && existsSync(generatedImagePath) ? true : false, // Indica si se generó imagen con IA
          processingPromptPath: processingPromptPath && existsSync(processingPromptPath) ? processingPromptPath : null, // Ruta del prompt de procesamiento de datos (una vez por video)
          imagePromptPath: imagePromptPath && existsSync(imagePromptPath) ? imagePromptPath : null, // Ruta del prompt de generación de imagen (una vez por llamada)
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
          originalThumbnailFile: originalThumbnailExists ? originalThumbnailPath : null,
          generatedThumbnailFile: generatedImagePath && existsSync(generatedImagePath) ? generatedImagePath : null,
          audioFile: savedAudioPath,
          transcriptionFile: savedTranscriptionPath,
          thumbnailFile: generatedImagePath && existsSync(generatedImagePath) ? generatedImagePath : (originalThumbnailExists ? originalThumbnailPath : null), // Por compatibilidad, usar imagen generada si existe, sino la original
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
    //showLog('❌', videoNumber, totalVideos, videoIdForLog, shortErrorMessage, null, elapsedTime);
    
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
    const { youtubeUrl, youtubeUrls, maxConcurrency: maxConcurrencyParam, transcriptionSource, thumbnail, downloadOriginalThumbnail, saveProcessingPrompt } = req.body;

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

    // Validar y parsear maxConcurrency si se proporciona
    if (maxConcurrencyParam !== undefined && maxConcurrencyParam !== null) {
      const parsedMaxConcurrency = parseInt(maxConcurrencyParam, 10);
      if (isNaN(parsedMaxConcurrency) || parsedMaxConcurrency < 1) {
        return res.status(400).json({
          error: 'maxConcurrency debe ser un número mayor a 0',
        });
      }
    }

    // Procesar videos en paralelo con límite de concurrencia
    // Usar el parámetro si se proporciona, sino usar el valor por defecto
    const maxConcurrency = maxConcurrencyParam !== undefined && maxConcurrencyParam !== null
      ? parseInt(maxConcurrencyParam, 10)
      : 3;
    
    // Limpiar la consola antes de comenzar
    if (typeof process !== 'undefined' && process.stdout) {
      process.stdout.write('\x1b[2J\x1b[0f'); // Limpiar pantalla y mover cursor al inicio
    }
    
    // Validar y parsear transcriptionSource (por defecto 'YOUTUBE')
    const validSources = ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE'];
    let source = 'YOUTUBE';
    if (transcriptionSource) {
      const sourceStr = String(transcriptionSource);
      if (validSources.includes(sourceStr)) {
        source = sourceStr;
      } else {
        return res.status(400).json({
          error: `transcriptionSource debe ser uno de: ${validSources.join(', ')}`,
        });
      }
    }
    
    // Compresión de audio fija al 50%
    const compressionPercent = 50;
    
    // Validar y parsear parámetros de miniatura
    // Si thumbnail no viene o es null, no se generará miniatura
    let imageConfig = null;
    if (thumbnail !== undefined && thumbnail !== null) {
      const validModels = ['gpt-image-1.5'];
      const finalModel = thumbnail.model && validModels.includes(thumbnail.model) ? thumbnail.model : 'gpt-image-1.5';
      
      const validImageSizes = ['1536x1024'];
      const finalImageSize = thumbnail.size && validImageSizes.includes(thumbnail.size) ? thumbnail.size : '1536x1024';
      
      const validImageQualities = ['medium'];
      const finalImageQuality = thumbnail.quality && validImageQualities.includes(thumbnail.quality) ? thumbnail.quality : 'medium';
      
      const shouldSaveImagePrompt = thumbnail.saveImagePrompt !== undefined ? Boolean(thumbnail.saveImagePrompt) : false;
      imageConfig = {
        generate: true,
        model: finalModel,
        size: finalImageSize,
        quality: finalImageQuality,
        saveImagePrompt: shouldSaveImagePrompt,
      };
    }
    
    // Validar downloadOriginalThumbnail (por defecto true)
    const shouldDownloadOriginal = downloadOriginalThumbnail !== undefined ? Boolean(downloadOriginalThumbnail) : true;
    
    const logHeader = `Procesando ${urls.length} video(s) de YouTube | Paralelo: ${Math.min(maxConcurrency, urls.length)} | Transcripción: ${source} | Compresión: ${compressionPercent}% | Miniatura: ${imageConfig ? 'Habilitada' : 'Deshabilitada'}`;
    await logInfo(logHeader);
    console.log('');
    console.log('================================');
    console.log(`Procesando ${urls.length} video(s) de YouTube`);
    console.log(`Procesamiento en paralelo: ${Math.min(maxConcurrency, urls.length)} video(s) simultáneo(s)`);
    console.log(`Fuente de transcripción: ${source}`);
    console.log(`Compresión de audio: ${compressionPercent}%`);
    console.log(`Generación de miniatura: ${imageConfig ? 'Habilitada' : 'Deshabilitada'}${imageConfig ? ` (${imageConfig.size}, ${imageConfig.quality})` : ''}`);
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
        setImageLogCallback(showLogLocal);
        
        const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
        const shouldSaveImagePrompt = (imageConfig && imageConfig.saveImagePrompt !== undefined) ? Boolean(imageConfig.saveImagePrompt) : false;
        const result = await processSingleVideo(url, videoNumber, urls.length, source, imageConfig, shouldDownloadOriginal, shouldSaveProcessingPrompt, shouldSaveImagePrompt);
        
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

    const logSummary = `Procesamiento completado | Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total: ${urls.length}`;
    await logInfo(logSummary);
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
    await logError(`Error al procesar video(s): ${error.message}`);
    await logError(`Stack: ${error.stack}`);
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
    const { playlistUrl, playlistUrls, maxConcurrency, limit, sortOrder, transcriptionSource, thumbnail, downloadOriginalThumbnail, usePlaylistIndex, saveProcessingPrompt } = req.body;

    // Soporte para array de URLs o URL única (retrocompatibilidad)
    const urls = playlistUrls || (playlistUrl ? [playlistUrl] : []);

    if (!urls || urls.length === 0) {
      return res.status(400).json({
        error: 'playlistUrl o playlistUrls es requerido',
      });
    }

    // Validar si alguna URL es de video individual en lugar de playlist
    // Si es una sola URL y es un video individual, procesarlo como video único
    if (urls.length === 1) {
      const url = urls[0];
      const videoId = extractVideoId(url);
      const playlistId = extractPlaylistId(url);
      
      // Si tiene videoId pero NO tiene playlistId, es un video individual
      if (videoId && !playlistId) {
        // Redirigir al procesamiento de video individual
        // Convertir los parámetros al formato de processVideo
        const youtubeUrls = [url];
        const videoMaxConcurrency = maxConcurrency || 1; // Para un solo video, usar 1
        
        // Crear un nuevo request body para processVideo
        const videoReq = {
          ...req,
          body: {
            youtubeUrls,
            maxConcurrency: videoMaxConcurrency,
            transcriptionSource,
            thumbnail,
            downloadOriginalThumbnail,
            saveProcessingPrompt,
          }
        };
        
        return await processVideo(videoReq, res);
      }
    }

    // Validar y parsear parámetros opcionales
    const parsedMaxConcurrency = maxConcurrency ? parseInt(maxConcurrency, 10) : null;
    const parsedLimit = limit ? parseInt(limit, 10) : null;

    if (parsedMaxConcurrency !== null && (isNaN(parsedMaxConcurrency) || parsedMaxConcurrency < 1)) {
      return res.status(400).json({
        error: 'maxConcurrency debe ser un número mayor a 0',
      });
    }

    if (parsedLimit !== null && (isNaN(parsedLimit) || parsedLimit < 1)) {
      return res.status(400).json({
        error: 'limit debe ser un número mayor a 0',
      });
    }

    // Validar y parsear transcriptionSource (por defecto 'YOUTUBE')
    const validSources = ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE'];
    let source = 'YOUTUBE';
    if (transcriptionSource) {
      const sourceStr = String(transcriptionSource);
      if (validSources.includes(sourceStr)) {
        source = sourceStr;
      } else {
        return res.status(400).json({
          error: `transcriptionSource debe ser uno de: ${validSources.join(', ')}`,
        });
      }
    }
    
    // Compresión de audio fija al 50%
    const compressionPercent = 50;
    
    // Validar y parsear sortOrder (por defecto 'ASC')
    const validSortOrders = ['ASC', 'DESC'];
    let sort = 'ASC';
    if (sortOrder) {
      const sortStr = String(sortOrder).toUpperCase();
      if (validSortOrders.includes(sortStr)) {
        sort = sortStr;
      } else {
        return res.status(400).json({
          error: `sortOrder debe ser uno de: ${validSortOrders.join(', ')}`,
        });
      }
    }
    
    // Validar y parsear parámetros de miniatura
    // Si thumbnail no viene o es null, no se generará miniatura
    let imageConfig = null;
    if (thumbnail !== undefined && thumbnail !== null) {
      const validModels = ['gpt-image-1.5'];
      const finalModel = thumbnail.model && validModels.includes(thumbnail.model) ? thumbnail.model : 'gpt-image-1.5';
      
      const validImageSizes = ['1536x1024'];
      const finalImageSize = thumbnail.size && validImageSizes.includes(thumbnail.size) ? thumbnail.size : '1536x1024';
      
      const validImageQualities = ['medium'];
      const finalImageQuality = thumbnail.quality && validImageQualities.includes(thumbnail.quality) ? thumbnail.quality : 'medium';
      
      const shouldSaveImagePrompt = thumbnail.saveImagePrompt !== undefined ? Boolean(thumbnail.saveImagePrompt) : false;
      imageConfig = {
        generate: true,
        model: finalModel,
        size: finalImageSize,
        quality: finalImageQuality,
        saveImagePrompt: shouldSaveImagePrompt,
      };
    }
    
    // Validar downloadOriginalThumbnail (por defecto true)
    const shouldDownloadOriginal = downloadOriginalThumbnail !== undefined ? Boolean(downloadOriginalThumbnail) : true;
    
    // Validar usePlaylistIndex (por defecto true)
    const shouldUseIndex = usePlaylistIndex !== undefined ? Boolean(usePlaylistIndex) : true;
    
    // Validar saveProcessingPrompt (por defecto false)
    const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
    // saveImagePrompt ahora está dentro de thumbnail
    const shouldSaveImagePrompt = (imageConfig && imageConfig.saveImagePrompt !== undefined) ? Boolean(imageConfig.saveImagePrompt) : false;
    
    // Si es una sola playlist, mantener el formato de respuesta original
    if (urls.length === 1) {
      return await processSinglePlaylist(urls[0], res, parsedMaxConcurrency, parsedLimit, sort, source, imageConfig, shouldDownloadOriginal, shouldUseIndex, shouldSaveProcessingPrompt, shouldSaveImagePrompt);
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
        const result = await processSinglePlaylist(playlistUrl, null, parsedMaxConcurrency, parsedLimit, sort, source, imageConfig, shouldDownloadOriginal, shouldUseIndex, shouldSaveProcessingPrompt, shouldSaveImagePrompt);
        allResults.push({
          playlistUrl,
          ...result,
        });
        
        totalProcessed += result.processed || 0;
        totalSkipped += result.skipped || 0;
        totalErrors += result.errors || 0;
        totalVideos += result.totalVideos || 0;
      } catch (error) {
        await logError(`Error al procesar playlist ${playlistNumber}: ${error.message}`);
        await logError(`Stack: ${error.stack}`);
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
    await logError(`Error al procesar playlist(s): ${error.message}`);
    await logError(`Stack: ${error.stack}`);
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
 * @param {number|null} maxConcurrencyParam - Cantidad máxima de videos concurrentes (opcional)
 * @param {number|null} limitParam - Cantidad máxima de videos a procesar (opcional)
 * @param {string} sortOrder - Orden de procesamiento: 'ASC' o 'DESC' (opcional, por defecto 'ASC')
 * @param {string} transcriptionSource - Fuente de transcripción (opcional, por defecto 'YOUTUBE')
 * @param {object} imageConfig - Configuración de generación de imágenes (opcional)
 * @returns {Promise<object>} - Resultado del procesamiento
 */
async function processSinglePlaylist(playlistUrl, res, maxConcurrencyParam = null, limitParam = null, sortOrder = 'ASC', transcriptionSource = 'YOUTUBE', imageConfig = null, downloadOriginalThumbnail = true, usePlaylistIndex = true, saveProcessingPrompt = false, saveImagePrompt = false) {
  // Compresión de audio fija al 50%
  const audioCompression = 50;
  try {
    // Extraer ID de la playlist
    const playlistId = extractPlaylistId(playlistUrl);
    
    // Si no se usa el índice, eliminar el archivo existente si existe
    if (!usePlaylistIndex && playlistId) {
      await deletePlaylistIndex(playlistId);
    }
    
    console.log('');
    console.log('================================');
    console.log('Procesando playlist de YouTube');
    console.log(`Fuente de transcripción: ${transcriptionSource}`);
    console.log(`Compresión de audio: ${audioCompression}%`);
    console.log(`Orden de procesamiento: ${sortOrder === 'DESC' ? 'Descendente (del último al primero)' : 'Ascendente (del primero al último)'}`);
    console.log(`Uso de índice: ${usePlaylistIndex ? 'Habilitado' : 'Deshabilitado'}`);
    console.log('================================');
    console.log('');

    // Obtener lista de videos de la playlist
    let videos = await getPlaylistVideos(playlistUrl);
    
    // Cargar índice de la playlist si está habilitado
    let playlistIndex = null;
    if (usePlaylistIndex && playlistId) {
      playlistIndex = await loadPlaylistIndex(playlistId);
      console.log(`📑 Índice de playlist cargado: ${playlistIndex.size} video(s) ya procesado(s)`);
      console.log('');
    }
    
    // Ordenar videos según sortOrder
    if (sortOrder === 'DESC') {
      videos = [...videos].reverse();
      console.log('📋 Ordenando videos en orden descendente (del último al primero)...');
    } else {
      console.log('📋 Ordenando videos en orden ascendente (del primero al último)...');
    }
    console.log('');

    if (videos.length === 0) {
      return res.status(400).json({
        error: 'No se encontraron videos en la playlist',
      });
    }

    // Filtrar videos que ya fueron procesados y verificar restricciones
    // Si hay un límite, buscar solo hasta encontrar esa cantidad de videos sin procesar
    const totalVideosInPlaylist = videos.length;
    const unprocessedVideos = [];
    const targetLimit = limitParam !== null && limitParam > 0 ? limitParam : null;
    let alreadyProcessedCount = 0;
    let ageRestrictedCount = 0;
    let checkedCount = 0;
    
    console.log(`📋 Total de videos en la playlist: ${totalVideosInPlaylist}`);
    if (targetLimit) {
      console.log(`🔍 Buscando ${targetLimit} video(s) sin procesar...`);
    } else {
      console.log('🔍 Verificando videos ya procesados y restricciones...');
    }
    console.log('');
    
    // Verificar cada video para ver si ya fue procesado o tiene restricción de edad
    // IMPORTANTE: Si hay un límite, debemos seguir buscando hasta encontrar esa cantidad de videos sin procesar
    // Si encontramos un video ya procesado, continuamos buscando (NO detenemos la búsqueda)
    for (const video of videos) {
      // Si ya tenemos suficientes videos sin procesar y hay un límite, detener la búsqueda
      if (targetLimit && unprocessedVideos.length >= targetLimit) {
        break;
      }
      
      checkedCount++;
      
      // Verificar si el video está en la lista negra
      
      const checkBlacklistStart = Date.now();
      const isBlacklisted = await isVideoBlacklisted(video.id);
      const checkBlacklistDuration = ((Date.now() - checkBlacklistStart) / 1000).toFixed(2);
      
      if (isBlacklisted) {
        //console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ En lista negra (verificación: ${checkBlacklistDuration}s)`);
        //await logInfo(`Video ${video.id}: En lista negra - Saltado (búsqueda, verificación: ${checkBlacklistDuration}s)`);
        continue;
      } else {
        //console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ No está en lista negra (verificación: ${checkBlacklistDuration}s)`);
        //await logInfo(`Video ${video.id}: No está en lista negra (búsqueda, verificación: ${checkBlacklistDuration}s)`);
      }
      
      // Verificar si el video ya fue procesado
      // Si se usa el índice: primero verificar el índice, luego verificar JSON si el índice dice que no está procesado
      // Si no se usa el índice: verificar directamente con JSON
      console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | Verificando si ya fue procesado...`);
      await logInfo(`Video ${video.id}: Verificando si ya fue procesado (búsqueda)`);
      
      let alreadyProcessed = false;
      const checkProcessedStart = Date.now();
      
      if (usePlaylistIndex && playlistIndex) {
        // Primero verificar el índice (más rápido)
        alreadyProcessed = playlistIndex.has(video.id);
        const indexCheckDuration = ((Date.now() - checkProcessedStart) / 1000).toFixed(2);
        
        if (alreadyProcessed) {
          console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ Ya procesado (índice, verificación: ${indexCheckDuration}s)`);
          await logInfo(`Video ${video.id}: Ya procesado según índice (búsqueda, verificación: ${indexCheckDuration}s)`);
        } else {
          console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ⚠️ No en índice, verificando JSON...`);
          await logInfo(`Video ${video.id}: No encontrado en índice, verificando JSON (búsqueda)`);
          
          // Si el índice dice que NO está procesado, verificar también el JSON de metadata
          // (por si el índice está desactualizado)
          const jsonCheckStart = Date.now();
          alreadyProcessed = await isVideoProcessed(video.id);
          const jsonCheckDuration = ((Date.now() - jsonCheckStart) / 1000).toFixed(2);
          const totalCheckDuration = ((Date.now() - checkProcessedStart) / 1000).toFixed(2);
          
          // Si el JSON confirma que está procesado pero no está en el índice, actualizar el índice
          if (alreadyProcessed) {
            console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ Ya procesado (JSON, verificación: ${jsonCheckDuration}s, total: ${totalCheckDuration}s)`);
            await logInfo(`Video ${video.id}: Ya procesado según JSON (búsqueda, verificación JSON: ${jsonCheckDuration}s, total: ${totalCheckDuration}s)`);
            await addVideoToPlaylistIndex(playlistId, video.id);
          } else {
            console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ No procesado (verificación JSON: ${jsonCheckDuration}s, total: ${totalCheckDuration}s)`);
            await logInfo(`Video ${video.id}: No procesado (búsqueda, verificación JSON: ${jsonCheckDuration}s, total: ${totalCheckDuration}s)`);
          }
        }
      } else {
        // Usar método tradicional (lee todos los JSON)
        alreadyProcessed = await isVideoProcessed(video.id);
        const checkProcessedDuration = ((Date.now() - checkProcessedStart) / 1000).toFixed(2);
        
        if (alreadyProcessed) {
          console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ Ya procesado (verificación: ${checkProcessedDuration}s)`);
          await logInfo(`Video ${video.id}: Ya procesado (búsqueda, verificación: ${checkProcessedDuration}s)`);
        } else {
          console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ No procesado (verificación: ${checkProcessedDuration}s)`);
          await logInfo(`Video ${video.id}: No procesado (búsqueda, verificación: ${checkProcessedDuration}s)`);
        }
      }
      
      if (alreadyProcessed) {
        // Video ya procesado: incrementar contador, mostrar log, pero CONTINUAR buscando
        alreadyProcessedCount++;
        
        // Actualizar el índice si está habilitado (el video podría haber sido procesado en una ejecución anterior)
        if (usePlaylistIndex && playlistId) {
          await addVideoToPlaylistIndex(playlistId, video.id);
        }
        
        // Mostrar log del video ya procesado
        const existingCalls = await findCallsByVideoId(video.id);
        const callsCount = existingCalls.length;
        console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ✅ Ya procesado (${callsCount} llamadas) - Saltado`);
        // IMPORTANTE: No hacer break aquí, continuar con el siguiente video para encontrar videos sin procesar
        continue;
      } else {
        // Verificar restricción de edad antes de agregar a la lista de procesamiento
        try {
          const hasAgeRestriction = await checkAgeRestriction(video.url, video.id);
          if (hasAgeRestriction) {
            ageRestrictedCount++;
            console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | 🚫 Requiere verificación de edad - Saltado`);
            
            // Agregar a la lista de videos fallidos
            try {
              const { saveFailedVideo } = await import('../services/youtubeService.js');
              await saveFailedVideo(video.url, 'Video requiere autenticación (verificación de edad) - Omitido');
            } catch (saveError) {
              // Si falla guardar, continuar sin bloquear
              console.warn(`⚠️  No se pudo guardar video fallido: ${saveError.message}`);
            }
          } else {
            unprocessedVideos.push(video);
            // Mostrar log del video que se procesará
            console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ⏳ Sin procesar - Se procesará`);
          }
        } catch (error) {
          // Si hay error al verificar, agregar el video de todas formas (para no bloquear videos válidos)
          console.warn(`   ⚠️  Error al verificar restricción de edad para ${video.id}: ${error.message}`);
          unprocessedVideos.push(video);
          console.log(`   [${checkedCount}/${totalVideosInPlaylist}] ${video.id} | ⏳ Sin procesar - Se procesará`);
        }
      }
    }
    
    const videosToProcess = unprocessedVideos;
    
    console.log('');
    if (targetLimit) {
      console.log(`📋 Videos sin procesar encontrados: ${videosToProcess.length} (buscando ${targetLimit})`);
      if (videosToProcess.length < targetLimit) {
        console.log(`⚠️  Solo se encontraron ${videosToProcess.length} video(s) sin procesar (se solicitó ${targetLimit})`);
      }
    } else {
      console.log(`📋 Videos sin procesar: ${videosToProcess.length}`);
    }
    console.log(`📋 Videos ya procesados encontrados: ${alreadyProcessedCount}`);
    console.log(`📋 Videos con restricción de edad: ${ageRestrictedCount}`);
    console.log(`📋 Videos verificados: ${checkedCount}`);
    
    if (videosToProcess.length === 0) {
      console.log('✅ Todos los videos de la playlist ya fueron procesados.');
      if (res) {
        return res.json({
          playlistUrl,
          totalVideos: totalVideosInPlaylist,
          processed: 0,
          skipped: totalVideosInPlaylist,
          errors: 0,
          results: [],
        });
      }
      return {
        playlistUrl,
        totalVideos: totalVideosInPlaylist,
        processed: 0,
        skipped: totalVideosInPlaylist,
        errors: 0,
        results: [],
      };
    }
    
    console.log('');

    const results = [];
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Procesar videos en paralelo con límite de concurrencia
    // Usar el parámetro si se proporciona, sino usar el valor por defecto
    const maxConcurrency = maxConcurrencyParam !== null 
      ? maxConcurrencyParam 
      : 3;
    
    // Limpiar la consola antes de comenzar
    if (typeof process !== 'undefined' && process.stdout) {
      process.stdout.write('\x1b[2J\x1b[0f'); // Limpiar pantalla y mover cursor al inicio
    }
    
    console.log(`⚡ Procesamiento en paralelo: ${Math.min(maxConcurrency, videosToProcess.length)} video(s) simultáneo(s)`);
    console.log('');

    // Función helper para mostrar logs usando lineManager (similar a showLogCallback)
    const showLogCallback = (icon, current, total, videoId, processText, percent = null, elapsedTime = null) => {
      const totalDigits = total.toString().length;
      const currentPadded = current.toString().padStart(totalDigits, '0');
      const currentStr = `[${currentPadded}/${total}]`;
      const processStr = percent !== null ? `${processText} ${percent.toFixed(1)}%` : processText;
      const timeStr = elapsedTime !== null ? `${elapsedTime.toFixed(1)}s` : '';
      const logLine = `${currentStr} ${videoId} | ${icon} ${processStr}${timeStr ? ` | ${timeStr}` : ''}`;
      lineManager.updateVideoLog(videoId, current, logLine);
      lineManager.writeVideoLine(videoId);
    };

    // Función para procesar un video con su índice
    const processVideoWithIndex = async (video, index) => {
      const videoNumber = index + 1;
      const startTime = Date.now();

      try {
        // Verificar si el video está en la lista negra
        showLogCallback('🔍', videoNumber, videosToProcess.length, video.id, 'Verificando lista negra...', null, null);
        await logInfo(`Video ${video.id}: Verificando lista negra`);
        
        const checkBlacklistStart = Date.now();
        const isBlacklisted = await isVideoBlacklisted(video.id);
        const checkBlacklistDuration = ((Date.now() - checkBlacklistStart) / 1000).toFixed(2);
        
        if (isBlacklisted) {
          await logInfo(`Video ${video.id}: En lista negra - Saltado (verificación: ${checkBlacklistDuration}s)`);
          const totalDigits = videosToProcess.length.toString().length;
          const currentPadded = videoNumber.toString().padStart(totalDigits, '0');
          const greenColor = '\x1b[32m'; // ANSI code para verde
          const resetColor = '\x1b[0m';   // ANSI code para resetear color
          const logLine = `${greenColor}[${currentPadded}/${videosToProcess.length}] ${video.id} | 🚫 En lista negra - Saltado${resetColor}`;
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
        } else {
          showLogCallback('✅', videoNumber, videosToProcess.length, video.id, 'No está en lista negra', null, parseFloat(checkBlacklistDuration));
          await logInfo(`Video ${video.id}: No está en lista negra (verificación: ${checkBlacklistDuration}s)`);
        }

        // Verificar si el video ya fue procesado
        console.log(`[${videoNumber}/${videosToProcess.length}] ${video.id} | Verificando si ya fue procesado...`);
        await logInfo(`Video ${video.id}: Verificando si ya fue procesado`);
        
        const checkProcessedStart = Date.now();
        const alreadyProcessed = await isVideoProcessed(video.id);
        const checkProcessedDuration = ((Date.now() - checkProcessedStart) / 1000).toFixed(2);
        
        if (alreadyProcessed) {
          console.log(`[${videoNumber}/${videosToProcess.length}] ${video.id} | ✅ Ya procesado (verificación: ${checkProcessedDuration}s)`);
          await logInfo(`Video ${video.id}: Ya procesado - Saltado (verificación: ${checkProcessedDuration}s)`);
          
          // Actualizar el índice si está habilitado (el video podría haber sido procesado en una ejecución anterior)
          if (usePlaylistIndex && playlistId) {
            await addVideoToPlaylistIndex(playlistId, video.id);
          }
          
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
          const totalDigits = videosToProcess.length.toString().length;
          const videoNumberPadded = videoNumber.toString().padStart(totalDigits, '0');
          // Aplicar color verde para "Ya procesado"
          const greenColor = '\x1b[32m';
          const resetColor = '\x1b[0m';
          const logLine = `${greenColor}[${videoNumberPadded}/${videosToProcess.length}] ${video.id} | Ya procesado (${existingCalls.length} llamadas) | ${duration.toFixed(1)}s${resetColor}`;
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
        setImageLogCallback(showLogLocal);
        
        // Procesar el video
        const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
        // saveImagePrompt ahora está dentro de thumbnail
        const shouldSaveImagePrompt = (imageConfig && imageConfig.saveImagePrompt !== undefined) ? Boolean(imageConfig.saveImagePrompt) : false;
        const result = await processSingleVideo(video.url, videoNumber, videosToProcess.length, transcriptionSource, imageConfig, downloadOriginalThumbnail, shouldSaveProcessingPrompt, shouldSaveImagePrompt);
        
        // Si el video se procesó exitosamente y estamos usando el índice, agregarlo
        if (result.processed === true && usePlaylistIndex && playlistId) {
          await addVideoToPlaylistIndex(playlistId, video.id);
        }
        
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
        const totalDigits = videosToProcess.length.toString().length;
        const videoNumberPadded = videoNumber.toString().padStart(totalDigits, '0');
        // Aplicar color rojo a los errores
        const redColor = '\x1b[31m';   // ANSI code para rojo
        const resetColor = '\x1b[0m';   // ANSI code para resetear color
        const logLine = `${redColor}[${videoNumberPadded}/${videosToProcess.length}] ${video.id} | Error: ${errorMessage} | ${duration.toFixed(1)}s${resetColor}`;
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
      if (nextIndex >= videosToProcess.length) return null;
      
      const currentIndex = nextIndex++;
      const video = videosToProcess[currentIndex];
      
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
    for (let i = 0; i < Math.min(maxConcurrency, videosToProcess.length); i++) {
      startNext();
    }
    
    // Esperar a que todos los procesos terminen
    // Usar un loop que espera hasta que todos estén completos
    while (completedCount < videosToProcess.length) {
      if (activePromises.size > 0) {
        await Promise.race(Array.from(activePromises));
      } else {
        // Si no hay promesas activas pero aún faltan por completar, esperar un poco
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Procesar resultados en orden
    for (let i = 0; i < videosToProcess.length; i++) {
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

    // Sincronizar el índice al final si está habilitado
    // Esto asegura que el índice esté actualizado incluso si se detectaron videos ya procesados
    if (usePlaylistIndex && playlistId && videosToProcess.length > 0) {
      const videoIds = videosToProcess.map(v => v.id);
      await syncPlaylistIndex(playlistId, videoIds);
      //console.log(`📑 Índice de playlist sincronizado`);
    }
    
    const finalSummary = limitParam !== null && limitParam > 0
      ? `Procesamiento completado | Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total en cola: ${videosToProcess.length} | Total en playlist: ${totalVideosInPlaylist}`
      : `Procesamiento completado | Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total en cola: ${videosToProcess.length}`;
    await logInfo(finalSummary);
    console.log('');
    console.log('');
    console.log('================================');
    console.log('✅ Procesamiento completado');
    console.log('================================');
    if (limitParam !== null && limitParam > 0) {
      console.log(`📊 Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total en cola: ${videosToProcess.length} | Total en playlist: ${totalVideosInPlaylist}`);
    } else {
      console.log(`📊 Procesados: ${processedCount} | Omitidos: ${skippedCount} | Errores: ${errorCount} | Total en cola: ${videosToProcess.length}`);
    }
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
    await logError(`Error al procesar playlist: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
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

/**
 * Genera una miniatura para una llamada basada en sus metadatos
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function generateThumbnail(req, res) {
  try {
    // Manejar errores de multer (archivo muy grande, tipo no permitido, etc.)
    if (req.fileValidationError) {
      return res.status(400).json({
        error: req.fileValidationError,
      });
    }

    // Obtener metadata desde archivo subido o desde body (JSON)
    let metadata = null;
    
    // Si hay un archivo subido (multipart/form-data)
    if (req.file) {
      try {
        // Convertir el buffer del archivo a string y parsear JSON
        const fileContent = req.file.buffer.toString('utf-8');
        metadata = JSON.parse(fileContent);
      } catch (error) {
        return res.status(400).json({
          error: 'El archivo JSON no es válido o está mal formateado',
          message: error.message,
        });
      }
    } else if (req.body.metadata) {
      // Si viene como objeto en el body (application/json)
      metadata = req.body.metadata;
    } else {
      return res.status(400).json({
        error: 'El parámetro "metadata" es requerido. Puede ser un archivo JSON (multipart/form-data) o un objeto (application/json)',
      });
    }

    // Validar que metadata es un objeto
    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({
        error: 'El metadata debe ser un objeto válido',
      });
    }

    // Validar que metadata tiene summary (necesario para generar thumbnailScene si no existe)
    if (!metadata.summary && !metadata.thumbnailScene) {
      return res.status(400).json({
        error: 'El metadata debe tener al menos "summary" o "thumbnailScene"',
      });
    }

    // Obtener parámetros de configuración de miniatura desde body (campos separados)
    const { model, size, quality, saveImagePrompt } = req.body;

    // Verificar si existe thumbnailScene, si no, generarlo
    let thumbnailScene = metadata.thumbnailScene;
    if (!thumbnailScene || thumbnailScene.trim() === '') {
      await logInfo(`Generando thumbnailScene para metadata (summary: ${metadata.summary ? 'presente' : 'ausente'})`);
      
      if (!metadata.summary) {
        return res.status(400).json({
          error: 'No se puede generar thumbnailScene sin el campo "summary" en metadata',
        });
      }

      try {
        thumbnailScene = await generateThumbnailScene(metadata.summary);
        await logInfo(`thumbnailScene generado exitosamente: ${thumbnailScene.substring(0, 100)}...`);
      } catch (error) {
        await logError(`Error al generar thumbnailScene: ${error.message}`);
        return res.status(500).json({
          error: 'Error al generar escena para miniatura',
          message: error.message,
        });
      }
    }

    // Crear metadata con thumbnailScene
    const metadataWithScene = {
      ...metadata,
      thumbnailScene: thumbnailScene,
    };

    // Validar y parsear parámetros de miniatura
    const validModels = ['gpt-image-1.5'];
    const finalModel = model && validModels.includes(model) ? model : 'gpt-image-1.5';
    
    const validImageSizes = ['1536x1024'];
    const finalImageSize = size && validImageSizes.includes(size) ? size : '1536x1024';
    
    const validImageQualities = ['medium'];
    const finalImageQuality = quality && validImageQualities.includes(quality) ? quality : 'medium';

    const imageConfig = {
      generate: true,
      model: finalModel,
      size: finalImageSize,
      quality: finalImageQuality,
      saveImagePrompt: saveImagePrompt !== undefined ? Boolean(saveImagePrompt) : false,
    };

    // Generar nombre de archivo para la miniatura
    const videoId = metadata.youtubeVideoId || 'unknown';
    const callNumber = metadata.callNumber || 1;
    const fileName = metadata.fileName || `${videoId}_call_${callNumber}`;
    const sanitizedFileName = sanitizeFilename(fileName);
    const generatedThumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}_generated.jpg`);

    // Ruta para guardar el prompt de imagen si está habilitado
    const imagePromptPath = imageConfig.saveImagePrompt 
      ? join(config.storage.callsPath, `${sanitizedFileName}_image_prompt.txt`)
      : null;

    // Leer el metadata existente para obtener la ruta de la miniatura anterior (si existe)
    let existingMetadata = null;
    let oldThumbnailPath = null;
    
    if (metadata.fileName) {
      try {
        existingMetadata = await readMetadataFile(metadata.fileName);
        
        // Obtener la ruta de la miniatura anterior
        if (existingMetadata.generatedThumbnailPath) {
          oldThumbnailPath = existingMetadata.generatedThumbnailPath;
        }
      } catch (error) {
        // Si no existe el archivo, continuar sin problema
        await logDebug(`No se encontró metadata existente para ${metadata.fileName}, se creará uno nuevo`);
      }
    }

    // Eliminar la miniatura anterior si existe
    if (oldThumbnailPath && existsSync(oldThumbnailPath)) {
      try {
        await unlink(oldThumbnailPath);
        await logInfo(`Miniatura anterior eliminada: ${oldThumbnailPath}`);
      } catch (error) {
        await logWarn(`No se pudo eliminar la miniatura anterior ${oldThumbnailPath}: ${error.message}`);
        // Continuar con la generación aunque no se haya podido eliminar el archivo anterior
      }
    }

    // Generar la miniatura
    try {
      const generatedImagePath = await generateThumbnailImage(
        metadataWithScene,
        generatedThumbnailPath,
        1, // videoNumber
        1, // totalVideos
        videoId,
        callNumber,
        1, // totalCalls
        imageConfig,
        imageConfig.saveImagePrompt,
        imagePromptPath
      );

      // Actualizar el metadata JSON si existe el archivo
      if (metadata.fileName && existingMetadata) {
        try {
          // Actualizar el campo generatedThumbnailPath con la nueva ruta
          existingMetadata.generatedThumbnailPath = generatedImagePath;
          existingMetadata.generatedThumbnail = existsSync(generatedImagePath);
          
          // Si se generó un nuevo thumbnailScene, actualizarlo también
          if (thumbnailScene) {
            existingMetadata.thumbnailScene = thumbnailScene;
          }
          
          // Guardar el metadata actualizado
          await saveMetadataFile(metadata.fileName, existingMetadata);
          await logInfo(`Metadata actualizado para ${metadata.fileName} con nueva miniatura generada: ${generatedImagePath}`);
        } catch (error) {
          // Si hay error al actualizar, loguear el warning
          await logWarn(`No se pudo actualizar el metadata para ${metadata.fileName}: ${error.message}`);
        }
      } else if (metadata.fileName && !existingMetadata) {
        // Si no existía metadata, crear uno nuevo con la información actualizada
        try {
          const newMetadata = {
            ...metadataWithScene,
            generatedThumbnailPath: generatedImagePath,
            generatedThumbnail: existsSync(generatedImagePath),
          };
          await saveMetadataFile(metadata.fileName, newMetadata);
          await logInfo(`Metadata creado para ${metadata.fileName} con miniatura generada: ${generatedImagePath}`);
        } catch (error) {
          await logWarn(`No se pudo crear el metadata para ${metadata.fileName}: ${error.message}`);
        }
      }

      return res.json({
        success: true,
        thumbnailScene: thumbnailScene,
        imagePath: generatedImagePath,
        metadata: {
          ...metadataWithScene,
          generatedThumbnailPath: generatedImagePath,
        },
      });
    } catch (error) {
      await logError(`Error al generar miniatura: ${error.message}`);
      return res.status(500).json({
        error: 'Error al generar miniatura',
        message: error.message,
      });
    }
  } catch (error) {
    await logError(`Error en generateThumbnail: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al generar miniatura',
      message: error.message,
    });
  }
}

/**
 * Procesa una playlist y retorna los archivos generados como un ZIP
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function processPlaylistForDownload(req, res) {
  const tempDir = join(config.storage.tempPath, `download_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  
  try {
    // Crear directorio temporal
    await mkdir(tempDir, { recursive: true });
    
    // Procesar la playlist igual que el endpoint original
    const { playlistUrl, playlistUrls, maxConcurrency, limit, sortOrder, transcriptionSource, thumbnail, downloadOriginalThumbnail, usePlaylistIndex, saveProcessingPrompt, saveImagePrompt } = req.body;

    // Soporte para array de URLs o URL única
    const urls = playlistUrls || (playlistUrl ? [playlistUrl] : []);

    if (!urls || urls.length === 0) {
      return res.status(400).json({
        error: 'playlistUrl o playlistUrls es requerido',
      });
    }

    // Validar y parsear parámetros opcionales (igual que processPlaylist)
    const parsedMaxConcurrency = maxConcurrency ? parseInt(maxConcurrency, 10) : null;
    const parsedLimit = limit ? parseInt(limit, 10) : null;
    
    if (parsedMaxConcurrency !== null && (isNaN(parsedMaxConcurrency) || parsedMaxConcurrency < 1)) {
      return res.status(400).json({
        error: 'maxConcurrency debe ser un número mayor a 0',
      });
    }

    if (parsedLimit !== null && (isNaN(parsedLimit) || parsedLimit < 1)) {
      return res.status(400).json({
        error: 'limit debe ser un número mayor a 0',
      });
    }

    // Validar y parsear transcriptionSource
    const validSources = ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE'];
    let source = 'YOUTUBE';
    if (transcriptionSource) {
      const sourceStr = String(transcriptionSource);
      if (validSources.includes(sourceStr)) {
        source = sourceStr;
      } else {
        return res.status(400).json({
          error: `transcriptionSource debe ser uno de: ${validSources.join(', ')}`,
        });
      }
    }

    // Validar y parsear parámetros de miniatura
    let imageConfig = null;
    if (thumbnail !== undefined && thumbnail !== null) {
      const validModels = ['gpt-image-1.5'];
      const finalModel = thumbnail.model && validModels.includes(thumbnail.model) ? thumbnail.model : 'gpt-image-1.5';
      
      const validImageSizes = ['1536x1024'];
      const finalImageSize = thumbnail.size && validImageSizes.includes(thumbnail.size) ? thumbnail.size : '1536x1024';
      
      const validImageQualities = ['medium'];
      const finalImageQuality = thumbnail.quality && validImageQualities.includes(thumbnail.quality) ? thumbnail.quality : 'medium';

      const shouldSaveImagePrompt = thumbnail.saveImagePrompt !== undefined ? Boolean(thumbnail.saveImagePrompt) : false;
      imageConfig = {
        generate: true,
        model: finalModel,
        size: finalImageSize,
        quality: finalImageQuality,
        saveImagePrompt: shouldSaveImagePrompt,
      };
    }

    const shouldDownloadOriginal = downloadOriginalThumbnail !== undefined ? Boolean(downloadOriginalThumbnail) : true;
    const shouldUseIndex = usePlaylistIndex !== undefined ? Boolean(usePlaylistIndex) : true;
    const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
    const shouldSaveImagePrompt = imageConfig && imageConfig.saveImagePrompt !== undefined ? Boolean(imageConfig.saveImagePrompt) : false;

    // Validar sortOrder
    const validSortOrders = ['ASC', 'DESC'];
    let sort = 'ASC';
    if (sortOrder) {
      const sortStr = String(sortOrder).toUpperCase();
      if (validSortOrders.includes(sortStr)) {
        sort = sortStr;
      } else {
        return res.status(400).json({
          error: `sortOrder debe ser uno de: ${validSortOrders.join(', ')}`,
        });
      }
    }

    // Procesar cada playlist y recopilar archivos generados
    const allProcessedFiles = [];
    
    for (const url of urls) {
      const result = await processSinglePlaylistForDownload(
        url,
        null,
        parsedMaxConcurrency,
        parsedLimit,
        sort,
        source,
        imageConfig,
        shouldDownloadOriginal,
        shouldUseIndex,
        shouldSaveProcessingPrompt,
        shouldSaveImagePrompt,
        tempDir
      );
      
      if (result && result.files) {
        allProcessedFiles.push(...result.files);
      }
    }

    if (allProcessedFiles.length === 0) {
      // Limpiar antes de retornar
      await cleanupDirectory(tempDir);
      return res.status(400).json({
        error: 'No se generaron archivos para descargar',
      });
    }

    // Crear ZIP con todos los archivos organizados en carpetas
    const zipFileName = `processed_videos_${Date.now()}.zip`;
    const zipPath = join(tempDir, zipFileName);
    
    await createZipFromFiles(allProcessedFiles, zipPath, tempDir);
    
    // Enviar el ZIP como respuesta
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);
    
    const zipStream = createReadStream(zipPath);
    zipStream.pipe(res);
    
    // Limpiar archivos después de enviar
    zipStream.on('end', async () => {
      try {
        await cleanupDirectory(tempDir);
      } catch (cleanupError) {
        await logError(`Error al limpiar archivos temporales: ${cleanupError.message}`);
      }
    });
    
    zipStream.on('error', async (error) => {
      await logError(`Error al enviar ZIP: ${error.message}`);
      try {
        await cleanupDirectory(tempDir);
      } catch (cleanupError) {
        await logError(`Error al limpiar archivos temporales: ${cleanupError.message}`);
      }
    });
    
  } catch (error) {
    await logError(`Error en processPlaylistForDownload: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    
    // Limpiar en caso de error
    try {
      await cleanupDirectory(tempDir);
    } catch (cleanupError) {
      await logError(`Error al limpiar archivos temporales: ${cleanupError.message}`);
    }
    
    return res.status(500).json({
      error: 'Error al procesar playlist para descarga',
      message: error.message,
    });
  }
}

/**
 * Procesa una playlist y guarda los archivos en una estructura temporal organizada
 * Similar a processSinglePlaylist pero guarda en tempDir y retorna la lista de archivos
 */
async function processSinglePlaylistForDownload(playlistUrl, res, maxConcurrencyParam, limitParam, sortOrder, transcriptionSource, imageConfig, downloadOriginalThumbnail, usePlaylistIndex, saveProcessingPrompt, saveImagePrompt, tempDir) {
  const files = [];
  
  try {
    // Procesar la playlist normalmente pero interceptar los archivos generados
    // Llamar a processSinglePlaylist pero con un callback para recopilar archivos
    
    // Obtener lista de videos
    const playlistId = extractPlaylistId(playlistUrl);
    let videos = await getPlaylistVideos(playlistUrl);
    
    if (sortOrder === 'DESC') {
      videos = [...videos].reverse();
    }
    
    // Filtrar videos ya procesados si se usa índice
    let videosToProcess = [];
    if (usePlaylistIndex && playlistId) {
      const playlistIndex = await loadPlaylistIndex(playlistId);
      videosToProcess = videos.filter(video => !playlistIndex.has(video.id));
    } else {
      videosToProcess = videos.filter(video => !isVideoProcessed(video.id));
    }
    
    // Aplicar límite
    if (limitParam && limitParam > 0) {
      videosToProcess = videosToProcess.slice(0, limitParam);
    }
    
    if (videosToProcess.length === 0) {
      return { files: [] };
    }
    
    // Procesar videos usando processSingleVideo pero modificado para guardar en estructura temporal
    // Por ahora, vamos a procesar normalmente y luego copiar/organizar los archivos
    
    // Procesar cada video y recopilar archivos generados
    const maxConcurrency = maxConcurrencyParam || 3;
    const processedVideos = new Map(); // videoId -> lista de archivos generados
    
    // Función para procesar un video y recopilar sus archivos
    const processVideoAndCollectFiles = async (video, index) => {
      try {
        const videoId = video.id;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Procesar el video (esto generará archivos en callsPath)
        const result = await processSingleVideo(
          videoUrl,
          index + 1,
          videosToProcess.length,
          transcriptionSource,
          imageConfig,
          downloadOriginalThumbnail,
          saveProcessingPrompt,
          saveImagePrompt
        );
        
        // Buscar todos los archivos generados para este video
        const videoFiles = await findFilesForVideo(videoId, config.storage.callsPath);
        
        // Organizar archivos por llamada en carpetas con formato "[idYoutube] - Part1"
        const organizedFiles = await organizeFilesForDownload(videoId, videoFiles, tempDir);
        
        processedVideos.set(videoId, organizedFiles);
        
        return result;
      } catch (error) {
        await logError(`Error al procesar video ${video.id}: ${error.message}`);
        return { processed: false, error: error.message };
      }
    };
    
    // Procesar videos con concurrencia
    const processPool = [];
    let currentIndex = 0;
    
    while (currentIndex < videosToProcess.length || processPool.length > 0) {
      // Agregar nuevos videos al pool hasta alcanzar maxConcurrency
      while (processPool.length < maxConcurrency && currentIndex < videosToProcess.length) {
        const video = videosToProcess[currentIndex];
        const promise = processVideoAndCollectFiles(video, currentIndex).finally(() => {
          const index = processPool.indexOf(promise);
          if (index > -1) {
            processPool.splice(index, 1);
          }
        });
        processPool.push(promise);
        currentIndex++;
      }
      
      // Esperar a que al menos uno termine
      if (processPool.length > 0) {
        await Promise.race(processPool);
      }
    }
    
    // Recopilar todos los archivos organizados
    for (const [videoId, videoFiles] of processedVideos) {
      files.push(...videoFiles);
    }
    
    return { files };
  } catch (error) {
    await logError(`Error en processSinglePlaylistForDownload: ${error.message}`);
    throw error;
  }
}

/**
 * Encuentra todos los archivos generados para un video
 */
async function findFilesForVideo(videoId, callsPath) {
  const files = [];
  try {
    const entries = await readdir(callsPath);
    
    for (const entry of entries) {
      // Buscar archivos que empiecen con el videoId o contengan el videoId en el nombre
      // Esto incluye:
      // - Archivos de llamadas: "videoId - callNumber - title.ext"
      // - Archivos de procesamiento: "videoId_processing_prompt.txt"
      if (entry.startsWith(videoId) || entry.includes(videoId)) {
        const filePath = join(callsPath, entry);
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          files.push({
            name: entry,
            path: filePath,
          });
        }
      }
    }
  } catch (error) {
    await logError(`Error al buscar archivos para video ${videoId}: ${error.message}`);
  }
  
  return files;
}

/**
 * Organiza los archivos de un video en carpetas con formato "[idYoutube] - Part1"
 */
async function organizeFilesForDownload(videoId, files, tempDir) {
  const organizedFiles = [];
  
  // Agrupar archivos por llamada (basado en el nombre del archivo)
  // El formato es: "[videoId] - [callNumber] - [title].[ext]"
  const callsMap = new Map(); // callNumber -> archivos de la llamada
  
  for (const file of files) {
    const fileName = file.name;
    
    // Extraer número de llamada del nombre del archivo
    // Formato: "videoId - callNumber - title.ext"
    const match = fileName.match(new RegExp(`^${videoId}\\s*-\\s*(\\d+)\\s*-`));
    
    if (match) {
      const callNumber = parseInt(match[1], 10);
      const folderName = `${videoId} - Part${callNumber}`;
      
      if (!callsMap.has(callNumber)) {
        callsMap.set(callNumber, {
          folderName,
          files: [],
        });
      }
      
      callsMap.get(callNumber).files.push(file);
    } else {
      // Archivos que no siguen el formato (como processing_prompt.txt) van a una carpeta general
      const folderName = `${videoId} - General`;
      if (!callsMap.has(0)) {
        callsMap.set(0, {
          folderName,
          files: [],
        });
      }
      callsMap.get(0).files.push(file);
    }
  }
  
  // Copiar archivos a la estructura temporal organizada
  for (const [callNumber, callData] of callsMap) {
    const callFolderPath = join(tempDir, callData.folderName);
    await mkdir(callFolderPath, { recursive: true });
    
    for (const file of callData.files) {
      const destPath = join(callFolderPath, file.name);
      await copyFile(file.path, destPath);
      
      // Agregar a la lista de archivos organizados para el ZIP
      organizedFiles.push({
        sourcePath: destPath,
        zipPath: `${callData.folderName}/${file.name}`,
      });
    }
  }
  
  return organizedFiles;
}

/**
 * Crea un archivo ZIP a partir de una lista de archivos organizados
 */
async function createZipFromFiles(files, zipPath, baseDir) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Máxima compresión
    });

    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    // Agregar archivos al ZIP organizados en carpetas
    for (const fileInfo of files) {
      const { sourcePath, zipPath: fileZipPath } = fileInfo;
      if (existsSync(sourcePath)) {
        archive.file(sourcePath, { name: fileZipPath });
      }
    }

    archive.finalize();
  });
}

/**
 * Limpia un directorio y su contenido
 */
async function cleanupDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    return;
  }

  try {
    const entries = await readdir(dirPath);
    
    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      const entryStat = await stat(entryPath);
      
      if (entryStat.isDirectory()) {
        await cleanupDirectory(entryPath);
        await rmdir(entryPath);
      } else {
        await unlink(entryPath);
      }
    }
    
    await rmdir(dirPath);
  } catch (error) {
    await logError(`Error al limpiar directorio ${dirPath}: ${error.message}`);
    // No lanzar error para no interrumpir el flujo
  }
}

/**
 * Lista todos los videos procesados con sus metadatos
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
/**
 * Obtiene la lista de videos de un canal o lista de reproducción de YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function listVideosFromSource(req, res) {
  try {
    const { sourceUrl } = req.body;
    
    if (!sourceUrl) {
      return res.status(400).json({
        error: 'sourceUrl es requerido',
      });
    }
    
    console.log(`📋 Obteniendo lista de videos de: ${sourceUrl}`);
    const videos = await getPlaylistVideos(sourceUrl);
    console.log(`✅ Se encontraron ${videos.length} video(s)`);
    
    return res.json({
      success: true,
      sourceUrl,
      totalVideos: videos.length,
      videos: videos.map(video => ({
        id: video.id,
        url: `https://www.youtube.com/watch?v=${video.id}`,
        title: video.title || 'Sin título',
      })),
      message: `Se encontraron ${videos.length} video(s)`,
    });
  } catch (error) {
    await logError(`Error en listVideosFromSource: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al obtener la lista de videos',
      message: error.message,
    });
  }
}

export async function listVideos(req, res) {
  try {
    const { readdir, readFile, stat } = await import('fs/promises');
    const files = await readdir(config.storage.callsPath);
    
    // Filtrar solo archivos JSON
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    // Leer todos los archivos JSON
    const videos = [];
    
    for (const jsonFile of jsonFiles) {
      try {
        const filePath = join(config.storage.callsPath, jsonFile);
        const fileContent = await readFile(filePath, 'utf-8');
        const metadata = JSON.parse(fileContent);
        
        // Extraer nombre base del archivo (sin extensión)
        const baseName = jsonFile.replace('.json', '');
        
        // Construir rutas de las imágenes (usar la ruta del metadata si existe, sino construirla)
        let originalThumbnailPath = metadata.originalThumbnailPath;
        let generatedThumbnailPath = metadata.generatedThumbnailPath;
        
        // Si no hay ruta en metadata, intentar construirla con diferentes formatos
        if (!originalThumbnailPath) {
          // Intentar diferentes formatos
          const possibleOriginalPaths = [
            join(config.storage.callsPath, `${baseName}_original.jpg`),
            join(config.storage.callsPath, `${baseName}_original.png`),
            join(config.storage.callsPath, `${baseName}.jpg`), // Formato antiguo
            join(config.storage.callsPath, `${baseName}.png`), // Formato antiguo
          ];
          
          for (const path of possibleOriginalPaths) {
            if (existsSync(path)) {
              originalThumbnailPath = path;
              break;
            }
          }
        }
        
        if (!generatedThumbnailPath) {
          // Intentar diferentes formatos
          const possibleGeneratedPaths = [
            join(config.storage.callsPath, `${baseName}_generated.jpg`),
            join(config.storage.callsPath, `${baseName}_generated.png`),
          ];
          
          for (const path of possibleGeneratedPaths) {
            if (existsSync(path)) {
              generatedThumbnailPath = path;
              break;
            }
          }
        }
        
        // Verificar si las imágenes existen
        const originalThumbnailExists = originalThumbnailPath && existsSync(originalThumbnailPath);
        const generatedThumbnailExists = generatedThumbnailPath && existsSync(generatedThumbnailPath);
        
        // Construir URLs relativas para las imágenes
        const originalThumbnailUrl = originalThumbnailExists ? `/api/video/thumbnail/original/${encodeURIComponent(baseName)}` : null;
        const generatedThumbnailUrl = generatedThumbnailExists ? `/api/video/thumbnail/generated/${encodeURIComponent(baseName)}` : null;
        
        // Construir ruta del audio si no está en metadata
        let audioPath = metadata.audioFile;
        if (!audioPath) {
          // Intentar construir la ruta del audio
          const possibleAudioPaths = [
            join(config.storage.callsPath, `${baseName}.mp3`),
          ];
          
          for (const path of possibleAudioPaths) {
            if (existsSync(path)) {
              audioPath = path;
              break;
            }
          }
        }
        
        // Verificar si existe un video generado
        const possibleVideoPaths = [
          join(config.storage.callsPath, `${baseName}.mp4`),
        ];
        
        let hasVideo = false;
        let videoPath = null;
        for (const path of possibleVideoPaths) {
          if (existsSync(path)) {
            hasVideo = true;
            videoPath = path;
            break;
          }
        }
        
        videos.push({
          fileName: baseName,
          title: metadata.title || 'Sin título',
          description: metadata.description || 'Sin descripción',
          theme: metadata.theme || 'General',
          tags: metadata.tags || [],
          date: metadata.date || null,
          name: metadata.name || null,
          age: metadata.age || null,
          youtubeVideoId: metadata.youtubeVideoId || null,
          youtubeUrl: metadata.youtubeUrl || (metadata.youtubeVideoId ? `https://www.youtube.com/watch?v=${metadata.youtubeVideoId}` : null),
          originalThumbnailUrl: originalThumbnailUrl,
          generatedThumbnailUrl: generatedThumbnailUrl,
          callNumber: metadata.callNumber || 1,
          hasVideo: hasVideo,
          videoPath: videoPath,
          youtubeUploaded: metadata.youtubeUploaded || false,
          youtubeVideoId: metadata.youtubeVideoId || null,
          youtubeVideoUrl: metadata.youtubeVideoUrl || null,
          fullMetadata: {
            ...metadata,
            // Asegurar que las rutas estén incluidas
            audioFile: audioPath || metadata.audioFile,
            originalThumbnailPath: originalThumbnailPath || metadata.originalThumbnailPath,
            generatedThumbnailPath: generatedThumbnailPath || metadata.generatedThumbnailPath,
          }, // Incluir metadata completo para generar miniatura y video
        });
      } catch (error) {
        await logWarn(`Error al leer archivo ${jsonFile}: ${error.message}`);
        // Continuar con el siguiente archivo
      }
    }
    
    // Ordenar por fecha (más reciente primero) o por nombre de archivo
    videos.sort((a, b) => {
      if (a.date && b.date) {
        return new Date(b.date) - new Date(a.date);
      }
      return b.fileName.localeCompare(a.fileName);
    });
    
    return res.json({
      success: true,
      total: videos.length,
      videos: videos,
    });
  } catch (error) {
    await logError(`Error en listVideos: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al listar videos',
      message: error.message,
    });
  }
}

/**
 * Sirve la miniatura original de un video
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function serveOriginalThumbnail(req, res) {
  try {
    const { baseName } = req.params;
    const decodedBaseName = decodeURIComponent(baseName);
    
    // Buscar el archivo de miniatura original (intentar diferentes formatos)
    const possiblePaths = [
      join(config.storage.callsPath, `${decodedBaseName}_original.jpg`),
      join(config.storage.callsPath, `${decodedBaseName}_original.png`),
      join(config.storage.callsPath, `${decodedBaseName}.jpg`), // Formato antiguo
      join(config.storage.callsPath, `${decodedBaseName}.png`), // Formato antiguo
    ];
    
    let imagePath = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        imagePath = resolve(path); // Convertir a ruta absoluta
        break;
      }
    }
    
    if (!imagePath) {
      return res.status(404).json({
        error: 'Miniatura original no encontrada',
      });
    }
    
    return res.sendFile(imagePath);
  } catch (error) {
    await logError(`Error al servir miniatura original: ${error.message}`);
    return res.status(500).json({
      error: 'Error al servir miniatura',
      message: error.message,
    });
  }
}

/**
 * Sirve la miniatura generada de un video
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function serveGeneratedThumbnail(req, res) {
  try {
    const { baseName } = req.params;
    const decodedBaseName = decodeURIComponent(baseName);
    
    // Buscar el archivo de miniatura generada
    const possiblePaths = [
      join(config.storage.callsPath, `${decodedBaseName}_generated.jpg`),
      join(config.storage.callsPath, `${decodedBaseName}_generated.png`),
    ];
    
    let imagePath = null;
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        imagePath = resolve(path); // Convertir a ruta absoluta
        break;
      }
    }
    
    if (!imagePath) {
      return res.status(404).json({
        error: 'Miniatura generada no encontrada',
      });
    }
    
    return res.sendFile(imagePath);
  } catch (error) {
    await logError(`Error al servir miniatura generada: ${error.message}`);
    return res.status(500).json({
      error: 'Error al servir miniatura',
      message: error.message,
    });
  }
}

/**
 * Elimina todos los archivos relacionados con una llamada
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
/**
 * Descarga o regenera la miniatura original desde YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function downloadOriginalThumbnail(req, res) {
  try {
    const { fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    
    if (!decodedFileName || decodedFileName.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro fileName es requerido',
      });
    }
    
    // Leer el metadata para obtener el videoId y la URL de la miniatura
    let metadata = null;
    try {
      metadata = await readMetadataFile(decodedFileName);
    } catch (error) {
      return res.status(404).json({
        error: 'No se encontró el metadata para este video',
        message: error.message,
      });
    }
    
    if (!metadata.youtubeVideoId) {
      return res.status(400).json({
        error: 'El metadata no contiene youtubeVideoId',
      });
    }
    
    // Obtener la URL de la miniatura desde YouTube
    const thumbnailUrl = await getThumbnailUrl(metadata.youtubeVideoId);
    
    if (!thumbnailUrl) {
      return res.status(404).json({
        error: 'No se pudo obtener la URL de la miniatura desde YouTube',
      });
    }
    
    // Construir la ruta donde guardar la miniatura
    const originalThumbnailPath = join(config.storage.callsPath, `${decodedFileName}_original.jpg`);
    
    // Eliminar la miniatura anterior si existe
    if (metadata.originalThumbnailPath && existsSync(metadata.originalThumbnailPath)) {
      try {
        await unlink(metadata.originalThumbnailPath);
        await logInfo(`Miniatura original anterior eliminada: ${metadata.originalThumbnailPath}`);
      } catch (error) {
        await logWarn(`No se pudo eliminar la miniatura anterior ${metadata.originalThumbnailPath}: ${error.message}`);
      }
    }
    
    // También intentar eliminar si existe en la ruta estándar
    if (existsSync(originalThumbnailPath) && originalThumbnailPath !== metadata.originalThumbnailPath) {
      try {
        await unlink(originalThumbnailPath);
      } catch (error) {
        // Ignorar error si no se puede eliminar
      }
    }
    
    // Descargar la miniatura
    try {
      await downloadThumbnail(thumbnailUrl, originalThumbnailPath);
      
      // Actualizar el metadata
      metadata.originalThumbnailPath = originalThumbnailPath;
      await saveMetadataFile(decodedFileName, metadata);
      
      await logInfo(`Miniatura original descargada y metadata actualizado para ${decodedFileName}`);
      
      return res.json({
        success: true,
        imagePath: originalThumbnailPath,
        thumbnailUrl: thumbnailUrl,
        metadata: metadata,
      });
    } catch (error) {
      await logError(`Error al descargar miniatura original: ${error.message}`);
      return res.status(500).json({
        error: 'Error al descargar miniatura original',
        message: error.message,
      });
    }
  } catch (error) {
    await logError(`Error en downloadOriginalThumbnail: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al descargar miniatura original',
      message: error.message,
    });
  }
}

/**
 * Función auxiliar para eliminar archivos de una llamada
 * @param {string} decodedFileName - Nombre del archivo (decodificado)
 * @returns {Promise<{deletedFiles: Array, deletedCount: number, errors: Array}>}
 */
async function deleteCallFiles(decodedFileName) {
  // Lista de posibles archivos relacionados con la llamada
  const possibleFiles = [
    // Archivos principales
    `${decodedFileName}.json`, // Metadata
    `${decodedFileName}.mp3`, // Audio
    `${decodedFileName}.srt`, // Transcripción
    // Miniaturas
    `${decodedFileName}_original.jpg`,
    `${decodedFileName}_original.png`,
    `${decodedFileName}_generated.jpg`,
    `${decodedFileName}_generated.png`,
    `${decodedFileName}.jpg`, // Formato antiguo
    `${decodedFileName}.png`, // Formato antiguo
    // Prompts
    `${decodedFileName}_processing_prompt.txt`,
    `${decodedFileName}_image_prompt.txt`,
  ];
  
  const deletedFiles = [];
  const errors = [];
  
  // Intentar eliminar cada archivo
  for (const fileName of possibleFiles) {
    const filePath = join(config.storage.callsPath, fileName);
    
    if (existsSync(filePath)) {
      try {
        await unlink(filePath);
        deletedFiles.push(fileName);
        await logInfo(`Archivo eliminado: ${fileName}`);
      } catch (error) {
        errors.push({
          file: fileName,
          error: error.message,
        });
        await logWarn(`Error al eliminar ${fileName}: ${error.message}`);
      }
    }
  }
  
  return { deletedFiles, deletedCount: deletedFiles.length, errors };
}

export async function deleteCall(req, res) {
  try {
    const { fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    
    if (!decodedFileName || decodedFileName.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro fileName es requerido',
      });
    }
    
    const { deletedFiles, deletedCount, errors } = await deleteCallFiles(decodedFileName);
    
    if (deletedFiles.length === 0 && errors.length === 0) {
      return res.status(404).json({
        error: 'No se encontraron archivos para eliminar',
        fileName: decodedFileName,
      });
    }
    
    return res.json({
      success: true,
      fileName: decodedFileName,
      deletedFiles: deletedFiles,
      deletedCount: deletedCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    await logError(`Error en deleteCall: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al eliminar llamada',
      message: error.message,
    });
  }
}

/**
 * Función auxiliar para renombrar archivos cuando cambia el título
 * @param {string} decodedFileName - Nombre del archivo actual (sin extensión)
 * @param {string} newSanitizedFileName - Nuevo nombre del archivo (sin extensión, sanitizado)
 * @param {object} metadata - Metadata del video
 * @returns {Promise<{renamedFiles: Array, errors: Array}>}
 */
async function renameFilesForTitleChange(decodedFileName, newSanitizedFileName, metadata) {
  // Si el nuevo nombre es igual al actual, no hacer nada
  if (newSanitizedFileName === decodedFileName) {
    return { renamedFiles: [], errors: [] };
  }
  
  // Lista de archivos a renombrar
  const filesToRename = [
    { ext: '.json', required: true },
    { ext: '.mp3', required: false },
    { ext: '.srt', required: false },
    { ext: '_original.jpg', required: false },
    { ext: '_original.png', required: false },
    { ext: '_generated.jpg', required: false },
    { ext: '_generated.png', required: false },
    { ext: '.jpg', required: false }, // Formato antiguo
    { ext: '.png', required: false }, // Formato antiguo
    { ext: '_processing_prompt.txt', required: false },
    { ext: '_image_prompt.txt', required: false },
  ];
  
  const renamedFiles = [];
  const errors = [];
  
  // Renombrar cada archivo
  for (const fileInfo of filesToRename) {
    const oldFilePath = join(config.storage.callsPath, `${decodedFileName}${fileInfo.ext}`);
    const newFilePath = join(config.storage.callsPath, `${newSanitizedFileName}${fileInfo.ext}`);
    
    if (existsSync(oldFilePath)) {
      try {
        // En Windows, si el archivo destino existe, eliminarlo primero
        if (existsSync(newFilePath)) {
          await unlink(newFilePath);
        }
        
        await copyFile(oldFilePath, newFilePath);
        await unlink(oldFilePath);
        renamedFiles.push(`${decodedFileName}${fileInfo.ext} -> ${newSanitizedFileName}${fileInfo.ext}`);
        await logInfo(`Archivo renombrado: ${decodedFileName}${fileInfo.ext} -> ${newSanitizedFileName}${fileInfo.ext}`);
      } catch (error) {
        errors.push({
          file: `${decodedFileName}${fileInfo.ext}`,
          error: error.message,
        });
        await logWarn(`Error al renombrar ${decodedFileName}${fileInfo.ext}: ${error.message}`);
        
        // Si es un archivo requerido y falla, lanzar error
        if (fileInfo.required) {
          throw new Error(`Error al renombrar archivo requerido: ${decodedFileName}${fileInfo.ext} - ${error.message}`);
        }
      }
    }
  }
  
  // Actualizar rutas de archivos en el metadata
  if (metadata.originalThumbnailPath) {
    const newThumbPath = join(config.storage.callsPath, `${newSanitizedFileName}_original.jpg`);
    // Verificar si el archivo fue renombrado (debería existir con el nuevo nombre)
    if (existsSync(newThumbPath)) {
      metadata.originalThumbnailPath = newThumbPath;
    } else {
      // Si no existe con el nuevo nombre, verificar si existe con extensión .png
      const newThumbPathPng = join(config.storage.callsPath, `${newSanitizedFileName}_original.png`);
      if (existsSync(newThumbPathPng)) {
        metadata.originalThumbnailPath = newThumbPathPng;
      } else {
        // Si no existe, limpiar el campo
        metadata.originalThumbnailPath = null;
      }
    }
  }
  
  // Actualizar generatedThumbnailPath y generatedThumbnail
  if (metadata.generatedThumbnailPath) {
    const newGenThumbPath = join(config.storage.callsPath, `${newSanitizedFileName}_generated.jpg`);
    // Verificar si el archivo fue renombrado (debería existir con el nuevo nombre)
    if (existsSync(newGenThumbPath)) {
      metadata.generatedThumbnailPath = newGenThumbPath;
      metadata.generatedThumbnail = true;
    } else {
      // Si no existe con .jpg, verificar si existe con extensión .png
      const newGenThumbPathPng = join(config.storage.callsPath, `${newSanitizedFileName}_generated.png`);
      if (existsSync(newGenThumbPathPng)) {
        metadata.generatedThumbnailPath = newGenThumbPathPng;
        metadata.generatedThumbnail = true;
      } else {
        // Si no existe, limpiar los campos
        metadata.generatedThumbnailPath = null;
        metadata.generatedThumbnail = false;
      }
    }
  } else if (metadata.generatedThumbnail !== undefined) {
    // Si no hay path pero existe el campo booleano, verificar si existe el archivo
    const newGenThumbPath = join(config.storage.callsPath, `${newSanitizedFileName}_generated.jpg`);
    const newGenThumbPathPng = join(config.storage.callsPath, `${newSanitizedFileName}_generated.png`);
    if (existsSync(newGenThumbPath)) {
      metadata.generatedThumbnailPath = newGenThumbPath;
      metadata.generatedThumbnail = true;
    } else if (existsSync(newGenThumbPathPng)) {
      metadata.generatedThumbnailPath = newGenThumbPathPng;
      metadata.generatedThumbnail = true;
    } else {
      metadata.generatedThumbnail = false;
    }
  }
  
  return { renamedFiles, errors };
}

/**
 * Actualiza el título de una llamada manualmente y renombra todos los archivos relacionados
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function updateTitle(req, res) {
  try {
    const { fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    const { title } = req.body;
    
    if (!decodedFileName || decodedFileName.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro fileName es requerido',
      });
    }
    
    if (!title || title.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro title es requerido y no puede estar vacío',
      });
    }
    
    const newTitle = title.trim();
    
    // Leer el metadata usando el fileName actual
    let metadata = null;
    try {
      metadata = await readMetadataFile(decodedFileName);
    } catch (error) {
      // Si no se encuentra con el fileName, intentar usar el fileName del metadata si existe
      await logWarn(`No se pudo leer metadata con fileName ${decodedFileName}, intentando buscar por metadata.fileName`);
      
      // Intentar buscar el archivo usando el fileName del metadata si está disponible
      // Esto puede pasar si el fileName cambió pero el archivo JSON aún tiene el nombre anterior
      try {
        // Buscar todos los archivos JSON y encontrar el que tenga el fileName correcto
        const files = await readdir(config.storage.callsPath);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        
        for (const jsonFile of jsonFiles) {
          try {
            const filePath = join(config.storage.callsPath, jsonFile);
            const content = await readFile(filePath, 'utf-8');
            const testMetadata = JSON.parse(content);
            
            // Si el fileName del metadata coincide con el que buscamos
            if (testMetadata.fileName === decodedFileName) {
              metadata = testMetadata;
              await logInfo(`Metadata encontrado usando fileName del metadata: ${jsonFile}`);
              break;
            }
          } catch (err) {
            // Continuar con el siguiente archivo
            continue;
          }
        }
        
        if (!metadata) {
          throw new Error(`No se encontró el metadata para ${decodedFileName}`);
        }
      } catch (searchError) {
        return res.status(404).json({
          error: 'No se encontró el metadata para este video',
          message: error.message,
        });
      }
    }
    
    // Guardar el título anterior para el log
    const oldTitle = metadata.title || 'N/A';
    
    // PASO 1: Actualizar el título en el metadata primero (sin cambiar el fileName aún)
    metadata.title = newTitle;
    
    // Extraer videoId y callNumber del fileName actual o del metadata
    // Formato: "videoId - callNumber - oldTitle"
    const fileNameParts = decodedFileName.split(' - ');
    const videoId = fileNameParts[0] || metadata.youtubeVideoId;
    const callNumber = fileNameParts[1] || metadata.callNumber || 1;
    
    // Construir nuevo fileName con el nuevo título
    const newFileName = `${videoId} - ${callNumber} - ${newTitle}`;
    const newSanitizedFileName = sanitizeFilename(newFileName);
    
    // Si el nuevo nombre es igual al actual, solo actualizar el título en el metadata y guardar
    if (newSanitizedFileName === decodedFileName) {
      // Guardar el metadata actualizado con el nuevo título
      await saveMetadataFile(newSanitizedFileName, metadata);
      await logInfo(`Título actualizado en metadata (sin cambios en nombres de archivos) para ${newSanitizedFileName}`);
      
      return res.json({
        success: true,
        message: 'Título actualizado (sin cambios en nombres de archivos)',
        oldTitle: oldTitle,
        newTitle: newTitle,
        fileName: newSanitizedFileName,
      });
    }
    
    // PASO 2: Guardar el metadata actualizado con el nuevo título (aún con el fileName antiguo)
    // Esto asegura que si algo falla después, al menos el título está actualizado
    try {
      await saveMetadataFile(decodedFileName, metadata);
      await logInfo(`Metadata actualizado con nuevo título (antes de renombrar archivos) para ${decodedFileName}`);
    } catch (error) {
      await logWarn(`No se pudo guardar metadata antes de renombrar: ${error.message}`);
    }
    
    // PASO 3: Renombrar archivos físicos
    let renamedFiles = [];
    let errors = [];
    try {
      const renameResult = await renameFilesForTitleChange(decodedFileName, newSanitizedFileName, metadata);
      renamedFiles = renameResult.renamedFiles;
      errors = renameResult.errors;
    } catch (error) {
      await logError(`Error al renombrar archivos: ${error.message}`);
      return res.status(500).json({
        error: 'Error al renombrar archivos',
        message: error.message,
      });
    }
    
    // PASO 4: Actualizar el fileName en el metadata y las rutas de archivos
    metadata.fileName = newSanitizedFileName;
    
    // Actualizar rutas de archivos en el metadata (ya se hace en renameFilesForTitleChange, pero asegurémonos)
    if (metadata.originalThumbnailPath) {
      const newThumbPath = join(config.storage.callsPath, `${newSanitizedFileName}_original.jpg`);
      if (existsSync(newThumbPath)) {
        metadata.originalThumbnailPath = newThumbPath;
      } else {
        const newThumbPathPng = join(config.storage.callsPath, `${newSanitizedFileName}_original.png`);
        if (existsSync(newThumbPathPng)) {
          metadata.originalThumbnailPath = newThumbPathPng;
        }
      }
    }
    
    if (metadata.generatedThumbnailPath) {
      const newGenThumbPath = join(config.storage.callsPath, `${newSanitizedFileName}_generated.jpg`);
      if (existsSync(newGenThumbPath)) {
        metadata.generatedThumbnailPath = newGenThumbPath;
        metadata.generatedThumbnail = true;
      } else {
        const newGenThumbPathPng = join(config.storage.callsPath, `${newSanitizedFileName}_generated.png`);
        if (existsSync(newGenThumbPathPng)) {
          metadata.generatedThumbnailPath = newGenThumbPathPng;
          metadata.generatedThumbnail = true;
        }
      }
    }
    
    // PASO 5: Guardar el metadata final con el nuevo fileName
    try {
      await saveMetadataFile(newSanitizedFileName, metadata);
      await logInfo(`Metadata actualizado con nuevo título y fileName para ${newSanitizedFileName}`);
    } catch (error) {
      await logError(`Error al guardar metadata final: ${error.message}`);
      return res.status(500).json({
        error: 'Error al guardar metadata actualizado',
        message: error.message,
      });
    }
    
    return res.json({
      success: true,
      oldFileName: decodedFileName,
      newFileName: newSanitizedFileName,
      oldTitle: oldTitle,
      newTitle: newTitle,
      renamedFiles: renamedFiles,
      renamedCount: renamedFiles.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: metadata,
    });
  } catch (error) {
    await logError(`Error en updateTitle: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al actualizar título',
      message: error.message,
    });
  }
}

/**
 * Regenera el título de una llamada y renombra todos los archivos relacionados
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function regenerateTitle(req, res) {
  try {
    const { fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    
    if (!decodedFileName || decodedFileName.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro fileName es requerido',
      });
    }
    
    // Leer el metadata para obtener el resumen y el videoId
    let metadata = null;
    try {
      metadata = await readMetadataFile(decodedFileName);
    } catch (error) {
      return res.status(404).json({
        error: 'No se encontró el metadata para este video',
        message: error.message,
      });
    }
    
    if (!metadata.summary) {
      return res.status(400).json({
        error: 'El metadata no contiene summary, necesario para generar el título',
      });
    }
    
    // Generar nuevo título
    let newTitle = null;
    try {
      newTitle = await generateTitle(metadata.summary);
      await logInfo(`Nuevo título generado para ${decodedFileName}: ${newTitle}`);
    } catch (error) {
      await logError(`Error al generar título: ${error.message}`);
      return res.status(500).json({
        error: 'Error al generar título',
        message: error.message,
      });
    }
    
    if (!newTitle || newTitle.trim() === '') {
      return res.status(500).json({
        error: 'El título generado está vacío',
      });
    }
    
    // Extraer videoId y callNumber del fileName actual
    // Formato: "videoId - callNumber - oldTitle"
    const fileNameParts = decodedFileName.split(' - ');
    const videoId = fileNameParts[0] || metadata.youtubeVideoId;
    const callNumber = fileNameParts[1] || metadata.callNumber || 1;
    
    // Construir nuevo fileName con el nuevo título
    const newFileName = `${videoId} - ${callNumber} - ${newTitle}`;
    const newSanitizedFileName = sanitizeFilename(newFileName);
    
    // Si el nuevo nombre es igual al actual, no hacer nada
    if (newSanitizedFileName === decodedFileName) {
      return res.json({
        success: true,
        message: 'El título generado es igual al actual',
        title: newTitle,
        fileName: newSanitizedFileName,
      });
    }
    
    // Renombrar archivos usando la función auxiliar
    let renamedFiles = [];
    let errors = [];
    try {
      const renameResult = await renameFilesForTitleChange(decodedFileName, newSanitizedFileName, metadata);
      renamedFiles = renameResult.renamedFiles;
      errors = renameResult.errors;
    } catch (error) {
      await logError(`Error al renombrar archivos: ${error.message}`);
      return res.status(500).json({
        error: 'Error al renombrar archivos',
        message: error.message,
      });
    }
    
    // Actualizar el metadata con el nuevo título y fileName
    metadata.title = newTitle;
    metadata.fileName = newSanitizedFileName;
    
    // Guardar el metadata actualizado
    try {
      await saveMetadataFile(newSanitizedFileName, metadata);
      await logInfo(`Metadata actualizado con nuevo título para ${newSanitizedFileName}`);
    } catch (error) {
      await logError(`Error al guardar metadata actualizado: ${error.message}`);
      return res.status(500).json({
        error: 'Error al guardar metadata actualizado',
        message: error.message,
      });
    }
    
    return res.json({
      success: true,
      oldFileName: decodedFileName,
      newFileName: newSanitizedFileName,
      oldTitle: metadata.title || 'N/A',
      newTitle: newTitle,
      renamedFiles: renamedFiles,
      renamedCount: renamedFiles.length,
      errors: errors.length > 0 ? errors : undefined,
      metadata: metadata,
    });
  } catch (error) {
    await logError(`Error en regenerateTitle: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al regenerar título',
      message: error.message,
    });
  }
}

/**
 * Agrega un video a la lista negra y elimina todos sus archivos
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function blacklistCall(req, res) {
  try {
    const { fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    
    if (!decodedFileName || decodedFileName.trim() === '') {
      return res.status(400).json({
        error: 'El parámetro fileName es requerido',
      });
    }
    
    // Leer el metadata para obtener el youtubeVideoId
    let metadata = null;
    let youtubeVideoId = null;
    
    try {
      metadata = await readMetadataFile(decodedFileName);
      youtubeVideoId = metadata.youtubeVideoId;
    } catch (error) {
      await logWarn(`No se pudo leer metadata para ${decodedFileName}: ${error.message}`);
    }
    
    // Si no hay videoId en el metadata, intentar extraerlo del fileName
    if (!youtubeVideoId) {
      // El formato del fileName suele ser: "videoId - callNumber - title"
      const match = decodedFileName.match(/^([^-\s]+)/);
      if (match) {
        youtubeVideoId = match[1];
      }
    }
    
    if (!youtubeVideoId) {
      return res.status(400).json({
        error: 'No se pudo determinar el ID del video de YouTube',
        fileName: decodedFileName,
      });
    }
    
    // Agregar a la lista negra
    try {
      await addToBlacklist(youtubeVideoId);
      await logInfo(`Video ${youtubeVideoId} agregado a la lista negra`);
    } catch (error) {
      await logError(`Error al agregar a la lista negra: ${error.message}`);
      return res.status(500).json({
        error: 'Error al agregar a la lista negra',
        message: error.message,
      });
    }
    
    // Eliminar todos los archivos relacionados
    const { deletedFiles, deletedCount, errors } = await deleteCallFiles(decodedFileName);
    
    return res.json({
      success: true,
      fileName: decodedFileName,
      youtubeVideoId: youtubeVideoId,
      addedToBlacklist: true,
      deletedFiles: deletedFiles,
      deletedCount: deletedCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    await logError(`Error en blacklistCall: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al agregar a lista negra y eliminar archivos',
      message: error.message,
    });
  }
}

/**
 * Verifica si un video está en la lista negra
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function checkBlacklist(req, res) {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({
        error: 'videoId es requerido',
      });
    }
    
    const isBlacklisted = await isVideoBlacklisted(videoId);
    
    return res.json({
      videoId,
      isBlacklisted,
      message: isBlacklisted ? 'Video está en lista negra' : 'Video no está en lista negra',
    });
  } catch (error) {
    await logError(`Error en checkBlacklist: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al verificar lista negra',
      message: error.message,
    });
  }
}

/**
 * Verifica si un video ya fue procesado
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function checkProcessed(req, res) {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({
        error: 'videoId es requerido',
      });
    }
    
    const alreadyProcessed = await isVideoProcessed(videoId);
    const calls = alreadyProcessed ? await findCallsByVideoId(videoId) : [];
    
    return res.json({
      videoId,
      isProcessed: alreadyProcessed,
      callsCount: calls.length,
      calls: calls.map(call => ({
        callId: call.callId,
        callNumber: call.callNumber,
        fileName: call.fileName,
        title: call.title,
        youtubeVideoId: call.youtubeVideoId,
      })),
      message: alreadyProcessed ? `Video ya procesado (${calls.length} llamadas)` : 'Video no procesado',
    });
  } catch (error) {
    await logError(`Error en checkProcessed: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al verificar si el video fue procesado',
      message: error.message,
    });
  }
}

/**
 * Descarga el audio de un video de YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function downloadVideoAudio(req, res) {
  try {
    const { videoUrl } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({
        error: 'videoUrl es requerido',
      });
    }
    
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({
        error: 'URL de YouTube no válida',
      });
    }
    
    console.log(`⬇️  Descargando audio de ${videoId}...`);
    const { audioPath, title, uploadDate } = await downloadAudio(videoUrl, 1, 1, videoId);
    console.log(`✅ Audio descargado: ${title || 'Sin título'}`);
    
    return res.json({
      success: true,
      videoId,
      videoUrl,
      audioPath,
      title,
      uploadDate,
      message: 'Audio descargado exitosamente',
    });
  } catch (error) {
    await logError(`Error en downloadVideoAudio: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al descargar audio',
      message: error.message,
    });
  }
}

/**
 * Transcribe un archivo de audio
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function transcribeAudioFile(req, res) {
  try {
    const { audioPath, transcriptionSource, videoId, youtubeUrl } = req.body;
    
    if (!audioPath) {
      return res.status(400).json({
        error: 'audioPath es requerido',
      });
    }
    
    if (!transcriptionSource) {
      return res.status(400).json({
        error: 'transcriptionSource es requerido (WHISPER-OpenAI, WHISPER-LOCAL, YOUTUBE)',
      });
    }
    
    const validSources = ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE'];
    if (!validSources.includes(transcriptionSource)) {
      return res.status(400).json({
        error: `transcriptionSource debe ser uno de: ${validSources.join(', ')}`,
      });
    }
    
    if (transcriptionSource === 'YOUTUBE' && !youtubeUrl) {
      return res.status(400).json({
        error: 'youtubeUrl es requerido cuando transcriptionSource es YOUTUBE',
      });
    }
    
    // Compresión de audio fija al 50%
    const audioCompression = 50;
    
    console.log(`🎤 Transcribiendo audio: ${audioPath}...`);
    const result = await transcribeAudio(
      audioPath,
      1,
      1,
      videoId || '',
      youtubeUrl || '',
      transcriptionSource,
      audioCompression
    );
    console.log(`✅ Transcripción completada`);
    
    // Guardar transcripción en temp si hay videoId
    let transcriptionPath = null;
    if (videoId) {
      transcriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
      const { writeFile } = await import('fs/promises');
      await writeFile(transcriptionPath, result.srt, 'utf-8');
    }
    
    return res.json({
      success: true,
      transcription: result.transcription,
      srt: result.srt,
      segments: result.segments,
      speakers: result.speakers,
      transcriptionPath,
      message: 'Transcripción completada exitosamente',
    });
  } catch (error) {
    await logError(`Error en transcribeAudioFile: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al transcribir audio',
      message: error.message,
    });
  }
}

/**
 * Genera un video a partir de un audio, una imagen de fondo y opcionalmente visualización de audio
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function generateVideo(req, res) {
  try {
    const { audioPath, imagePath, outputPath, visualizationType, videoCodec, audioCodec, fps, resolution, bitrate, barCount, barPositionY, barOpacity } = req.body;

    if (!audioPath) {
      return res.status(400).json({
        error: 'audioPath es requerido',
      });
    }

    if (!imagePath) {
      return res.status(400).json({
        error: 'imagePath es requerido',
      });
    }

    // Si no se proporciona outputPath, generar uno automáticamente
    let finalOutputPath = outputPath;
    if (!finalOutputPath) {
      const audioName = basename(audioPath, '.mp3');
      finalOutputPath = join(config.storage.tempPath, `${audioName}_video.mp4`);
    }

    // Validar que los archivos existan
    if (!existsSync(audioPath)) {
      return res.status(400).json({
        error: 'El archivo de audio no existe',
        audioPath,
      });
    }

    if (!existsSync(imagePath)) {
      return res.status(400).json({
        error: 'La imagen de fondo no existe',
        imagePath,
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('🎬 NUEVA SOLICITUD DE GENERACIÓN DE VIDEO');
    console.log('='.repeat(60));
    console.log(`📁 Audio: ${audioPath}`);
    console.log(`🖼️  Imagen: ${imagePath}`);
    console.log(`💾 Salida: ${finalOutputPath}`);
    console.log(`📹 Visualización: ${visualizationType || 'none'}`);
    console.log(`⚙️  Resolución: ${resolution || '1920x1080'}`);
    console.log(`🎞️  FPS: ${fps || 30}`);
    console.log(`📊 Bitrate: ${bitrate || 5000} kbps`);
    console.log('='.repeat(60) + '\n');

    // Generar el video
    const videoPath = await generateVideoFromAudio(
      audioPath,
      imagePath,
      finalOutputPath,
      {
        visualizationType: visualizationType || 'none',
        videoCodec: videoCodec || 'libx264',
        audioCodec: audioCodec || 'aac',
        fps: fps || 30,
        resolution: resolution || '1920x1080',
        bitrate: bitrate || 5000,
        barCount: barCount || 64,
        barPositionY: barPositionY !== undefined ? barPositionY : null,
        barOpacity: barOpacity !== undefined ? barOpacity : 0.7,
      }
    );

    console.log('\n' + '='.repeat(60));
    console.log('✅ GENERACIÓN COMPLETADA EXITOSAMENTE');
    console.log('='.repeat(60));
    console.log(`📁 Video guardado en: ${videoPath}`);
    console.log('='.repeat(60) + '\n');

    return res.json({
      success: true,
      videoPath,
      message: 'Video generado exitosamente',
    });
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ ERROR EN GENERACIÓN DE VIDEO');
    console.error('='.repeat(60));
    console.error(`Mensaje: ${error.message}`);
    if (error.stack) {
      console.error(`Stack: ${error.stack}`);
    }
    console.error('='.repeat(60) + '\n');
    
    await logError(`Error en generateVideo: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al generar video',
      message: error.message,
    });
  }
}

/**
 * Obtiene la URL de la miniatura de un video de YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function getVideoThumbnailUrl(req, res) {
  try {
    const { videoId, videoUrl } = req.body;
    
    let finalVideoId = videoId;
    
    if (!finalVideoId && videoUrl) {
      finalVideoId = extractVideoId(videoUrl);
    }
    
    if (!finalVideoId) {
      return res.status(400).json({
        error: 'videoId o videoUrl es requerido',
      });
    }
    
    console.log(`🖼️  Obteniendo URL de miniatura para ${finalVideoId}...`);
    const thumbnailUrl = await getThumbnailUrl(finalVideoId);
    console.log(`✅ URL de miniatura obtenida`);
    
    return res.json({
      success: true,
      videoId: finalVideoId,
      thumbnailUrl,
      message: 'URL de miniatura obtenida exitosamente',
    });
  } catch (error) {
    await logError(`Error en getVideoThumbnailUrl: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al obtener URL de miniatura',
      message: error.message,
    });
  }
}

/**
 * Descarga la transcripción de un video desde YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function downloadYouTubeTranscription(req, res) {
  try {
    const { videoUrl, videoId: videoIdParam } = req.body;
    
    let videoId = videoIdParam;
    let finalVideoUrl = videoUrl;
    
    if (!videoId && !videoUrl) {
      return res.status(400).json({
        error: 'videoUrl o videoId es requerido',
      });
    }
    
    if (!videoId && videoUrl) {
      videoId = extractVideoId(videoUrl);
      finalVideoUrl = videoUrl;
    } else if (videoId && !videoUrl) {
      finalVideoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    if (!videoId) {
      return res.status(400).json({
        error: 'No se pudo extraer videoId de la URL',
      });
    }
    
    console.log(`📥 Descargando transcripción de YouTube para ${videoId}...`);
    const { downloadSubtitles } = await import('../services/youtubeService.js');
    const result = await downloadSubtitles(finalVideoUrl, videoId, 1, 1);
    
    // Convertir al formato esperado
    const formattedSegments = result.segments.map((segment, index) => ({
      id: index,
      seek: Math.floor(segment.start * 100),
      start: segment.start,
      end: segment.end,
      text: segment.text,
      tokens: [],
      temperature: 0.0,
      avg_logprob: -1.0,
      compression_ratio: 1.0,
      no_speech_prob: 0.0,
    }));
    
    // Generar SRT usando la función del servicio de transcripción
    const { generateSRT } = await import('../services/transcriptionService.js');
    const srt = generateSRT(formattedSegments);
    
    // Guardar transcripción en temp
    const transcriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
    const { writeFile } = await import('fs/promises');
    await writeFile(transcriptionPath, srt, 'utf-8');
    
    console.log(`✅ Transcripción descargada`);
    
    return res.json({
      success: true,
      videoId,
      videoUrl: finalVideoUrl,
      srt,
      segments: formattedSegments,
      transcriptionPath,
      message: 'Transcripción descargada exitosamente',
    });
  } catch (error) {
    await logError(`Error en downloadYouTubeTranscription: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al descargar transcripción de YouTube',
      message: error.message,
    });
  }
}

/**
 * Procesa un audio MP3: separa llamadas, recorta audios y limpia temporales
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function processAudioFile(req, res) {
  try {
    const { 
      audioPath, 
      transcriptionPath, 
      videoId, 
      youtubeUrl, 
      uploadDate,
      thumbnailUrl,
      saveProcessingPrompt,
      saveImagePrompt,
      thumbnail,
      downloadOriginalThumbnail
    } = req.body;
    
    if (!audioPath) {
      return res.status(400).json({
        error: 'audioPath es requerido',
      });
    }
    
    if (!transcriptionPath) {
      return res.status(400).json({
        error: 'transcriptionPath es requerido',
      });
    }
    
    if (!videoId) {
      return res.status(400).json({
        error: 'videoId es requerido',
      });
    }
    
    // Verificar que los archivos existan
    if (!existsSync(audioPath)) {
      return res.status(400).json({
        error: `El archivo de audio no existe: ${audioPath}`,
      });
    }
    
    if (!existsSync(transcriptionPath)) {
      return res.status(400).json({
        error: `El archivo de transcripción no existe: ${transcriptionPath}`,
      });
    }
    
    // Leer transcripción
    const { readFile } = await import('fs/promises');
    const srt = await readFile(transcriptionPath, 'utf-8');
    
    // Parsear SRT a segments
    const segments = parseSRTToSegments(srt);
    
    // Procesar datos (separar llamadas)
    const processingPromptPath = saveProcessingPrompt ? join(config.storage.callsPath, `${videoId}_processing_prompt.txt`) : null;
    const shouldSaveProcessingPrompt = saveProcessingPrompt !== undefined ? Boolean(saveProcessingPrompt) : false;
    
    console.log(`🤖 Procesando datos de ${videoId}...`);
    const separatedCalls = await separateCalls(segments, srt, 1, 1, videoId, shouldSaveProcessingPrompt, processingPromptPath);
    console.log(`✅ Procesamiento de datos completado - ${separatedCalls.length} llamadas encontradas`);
    
    // Procesar cada llamada
    const processedCalls = [];
    const totalCalls = separatedCalls.length;
    
    // Validar configuración de miniatura
    let imageConfig = null;
    if (thumbnail !== undefined && thumbnail !== null) {
      const validModels = ['gpt-image-1.5'];
      const finalModel = thumbnail.model && validModels.includes(thumbnail.model) ? thumbnail.model : 'gpt-image-1.5';
      const validImageSizes = ['1536x1024'];
      const finalImageSize = thumbnail.size && validImageSizes.includes(thumbnail.size) ? thumbnail.size : '1536x1024';
      const validImageQualities = ['medium'];
      const finalImageQuality = thumbnail.quality && validImageQualities.includes(thumbnail.quality) ? thumbnail.quality : 'medium';
      const shouldSaveImagePrompt = thumbnail.saveImagePrompt !== undefined ? Boolean(thumbnail.saveImagePrompt) : false;
      imageConfig = {
        generate: true,
        model: finalModel,
        size: finalImageSize,
        quality: finalImageQuality,
        saveImagePrompt: shouldSaveImagePrompt,
      };
    }
    
    const shouldSaveImagePrompt = saveImagePrompt !== undefined ? Boolean(saveImagePrompt) : false;
    const shouldDownloadOriginal = downloadOriginalThumbnail !== undefined ? Boolean(downloadOriginalThumbnail) : true;
    
    for (let i = 0; i < separatedCalls.length; i++) {
      const call = separatedCalls[i];
      const callNumber = i + 1;
      
      try {
        console.log(`✂️  Recortando llamada ${callNumber}/${totalCalls}...`);
        
        // Preparar metadatos
        const metadata = {
          title: call.title || 'Llamada sin título',
          description: call.description || 'Sin descripción disponible',
          theme: call.topic || 'General',
          tags: call.tags || [],
          date: uploadDate || new Date().toISOString().split('T')[0],
          name: call.name || null,
          age: call.age || null,
          summary: call.summary || null,
          thumbnailScene: call.thumbnailScene || null,
          youtubeVideoId: videoId,
          youtubeUrl: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`,
          speakers: ['Conductor', 'Llamante'],
        };
        
        // Generar nombre de archivo
        const fileName = `${videoId} - ${callNumber} - ${metadata.title}`;
        const sanitizedFileName = sanitizeFilename(fileName);
        
        // Extraer segmento de audio
        const callAudioPath = join(config.storage.callsPath, `${sanitizedFileName}.mp3`);
        await extractAudioSegment(audioPath, call.start, call.end, callAudioPath, 1, 1, videoId, callNumber, totalCalls);
        
        // Generar SRT para esta llamada
        const callSegments = segments.filter(
          (seg) => seg.start >= call.start && seg.end <= call.end
        );
        const callSRT = generateCallSRT(callSegments, call.start);
        
        // Guardar transcripción
        const savedTranscriptionPath = await saveTranscriptionFile(sanitizedFileName, callSRT);
        
        // Descargar miniatura original si está configurado
        const originalThumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}_original.jpg`);
        let originalThumbnailExists = false;
        
        if (shouldDownloadOriginal && thumbnailUrl && !existsSync(originalThumbnailPath)) {
          try {
            await downloadThumbnail(thumbnailUrl, originalThumbnailPath);
            originalThumbnailExists = existsSync(originalThumbnailPath);
          } catch (error) {
            console.warn(`⚠️  No se pudo descargar miniatura original: ${error.message}`);
          }
        } else if (existsSync(originalThumbnailPath)) {
          originalThumbnailExists = true;
        }
        
        // Generar miniatura si está configurado
        let generatedImagePath = null;
        const imagePromptPath = shouldSaveImagePrompt ? join(config.storage.callsPath, `${sanitizedFileName}_image_prompt.txt`) : null;
        
        if (imageConfig && imageConfig.generate) {
          try {
            const generatedThumbnailPath = join(config.storage.callsPath, `${sanitizedFileName}_generated.jpg`);
            generatedImagePath = await generateThumbnailImage(
              metadata,
              generatedThumbnailPath,
              1,
              1,
              videoId,
              callNumber,
              totalCalls,
              imageConfig,
              shouldSaveImagePrompt,
              imagePromptPath
            );
          } catch (error) {
            console.warn(`⚠️  No se pudo generar imagen para ${sanitizedFileName}: ${error.message}`);
          }
        }
        
        // Guardar metadata
        const fullMetadata = {
          callId: uuidv4(),
          callNumber,
          fileName: sanitizedFileName,
          thumbnailUrl: thumbnailUrl || null,
          originalThumbnailPath: originalThumbnailExists ? originalThumbnailPath : null,
          generatedThumbnailPath: generatedImagePath && existsSync(generatedImagePath) ? generatedImagePath : null,
          generatedThumbnail: generatedImagePath && existsSync(generatedImagePath) ? true : false,
          processingPromptPath: processingPromptPath && existsSync(processingPromptPath) ? processingPromptPath : null,
          imagePromptPath: imagePromptPath && existsSync(imagePromptPath) ? imagePromptPath : null,
          ...metadata,
        };
        const savedMetadataPath = await saveMetadataFile(sanitizedFileName, fullMetadata);
        
        processedCalls.push({
          callId: fullMetadata.callId,
          callNumber,
          fileName: sanitizedFileName,
          youtubeVideoId: videoId,
          youtubeUrl: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`,
          title: metadata.title,
          description: metadata.description,
          theme: metadata.theme,
          tags: metadata.tags,
          date: metadata.date,
          name: metadata.name,
          age: metadata.age,
          summary: metadata.summary,
          speakers: metadata.speakers,
          thumbnailUrl: thumbnailUrl || null,
          generatedThumbnailFile: generatedImagePath && existsSync(generatedImagePath) ? generatedImagePath : null,
          audioFile: callAudioPath,
          transcriptionFile: savedTranscriptionPath,
          metadataFile: savedMetadataPath,
        });
      } catch (error) {
        console.warn(`⚠️  Error al procesar llamada ${callNumber}: ${error.message}`);
        // Continuar con la siguiente llamada
      }
    }
    
    // Limpiar archivos temporales
    try {
      if (existsSync(audioPath)) {
        await unlink(audioPath);
      }
      if (existsSync(transcriptionPath)) {
        await unlink(transcriptionPath);
      }
      // Limpiar versiones comprimidas si existen
      const audioDir = dirname(audioPath);
      const audioBaseName = basename(audioPath, '.mp3');
      const compressedPaths = [
        join(audioDir, `${audioBaseName}_min.mp3`),
        join(audioDir, `${audioBaseName}_min2.mp3`),
      ];
      for (const compressedPath of compressedPaths) {
        if (existsSync(compressedPath)) {
          await unlink(compressedPath);
        }
      }
    } catch (error) {
      console.warn('⚠️  Error al eliminar archivos temporales:', error.message);
    }
    
    console.log(`✅ Audio procesado exitosamente (${processedCalls.length} llamadas)`);
    
    return res.json({
      success: true,
      videoId,
      processed: true,
      calls: processedCalls,
      message: `Audio procesado exitosamente (${processedCalls.length} llamadas)`,
    });
  } catch (error) {
    await logError(`Error en processAudioFile: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al procesar audio',
      message: error.message,
    });
  }
}

/**
 * Sube un video generado a YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function uploadVideoToYouTube(req, res) {
  try {
    const { videoPath, title, description, tags, privacyStatus, thumbnailPath, metadataPath } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        error: 'videoPath es requerido',
      });
    }

    if (!existsSync(videoPath)) {
      return res.status(400).json({
        error: 'El archivo de video no existe',
        videoPath,
      });
    }

    // Cargar metadata si está disponible
    let metadata = {};
    if (metadataPath && existsSync(metadataPath)) {
      try {
        const metadataContent = readFileSync(metadataPath, 'utf8');
        metadata = JSON.parse(metadataContent);
      } catch (error) {
        console.warn(`No se pudo cargar metadata desde ${metadataPath}: ${error.message}`);
      }
    }

    // Usar metadata del JSON o los parámetros proporcionados
    const videoMetadata = {
      title: title || metadata.title || 'Sin título',
      description: description || metadata.shortDescription || metadata.description || '',
      tags: tags || metadata.tags || [],
      privacyStatus: privacyStatus || 'public',
      thumbnailPath: thumbnailPath || metadata.generatedThumbnailPath || metadata.originalThumbnailPath || null,
    };

    console.log('\n' + '='.repeat(60));
    console.log('📤 SUBIENDO VIDEO A YOUTUBE');
    console.log('='.repeat(60));
    console.log(`📁 Video: ${videoPath}`);
    console.log(`📝 Título: ${videoMetadata.title}`);
    console.log(`🔒 Privacidad: ${videoMetadata.privacyStatus}`);
    console.log('='.repeat(60) + '\n');

    // Subir el video
    const { uploadVideoToYouTube: uploadVideo } = await import('../services/youtubeUploadService.js');
    const result = await uploadVideo(videoPath, videoMetadata);

    // Actualizar metadata si se proporcionó metadataPath
    if (metadataPath && existsSync(metadataPath)) {
      try {
        const metadataContent = readFileSync(metadataPath, 'utf8');
        const updatedMetadata = JSON.parse(metadataContent);
        
        // Agregar información de YouTube
        updatedMetadata.youtubeUploaded = true;
        updatedMetadata.youtubeVideoId = result.videoId;
        updatedMetadata.youtubeVideoUrl = result.videoUrl;
        updatedMetadata.youtubeUploadDate = new Date().toISOString();
        
        // Guardar metadata actualizado
        writeFileSync(metadataPath, JSON.stringify(updatedMetadata, null, 2));
        console.log(`✅ Metadata actualizado: ${metadataPath}`);
      } catch (error) {
        console.warn(`⚠️  No se pudo actualizar metadata: ${error.message}`);
      }
    }

    return res.json({
      success: true,
      videoId: result.videoId,
      videoUrl: result.videoUrl,
      title: result.title,
      message: 'Video subido exitosamente a YouTube',
    });
  } catch (error) {
    console.error('❌ Error al subir video a YouTube:', error.message);
    // Si el error es de autenticación, incluir la URL de autenticación
    if (error.message.includes('No se encontró el token de acceso') || error.message.includes('autentica primero')) {
      try {
        const { getAuthUrl } = await import('../services/youtubeUploadService.js');
        const authUrl = await getAuthUrl();
        return res.status(401).json({
          error: 'Autenticación requerida',
          message: error.message,
          authUrl: authUrl,
          requiresAuth: true,
        });
      } catch (authError) {
        // Si no se puede obtener la URL, devolver el error original
      }
    }
    
    return res.status(500).json({
      error: 'Error al subir video a YouTube',
      message: error.message,
    });
  }
}

/**
 * Obtiene la URL de autenticación de YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function getYouTubeAuthUrl(req, res) {
  try {
    const { getAuthUrl } = await import('../services/youtubeUploadService.js');
    const authUrl = await getAuthUrl();
    
    return res.json({
      success: true,
      authUrl: authUrl,
      message: 'URL de autenticación generada',
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Error al obtener URL de autenticación',
      message: error.message,
    });
  }
}

/**
 * Guarda el código de autorización de YouTube
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function saveYouTubeAuthCode(req, res) {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({
        error: 'code es requerido',
      });
    }
    
    const { saveAuthorizationCode } = await import('../services/youtubeUploadService.js');
    const tokens = await saveAuthorizationCode(code);
    
    return res.json({
      success: true,
      message: 'Autenticación exitosa. Token guardado correctamente.',
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Error al guardar código de autorización',
      message: error.message,
    });
  }
}

/**
 * Callback de OAuth de YouTube - captura el código de autorización
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function youtubeAuthCallback(req, res) {
  try {
    const { code, error } = req.query;
    
    if (error) {
      // Si hay un error en la autorización
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Error de Autenticación</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .error { background: #ffebee; color: #c62828; padding: 20px; border-radius: 8px; max-width: 600px; margin: 0 auto; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Error de Autenticación</h1>
            <p>${error}</p>
            <p>Por favor, intenta nuevamente.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    if (!code) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Error de Autenticación</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .error { background: #ffebee; color: #c62828; padding: 20px; border-radius: 8px; max-width: 600px; margin: 0 auto; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Error</h1>
            <p>No se recibió el código de autorización.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Guardar el código de autorización
    const { saveAuthorizationCode } = await import('../services/youtubeUploadService.js');
    await saveAuthorizationCode(code);
    
    // Mostrar página de éxito
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Autenticación Exitosa</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .success { background: #e8f5e9; color: #2e7d32; padding: 30px; border-radius: 8px; max-width: 600px; margin: 0 auto; }
          .success h1 { margin-top: 0; }
          .success p { font-size: 16px; line-height: 1.6; }
          .button { display: inline-block; background: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px; }
          .button:hover { background: #45a049; }
        </style>
      </head>
      <body>
        <div class="success">
          <h1>✅ Autenticación Exitosa</h1>
          <p>Tu cuenta de YouTube ha sido autenticada correctamente.</p>
          <p>Ahora puedes cerrar esta ventana y volver a intentar subir tu video.</p>
          <p><strong>El token se ha guardado automáticamente.</strong></p>
        </div>
        <script>
          // Cerrar la ventana automáticamente después de 3 segundos
          setTimeout(() => {
            window.close();
          }, 3000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error en callback de YouTube:', error);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .error { background: #ffebee; color: #c62828; padding: 20px; border-radius: 8px; max-width: 600px; margin: 0 auto; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Error</h1>
          <p>${error.message}</p>
        </div>
      </body>
      </html>
    `);
  }
}
