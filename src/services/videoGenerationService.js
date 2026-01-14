import ffmpeg from 'fluent-ffmpeg';
import { existsSync } from 'fs';
import { join } from 'path';
import config from '../config/config.js';

/**
 * Genera un video a partir de un audio, una imagen de fondo y opcionalmente visualización de audio
 * @param {string} audioPath - Ruta del archivo de audio
 * @param {string} imagePath - Ruta de la imagen de fondo
 * @param {string} outputPath - Ruta donde guardar el video generado
 * @param {object} options - Opciones de generación
 * @param {string} options.visualizationType - Tipo de visualización: 'bars', 'waves', 'spectrum', 'vectorscope', 'cqt', 'none' (default: 'none')
 * @param {string} options.videoCodec - Códec de video (default: 'libx264')
 * @param {string} options.audioCodec - Códec de audio (default: 'aac')
 * @param {number} options.fps - Frames por segundo (default: 30)
 * @param {string} options.resolution - Resolución del video (default: '1920x1080')
 * @param {number} options.bitrate - Bitrate del video en kbps (default: 5000)
 * @param {number} options.barCount - Cantidad de barras a mostrar (menor = menos barras) (default: 64)
 * @param {number} options.barPositionY - Posición Y de las barras en píxeles (null = automático con margen del 10%) (default: null)
 * @param {number} options.barOpacity - Opacidad de las barras (0.0 a 1.0) (default: 0.7)
 * @returns {Promise<string>} - Ruta del archivo de video generado
 */
export async function generateVideoFromAudio(
  audioPath,
  imagePath,
  outputPath,
  options = {}
) {
  return new Promise((resolve, reject) => {
    console.log('🎬 Iniciando generación de video...');
    console.log(`📁 Audio: ${audioPath}`);
    console.log(`🖼️  Imagen: ${imagePath}`);
    console.log(`💾 Salida: ${outputPath}`);
    
    // Validar que los archivos existan
    if (!existsSync(audioPath)) {
      console.error(`❌ Error: El archivo de audio no existe: ${audioPath}`);
      reject(new Error(`El archivo de audio no existe: ${audioPath}`));
      return;
    }
    console.log('✅ Archivo de audio encontrado');

    if (!existsSync(imagePath)) {
      console.error(`❌ Error: La imagen de fondo no existe: ${imagePath}`);
      reject(new Error(`La imagen de fondo no existe: ${imagePath}`));
      return;
    }
    console.log('✅ Imagen de fondo encontrada');

    // Opciones por defecto
    const {
      visualizationType = 'none', // 'bars', 'waves', 'spectrum', 'vectorscope', 'cqt', 'none'
      videoCodec = 'libx264',
      audioCodec = 'aac',
      fps = 30,
      resolution = '1920x1080',
      bitrate = 5000,
      barCount = 64, // Cantidad de barras (menor = menos barras)
      barPositionY = null, // Posición Y de las barras (null = automático)
      barOpacity = 0.7, // Opacidad de las barras (0.0 a 1.0)
    } = options;

    console.log(`⚙️  Configuración:`);
    console.log(`   - Visualización: ${visualizationType}`);
    console.log(`   - Resolución: ${resolution}`);
    console.log(`   - FPS: ${fps}`);
    console.log(`   - Bitrate: ${bitrate} kbps`);
    console.log(`   - Códec video: ${videoCodec}`);
    console.log(`   - Códec audio: ${audioCodec}`);
    if (visualizationType === 'bars') {
      console.log(`   - Cantidad de barras: ${barCount}`);
      console.log(`   - Posición Y: ${barPositionY !== null ? barPositionY + 'px' : 'automático (margen 10%)'}`);
      console.log(`   - Opacidad: ${Math.round(barOpacity * 100)}%`);
    }

    // Obtener duración del audio
    console.log('📊 Analizando metadatos del audio...');
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`❌ Error al obtener metadatos: ${err.message}`);
        reject(new Error(`Error al obtener metadatos del audio: ${err.message}`));
        return;
      }

      const duration = metadata.format.duration;
      const durationMinutes = Math.floor(duration / 60);
      const durationSeconds = Math.floor(duration % 60);
      console.log(`✅ Duración del audio: ${durationMinutes}:${durationSeconds.toString().padStart(2, '0')} (${duration.toFixed(2)}s)`);
      
      // Calcular total de frames esperados
      const totalFrames = Math.ceil(duration * fps);
      console.log(`📊 Total de frames esperados: ${totalFrames} (${duration.toFixed(2)}s × ${fps} fps)`);

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
          // Posición automática: dejar un espacio del 10% de la altura del video desde abajo
          const bottomMargin = Math.floor(height * 0.1); // 10% de margen inferior
          barY = height - barHeight - bottomMargin;
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
        
        console.log(`   [DEBUG] Configuración de barras:`);
        console.log(`      - Ancho visualización: ${visualizationWidth}px (todo el ancho)`);
        console.log(`      - win_size: ${winSize}`);
        console.log(`      - Rate: ${barRate} fps (movimiento más lento)`);
        console.log(`      - Opacidad: ${opacityValue} (${Math.round(barOpacity * 100)}%)`);
        console.log(`      - Posición Y: ${barY}px (parte inferior con margen 10%)`);
        console.log(`      - Posición X: ${visualizationX}px`);
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
      } else if (visualizationType === 'waves') {
        // Ondas de audio (showwaves)
        const [width, height] = resolution.split('x').map(Number);
        const waveHeight = Math.floor(height / 4);
        const waveY = height - waveHeight;
        filterComplex = `[1:a]showwaves=mode=line:size=${width}x${waveHeight}:colors=0x00ff00@0.9[waves];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][waves]overlay=0:${waveY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
      } else if (visualizationType === 'spectrum') {
        // Espectrograma (showspectrum) - visualización de frecuencia en el tiempo
        const [width, height] = resolution.split('x').map(Number);
        const spectrumHeight = Math.floor(height / 3);
        const spectrumY = height - spectrumHeight;
        filterComplex = `[1:a]showspectrum=mode=combined:color=rainbow:scale=log:size=${width}x${spectrumHeight}[spec];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][spec]overlay=0:${spectrumY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
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
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
      } else if (visualizationType === 'cqt') {
        // Visualización en escala musical (showcqt)
        const [width, height] = resolution.split('x').map(Number);
        const cqtHeight = Math.floor(height / 3);
        const cqtY = height - cqtHeight;
        filterComplex = `[1:a]showcqt=size=${width}x${cqtHeight}:rate=${fps}:basefreq=20.0:endfreq=20000[music];[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[bg];[bg][music]overlay=0:${cqtY}[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
      } else {
        // Sin visualización, solo imagen de fondo que se repite
        filterComplex = `[0:v]scale=${resolution},loop=loop=-1:size=1:start=0[v]`;
        outputOptions = [
          `-map [v]`,
          `-map 1:a`,
          `-c:v ${videoCodec}`,
          `-c:a ${audioCodec}`,
          `-r ${fps}`,
          `-b:v ${bitrate}k`,
          `-pix_fmt yuv420p`,
          `-shortest`,
        ];
      }

      // Aplicar filtros
      console.log('🔧 Configurando filtros de video...');
      if (filterComplex) {
        command = command.complexFilter(filterComplex);
        console.log('✅ Filtros configurados');
      }

      // Configurar output
      console.log('🚀 Iniciando renderizado de video con FFmpeg...');
      command
        .outputOptions(outputOptions)
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log('📝 Comando FFmpeg ejecutado');
        })
        .on('progress', (progress) => {
          let percent = 0;
          let displayText = '';
          
          // Calcular porcentaje basado en frames procesados
          if (progress.frames !== undefined && totalFrames > 0) {
            percent = Math.min(100, Math.round((progress.frames / totalFrames) * 100));
            displayText = `Frames: ${progress.frames}/${totalFrames}`;
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
            process.stdout.write(`\r⏳ Progreso: [${bar}] ${percent}% | ${displayText} | Tiempo: ${time}`);
          } else if (progress.frames !== undefined) {
            // Si no podemos calcular porcentaje pero tenemos frames
            process.stdout.write(`\r📹 Frames procesados: ${progress.frames}/${totalFrames || '?'}`);
          }
        })
        .on('end', () => {
          console.log('\n✅ Video generado exitosamente!');
          console.log(`📁 Archivo guardado en: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('\n❌ Error al generar video:');
          console.error(`   Mensaje: ${err.message}`);
          if (err.stderr) {
            console.error(`   Detalles: ${err.stderr}`);
          }
          reject(new Error(`Error al generar video: ${err.message}`));
        })
        .run();
    });
  });
}
