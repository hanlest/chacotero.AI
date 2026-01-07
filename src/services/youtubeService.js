import ytDlpWrapModule from 'yt-dlp-wrap';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { platform } from 'os';
import config from '../config/config.js';

// yt-dlp-wrap tiene un doble default export, necesitamos acceder al default interno
const YTDlpWrap = ytDlpWrapModule.default?.default || ytDlpWrapModule.default || ytDlpWrapModule;

// Ruta donde se guardará el binario de yt-dlp
const YT_DLP_BINARY_PATH = join(config.storage.basePath, 'yt-dlp' + (platform() === 'win32' ? '.exe' : ''));

/**
 * Función para mostrar log en formato unificado (importada desde videoController)
 * Esta función será pasada como callback desde videoController
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
 * Guarda información de un video que no se pudo descargar en un archivo de texto
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} errorMessage - Mensaje de error
 */
async function saveFailedVideo(youtubeUrl, errorMessage) {
  try {
    const failedVideosPath = join(config.storage.basePath, 'failed_videos.txt');
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${youtubeUrl} | Error: ${errorMessage}\n`;
    
    const { appendFile, mkdir } = await import('fs/promises');
    
    // Asegurar que el directorio existe
    if (!existsSync(config.storage.basePath)) {
      await mkdir(config.storage.basePath, { recursive: true });
    }
    
    await appendFile(failedVideosPath, entry, 'utf-8');
    console.log(`📝 Video fallido guardado en: ${failedVideosPath}`);
  } catch (error) {
    // Si falla guardar, solo loguear el error pero no lanzar excepción
    console.warn('⚠️  No se pudo guardar el video fallido en el archivo:', error.message);
  }
}

/**
 * Asegura que yt-dlp esté disponible, descargándolo si es necesario
 */
async function ensureYtDlp() {
  // Si el binario ya existe, usarlo
  if (existsSync(YT_DLP_BINARY_PATH)) {
    return YT_DLP_BINARY_PATH;
  }

  // Si yt-dlp está en el PATH, usarlo
  try {
    const ytDlpWrap = new YTDlpWrap();
    await ytDlpWrap.getVersion();
    return 'yt-dlp'; // Usar el del PATH
  } catch (error) {
    // No está en el PATH, descargarlo
    console.log('Descargando yt-dlp desde GitHub...');
    try {
      await YTDlpWrap.downloadFromGithub(YT_DLP_BINARY_PATH, undefined, platform());
      console.log(`yt-dlp descargado en: ${YT_DLP_BINARY_PATH}`);
      return YT_DLP_BINARY_PATH;
    } catch (downloadError) {
      throw new Error(`No se pudo descargar yt-dlp: ${downloadError.message}. Por favor, instala yt-dlp manualmente.`);
    }
  }
}

/**
 * Extrae el videoId de una URL de YouTube
 * @param {string} url - URL del video de YouTube
 * @returns {string|null} - VideoId o null si no es válida
 */
export function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Obtiene la URL de la miniatura de un video de YouTube
 * @param {string} videoId - ID del video de YouTube
 * @returns {Promise<string>} - URL de la miniatura
 */
export async function getThumbnailUrl(videoId) {
  if (!videoId) {
    return null;
  }

  // Intentar obtener la URL desde los metadatos de yt-dlp primero
  try {
    const ytDlpBinaryPath = await ensureYtDlp();
    const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    const infoResult = await ytDlpWrap.execPromise([
      youtubeUrl,
      '--dump-json',
      '--no-playlist',
    ]);

    let videoInfo;
    if (typeof infoResult === 'string') {
      videoInfo = JSON.parse(infoResult);
    } else if (infoResult.stdout) {
      videoInfo = JSON.parse(infoResult.stdout);
    } else if (infoResult.data) {
      videoInfo = typeof infoResult.data === 'string' ? JSON.parse(infoResult.data) : infoResult.data;
    } else {
      videoInfo = infoResult;
    }

    // Priorizar maxresdefault, luego hqdefault, luego thumbnail
    if (videoInfo.thumbnail) {
      return videoInfo.thumbnail;
    }
    if (videoInfo.thumbnails && videoInfo.thumbnails.length > 0) {
      // Buscar la miniatura de mayor resolución
      const maxRes = videoInfo.thumbnails.find(t => t.id === 'maxresdefault') || 
                     videoInfo.thumbnails.find(t => t.id === 'hqdefault') ||
                     videoInfo.thumbnails[videoInfo.thumbnails.length - 1];
      if (maxRes && maxRes.url) {
        return maxRes.url;
      }
    }
  } catch (error) {
    // Si falla obtener desde yt-dlp, usar URL estándar de YouTube
    console.warn(`No se pudo obtener miniatura desde yt-dlp para ${videoId}, usando URL estándar`);
  }

  // Fallback: usar URL estándar de YouTube
  // Intentar maxresdefault primero, si no existe usar hqdefault
  return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Descarga el audio de un video de YouTube
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @returns {Promise<{videoId: string, audioPath: string, title: string, uploadDate: string}>}
 */
export async function downloadAudio(youtubeUrl, videoNumber = 1, totalVideos = 1, videoIdParam = null) {
  // Obtener videoId si no se proporcionó
  let videoId = videoIdParam;
  if (!videoId) {
    videoId = extractVideoId(youtubeUrl);
  }
  
  if (!videoId) {
    throw new Error('URL de YouTube no válida');
  }

  // Verificar si el audio ya existe en temp
  const audioPath = join(config.storage.tempPath, `${videoId}.mp3`);
  if (existsSync(audioPath)) {
    
    // Obtener metadatos del video
    const ytDlpBinaryPath = await ensureYtDlp();
    const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
    
        try {
          const infoArgs = [
            youtubeUrl,
            '--dump-json',
            '--no-playlist',
          ];
          
          
          const infoResult = await ytDlpWrap.execPromise(infoArgs);

      let videoInfo;
      if (typeof infoResult === 'string') {
        videoInfo = JSON.parse(infoResult);
      } else if (infoResult.stdout) {
        videoInfo = JSON.parse(infoResult.stdout);
      } else if (infoResult.data) {
        videoInfo = typeof infoResult.data === 'string' ? JSON.parse(infoResult.data) : infoResult.data;
      } else {
        videoInfo = infoResult;
      }

      const title = videoInfo.title || 'Sin título';
      const uploadDate = videoInfo.upload_date 
        ? `${videoInfo.upload_date.slice(0, 4)}-${videoInfo.upload_date.slice(4, 6)}-${videoInfo.upload_date.slice(6, 8)}`
        : new Date().toISOString().split('T')[0];

      return {
        videoId,
        audioPath,
        title,
        uploadDate,
      };
    } catch (error) {
      // Si falla obtener metadatos, usar valores por defecto
      return {
        videoId,
        audioPath,
        title: 'Sin título',
        uploadDate: new Date().toISOString().split('T')[0],
      };
    }
  }

  // Asegurar que yt-dlp esté disponible
  const ytDlpBinaryPath = await ensureYtDlp();
  const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
  const outputPath = join(config.storage.tempPath, `${videoId}.%(ext)s`);

  try {
    // Construir argumentos base
    const args = [
      youtubeUrl,
      '--format', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--output', outputPath,
      '--no-playlist',
      '--no-warnings',
      '--quiet',
    ];
    
    const downloadPromise = new Promise((resolve, reject) => {
      let stderrOutput = '';
      
      const emitter = ytDlpWrap.exec(args);

      // Capturar stderr para detectar errores específicos
      if (emitter.stderr) {
        emitter.stderr.on('data', (data) => {
          stderrOutput += data.toString();
        });
      }

      let lastPercent = 0;
      let lastUpdate = Date.now();

      emitter.on('progress', (progress) => {
        const percent = progress.percent || 0;
        
        // Actualizar log solo si hay cambio significativo o cada 500ms
        const now = Date.now();
        if (percent !== lastPercent && (percent - lastPercent >= 5 || now - lastUpdate > 500)) {
          if (showLogCallback) {
            showLogCallback('📥', videoNumber, totalVideos, videoId, 'Descargando audio', percent, null);
          }
          lastPercent = percent;
          lastUpdate = now;
        }
      });

      emitter.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Detectar errores específicos en stderr
          const errorMessage = stderrOutput || '';
          reject(new Error(`yt-dlp terminó con código ${code}. ${errorMessage.substring(0, 300)}`));
        }
      });

      emitter.on('error', (error) => {
        reject(error);
      });
    });

    await downloadPromise;

    // Buscar el archivo descargado
    const audioPath = join(config.storage.tempPath, `${videoId}.mp3`);
    
    if (!existsSync(audioPath)) {
      throw new Error('No se pudo descargar el audio');
    }

    // Obtener metadatos del video
    const infoArgs = [
      youtubeUrl,
      '--dump-json',
      '--no-playlist',
    ];
    
    const infoResult = await ytDlpWrap.execPromise(infoArgs);

    // yt-dlp-wrap puede retornar la salida de diferentes maneras
    let videoInfo;
    if (typeof infoResult === 'string') {
      videoInfo = JSON.parse(infoResult);
    } else if (infoResult.stdout) {
      videoInfo = JSON.parse(infoResult.stdout);
    } else if (infoResult.data) {
      videoInfo = typeof infoResult.data === 'string' ? JSON.parse(infoResult.data) : infoResult.data;
    } else {
      videoInfo = infoResult;
    }

    const title = videoInfo.title || 'Sin título';
    const uploadDate = videoInfo.upload_date 
      ? `${videoInfo.upload_date.slice(0, 4)}-${videoInfo.upload_date.slice(4, 6)}-${videoInfo.upload_date.slice(6, 8)}`
      : new Date().toISOString().split('T')[0];

    return {
      videoId,
      audioPath,
      title,
      uploadDate,
    };
  } catch (error) {
    // Verificar que videoId esté definido antes de usarlo
    let videoIdForCleanup = videoId;
    if (!videoIdForCleanup) {
      // Intentar extraerlo de la URL como último recurso
      videoIdForCleanup = extractVideoId(youtubeUrl) || 'unknown';
    }
    
    // Limpiar archivo parcial si existe
    try {
      const audioPath = join(config.storage.tempPath, `${videoIdForCleanup}.mp3`);
      if (existsSync(audioPath)) {
        try {
          unlinkSync(audioPath);
        } catch (e) {
          // Ignorar errores de limpieza
        }
      }
    } catch (cleanupError) {
      // Ignorar errores de limpieza
    }
    
    // Guardar video fallido en archivo
    try {
      await saveFailedVideo(youtubeUrl, error.message);
    } catch (saveError) {
      // Ignorar errores al guardar
    }
    
    // Crear mensaje de error más detallado
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      youtubeUrl,
      videoId: videoIdForCleanup,
      videoNumber,
      totalVideos,
      errorType: error.constructor.name,
    };
    
    console.error('Error detallado en downloadAudio:', JSON.stringify(errorDetails, null, 2));
    
    throw new Error(`Error al descargar audio: ${error.message}\nStack: ${error.stack}\nVideoId: ${videoIdForCleanup}\nURL: ${youtubeUrl}`);
  }
}

/**
 * Obtiene la lista de videos de una playlist de YouTube
 * @param {string} playlistUrl - URL de la playlist de YouTube
 * @returns {Promise<Array<{id: string, url: string, title: string}>>}
 */
export async function getPlaylistVideos(playlistUrl) {
  try {
    // Asegurar que yt-dlp esté disponible
    const ytDlpBinaryPath = await ensureYtDlp();
    const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);

    console.log('📋 Obteniendo lista de videos de la playlist...');
    
    // Construir argumentos base
    const args = [
      playlistUrl,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
    ];

    
    // Obtener información de la playlist
    const infoResult = await ytDlpWrap.execPromise(args);

    let playlistData;
    if (typeof infoResult === 'string') {
      // Si es un string, puede venir como múltiples líneas JSON (uno por video)
      const lines = infoResult.trim().split('\n').filter(line => line.trim());
      playlistData = lines.map(line => JSON.parse(line));
    } else if (infoResult.stdout) {
      const lines = infoResult.stdout.trim().split('\n').filter(line => line.trim());
      playlistData = lines.map(line => JSON.parse(line));
    } else if (Array.isArray(infoResult)) {
      playlistData = infoResult;
    } else {
      playlistData = [infoResult];
    }

    // Extraer información de cada video
    const videos = playlistData
      .filter(video => video.id) // Filtrar entradas válidas (solo necesita id)
      .map(video => ({
        id: video.id,
        url: video.url || video.webpage_url || `https://www.youtube.com/watch?v=${video.id}`,
        title: video.title || 'Sin título',
      }));

    console.log(`✅ Se encontraron ${videos.length} video(s) en la playlist`);
    return videos;
  } catch (error) {
    throw new Error(`Error al obtener videos de la playlist: ${error.message}`);
  }
}
