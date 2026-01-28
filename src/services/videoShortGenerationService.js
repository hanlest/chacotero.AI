import ffmpeg from 'fluent-ffmpeg';
import { existsSync, readdir, stat } from 'fs';
import { readdir as readdirAsync, stat as statAsync } from 'fs/promises';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../config/config.js';
import { downloadSubtitles, extractVideoId } from './youtubeService.js';
import { generateSRT } from './transcriptionService.js';
import { readMetadataFile } from './fileService.js';
import { logInfo, logError, logWarn } from './loggerService.js';

const execAsync = promisify(exec);

// Map para almacenar el progreso de generación de shorts
// Key: shortId, Value: { percent, frames, totalFrames, status, startTime, fps, outputPath, videoTitle }
const shortGenerationProgress = new Map();

// Map para almacenar conexiones SSE activas
// Key: shortId, Value: Set de Response objects
const sseConnections = new Map();

/**
 * Registra una conexión SSE para un shortId
 * @param {string} shortId - ID único del short
 * @param {Response} res - Objeto Response de Express para SSE
 */
export function registerShortSSEConnection(shortId, res) {
  if (!sseConnections.has(shortId)) {
    sseConnections.set(shortId, new Set());
  }
  sseConnections.get(shortId).add(res);
  
  // Enviar progreso actual si existe
  const progress = shortGenerationProgress.get(shortId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierra
  res.on('close', () => {
    const connections = sseConnections.get(shortId);
    if (connections) {
      connections.delete(res);
      if (connections.size === 0) {
        sseConnections.delete(shortId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso
 * @param {string} shortId - ID único del short
 * @param {object} progressData - Datos de progreso
 */
function notifySSEConnections(shortId, progressData) {
  const connections = sseConnections.get(shortId);
  if (connections) {
    const message = `data: ${JSON.stringify(progressData)}\n\n`;
    connections.forEach(res => {
      try {
        res.write(message);
      } catch (error) {
        // Si la conexión está cerrada, removerla
        connections.delete(res);
      }
    });
  }
}

/**
 * Obtiene el progreso de un short específico
 * @param {string} shortId - ID único del short
 * @returns {object|null} - Datos de progreso o null si no existe
 */
export function getShortProgress(shortId) {
  return shortGenerationProgress.get(shortId) || null;
}

/**
 * Actualiza el progreso de un short
 * @param {string} shortId - ID único del short
 * @param {object} progressData - Datos de progreso
 */
export function updateShortProgress(shortId, progressData) {
  shortGenerationProgress.set(shortId, progressData);
  notifySSEConnections(shortId, progressData);
}

/**
 * Obtiene todos los shorts activos
 * @returns {Array} - Array de objetos con shortId y datos de progreso
 */
export function getActiveShorts() {
  const active = [];
  shortGenerationProgress.forEach((progress, shortId) => {
    if (progress.status === 'processing' || progress.status === 'starting') {
      active.push({
        shortId,
        ...progress
      });
    }
  });
  return active;
}

/**
 * Obtiene la duración de un archivo de audio o video
 * @param {string} filePath - Ruta del archivo
 * @returns {Promise<number>} - Duración en segundos
 */
async function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}

/**
 * Selecciona videos de fondo aleatorios hasta completar la duración necesaria
 * @param {number} requiredDuration - Duración necesaria en segundos
 * @returns {Promise<Array>} - Array de objetos {path, startTime, duration}
 */
async function selectBackgroundVideos(requiredDuration) {
  const backgroundVideosPath = config.storage.shortBackgroundVideosPath;
  
  if (!existsSync(backgroundVideosPath)) {
    throw new Error(`La carpeta de videos de fondo no existe: ${backgroundVideosPath}`);
  }
  
  // Leer archivos de video de la carpeta
  const files = await readdirAsync(backgroundVideosPath);
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const videoFiles = files.filter(f => {
    const ext = f.toLowerCase().substring(f.lastIndexOf('.'));
    return videoExtensions.includes(ext);
  }).map(f => join(backgroundVideosPath, f));
  
  if (videoFiles.length === 0) {
    throw new Error('No se encontraron videos de fondo en la carpeta configurada');
  }
  
  // Obtener duraciones de todos los videos
  const videosWithDuration = [];
  for (const videoPath of videoFiles) {
    try {
      const duration = await getMediaDuration(videoPath);
      videosWithDuration.push({ path: videoPath, duration });
    } catch (error) {
      await logWarn(`Error al obtener duración de ${videoPath}: ${error.message}`);
    }
  }
  
  if (videosWithDuration.length === 0) {
    throw new Error('No se pudieron leer las duraciones de los videos de fondo');
  }
  
  // Seleccionar videos aleatorios hasta completar la duración
  const selectedVideos = [];
  let currentDuration = 0;
  const shuffled = [...videosWithDuration].sort(() => Math.random() - 0.5);
  
  while (currentDuration < requiredDuration) {
    for (const video of shuffled) {
      if (currentDuration >= requiredDuration) break;
      
      const remainingDuration = requiredDuration - currentDuration;
      const videoStartTime = 0;
      const videoDuration = Math.min(video.duration, remainingDuration);
      
      selectedVideos.push({
        path: video.path,
        startTime: videoStartTime,
        duration: videoDuration,
        totalDuration: video.duration
      });
      
      currentDuration += videoDuration;
    }
    
    // Si aún no tenemos suficiente duración y ya usamos todos los videos, repetir desde el inicio
    if (currentDuration < requiredDuration && selectedVideos.length >= videosWithDuration.length) {
      // Mezclar de nuevo para variedad
      shuffled.sort(() => Math.random() - 0.5);
    }
  }
  
  return selectedVideos;
}

/**
 * Genera un waveform vertical del audio
 * @param {string} audioPath - Ruta del archivo de audio
 * @param {string} outputPath - Ruta donde guardar la imagen del waveform
 * @param {number} width - Ancho del waveform (altura del video, 1920px)
 * @param {number} height - Alto del waveform (ancho del video, 1080px)
 * @returns {Promise<string>} - Ruta del archivo generado
 */
async function generateVerticalWaveform(audioPath, outputPath, width, height) {
  return new Promise((resolve, reject) => {
    // Generar waveform horizontal primero (width x height)
    // Luego rotar 90° para orientación vertical
    // El resultado será height x width (1080x1920 para el waveform completo, pero solo usamos una parte)
    ffmpeg(audioPath)
      .complexFilter([
        `showwavespic=s=${width}x${height}:colors=0x667eea:scale=lin:split_channels=0[wave]`,
        `[wave]transpose=1[cw]` // Rotar 90° (transpose=1 = 90° clockwise)
      ])
      .outputOptions([
        '-map', '[cw]',
        '-frames:v', '1'
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`Error al generar waveform: ${err.message}`)))
      .run();
  });
}

/**
 * Genera un video short vertical (1080x1920)
 * @param {string} shortId - ID único del short
 * @param {string} fileName - Nombre del archivo de la llamada (sin extensión)
 * @param {string} youtubeVideoUrl - URL del video de YouTube
 * @param {object} options - Opciones de generación
 * @returns {Promise<string>} - Ruta del archivo de video generado
 */
export async function generateShortVideo(shortId, fileName, youtubeVideoUrl, options = {}) {
  try {
    // Inicializar progreso
    updateShortProgress(shortId, {
      percent: 0,
      frames: 0,
      totalFrames: 0,
      status: 'starting',
      startTime: Date.now(),
      fps: 0,
      outputPath: null,
      videoTitle: fileName
    });
    
    await logInfo(`[Short ${shortId}] Iniciando generación de short para ${fileName}`);
    
    // 1. Extraer videoId de la URL
    const videoId = extractVideoId(youtubeVideoUrl);
    if (!videoId) {
      throw new Error('No se pudo extraer videoId de la URL de YouTube');
    }
    
    updateShortProgress(shortId, { percent: 5, status: 'processing' });
    
    // 2. Obtener transcripción desde YouTube
    await logInfo(`[Short ${shortId}] Descargando transcripción desde YouTube...`);
    let subtitleResult;
    try {
      subtitleResult = await downloadSubtitles(youtubeVideoUrl, videoId, 1, 1);
    } catch (error) {
      throw new Error(`Error al descargar transcripción: ${error.message}`);
    }
    
    // Convertir segmentos al formato esperado
    const formattedSegments = subtitleResult.segments.map((segment, index) => ({
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
    
    // Generar SRT
    const srtContent = generateSRT(formattedSegments);
    const srtPath = join(config.storage.tempPath, `${shortId}_subtitles.srt`);
    const { writeFile } = await import('fs/promises');
    await writeFile(srtPath, srtContent, 'utf-8');
    
    updateShortProgress(shortId, { percent: 15, status: 'processing' });
    
    // 3. Obtener miniatura generada del video
    await logInfo(`[Short ${shortId}] Obteniendo miniatura generada...`);
    const metadata = await readMetadataFile(fileName);
    let thumbnailPath = null;
    
    if (metadata && metadata.generatedThumbnailPath) {
      // Si la ruta es relativa, convertirla a absoluta
      if (!metadata.generatedThumbnailPath.startsWith('/') && !metadata.generatedThumbnailPath.match(/^[A-Za-z]:/)) {
        thumbnailPath = join(config.storage.callsPath, metadata.generatedThumbnailPath);
      } else {
        thumbnailPath = metadata.generatedThumbnailPath;
      }
    }
    
    // Si no está en metadata, intentar construirla
    if (!thumbnailPath || !existsSync(thumbnailPath)) {
      thumbnailPath = join(config.storage.callsPath, `${fileName}_generated.jpg`);
      if (!existsSync(thumbnailPath)) {
        // Intentar con .png
        thumbnailPath = join(config.storage.callsPath, `${fileName}_generated.png`);
        if (!existsSync(thumbnailPath)) {
          throw new Error('No se encontró la miniatura generada del video');
        }
      }
    }
    
    updateShortProgress(shortId, { percent: 20, status: 'processing' });
    
    // 4. Obtener ruta del audio
    const audioPath = join(config.storage.callsPath, `${fileName}.mp3`);
    if (!existsSync(audioPath)) {
      throw new Error(`No se encontró el archivo de audio: ${audioPath}`);
    }
    
    // Obtener duración del audio
    const audioDuration = await getMediaDuration(audioPath);
    await logInfo(`[Short ${shortId}] Duración del audio: ${audioDuration.toFixed(2)}s`);
    
    updateShortProgress(shortId, { percent: 25, status: 'processing' });
    
    // 5. Seleccionar videos de fondo
    await logInfo(`[Short ${shortId}] Seleccionando videos de fondo...`);
    const backgroundVideos = await selectBackgroundVideos(audioDuration);
    await logInfo(`[Short ${shortId}] Seleccionados ${backgroundVideos.length} videos de fondo`);
    
    updateShortProgress(shortId, { percent: 30, status: 'processing' });
    
    // 6. Generar waveform vertical
    await logInfo(`[Short ${shortId}] Generando waveform vertical...`);
    const waveformPath = join(config.storage.tempPath, `${shortId}_waveform.png`);
    // Para waveform vertical: generar horizontal primero con altura del video como ancho
    // Luego rotar 90° para que quede vertical
    const waveformWidth = 1920; // Altura del video (para generar horizontal primero)
    const waveformHeight = 100; // Alto del waveform (después de rotar será el ancho)
    await generateVerticalWaveform(audioPath, waveformPath, waveformWidth, waveformHeight);
    
    updateShortProgress(shortId, { percent: 40, status: 'processing' });
    
    // 7. Preparar ruta de salida
    const outputPath = join(config.storage.callsPath, `${fileName}_short.mp4`);
    
    // 8. Componer video con FFmpeg
    await logInfo(`[Short ${shortId}] Componiendo video con FFmpeg...`);
    
    // Resolución del short: 1080x1920 (vertical)
    const shortWidth = 1080;
    const shortHeight = 1920;
    
    // Calcular altura de la miniatura (escalada al ancho completo)
    const thumbnailHeight = Math.floor((shortWidth / 1536) * 1024); // Asumiendo miniatura original 1536x1024
    
    // Altura disponible para videos de fondo y waveform
    const availableHeight = shortHeight - thumbnailHeight - waveformHeight;
    
    return new Promise((resolve, reject) => {
      // Construir filtros complejos de FFmpeg
      const filters = [];
      
      // 1. Escalar miniatura al ancho completo
      filters.push(`[0:v]scale=${shortWidth}:-1[thumbnail]`);
      
      // 2. Preparar videos de fondo (concatenar y hacer loop)
      const backgroundInputs = [];
      backgroundVideos.forEach((video, index) => {
        const inputIndex = index + 1; // Empezar desde input 1 (0 es miniatura)
        filters.push(`[${inputIndex}:v]scale=${shortWidth}:${availableHeight}:force_original_aspect_ratio=decrease,pad=${shortWidth}:${availableHeight}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v${index}]`);
      });
      
      // Concatenar videos de fondo
      if (backgroundVideos.length > 1) {
        const concatInputs = backgroundVideos.map((_, index) => `[v${index}]`).join('');
        filters.push(`${concatInputs}concat=n=${backgroundVideos.length}:v=1:a=0[bg_concat]`);
      } else {
        filters.push(`[v0]copy[bg_concat]`);
      }
      
      // Hacer loop del fondo si es necesario
      filters.push(`[bg_concat]loop=loop=-1:size=1:start=0,trim=duration=${audioDuration}[bg_loop]`);
      
      // 3. Escalar waveform (el waveform está en el input después de los videos de fondo)
      // Después de rotar, el waveform tiene dimensiones height x width (100x1920)
      // Necesitamos escalarlo a shortWidth x waveformHeight (1080x100)
      const waveformInputIndex = backgroundVideos.length + 1;
      filters.push(`[${waveformInputIndex}:v]scale=${shortWidth}:${waveformHeight}[waveform]`);
      
      // 4. Apilar verticalmente: miniatura arriba, fondo en medio, waveform abajo
      filters.push(`[thumbnail][bg_loop][waveform]vstack=inputs=3[stacked]`);
      
      // 5. Agregar subtítulos
      filters.push(`[stacked]subtitles='${srtPath.replace(/\\/g, '/').replace(/'/g, "\\'")}':force_style='FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H000000,Alignment=10'[final]`);
      
      // Construir comando FFmpeg
      let command = ffmpeg();
      
      // Inputs: miniatura, videos de fondo, waveform, audio
      command.input(thumbnailPath);
      backgroundVideos.forEach(video => {
        command.input(video.path);
      });
      command.input(waveformPath);
      command.input(audioPath);
      
      // Aplicar filtros complejos
      command.complexFilter(filters);
      
      // Configurar salida
      // El audio está en el último input (después de miniatura, videos de fondo y waveform)
      const audioInputIndex = backgroundVideos.length + 2;
      command
        .outputOptions([
          '-map', '[final]',
          '-map', `${audioInputIndex}:a`, // Audio del último input
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-r', '30',
          '-b:v', '5000k',
          '-pix_fmt', 'yuv420p',
          '-shortest'
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          logInfo(`[Short ${shortId}] Comando FFmpeg: ${commandLine}`).catch(() => {});
        })
        .on('progress', (progress) => {
          const frames = progress.frames || 0;
          const time = progress.timemark || '00:00:00';
          
          // Calcular porcentaje basado en frames
          let percent = 50; // Base después de preparación
          if (progress.targetSize) {
            // Intentar calcular basado en tamaño si es posible
            percent = Math.min(95, 50 + (frames / 1000) * 45); // Estimación
          }
          
          updateShortProgress(shortId, {
            percent: Math.min(95, percent),
            frames: frames,
            status: 'processing',
            fps: progress.currentFps || 0
          });
        })
        .on('end', () => {
          updateShortProgress(shortId, {
            percent: 100,
            status: 'completed',
            outputPath: outputPath
          });
          logInfo(`[Short ${shortId}] Video short generado exitosamente: ${outputPath}`).catch(() => {});
          resolve(outputPath);
        })
        .on('error', (err) => {
          updateShortProgress(shortId, {
            status: 'error',
            error: err.message
          });
          logError(`[Short ${shortId}] Error al generar video: ${err.message}`).catch(() => {});
          reject(err);
        })
        .run();
    });
    
  } catch (error) {
    updateShortProgress(shortId, {
      status: 'error',
      error: error.message
    });
    await logError(`[Short ${shortId}] Error: ${error.message}`);
    throw error;
  }
}
