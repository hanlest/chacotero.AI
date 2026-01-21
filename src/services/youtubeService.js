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
 * Lee la lista de videos fallidos desde el archivo JSON
 * @returns {Promise<Array>} - Array de objetos con información de videos fallidos
 */
async function getFailedVideos() {
  try {
    const failedVideosPath = join(config.storage.basePath, 'failed_videos.json');
    
    if (!existsSync(failedVideosPath)) {
      return [];
    }
    
    const { readFile } = await import('fs/promises');
    const content = await readFile(failedVideosPath, 'utf-8');
    const failedVideos = JSON.parse(content);
    
    // Validar que sea un array
    if (!Array.isArray(failedVideos)) {
      return [];
    }
    
    return failedVideos;
  } catch (error) {
    console.warn('⚠️  Error al leer videos fallidos:', error.message);
    return [];
  }
}

/**
 * Guarda información de un video que no se pudo descargar en un archivo JSON
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} errorMessage - Mensaje de error
 */
export async function saveFailedVideo(youtubeUrl, errorMessage) {
  try {
    const failedVideosPath = join(config.storage.basePath, 'failed_videos.json');
    const timestamp = new Date().toISOString();
    
    // Extraer videoId de la URL
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      console.warn('⚠️  No se pudo extraer videoId de la URL:', youtubeUrl);
      return;
    }
    
    // Leer videos fallidos existentes
    const failedVideos = await getFailedVideos();
    
    // Verificar si el video ya está en la lista (por videoId)
    const existingIndex = failedVideos.findIndex(v => v.videoId === videoId);
    
    if (existingIndex !== -1) {
      // Si ya existe, actualizar con el nuevo error y timestamp
      failedVideos[existingIndex] = {
        videoId,
        youtubeUrl,
        error: errorMessage,
        timestamp,
      };
    } else {
      // Si no existe, agregar nuevo
      failedVideos.push({
        videoId,
        youtubeUrl,
        error: errorMessage,
        timestamp,
      });
    }
    
    const { writeFile, mkdir } = await import('fs/promises');
    
    // Asegurar que el directorio existe
    if (!existsSync(config.storage.basePath)) {
      await mkdir(config.storage.basePath, { recursive: true });
    }
    
    // Guardar el archivo completo
    await writeFile(failedVideosPath, JSON.stringify(failedVideos, null, 2), 'utf-8');
    //console.log(`📝 Video fallido guardado en: ${failedVideosPath}`);
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

  // Limpiar archivos .part huérfanos antes de descargar
  try {
    const { readdir } = await import('fs/promises');
    const tempFiles = await readdir(config.storage.tempPath);
    const partFiles = tempFiles.filter(f => f.includes(videoId) && f.endsWith('.part'));
    for (const partFile of partFiles) {
      try {
        const partPath = join(config.storage.tempPath, partFile);
        // Esperar un poco antes de intentar eliminar (por si está siendo usado)
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (existsSync(partPath)) {
          const { unlink } = await import('fs/promises');
          await unlink(partPath);
        }
      } catch (e) {
        // Ignorar errores de limpieza
      }
    }
  } catch (e) {
    // Ignorar errores de limpieza
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
          } else {
            // Si no hay callback, mostrar directamente en consola
            console.log(`📥 Descargando audio de ${videoId}: ${percent.toFixed(1)}%`);
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
    
    // Detectar tipo de error específico
    const errorMessage = error.message || '';
    const isAgeVerificationError = errorMessage.includes('Sign in to confirm your age') || 
                                   errorMessage.includes('inappropriate for some users') ||
                                   errorMessage.includes('autenticación') ||
                                   errorMessage.includes('cookies');
    const is403Error = errorMessage.includes('403') || errorMessage.includes('Forbidden');
    const isConversionError = errorMessage.includes('audio conversion failed') || 
                              errorMessage.includes('Conversion failed') ||
                              errorMessage.includes('Postprocessing');
    const isFileLockError = errorMessage.includes('WinError 32') || 
                            errorMessage.includes('Unable to rename file') ||
                            errorMessage.includes('está siendo utilizado por otro proceso') ||
                            errorMessage.includes('being used by another process');
    
    // Si es un error de bloqueo de archivo, intentar recuperar el archivo .part
    if (isFileLockError) {
      try {
        if (showLogCallback) {
          showLogCallback('🔄', videoNumber, totalVideos, videoIdForCleanup, 'Recuperando archivo...', null, null);
        }
        
        // Esperar un poco para que el proceso termine
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Buscar archivos .part para este videoId
        const { readdir, rename } = await import('fs/promises');
        const tempFiles = await readdir(config.storage.tempPath);
        const partFiles = tempFiles.filter(f => f.includes(videoId) && f.endsWith('.part'));
        
        for (const partFile of partFiles) {
          const partPath = join(config.storage.tempPath, partFile);
          // Intentar renombrar el archivo .part al archivo final
          const finalName = partFile.replace('.part', '');
          const finalPath = join(config.storage.tempPath, finalName);
          
          try {
            // Esperar un poco más antes de renombrar
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (existsSync(partPath) && !existsSync(finalPath)) {
              await rename(partPath, finalPath);
              
              // Verificar si el archivo final existe y tiene contenido
              if (existsSync(finalPath)) {
                const { statSync } = await import('fs');
                const stats = statSync(finalPath);
                if (stats.size > 0) {
                  // El archivo se recuperó exitosamente, continuar con el procesamiento
                  const possibleExtensions = ['m4a', 'webm', 'opus', 'ogg', 'mp3'];
                  let downloadedAudioPath = finalPath;
                  
                  // Si no es MP3, intentar convertir
                  if (!finalPath.endsWith('.mp3')) {
                    if (showLogCallback) {
                      showLogCallback('🔄', videoNumber, totalVideos, videoIdForCleanup, 'Convirtiendo a MP3...', null, null);
                    }
                    
                    const { execSync } = await import('child_process');
                    const ffmpegPath = 'ffmpeg';
                    const mp3Path = join(config.storage.tempPath, `${videoId}.mp3`);
                    
                    try {
                      execSync(`"${ffmpegPath}" -i "${finalPath}" -acodec libmp3lame -q:a 0 "${mp3Path}" -y`, {
                        stdio: 'ignore'
                      });
                      
                      try {
                        unlinkSync(finalPath);
                      } catch (e) {
                        // Ignorar errores de eliminación
                      }
                      
                      downloadedAudioPath = mp3Path;
                    } catch (ffmpegError) {
                      // Si falla la conversión, usar el archivo original
                      downloadedAudioPath = finalPath;
                    }
                  }
                  
                  // Obtener metadatos del video
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
                    audioPath: downloadedAudioPath,
                    title,
                    uploadDate,
                  };
                }
              }
            }
          } catch (renameError) {
            // Si falla el renombrado, continuar con el manejo de errores normal
            console.warn('No se pudo renombrar archivo .part:', renameError.message);
          }
        }
      } catch (recoveryError) {
        // Si falla la recuperación, continuar con el manejo de errores normal
        console.warn('Recuperación de archivo .part falló:', recoveryError.message);
      }
    }
    
    // Si es un error de conversión, intentar descargar sin conversión y convertir después
    if (isConversionError && !errorMessage.includes('ya intentado sin conversión')) {
      try {
        if (showLogCallback) {
          showLogCallback('📥', videoNumber, totalVideos, videoIdForCleanup, 'Reintentando sin conversión...', null, null);
        }
        
        // Intentar descargar en formato original (m4a, webm, opus) sin conversión
        const argsNoConversion = [
          youtubeUrl,
          '--format', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best',
          '--output', outputPath,
          '--no-playlist',
          '--no-warnings',
          '--quiet',
        ];
        
        const downloadPromiseNoConversion = new Promise((resolve, reject) => {
          let stderrOutput = '';
          
          const emitter = ytDlpWrap.exec(argsNoConversion);
          
          if (emitter.stderr) {
            emitter.stderr.on('data', (data) => {
              stderrOutput += data.toString();
            });
          }
          
          emitter.on('progress', (progress) => {
            const percent = progress.percent || 0;
            if (showLogCallback && percent > 0) {
              showLogCallback('📥', videoNumber, totalVideos, videoIdForCleanup, 'Descargando audio (sin conversión)', percent, null);
            }
          });
          
          emitter.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`yt-dlp terminó con código ${code}. ${stderrOutput.substring(0, 300)} ya intentado sin conversión`));
            }
          });
          
          emitter.on('error', (error) => {
            reject(error);
          });
        });
        
        await downloadPromiseNoConversion;
        
        // Buscar el archivo descargado (puede ser m4a, webm, opus, etc.)
        const possibleExtensions = ['m4a', 'webm', 'opus', 'ogg', 'mp3'];
        let downloadedAudioPath = null;
        
        for (const ext of possibleExtensions) {
          const testPath = join(config.storage.tempPath, `${videoId}.${ext}`);
          if (existsSync(testPath)) {
            downloadedAudioPath = testPath;
            break;
          }
        }
        
        if (!downloadedAudioPath) {
          throw new Error('No se pudo encontrar el archivo descargado');
        }
        
        // Si no es MP3, intentar convertir con ffmpeg
        if (!downloadedAudioPath.endsWith('.mp3')) {
          if (showLogCallback) {
            showLogCallback('🔄', videoNumber, totalVideos, videoIdForCleanup, 'Convirtiendo a MP3...', null, null);
          }
          
          const { execSync } = await import('child_process');
          const ffmpegPath = 'ffmpeg'; // Asumir que ffmpeg está en PATH
          const mp3Path = join(config.storage.tempPath, `${videoId}.mp3`);
          
          try {
            execSync(`"${ffmpegPath}" -i "${downloadedAudioPath}" -acodec libmp3lame -q:a 0 "${mp3Path}" -y`, {
              stdio: 'ignore'
            });
            
            // Eliminar el archivo original
            try {
              unlinkSync(downloadedAudioPath);
            } catch (e) {
              // Ignorar errores de eliminación
            }
            
            downloadedAudioPath = mp3Path;
          } catch (ffmpegError) {
            // Si falla la conversión, usar el archivo original
            console.warn(`No se pudo convertir a MP3, usando formato original: ${downloadedAudioPath}`);
          }
        }
        
        // Obtener metadatos del video
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
          audioPath: downloadedAudioPath,
          title,
          uploadDate,
        };
      } catch (retryError) {
        // Si el reintento falla, continuar con el manejo de errores normal
        console.warn('Reintento sin conversión falló:', retryError.message);
      }
    }
    
    // Crear mensaje corto para el log
    let shortErrorMessage = 'Error al descargar';
    if (isAgeVerificationError) {
      shortErrorMessage = 'Requiere verificación de edad';
    } else if (is403Error) {
      shortErrorMessage = 'Bloqueado por YouTube (403)';
    } else if (isConversionError) {
      shortErrorMessage = 'Error en conversión de audio';
    } else if (isFileLockError) {
      shortErrorMessage = 'Error de bloqueo de archivo';
    }
    
    // Mostrar mensaje corto en el log si hay callback
    if (showLogCallback) {
      showLogCallback('❌', videoNumber, totalVideos, videoIdForCleanup, shortErrorMessage, null, null);
    }
    
    // Guardar video fallido en archivo JSON
    try {
      await saveFailedVideo(youtubeUrl, error.message);
    } catch (saveError) {
      // Ignorar errores al guardar
    }
    
    // Crear mensaje de error más detallado para el stack
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      youtubeUrl,
      videoId: videoIdForCleanup,
      videoNumber,
      totalVideos,
      errorType: error.constructor.name,
    };
    
    //console.error('Error detallado en downloadAudio:', JSON.stringify(errorDetails, null, 2));
    
    // Lanzar error con mensaje mejorado
    if (isAgeVerificationError) {
      throw new Error(`Video requiere autenticación (verificación de edad). URL: ${youtubeUrl}`);
    } else if (is403Error) {
      throw new Error(`Video bloqueado por YouTube (403). URL: ${youtubeUrl}`);
    } else if (isConversionError) {
      throw new Error(`Error en conversión de audio. URL: ${youtubeUrl}`);
    } else if (isFileLockError) {
      throw new Error(`Error de bloqueo de archivo (Windows). URL: ${youtubeUrl}`);
    } else {
      throw new Error(`Error al descargar audio: ${error.message}\nStack: ${error.stack}\nVideoId: ${videoIdForCleanup}\nURL: ${youtubeUrl}`);
    }
  }
}

/**
 * Verifica si un video tiene restricción de edad
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} videoId - ID del video
 * @returns {Promise<boolean>} - true si tiene restricción de edad, false si no
 */
export async function checkAgeRestriction(youtubeUrl, videoId) {
  try {
    const ytDlpBinaryPath = await ensureYtDlp();
    const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
    
    // Intentar obtener información del video sin descargar
    const args = [
      youtubeUrl,
      '--skip-download',
      '--dump-json',
      '--no-warnings',
      '--quiet',
    ];
    
    try {
      await ytDlpWrap.execPromise(args);
      // Si no hay error, el video no tiene restricción de edad
      return false;
    } catch (error) {
      const errorMessage = error.message || '';
      const isAgeVerificationError = errorMessage.includes('Sign in to confirm your age') || 
                                     errorMessage.includes('inappropriate for some users') ||
                                     errorMessage.includes('autenticación') ||
                                     errorMessage.includes('verificación de edad') ||
                                     errorMessage.includes('cookies');
      return isAgeVerificationError;
    }
  } catch (error) {
    // Si hay un error inesperado, asumir que no tiene restricción (para no bloquear videos válidos)
    return false;
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

/**
 * Descarga los subtítulos de un video de YouTube
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} videoId - ID del video
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @returns {Promise<{srt: string, segments: Array}>} - Subtítulos en formato SRT y segmentos
 */
export async function downloadSubtitles(youtubeUrl, videoId, videoNumber = 1, totalVideos = 1) {
  try {
    // Asegurar que yt-dlp esté disponible
    const ytDlpBinaryPath = await ensureYtDlp();
    const ytDlpWrap = new YTDlpWrap(ytDlpBinaryPath);
    
    // Ruta donde se guardarán los subtítulos
    const subtitlesPath = join(config.storage.tempPath, `${videoId}.%(ext)s`);
    
    if (showLogCallback) {
      showLogCallback('📝', videoNumber, totalVideos, videoId, 'Descargando subtítulos de YouTube...', null, null);
    }
    
    // Intentar descargar subtítulos
    // Primero intentar subtítulos manuales en español, luego automáticos
    const args = [
      youtubeUrl,
      '--write-subs',           // Descargar subtítulos manuales
      '--write-auto-subs',      // Descargar subtítulos automáticos si no hay manuales
      '--sub-lang', 'es,es-419', // Priorizar español
      '--sub-format', 'srt',     // Formato SRT
      '--skip-download',         // No descargar el video/audio
      '--output', subtitlesPath,
      '--no-warnings',
      '--quiet',
    ];
    
    try {
      await ytDlpWrap.execPromise(args);
    } catch (error) {
      // Si falla, intentar solo con subtítulos automáticos
      const autoArgs = [
        youtubeUrl,
        '--write-auto-subs',
        '--sub-lang', 'es,es-419',
        '--sub-format', 'srt',
        '--skip-download',
        '--output', subtitlesPath,
        '--no-warnings',
        '--quiet',
      ];
      
      try {
        await ytDlpWrap.execPromise(autoArgs);
      } catch (autoError) {
        throw new Error('No se encontraron subtítulos disponibles en YouTube para este video');
      }
    }
    
    // Buscar el archivo de subtítulos descargado
    // yt-dlp puede generar archivos con diferentes nombres según el idioma
    const { readdir } = await import('fs/promises');
    const tempFiles = await readdir(config.storage.tempPath);
    const subtitleFiles = tempFiles.filter(f => 
      f.startsWith(videoId) && (f.endsWith('.es.srt') || f.endsWith('.es-419.srt') || f.endsWith('.srt'))
    );
    
    if (subtitleFiles.length === 0) {
      throw new Error('No se encontró el archivo de subtítulos descargado');
    }
    
    // Usar el primer archivo encontrado (preferir .es.srt sobre .es-419.srt)
    const subtitleFile = subtitleFiles.sort((a, b) => {
      if (a.includes('.es.srt') && !b.includes('.es.srt')) return -1;
      if (!a.includes('.es.srt') && b.includes('.es.srt')) return 1;
      return 0;
    })[0];
    
    const subtitlePath = join(config.storage.tempPath, subtitleFile);
    const { readFile } = await import('fs/promises');
    const srtContent = await readFile(subtitlePath, 'utf-8');
    
    if (showLogCallback) {
      showLogCallback('📝', videoNumber, totalVideos, videoId, 'Subtítulos descargados', 100, null);
    }
    
    // Parsear SRT a segmentos (usando la misma función que ya existe)
    const segments = parseSRTContent(srtContent);
    
    return {
      srt: srtContent,
      segments,
    };
  } catch (error) {
    if (showLogCallback) {
      showLogCallback('📝', videoNumber, totalVideos, videoId, `Error: ${error.message}`, null, null);
    }
    throw new Error(`Error al descargar subtítulos de YouTube: ${error.message}`);
  }
}

/**
 * Parsea contenido SRT a segmentos
 * @param {string} srtContent - Contenido del archivo SRT
 * @returns {Array} - Array de segmentos con {start, end, text}
 */
function parseSRTContent(srtContent) {
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
    const timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
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
