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
 * Muestra una barra de progreso animada para la transcripción
 * @param {number} fileSizeMB - Tamaño del archivo en MB (para estimar tiempo)
 */
function showTranscriptionProgress(fileSizeMB) {
  const barLength = 50; // Barra de progreso
  let progress = 0;
  const startTime = Date.now();
  let isComplete = false;
  
  // Estimar tiempo basado en tamaño (aproximadamente 1MB por minuto de procesamiento)
  const estimatedSeconds = Math.max(10, Math.min(120, fileSizeMB * 10));
  
  const interval = setInterval(() => {
    if (isComplete) {
      clearInterval(interval);
      return;
    }
    
    const elapsed = (Date.now() - startTime) / 1000;
    // Simular progreso basado en tiempo transcurrido, pero no llegar al 100% hasta que termine
    progress = Math.min(90, (elapsed / estimatedSeconds) * 100);
    
    const filled = Math.round((progress / 100) * barLength);
    const empty = barLength - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const percentStr = progress.toFixed(1).padStart(5, ' ');
    const elapsedStr = formatTime(elapsed);
    
    process.stdout.write(`\r🎤 [${bar}] ${percentStr}% | Tiempo: ${elapsedStr}`);
  }, 200);
  
  return () => {
    isComplete = true;
    clearInterval(interval);
    // Completar la barra y limpiarla
    const bar = '█'.repeat(barLength);
    process.stdout.write(`\r🎤 [${bar}] 100.0% | Completado\n`);
  };
}

/**
 * Muestra una barra de progreso para la compresión de audio
 * @param {number} percent - Porcentaje de progreso
 */
function showCompressionProgressBar(percent) {
  const barLength = 50; // Barra de progreso
  const filled = Math.round((percent / 100) * barLength);
  const empty = barLength - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percentStr = percent.toFixed(1).padStart(5, ' ');
  process.stdout.write(`\r🗜️  [${bar}] ${percentStr}%`);
}

/**
 * Comprime un archivo de audio para reducir su tamaño
 * @param {string} inputPath - Ruta del archivo original
 * @param {string} outputPath - Ruta donde guardar el archivo comprimido
 * @returns {Promise<string>} - Ruta del archivo comprimido
 */
async function compressAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('🗜️  Comprimiendo audio para transcripción...');
    
    // Calcular bitrate objetivo para que el archivo sea aproximadamente 20MB
    const stats = statSync(inputPath);
    const originalSizeMB = stats.size / (1024 * 1024);
    const targetSizeMB = 20; // Objetivo: 20MB para dejar margen
    const targetBitrate = Math.max(32, Math.min(128, Math.floor((targetSizeMB / originalSizeMB) * 128)));
    
    console.log(`   Tamaño original: ${originalSizeMB.toFixed(2)}MB`);
    console.log(`   Comprimiendo a ${targetBitrate}kbps...`);
    
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(targetBitrate)
      .audioChannels(1) // Mono para reducir tamaño
      .audioFrequency(16000) // 16kHz es suficiente para transcripción
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent !== undefined) {
          showCompressionProgressBar(progress.percent);
        }
      })
      .on('end', () => {
        // Completar y limpiar la barra de progreso
        const bar = '█'.repeat(50);
        process.stdout.write(`\r🗜️  [${bar}] 100.0%\n`);
        
        const compressedStats = statSync(outputPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        console.log(`   ✅ Compresión completada: ${compressedSizeMB.toFixed(2)}MB`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        // Limpiar la barra de progreso en caso de error
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        reject(new Error(`Error al comprimir audio: ${err.message}`));
      })
      .run();
  });
}

/**
 * Transcribe un archivo de audio usando Whisper
 * @param {string} audioPath - Ruta del archivo de audio
 * @returns {Promise<{transcription: string, srt: string, segments: Array}>}
 */
export async function transcribeAudio(audioPath) {
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
        console.log('✅ Audio comprimido ya existe, usando archivo existente');
        audioToTranscribe = compressedAudioPath;
        
        // Verificar el tamaño del archivo comprimido
        const compressedStats = statSync(compressedAudioPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        
        if (compressedSizeMB > 25) {
          // Si aún es muy grande, intentar con la versión más comprimida
          const moreCompressedPath = join(dir, `${baseName}_min2.mp3`);
          if (existsSync(moreCompressedPath)) {
            console.log('✅ Audio más comprimido ya existe, usando archivo existente');
            audioToTranscribe = moreCompressedPath;
            compressedAudioPath = moreCompressedPath;
          } else {
            // Comprimir más agresivamente
            // if (existsSync(compressedAudioPath)) {
            //   unlinkSync(compressedAudioPath);
            // }
            audioToTranscribe = await compressAudio(audioPath, moreCompressedPath);
            compressedAudioPath = moreCompressedPath;
          }
        }
      } else {
        // Comprimir el audio
        audioToTranscribe = await compressAudio(audioPath, compressedAudioPath);
        
        // Verificar el tamaño del archivo comprimido
        const compressedStats = statSync(compressedAudioPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        
        if (compressedSizeMB > 25) {
          // Si aún es muy grande, comprimir más agresivamente
          const moreCompressedPath = join(dir, `${baseName}_min2.mp3`);
          // if (existsSync(compressedAudioPath)) {
          //   unlinkSync(compressedAudioPath);
          // }
          audioToTranscribe = await compressAudio(audioPath, moreCompressedPath);
          compressedAudioPath = moreCompressedPath;
        }
      }
    }
    
    // Obtener tamaño del archivo a transcribir (puede ser el comprimido)
    const finalStats = statSync(audioToTranscribe);
    const finalSizeMB = finalStats.size / (1024 * 1024);
    
    // Log antes de iniciar la transcripción
    console.log(`   Tamaño: ${finalSizeMB.toFixed(2)}MB`);
    
    // Iniciar barra de progreso
    const stopProgress = showTranscriptionProgress(finalSizeMB);
    
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

      // Transcribir con Whisper con timeout
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
      
      // Detener la barra de progreso inmediatamente después de recibir la respuesta
      stopProgress();
    } catch (apiError) {
      stopProgress();
      
      // Limpiar archivo comprimido si existe y hay error
      // if (compressedAudioPath && existsSync(compressedAudioPath)) {
      //   try {
      //     unlinkSync(compressedAudioPath);
      //   } catch (e) {
      //     // Ignorar errores de limpieza
      //   }
      // }
      
      // Mejorar mensajes de error
      if (apiError.message.includes('Connection error') || apiError.message.includes('ECONNREFUSED')) {
        throw new Error('Error de conexión con la API de OpenAI. Verifica tu conexión a internet y que la API key sea válida.');
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
