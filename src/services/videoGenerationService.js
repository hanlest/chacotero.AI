import ffmpeg from 'fluent-ffmpeg';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../config/config.js';

const execAsync = promisify(exec);

// Map para almacenar el progreso de generación de videos
// Key: generationId, Value: { percent, frames, totalFrames, status, startTime, fps, outputPath, videoTitle }
const videoGenerationProgress = new Map();

// Map para almacenar conexiones SSE activas
// Key: generationId, Value: Set de Response objects
const sseConnections = new Map();

/**
 * Registra una conexión SSE para un generationId
 * @param {string} generationId - ID único de la generación
 * @param {Response} res - Objeto Response de Express para SSE
 */
export function registerSSEConnection(generationId, res) {
  if (!sseConnections.has(generationId)) {
    sseConnections.set(generationId, new Set());
  }
  sseConnections.get(generationId).add(res);
  
  // Enviar progreso actual si existe
  const progress = videoGenerationProgress.get(generationId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierra
  res.on('close', () => {
    const connections = sseConnections.get(generationId);
    if (connections) {
      connections.delete(res);
      if (connections.size === 0) {
        sseConnections.delete(generationId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso
 * @param {string} generationId - ID único de la generación
 * @param {object} progressData - Datos de progreso
 */
function notifySSEConnections(generationId, progressData) {
  const connections = sseConnections.get(generationId);
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
 * Obtiene el progreso de una generación específica
 * @param {string} generationId - ID único de la generación
 * @returns {object|null} - Datos de progreso o null si no existe
 */
export function getVideoGenerationProgress(generationId) {
  return videoGenerationProgress.get(generationId) || null;
}

/**
 * Obtiene todas las generaciones activas
 * @returns {Array} - Array de objetos con generationId y datos de progreso
 */
export function getActiveGenerations() {
  const active = [];
  videoGenerationProgress.forEach((progress, generationId) => {
    if (progress.status === 'processing' || progress.status === 'starting') {
      active.push({
        generationId,
        ...progress
      });
    }
  });
  return active;
}

/**
 * Detecta qué codec de GPU está disponible en el sistema
 * @returns {Promise<string>} Codec disponible: 'h264_nvenc', 'h264_amf', 'h264_qsv', o 'libx264' (fallback)
 */
async function detectGPUCodec() {
  try {
    // Determinar comando según el sistema operativo
    const isWindows = process.platform === 'win32';
    console.log(`   🔍 Sistema operativo: ${process.platform}`);

    // Obtener lista completa de encoders primero
    let encodersOutput = '';
    try {
      const { stdout, stderr } = await execAsync('ffmpeg -hide_banner -encoders');
      encodersOutput = stdout || stderr || '';
    } catch (e) {
      console.log(`   ❌ Error al obtener lista de encoders: ${e.message}`);
      return 'libx264';
    }

    // Verificar NVIDIA NVENC (NVIDIA)
    console.log(`   🔍 Verificando NVIDIA NVENC...`);
    if (encodersOutput.includes('h264_nvenc')) {
      console.log('   ✅ GPU detectada: NVIDIA (NVENC)');
      return 'h264_nvenc';
    } else {
      console.log('   ❌ NVIDIA NVENC no disponible en FFmpeg');
    }

    // Verificar AMD VCE (AMD)
    console.log(`   🔍 Verificando AMD VCE...`);
    if (encodersOutput.includes('h264_amf')) {
      console.log('   ✅ GPU detectada: AMD (VCE)');
      return 'h264_amf';
    } else {
      console.log('   ❌ AMD VCE no disponible en FFmpeg');
    }

    // Verificar Intel Quick Sync (Intel)
    console.log(`   🔍 Verificando Intel Quick Sync...`);
    if (encodersOutput.includes('h264_qsv')) {
      console.log('   ✅ GPU detectada: Intel (Quick Sync)');
      return 'h264_qsv';
    } else {
      console.log('   ❌ Intel Quick Sync no disponible en FFmpeg');
    }

    console.log('   ⚠️  No se detectó GPU, usando codec de software (libx264)');
    console.log('   💡 Nota: Para usar GPU, necesitas FFmpeg compilado con soporte de GPU');
    return 'libx264';
  } catch (error) {
    console.warn('   ⚠️  Error al detectar GPU, usando codec de software (libx264):', error.message);
    return 'libx264';
  }
}

/**
 * Genera un video a partir de un audio, una imagen de fondo y opcionalmente visualización de audio
 * @param {string} audioPath - Ruta del archivo de audio
 * @param {string} imagePath - Ruta de la imagen de fondo
 * @param {string} outputPath - Ruta donde guardar el video generado
 * @param {object} options - Opciones de generación
 * @param {string} options.visualizationType - Tipo de visualización: 'bars', 'waves', 'spectrum', 'vectorscope', 'cqt', 'none' (default: 'none')
 * @param {string|null} options.videoCodec - Códec de video (null = auto-detect GPU, 'libx264' = CPU, 'h264_nvenc' = NVIDIA, 'h264_amf' = AMD, 'h264_qsv' = Intel)
 * @param {boolean} options.useGPU - Intentar usar GPU si está disponible (default: true)
 * @param {string} options.audioCodec - Códec de audio (default: 'aac')
 * @param {number} options.fps - Frames por segundo (default: 30)
 * @param {string} options.resolution - Resolución del video (default: '1920x1080')
 * @param {number} options.bitrate - Bitrate del video en kbps (default: 5000)
 * @param {number} options.barCount - Cantidad de barras a mostrar (menor = menos barras) (default: 64)
 * @param {number} options.barPositionY - Posición Y de las barras en píxeles (null = automático con margen del 10%) (default: null)
 * @param {number} options.barOpacity - Opacidad de las barras (0.0 a 1.0) (default: 0.7)
 * @param {string|null} options.generationId - ID único para rastrear el progreso (opcional)
 * @param {string} options.videoTitle - Título del video para mostrar en el UI (opcional)
 * @returns {Promise<string>} - Ruta del archivo de video generado
 */
export async function generateVideoFromAudio(
  audioPath,
  imagePath,
  outputPath,
  options = {}
) {
  const { generationId = null, videoTitle = null } = options;
  // Validar que los archivos existan
  if (!existsSync(audioPath)) {
    throw new Error(`El archivo de audio no existe: ${audioPath}`);
  }

  if (!existsSync(imagePath)) {
    throw new Error(`La imagen de fondo no existe: ${imagePath}`);
  }

  // Opciones por defecto
  const {
    visualizationType = 'none', // 'bars', 'waves', 'spectrum', 'vectorscope', 'cqt', 'none'
    videoCodec = null, // null = auto-detect GPU, 'libx264' = CPU, 'h264_nvenc' = NVIDIA, 'h264_amf' = AMD, 'h264_qsv' = Intel
    useGPU = true, // Intentar usar GPU si está disponible
    audioCodec = 'aac',
    fps = 30,
    resolution = '1920x1080',
    bitrate = 5000,
    barCount = 64, // Cantidad de barras (menor = menos barras)
    barPositionY = null, // Posición Y de las barras (null = automático)
    barOpacity = 0.7, // Opacidad de las barras (0.0 a 1.0)
  } = options;

  // Detectar codec de GPU si no se especifica y useGPU está habilitado
  let finalVideoCodec = videoCodec;
  if (!finalVideoCodec && useGPU) {
    console.log('🔍 Detectando GPU disponible...');
    try {
      finalVideoCodec = await detectGPUCodec();
      console.log(`   ✅ Codec seleccionado: ${finalVideoCodec}`);
    } catch (error) {
      console.warn('⚠️  Error al detectar GPU, usando codec de software:', error.message);
      finalVideoCodec = 'libx264';
    }
  } else if (!finalVideoCodec) {
    finalVideoCodec = 'libx264';
  } else if (finalVideoCodec) {
    console.log(`   ℹ️  Usando codec especificado manualmente: ${finalVideoCodec}`);
  }

  return new Promise((resolve, reject) => {
    console.log('🎬 Iniciando generación de video...');
    
    // Inicializar progreso si hay generationId
    if (generationId) {
      videoGenerationProgress.set(generationId, {
        percent: 0,
        frames: 0,
        totalFrames: 0,
        status: 'starting',
        startTime: Date.now(),
        fps: 0,
        outputPath: outputPath,
        videoTitle: videoTitle || 'Generando video...'
      });
      notifySSEConnections(generationId, videoGenerationProgress.get(generationId));
    }
    /*console.log(`📁 Audio: ${audioPath}`);
    console.log(`🖼️  Imagen: ${imagePath}`);
    console.log(`💾 Salida: ${outputPath}`);
    console.log('✅ Archivo de audio encontrado');
    console.log('✅ Imagen de fondo encontrada');

    console.log(`⚙️  Configuración:`);
    console.log(`   - Visualización: ${visualizationType}`);
    console.log(`   - Resolución: ${resolution}`);
    console.log(`   - FPS: ${fps}`);
    console.log(`   - Bitrate: ${bitrate} kbps`);
    console.log(`   - Códec video: ${finalVideoCodec} ${finalVideoCodec !== 'libx264' ? '(GPU)' : '(CPU)'}`);
    console.log(`   - Códec audio: ${audioCodec}`);
    if (visualizationType === 'bars') {
      console.log(`   - Cantidad de barras: ${barCount}`);
      console.log(`   - Posición Y: ${barPositionY !== null ? barPositionY + 'px' : 'automático (margen 10%)'}`);
      console.log(`   - Opacidad: ${Math.round(barOpacity * 100)}%`);
    }*/

    // Obtener duración del audio
    //console.log('📊 Analizando metadatos del audio...');
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`❌ Error al obtener metadatos: ${err.message}`);
        reject(new Error(`Error al obtener metadatos del audio: ${err.message}`));
        return;
      }

      const duration = metadata.format.duration;
      const durationMinutes = Math.floor(duration / 60);
      const durationSeconds = Math.floor(duration % 60);
      //console.log(`✅ Duración del audio: ${durationMinutes}:${durationSeconds.toString().padStart(2, '0')} (${duration.toFixed(2)}s)`);
      
      // Calcular total de frames esperados
      const totalFrames = Math.ceil(duration * fps);
      //console.log(`📊 Total de frames esperados: ${totalFrames} (${duration.toFixed(2)}s × ${fps} fps)`);
      
      // Actualizar totalFrames en el progreso
      if (generationId) {
        const progress = videoGenerationProgress.get(generationId);
        if (progress) {
          progress.totalFrames = totalFrames;
          progress.status = 'processing';
          notifySSEConnections(generationId, progress);
        }
      }

      // Construir el comando de ffmpeg
      let command = ffmpeg();

      // Agregar imagen de fondo como input
      command = command.input(imagePath);

      // Agregar audio como input
      command = command.input(audioPath);

      // Configurar el filtro complejo según el tipo de visualización
      let filterComplex = '';
      let outputOptions = [];

      if (visualizationType === 'bars') {
        // Barras de audio (showfreqs) - mejorado para mejor visualización
        // Extraer ancho y alto de la resolución
        const [width, height] = resolution.split('x').map(Number);
        // Crear visualización de barras en la parte inferior del video, pero un poco más arriba
        // Las barras ocuparán 1/4 de la altura del video
        const barHeight = Math.floor(height / 4);
        // Calcular posición Y: usar barPositionY si se especifica, sino calcular automáticamente
        let barY;
        if (barPositionY !== null && barPositionY !== undefined) {
          // Usar posición Y especificada
          barY = Math.max(0, Math.min(height - barHeight, barPositionY));
        } else {
          // Posición automática: colocar las barras lo más abajo posible (sin margen)
          barY = height - barHeight;
        }
        
        // Usar todo el ancho del video para las barras
        const visualizationWidth = width;
        const visualizationX = 0; // Sin centrar, usar todo el ancho
        
        // Calcular win_size para controlar la resolución de frecuencia y suavidad
        // win_size puede ser: 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536
        // Un win_size más grande = más suave pero más lento de procesar
        // Ajustar según barCount: más barras = win_size más grande
        const baseBarCount = 64;
        const widthRatio = barCount / baseBarCount;
        const baseWinSize = 4096; // Aumentado para más suavidad
        const winSize = Math.max(1024, Math.min(65536, Math.round(baseWinSize * widthRatio)));
        
        // Aplicar opacidad usando el filtro 'format=yuva420p' y 'geq' para modificar el canal alpha
        const opacityValue = barOpacity.toFixed(2);
        
        // Usar showfreqs con configuración personalizada
        // fscale=log para mejor distribución de frecuencias
        // rate=10 para hacer que las barras se muevan más lento (por defecto es 25)
        // win_size más grande = barras más suaves
        // El tamaño de visualización controla cuántas barras se muestran
        // Aplicar opacidad convirtiendo a formato con canal alpha y luego modificándolo
        // geq usa 'a' (no 'alpha') para el canal alpha en formato yuva420p
        const barRate = 10; // Reducir a 10 fps para movimiento más lento y suave
        filterComplex = `[1:a]showfreqs=mode=bar:ascale=log:fscale=log:win_size=${winSize}:rate=${barRate}:colors=0xff0000:size=${visualizationWidth}x${barHeight}[freq_raw];[freq_raw]format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='p(X,Y)*${opacityValue}'[freq];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][freq]overlay=${visualizationX}:${barY}[v]`;
        
        /*console.log(`   [DEBUG] Configuración de barras:`);
        console.log(`      - Ancho visualización: ${visualizationWidth}px (todo el ancho)`);
        console.log(`      - win_size: ${winSize}`);
        console.log(`      - Rate: ${barRate} fps (movimiento más lento)`);
        console.log(`      - Opacidad: ${opacityValue} (${Math.round(barOpacity * 100)}%)`);
        console.log(`      - Posición Y: ${barY}px (parte inferior, sin margen)`);
        console.log(`      - Posición X: ${visualizationX}px`);*/
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      } else if (visualizationType === 'waves') {
        // Ondas de audio (showwaves)
        const [width, height] = resolution.split('x').map(Number);
        const waveHeight = Math.floor(height / 4);
        const waveY = height - waveHeight;
        filterComplex = `[1:a]showwaves=mode=line:size=${width}x${waveHeight}:colors=0x00ff00@0.9[waves];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][waves]overlay=0:${waveY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      } else if (visualizationType === 'spectrum') {
        // Espectrograma (showspectrum) - visualización de frecuencia en el tiempo
        const [width, height] = resolution.split('x').map(Number);
        const spectrumHeight = Math.floor(height / 3);
        const spectrumY = height - spectrumHeight;
        filterComplex = `[1:a]showspectrum=mode=combined:color=rainbow:scale=log:size=${width}x${spectrumHeight}[spec];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][spec]overlay=0:${spectrumY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      } else if (visualizationType === 'vectorscope') {
        // Vectorscopio (avectorscope) - visualización estéreo
        const [width, height] = resolution.split('x').map(Number);
        const scopeSize = Math.min(Math.floor(width / 2), Math.floor(height / 2));
        const scopeX = Math.floor((width - scopeSize) / 2);
        const scopeY = Math.floor((height - scopeSize) / 2);
        filterComplex = `[1:a]avectorscope=mode=lissajous_xy:size=${scopeSize}x${scopeSize}:rate=${fps}[scope];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][scope]overlay=${scopeX}:${scopeY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      } else if (visualizationType === 'cqt') {
        // Visualización en escala musical (showcqt)
        const [width, height] = resolution.split('x').map(Number);
        const cqtHeight = Math.floor(height / 3);
        const cqtY = height - cqtHeight;
        filterComplex = `[1:a]showcqt=size=${width}x${cqtHeight}:rate=${fps}:basefreq=20.0:endfreq=20000[music];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][music]overlay=0:${cqtY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      } else {
        // Sin visualización, solo imagen de fondo que se repite
        filterComplex = `[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${finalVideoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
        
        // Opciones adicionales para codecs de GPU
        if (finalVideoCodec === 'h264_nvenc') {
          // NVIDIA NVENC: usar preset para mejor rendimiento
          outputOptions.push('-preset', 'p4'); // p4 = balanced, p1 = fastest, p7 = slowest (mejor calidad)
          outputOptions.push('-rc', 'vbr'); // Variable bitrate
        } else if (finalVideoCodec === 'h264_amf') {
          // AMD VCE: usar preset
          outputOptions.push('-quality', 'balanced'); // balanced, speed, quality
        } else if (finalVideoCodec === 'h264_qsv') {
          // Intel Quick Sync: usar preset
          outputOptions.push('-preset', 'balanced'); // balanced, fast, medium, slow, slower, veryslow
        }
      }

      // Aplicar filtros
      //console.log('🔧 Configurando filtros de video...');
      if (filterComplex) {
        command = command.complexFilter(filterComplex);
        //console.log('✅ Filtros configurados');
      }

      // Configurar output
      console.log('🚀 Iniciando renderizado de video con FFmpeg...');
      
      // Variables para calcular FPS
      let startTime = null;
      let lastFrames = 0;
      let lastFpsTime = null;
      
      command
        .outputOptions(outputOptions)
        .output(outputPath)
        .on('start', (commandLine) => {
          //console.log('📝 Comando FFmpeg ejecutado');
          startTime = Date.now();
          lastFpsTime = Date.now();
        })
        .on('progress', (progress) => {
          let percent = 0;
          let displayText = '';
          let fpsText = '';
          let averageFps = 0;
          let instantFps = 0;
          
          // Calcular porcentaje basado en frames procesados
          if (progress.frames !== undefined && totalFrames > 0) {
            percent = Math.min(100, Math.round((progress.frames / totalFrames) * 100));
            displayText = `Frames: ${progress.frames}/${totalFrames}`;
            
            // Calcular FPS (frames por segundo)
            if (startTime !== null && progress.frames > 0) {
              const currentTime = Date.now();
              const elapsedSeconds = (currentTime - startTime) / 1000;
              
              if (elapsedSeconds > 0) {
                // FPS promedio desde el inicio
                averageFps = progress.frames / elapsedSeconds;
                
                // FPS instantáneo (último segundo)
                instantFps = 0;
                if (lastFpsTime !== null && lastFrames < progress.frames) {
                  const timeSinceLastUpdate = (currentTime - lastFpsTime) / 1000;
                  if (timeSinceLastUpdate > 0) {
                    const framesSinceLastUpdate = progress.frames - lastFrames;
                    instantFps = framesSinceLastUpdate / timeSinceLastUpdate;
                  }
                }
                
                // Mostrar FPS promedio y/o instantáneo
                if (instantFps > 0 && elapsedSeconds > 1) {
                  fpsText = ` | FPS: ${averageFps.toFixed(1)} (prom) / ${instantFps.toFixed(1)} (inst)`;
                } else {
                  fpsText = ` | FPS: ${averageFps.toFixed(1)}`;
                }
                
                lastFrames = progress.frames;
                lastFpsTime = currentTime;
              }
            }
          } else if (progress.percent !== undefined) {
            // Si FFmpeg proporciona porcentaje directamente, usarlo
            percent = Math.round(progress.percent);
            displayText = `Procesando`;
          }
          
          if (percent > 0) {
            const time = progress.timemark || '00:00:00';
            // Crear barra de progreso visual
            const barLength = 30;
            const filled = Math.round((percent / 100) * barLength);
            const empty = barLength - filled;
            const bar = '█'.repeat(filled) + '░'.repeat(empty);
            process.stdout.write(`\r⏳ Progreso: [${bar}] ${percent}% | ${displayText}${fpsText} | Tiempo: ${time}`);
            
            // Actualizar progreso en el Map y notificar SSE
            if (generationId) {
              const progressData = videoGenerationProgress.get(generationId);
              if (progressData) {
                progressData.percent = percent;
                progressData.frames = progress.frames || 0;
                progressData.totalFrames = totalFrames;
                progressData.status = 'processing';
                progressData.fps = instantFps > 0 ? instantFps : (averageFps > 0 ? averageFps : 0);
                notifySSEConnections(generationId, progressData);
              }
            }
          } else if (progress.frames !== undefined) {
            // Si no podemos calcular porcentaje pero tenemos frames
            process.stdout.write(`\r📹 Frames procesados: ${progress.frames}/${totalFrames || '?'}${fpsText}`);
            
            // Actualizar progreso en el Map
            if (generationId) {
              const progressData = videoGenerationProgress.get(generationId);
              if (progressData) {
                progressData.frames = progress.frames;
                progressData.totalFrames = totalFrames;
                progressData.status = 'processing';
                notifySSEConnections(generationId, progressData);
              }
            }
          }
        })
        .on('end', () => {
          console.log('\n✅ Video generado exitosamente!');
          console.log(`📁 Archivo guardado en: ${outputPath}`);
          
          // Actualizar progreso a completado
          if (generationId) {
            const progressData = videoGenerationProgress.get(generationId);
            if (progressData) {
              progressData.percent = 100;
              progressData.status = 'completed';
              notifySSEConnections(generationId, progressData);
              
              // Limpiar después de 5 minutos
              setTimeout(() => {
                videoGenerationProgress.delete(generationId);
                sseConnections.delete(generationId);
              }, 5 * 60 * 1000);
            }
          }
          
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('\n❌ Error al generar video:');
          console.error(`   Mensaje: ${err.message}`);
          if (err.stderr) {
            console.error(`   Detalles: ${err.stderr}`);
          }
          
          // Actualizar progreso a error
          if (generationId) {
            const progressData = videoGenerationProgress.get(generationId);
            if (progressData) {
              progressData.status = 'error';
              progressData.error = err.message;
              notifySSEConnections(generationId, progressData);
              
              // Limpiar después de 5 minutos
              setTimeout(() => {
                videoGenerationProgress.delete(generationId);
                sseConnections.delete(generationId);
              }, 5 * 60 * 1000);
            }
          }
          
          reject(new Error(`Error al generar video: ${err.message}`));
        })
        .run();
    });
  });
}
