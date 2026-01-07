import { v4 as uuidv4 } from 'uuid';
import { downloadAudio, extractVideoId, getPlaylistVideos } from '../services/youtubeService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { separateCalls } from '../services/callSeparationService.js';
// import { generateMetadata } from '../services/metadataService.js'; // Ya no se usa, los metadatos vienen de la separación de llamadas
import { saveAudioFile, saveTranscriptionFile, saveMinTranscriptionFile, saveMetadataFile, generateMinSRT } from '../services/fileService.js';
import { findCallsByVideoId, isVideoProcessed } from '../services/videoIndexService.js';
import { extractAudioSegment, readAudioFile } from '../utils/audioUtils.js';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import config from '../config/config.js';

/**
 * Función interna que procesa un video individual
 * @param {string} youtubeUrl - URL del video de YouTube
 * @returns {Promise<{videoId: string, processed: boolean, message?: string, calls: Array}>}
 */
async function processSingleVideo(youtubeUrl) {
  try {
    if (!youtubeUrl) {
      throw new Error('youtubeUrl es requerido');
    }

    // Extraer videoId
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      throw new Error('URL de YouTube no válida');
    }

    // Verificar si el video ya fue procesado
    const alreadyProcessed = await isVideoProcessed(videoId);
    
    if (alreadyProcessed) {
      console.log('');
      console.log('--------------------------------');
      console.log(`⚠️  Video ya procesado anteriormente: ${videoId}`);
      console.log('--------------------------------');
      console.log('');
      
      const existingCalls = await findCallsByVideoId(videoId);
      console.log(`📋 Se encontraron ${existingCalls.length} llamada(s) existente(s) para este video`);
      console.log('');
      
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
          audioFile: call.audioFile,
          transcriptionFile: call.transcriptionFile,
          metadataFile: call.metadataFile,
        })),
      };
    }

    // Procesar el video
    console.log("");
    console.log("--------------------------------");
    console.log(`Procesando video: ${videoId}`);
    console.log("--------------------------------");
    console.log("");

    // 1. Descargar audio
    console.log('Descargando audio...');
    const { audioPath, title: videoTitle, uploadDate } = await downloadAudio(youtubeUrl);
    console.log('Audio descargado:', audioPath);

    // 2. Transcribir (verificar si ya existe)
    const transcriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
    
    let transcription, srt, segments, speakers;
    
    if (existsSync(transcriptionPath)) {
      console.log('✅ Transcripción ya existe, cargando desde archivo...');
      // Cargar transcripción existente
      const { readFile } = await import('fs/promises');
      srt = await readFile(transcriptionPath, 'utf-8');
      
      // Reconstruir segments desde el SRT
      segments = parseSRTToSegments(srt);
      
      // Generar transcripción simplificada en memoria (no guardar archivo)
      transcription = generateMinSRT(srt);
      
      speakers = ['Conductor', 'Llamante']; // Valores por defecto
      
      console.log('✅ Transcripción cargada desde archivo');
    } else {
      console.log('🔄 Iniciando transcripción del audio...');
      const result = await transcribeAudio(audioPath);
      transcription = result.transcription;
      srt = result.srt;
      segments = result.segments;
      speakers = result.speakers;
      
      // Guardar transcripción del video completo en temp (solo SRT, no _min.txt)
      const { writeFile } = await import('fs/promises');
      await writeFile(transcriptionPath, srt, 'utf-8');
      console.log('✅ Transcripción completada y guardada');
      console.log(`   Segmentos encontrados: ${segments.length}`);
      console.log(`   Speakers identificados: ${speakers.join(', ')}`);
    }

    // 3. Separar llamadas
    // Usar el SRT completo (con timestamps) en lugar de la versión simplificada
    // GPT-5.2 tiene suficiente contexto (128k tokens) para procesar la transcripción completa
    console.log('Separando llamadas...');
    const separatedCalls = await separateCalls(segments, srt);
    console.log(`Se encontraron ${separatedCalls.length} llamada(s)`);

    // 4. Procesar cada llamada
    console.log('');
    console.log('--------------------------------');
    console.log('Recortando audios de las llamadas...');
    console.log('--------------------------------');
    console.log('');
    
    const processedCalls = [];
    const totalCalls = separatedCalls.length;

    // Función para mostrar barra de progreso de procesamiento de llamadas
    function showCallProcessingProgress(current, total, step = '') {
      const barLength = 50;
      const percent = (current / total) * 100;
      const filled = Math.round((percent / 100) * barLength);
      const empty = barLength - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      const percentStr = percent.toFixed(1).padStart(5, ' ');
      const stepStr = step ? ` | ${step}` : '';
      process.stdout.write(`\r📞 [${bar}] ${percentStr}% | Llamada ${current}/${total}${stepStr}`);
    }

    for (let i = 0; i < separatedCalls.length; i++) {
      const call = separatedCalls[i];
      const callNumber = i + 1;

      // Limpiar cualquier rastro de la llamada anterior antes de mostrar la nueva
      if (i > 0) {
        process.stdout.write('\r' + ' '.repeat(150) + '\r');
      }
      
      try {
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
        
        // Importar sanitizeFilename para sanitizar el nombre antes de usarlo
        const { sanitizeFilename } = await import('../services/fileService.js');
        const sanitizedFileName = sanitizeFilename(fileName);

        // Extraer segmento de audio directamente a calls (archivo final)
        // Limpiar cualquier barra de progreso anterior antes de mostrar la de extracción
        process.stdout.write('\r' + ' '.repeat(150) + '\r');
        const callAudioPath = join(config.storage.callsPath, `${sanitizedFileName}.mp3`);
        await extractAudioSegment(audioPath, call.start, call.end, callAudioPath, callNumber, totalCalls);

        // Leer audio como buffer
        showCallProcessingProgress(callNumber, totalCalls, 'Leyendo audio...');
        const audioBuffer = await readAudioFile(callAudioPath);

        // Generar SRT para esta llamada
        const callSegments = segments.filter(
          (seg) => seg.start >= call.start && seg.end <= call.end
        );
        const callSRT = generateCallSRT(callSegments, call.start);

        // Guardar archivos con el nuevo formato de nombre (usar nombre sanitizado)
        // El audio ya está guardado en callsPath por extractAudioSegment, solo guardar transcripción y metadata
        showCallProcessingProgress(callNumber, totalCalls, 'Guardando archivos...');
        const savedAudioPath = callAudioPath; // Ya está guardado en callsPath
        const savedTranscriptionPath = await saveTranscriptionFile(sanitizedFileName, callSRT);
        
        const fullMetadata = {
          callId: uuidv4(), // Mantener callId interno para referencias
          callNumber,
          fileName: sanitizedFileName, // Nombre del archivo (sanitizado, usado para guardar archivos)
          ...metadata,
        };
        const savedMetadataPath = await saveMetadataFile(sanitizedFileName, fullMetadata);
        
        // Completar y limpiar la barra de progreso
        const bar = '█'.repeat(50);
        process.stdout.write(`\r📞 [${bar}] 100.0% | Llamada ${callNumber}/${totalCalls} | Completada`);
        // Limpiar la línea completamente antes de mostrar el mensaje final
        process.stdout.write('\r' + ' '.repeat(150) + '\r');

        processedCalls.push({
          callId: fullMetadata.callId,
          callNumber,
          fileName: sanitizedFileName,
          youtubeVideoId: videoId,
          title: metadata.title,
          description: metadata.description,
          theme: metadata.theme,
          tags: metadata.tags,
          date: metadata.date,
          name: metadata.name,
          age: metadata.age,
          summary: metadata.summary,
          speakers: metadata.speakers,
          audioFile: savedAudioPath,
          transcriptionFile: savedTranscriptionPath,
          metadataFile: savedMetadataPath,
        });

        console.log(`Llamada ${callNumber} procesada: ${metadata.title}`);
      } catch (error) {
        console.error(`Error al procesar llamada ${callNumber}:`, error);
        // Continuar con la siguiente llamada
      }
    }

    console.log('');
    console.log('--------------------------------');
    console.log('✅ Recorte de audios completado');
    console.log('--------------------------------');
    console.log('');

    // Eliminar archivos temporales del video completo después de procesar todas las llamadas
    try {
      const originalAudioPath = join(config.storage.tempPath, `${videoId}.mp3`);
      const originalAudioMinPath = join(config.storage.tempPath, `${videoId}_min.mp3`);
      const originalAudioMin2Path = join(config.storage.tempPath, `${videoId}_min2.mp3`);
      const originalTranscriptionPath = join(config.storage.tempPath, `${videoId}.srt`);
      
      if (existsSync(originalAudioPath)) {
        await unlink(originalAudioPath);
        console.log(`🗑️  Audio original eliminado: ${videoId}.mp3`);
      }
      
      if (existsSync(originalAudioMinPath)) {
        await unlink(originalAudioMinPath);
        console.log(`🗑️  Audio comprimido _min eliminado: ${videoId}_min.mp3`);
      }
      
      if (existsSync(originalAudioMin2Path)) {
        await unlink(originalAudioMin2Path);
        console.log(`🗑️  Audio comprimido _min2 eliminado: ${videoId}_min2.mp3`);
      }
      
      if (existsSync(originalTranscriptionPath)) {
        await unlink(originalTranscriptionPath);
        console.log(`🗑️  Transcripción original eliminada: ${videoId}.srt`);
      }
    } catch (error) {
      console.warn('⚠️  Error al eliminar archivos temporales:', error.message);
      // Continuar aunque falle la eliminación
    }

    return {
      videoId,
      processed: true,
      calls: processedCalls,
    };
  } catch (error) {
    console.error('Error al procesar video:', error);
    throw error;
  }
}

/**
 * Procesa un video de YouTube y extrae las llamadas
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function processVideo(req, res) {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({
        error: 'youtubeUrl es requerido',
      });
    }

    // Extraer videoId
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return res.status(400).json({
        error: 'URL de YouTube no válida',
      });
    }

    // Verificar si el video ya fue procesado
    const alreadyProcessed = await isVideoProcessed(videoId);
    
    if (alreadyProcessed) {
      console.log('');
      console.log('--------------------------------');
      console.log(`⚠️  Video ya procesado anteriormente: ${videoId}`);
      console.log('--------------------------------');
      console.log('');
      
      const existingCalls = await findCallsByVideoId(videoId);
      console.log(`📋 Se encontraron ${existingCalls.length} llamada(s) existente(s) para este video`);
      console.log('');
      
      return res.json({
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
          audioFile: call.audioFile,
          transcriptionFile: call.transcriptionFile,
          metadataFile: call.metadataFile,
        })),
      });
    }

    // Procesar el video usando la función interna
    const result = await processSingleVideo(youtubeUrl);
    return res.json(result);
  } catch (error) {
    console.error('Error al procesar video:', error);
    return res.status(500).json({
      error: 'Error al procesar el video',
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
    const { playlistUrl } = req.body;

    if (!playlistUrl) {
      return res.status(400).json({
        error: 'playlistUrl es requerido',
      });
    }

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

    // Procesar cada video uno tras otro
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const videoNumber = i + 1;

      console.log('');
      console.log('================================');
      console.log(`Video ${videoNumber}/${videos.length}: ${video.title}`);
      console.log(`ID: ${video.id}`);
      console.log('================================');
      console.log('');

      try {
        // Verificar si el video ya fue procesado
        const alreadyProcessed = await isVideoProcessed(video.id);
        
        if (alreadyProcessed) {
          console.log(`⏭️  Video ${videoNumber} ya procesado anteriormente, omitiendo...`);
          const existingCalls = await findCallsByVideoId(video.id);
          results.push({
            videoId: video.id,
            videoTitle: video.title,
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
              audioFile: call.audioFile,
              transcriptionFile: call.transcriptionFile,
              metadataFile: call.metadataFile,
            })),
          });
          skippedCount++;
          continue;
        }

        // Procesar el video
        const result = await processSingleVideo(video.url);
        results.push({
          videoId: video.id,
          videoTitle: video.title,
          ...result,
        });
        processedCount++;
      } catch (error) {
        // Detectar tipo de error para mensaje más claro
        let errorMessage = error.message;
        let shouldSkip = false;
        
        if (error.message.includes('autenticación') || error.message.includes('cookies') || 
            error.message.includes('Sign in to confirm your age') ||
            error.message.includes('inappropriate for some users')) {
          errorMessage = 'Video requiere autenticación (verificación de edad) - Omitido';
          shouldSkip = true;
          errorCount++; // Contar como error
        } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
          errorMessage = 'Video bloqueado por YouTube (403) - Omitido';
          shouldSkip = true;
          errorCount++; // Contar como error
        } else {
          errorCount++;
        }
        
        console.error(`❌ Error al procesar video ${videoNumber} (${video.id}):`, errorMessage);
        
        results.push({
          videoId: video.id,
          videoTitle: video.title,
          processed: false,
          skipped: shouldSkip,
          error: errorMessage,
        });
        
        // Continuar con el siguiente video aunque haya error
      }
    }

    console.log('');
    console.log('================================');
    console.log('✅ Procesamiento de playlist completado');
    console.log('================================');
    console.log(`📊 Resumen:`);
    console.log(`   - Videos procesados: ${processedCount}`);
    console.log(`   - Videos omitidos (ya procesados): ${skippedCount}`);
    console.log(`   - Videos con error: ${errorCount}`);
    console.log(`   - Total: ${videos.length}`);
    console.log('');

    // Agrupar resultados por estado
    const processedVideos = results.filter(r => r.processed === true);
    // Videos omitidos por error (restricción de edad, 403, etc.) - NO incluir los ya procesados
    const skippedByErrorVideos = results.filter(r => 
      r.processed === false && 
      r.skipped === true && 
      r.error && 
      r.message !== 'Video ya procesado anteriormente'
    );
    // Videos con error (otros errores que no son omitidos)
    const errorVideos = results.filter(r => r.processed === false && !r.skipped && r.error);
    
    // Combinar todos los videos con error (omitidos por error + otros errores)
    const allErrorVideos = [...skippedByErrorVideos, ...errorVideos];

    console.log('📋 Detalle de videos:');
    console.log('');
    
    if (processedVideos.length > 0) {
      console.log(`✅ Videos procesados (${processedVideos.length}):`);
      processedVideos.forEach((video, index) => {
        console.log(`   ${index + 1}. ${video.videoTitle || 'Sin título'} (${video.videoId})`);
        if (video.calls && video.calls.length > 0) {
          console.log(`      → ${video.calls.length} llamada(s) extraída(s)`);
        }
      });
      console.log('');
    }



    return res.json({
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
    });
  } catch (error) {
    console.error('Error al procesar playlist:', error);
    return res.status(500).json({
      error: 'Error al procesar la playlist',
      message: error.message,
    });
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
