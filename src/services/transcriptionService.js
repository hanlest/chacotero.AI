import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { statSync, existsSync, unlinkSync } from 'fs';
import { basename, join, dirname } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import config from '../config/config.js';
import { pipeline, env } from '@xenova/transformers';
import pkg from 'wavefile';
const { WaveFile } = pkg;

// Suprimir warnings de onnxruntime (son informativos y no afectan la funcionalidad)
env.suppressWarnings = true;

// Suprimir warnings de onnxruntime a nivel de proceso
if (typeof process !== 'undefined' && process.stderr) {
  // Guardar la función original
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  
  // Redirigir stderr para filtrar warnings de onnxruntime
  process.stderr.write = function(chunk, encoding, fd) {
    // Convertir chunk a string si es necesario
    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString();
    
    // Filtrar warnings de onnxruntime sobre initializers no utilizados
    if (chunkStr.includes('onnxruntime') && 
        (chunkStr.includes('CleanUnusedInitializersAndNodeArgs') || 
         chunkStr.includes('Removing initializer'))) {
      return true; // Suprimir el warning
    }
    
    // Pasar todos los demás mensajes normalmente
    return originalStderrWrite(chunk, encoding, fd);
  };
}

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
 * Variable global para el modelo de Whisper local (se carga una vez)
 */
let whisperModel = null;

/**
 * Carga el modelo de Whisper local (se carga solo una vez)
 * @returns {Promise<Object>} - Modelo de transcripción
 */
async function loadWhisperModel() {
  if (whisperModel) {
    return whisperModel;
  }

  const modelName = `Xenova/whisper-${config.whisper.modelSize}`;
  
  if (showLogCallback) {
    // No tenemos videoNumber aquí, así que usamos valores por defecto
    showLogCallback('🎤', 0, 0, '', 'Cargando modelo Whisper local...', null, null);
  }

  try {
    whisperModel = await pipeline(
      'automatic-speech-recognition',
      modelName,
      {
        device: config.whisper.device,
        dtype: 'q8', // Quantización para reducir uso de memoria
      }
    );
    
    if (showLogCallback) {
      showLogCallback('🎤', 0, 0, '', 'Modelo Whisper cargado', 100, null);
    }
    
    return whisperModel;
  } catch (error) {
    throw new Error(`Error al cargar modelo Whisper: ${error.message}`);
  }
}

/**
 * Transcribe audio usando Whisper local (@xenova/transformers)
 * @param {string} audioPath - Ruta del archivo de audio
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @returns {Promise<{transcription: string, srt: string, segments: Array}>}
 */
async function transcribeAudioLocal(audioPath, videoNumber = 1, totalVideos = 1, videoId = '') {
  const startTime = Date.now();
  let lastUpdate = Date.now();
  let progressInterval = null; // Declarar fuera del try para que esté disponible en los catch
  
  try {
    // Obtener tamaño del archivo para estimar tiempo
    const stats = statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    // Estimar tiempo: @xenova/transformers es más lento que faster-whisper
    // En CPU: aproximadamente 1-2x tiempo real (depende del modelo)
    const modelSpeedFactor = {
      'tiny': 0.5,    // ~0.5x tiempo real
      'base': 1.0,    // ~1x tiempo real
      'small': 1.5,   // ~1.5x tiempo real
      'medium': 2.5,  // ~2.5x tiempo real
      'large-v2': 4.0, // ~4x tiempo real
      'large-v3': 4.0, // ~4x tiempo real
    };
    
    const speedFactor = modelSpeedFactor[config.whisper.modelSize] || 1.0;
    let estimatedDuration = Math.max(30, fileSizeMB * speedFactor);
    
    // Cargar modelo si no está cargado
    const model = await loadWhisperModel();
    
    // Simular progreso mientras procesa
    progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      
      // Ajustar dinámicamente la estimación
      if (elapsed > 10 && (elapsed / estimatedDuration) * 100 > 90) {
        estimatedDuration = elapsed / 0.95;
      }
      
      const linearProgress = Math.min(0.99, (elapsed / estimatedDuration));
      const estimatedProgress = Math.min(99, linearProgress * 100);
      
      if (showLogCallback && Date.now() - lastUpdate > 500) {
        showLogCallback('🎤', videoNumber, totalVideos, videoId, 'Transcribiendo (local)', estimatedProgress, elapsed);
        lastUpdate = Date.now();
      }
    }, 500);
    
    // Leer y procesar el archivo de audio
    // @xenova/transformers requiere el audio como buffer en Node.js
    // Convertir MP3 a WAV usando ffmpeg temporalmente
    const tempWavPath = join(dirname(audioPath), `${basename(audioPath, '.mp3')}_temp_${Date.now()}.wav`);
    
    try {
      // Convertir MP3 a WAV usando ffmpeg
      if (showLogCallback) {
        showLogCallback('🔄', videoNumber, totalVideos, videoId, 'Convirtiendo audio a WAV...', null, null);
      }
      
      await new Promise((resolve, reject) => {
        ffmpeg(audioPath)
          .audioCodec('pcm_s16le')
          .audioChannels(1) // Mono
          .audioFrequency(16000) // 16kHz (requerido por Whisper)
          .output(tempWavPath)
          .on('end', resolve)
          .on('error', (err) => {
            reject(new Error(`Error al convertir audio a WAV: ${err.message}`));
          })
          .run();
      });
      
      // Leer el archivo WAV como buffer
      const wavBuffer = await readFile(tempWavPath);
      
      // Cargar el WAV usando wavefile
      const wav = new WaveFile(wavBuffer);
      
      // Convertir a 16-bit y 16kHz si es necesario
      if (wav.fmt.bitsPerSample !== 16) {
        wav.toBitDepth('16');
      }
      if (wav.fmt.sampleRate !== 16000) {
        wav.toSampleRate(16000);
      }
      
      // Obtener los datos de audio
      // Si es estéreo, convertir a mono promediando los canales
      let audioData;
      if (wav.fmt.numChannels === 1) {
        // Ya es mono
        audioData = wav.getSamples(false); // false = no interleaved
      } else {
        // Es estéreo, convertir a mono promediando los canales
        const samples = wav.getSamples(true); // true = interleaved (L, R, L, R, ...)
        audioData = [];
        for (let i = 0; i < samples.length; i += 2) {
          // Promediar los canales izquierdo y derecho
          const left = samples[i] || 0;
          const right = samples[i + 1] || 0;
          audioData.push(Math.floor((left + right) / 2));
        }
      }
      
      console.log('[DEBUG] Audio data length:', audioData.length);
      console.log('[DEBUG] Sample rate:', wav.fmt.sampleRate);
      console.log('[DEBUG] Channels:', wav.fmt.numChannels);
      console.log('[DEBUG] Bits per sample:', wav.fmt.bitsPerSample);
      console.log('[DEBUG] First 10 samples:', audioData.slice(0, 10));
      
      // Convertir a Float32Array normalizado (-1.0 a 1.0)
      // Los valores int16 van de -32768 a 32767
      const float32Data = new Float32Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        // Normalizar de int16 (-32768 a 32767) a float32 (-1.0 a 1.0)
        float32Data[i] = Math.max(-1.0, Math.min(1.0, audioData[i] / 32768.0));
      }
      
      console.log('[DEBUG] Float32Array length:', float32Data.length);
      console.log('[DEBUG] Float32Array first 10:', Array.from(float32Data.slice(0, 10)));
      // No calcular min/max aquí porque causa stack overflow con arrays grandes
      // Se calculará más abajo con un bucle
      
      // Transcribir audio usando los datos procesados
      // @xenova/transformers espera el audio como Float32Array normalizado
      // y puede aceptarlo de diferentes formas
      let result;
      
      // Verificar que tenemos datos válidos
      if (float32Data.length === 0) {
        throw new Error('No hay datos de audio para transcribir');
      }
      
      // Verificar que los datos no estén todos en cero (sin usar spread operator para evitar stack overflow)
      let maxValue = -Infinity;
      let minValue = Infinity;
      const sampleSize = Math.min(10000, float32Data.length); // Verificar primeros 10000 samples
      for (let i = 0; i < sampleSize; i++) {
        const val = float32Data[i];
        if (val > maxValue) maxValue = val;
        if (val < minValue) minValue = val;
      }
      console.log('[DEBUG] Rango de valores de audio (primeros', sampleSize, '):', minValue, 'a', maxValue);
      
      // También verificar una muestra del medio y del final
      const midSample = Math.floor(float32Data.length / 2);
      const endSample = Math.min(midSample + 10000, float32Data.length);
      let midMax = -Infinity;
      let midMin = Infinity;
      for (let i = midSample; i < endSample; i++) {
        const val = float32Data[i];
        if (val > midMax) midMax = val;
        if (val < midMin) midMin = val;
      }
      console.log('[DEBUG] Rango de valores de audio (medio,', midSample, 'a', endSample, '):', midMin, 'a', midMax);
      
      const overallMax = Math.max(maxValue, midMax);
      const overallMin = Math.min(minValue, midMin);
      
      if (Math.abs(overallMax) < 0.001 && Math.abs(overallMin) < 0.001) {
        throw new Error('Los datos de audio parecen estar en silencio o mal procesados');
      }
      
      console.log('[DEBUG] Duración estimada del audio:', (float32Data.length / 16000).toFixed(2), 'segundos');
      
      try {
        // @xenova/transformers puede procesar archivos grandes automáticamente
        // pero necesitamos asegurarnos de que el formato sea correcto
        // El modelo espera Float32Array normalizado entre -1.0 y 1.0
        console.log('[DEBUG] Iniciando transcripción con', float32Data.length, 'muestras');
        
        result = await model(float32Data, {
          language: 'es',
          task: 'transcribe',
          return_timestamps: true,
          chunk_length_s: 30, // Procesar en chunks de 30 segundos
        });
        
        console.log('[DEBUG] Transcripción completada');
      } catch (error) {
        console.log('[DEBUG] Error con formato directo:', error.message);
        console.log('[DEBUG] Intentando formato objeto...');
        
        // Si falla, intentar con formato de objeto
        try {
          result = await model({
            raw: float32Data,
            sampling_rate: 16000,
          }, {
            language: 'es',
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 30,
          });
        } catch (error2) {
          console.log('[DEBUG] Error con formato objeto también:', error2.message);
          throw new Error(`Error al transcribir audio: ${error2.message}`);
        }
      }
      
      // Debug: Log del resultado para ver su estructura
      console.log('[DEBUG] Resultado del modelo:', JSON.stringify(result, null, 2));
      
      // Limpiar archivo temporal
      try {
        if (existsSync(tempWavPath)) {
          unlinkSync(tempWavPath);
        }
      } catch (e) {
        // Ignorar errores de limpieza
      }
      
      // Limpiar intervalo
      clearInterval(progressInterval);
      
      const elapsed = (Date.now() - startTime) / 1000;
      if (showLogCallback) {
        showLogCallback('🎤', videoNumber, totalVideos, videoId, 'Transcribiendo (local)', 100, elapsed);
      }
      
      // Convertir resultado a formato compatible con OpenAI API
      const segments = [];
      let fullText = '';
      
      // @xenova/transformers devuelve el resultado en diferentes formatos
      // Verificar primero si tiene la propiedad 'text' directamente
      if (result.text) {
        fullText = result.text;
        console.log('[DEBUG] Texto encontrado en result.text:', fullText.substring(0, 100));
      }
      
      // Verificar si tiene chunks con timestamps
      if (result.chunks && Array.isArray(result.chunks) && result.chunks.length > 0) {
        console.log('[DEBUG] Chunks encontrados:', result.chunks.length);
        // Formato con chunks
        result.chunks.forEach((chunk, index) => {
          // El formato puede variar: chunk puede tener timestamp como array [start, end] o como objeto
          let start = 0;
          let end = 0;
          let text = '';
          
          if (Array.isArray(chunk.timestamp)) {
            start = chunk.timestamp[0] || 0;
            end = chunk.timestamp[1] || 0;
          } else if (chunk.timestamp) {
            start = chunk.timestamp.start || chunk.timestamp[0] || 0;
            end = chunk.timestamp.end || chunk.timestamp[1] || 0;
          }
          
          text = chunk.text || chunk.transcription || '';
          
          if (text.trim()) {
            segments.push({
              id: index,
              seek: Math.floor(start * 100), // en centésimas de segundo
              start: start,
              end: end,
              text: text.trim(),
              tokens: [],
              temperature: 0.0,
              avg_logprob: -1.0,
              compression_ratio: 1.0,
              no_speech_prob: 0.0,
            });
            
            if (!fullText) {
              fullText = text.trim();
            } else {
              fullText += ' ' + text.trim();
            }
          }
        });
      }
      
      // Si no hay chunks pero sí hay texto, crear segmentos básicos
      if (!fullText && result.text) {
        fullText = result.text;
        console.log('[DEBUG] Usando result.text directamente:', fullText.substring(0, 100));
      }
      
      // Si aún no hay texto, verificar otras propiedades posibles
      if (!fullText) {
        console.log('[DEBUG] No se encontró texto. Propiedades del resultado:', Object.keys(result));
        if (result.transcription) {
          fullText = result.transcription;
        } else if (result.output && result.output.text) {
          fullText = result.output.text;
        } else if (typeof result === 'string') {
          fullText = result;
        }
      }
      
      // Si no hay segmentos pero sí hay texto, crear uno genérico
      if (segments.length === 0 && fullText) {
        segments.push({
          id: 0,
          seek: 0,
          start: 0,
          end: 0,
          text: fullText,
          tokens: [],
          temperature: 0.0,
          avg_logprob: -1.0,
          compression_ratio: 1.0,
          no_speech_prob: 0.0,
        });
      }
      
      console.log('[DEBUG] Texto final:', fullText ? fullText.substring(0, 200) : 'VACÍO');
      console.log('[DEBUG] Segmentos:', segments.length);
      
      // Generar formato SRT
      const srt = generateSRT(segments);
      
      // Identificar speakers
      const speakers = identifySpeakers(segments);
      
      return {
        transcription: fullText.trim(),
        srt,
        segments,
        speakers,
      };
    } catch (conversionError) {
      // Limpiar archivo temporal en caso de error
      try {
        if (existsSync(tempWavPath)) {
          unlinkSync(tempWavPath);
        }
      } catch (e) {
        // Ignorar errores de limpieza
      }
      // Limpiar intervalo si aún está activo
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      throw new Error(`Error en transcripción local: ${conversionError.message}`);
    }
  } catch (error) {
    // Limpiar intervalo si aún está activo
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    throw new Error(`Error en transcripción local: ${error.message}`);
  }
}

/**
 * Comprime un archivo de audio para reducir su tamaño
 * @param {string} inputPath - Ruta del archivo original
 * @param {string} outputPath - Ruta donde guardar el archivo comprimido
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @param {number} compressionPercent - Porcentaje de compresión (0-100). 0 = sin compresión (128kbps), 100 = máxima compresión (32kbps)
 * @returns {Promise<string>} - Ruta del archivo comprimido
 */
async function compressAudio(inputPath, outputPath, videoNumber = 1, totalVideos = 1, videoId = '', compressionPercent = 50) {
  return new Promise((resolve, reject) => {
    // Calcular bitrate basado en el porcentaje de compresión
    // 0% = 128 kbps (sin compresión, calidad máxima)
    // 50% = 80 kbps (compresión media)
    // 100% = 32 kbps (máxima compresión, calidad mínima)
    const minBitrate = 32;
    const maxBitrate = 128;
    const targetBitrate = Math.round(maxBitrate - ((compressionPercent / 100) * (maxBitrate - minBitrate)));
    
    // Asegurar que el bitrate esté en el rango válido
    const finalBitrate = Math.max(minBitrate, Math.min(maxBitrate, targetBitrate));
    
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(finalBitrate)
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
 * Obtiene transcripción desde YouTube
 * @param {string} youtubeUrl - URL del video de YouTube
 * @param {string} videoId - ID del video
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @returns {Promise<{transcription: string, srt: string, segments: Array}>}
 */
async function transcribeFromYouTube(youtubeUrl, videoId, videoNumber = 1, totalVideos = 1) {
  try {
    const { downloadSubtitles } = await import('../services/youtubeService.js');
    
    const result = await downloadSubtitles(youtubeUrl, videoId, videoNumber, totalVideos);
    
    // Convertir segmentos al formato esperado (con id, seek, etc.)
    const formattedSegments = result.segments.map((segment, index) => ({
      id: index,
      seek: Math.floor(segment.start * 100), // en centésimas de segundo
      start: segment.start,
      end: segment.end,
      text: segment.text,
      tokens: [],
      temperature: 0.0,
      avg_logprob: -1.0,
      compression_ratio: 1.0,
      no_speech_prob: 0.0,
    }));
    
    // Generar texto completo
    const fullText = formattedSegments.map(s => s.text).join(' ');
    
    // Generar SRT (ya lo tenemos del resultado, pero asegurémonos de que esté bien formateado)
    const srt = generateSRT(formattedSegments);
    
    // Identificar speakers
    const speakers = identifySpeakers(formattedSegments);
    
    return {
      transcription: fullText,
      srt,
      segments: formattedSegments,
      speakers,
    };
  } catch (error) {
    throw new Error(`Error al obtener transcripción de YouTube: ${error.message}`);
  }
}

/**
 * Transcribe un archivo de audio usando Whisper o obtiene transcripción de YouTube
 * @param {string} audioPath - Ruta del archivo de audio (no se usa si source es YOUTUBE)
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @param {string} youtubeUrl - URL del video de YouTube (necesaria si source es YOUTUBE)
 * @param {string} source - Fuente de transcripción: 'WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE'
 * @param {number} audioCompression - Porcentaje de compresión de audio (0-100)
 * @returns {Promise<{transcription: string, srt: string, segments: Array}>}
 */
export async function transcribeAudio(audioPath, videoNumber = 1, totalVideos = 1, videoId = '', youtubeUrl = '', source = 'WHISPER-OpenAI', audioCompression = 50) {
  // Si la fuente es YOUTUBE, obtener transcripción directamente
  if (source === 'YOUTUBE') {
    if (!youtubeUrl) {
      throw new Error('youtubeUrl es requerida cuando source es YOUTUBE');
    }
    return await transcribeFromYouTube(youtubeUrl, videoId, videoNumber, totalVideos);
  }
  
  // Si está configurado para usar local, usar función local
  if (source === 'WHISPER-LOCAL') {
    // Para local, no necesitamos comprimir tanto (puede procesar archivos más grandes)
    // Pero mantenemos la lógica de compresión si el archivo es muy grande
    let audioToTranscribe = audioPath;
    let compressedAudioPath = null;

    try {
      const stats = statSync(audioPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      // Para local, podemos procesar archivos más grandes, pero comprimimos si es > 50MB
      // para mejorar velocidad
      if (fileSizeMB > 50) {
        const dir = dirname(audioPath);
        const baseName = basename(audioPath, '.mp3');
        compressedAudioPath = join(dir, `${baseName}_min.mp3`);
        
        if (!existsSync(compressedAudioPath)) {
          if (showLogCallback) {
            showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', null, null);
          }
          audioToTranscribe = await compressAudio(audioPath, compressedAudioPath, videoNumber, totalVideos, videoId, audioCompression);
        } else {
          audioToTranscribe = compressedAudioPath;
        }
      }
      
      return await transcribeAudioLocal(audioToTranscribe, videoNumber, totalVideos, videoId);
    } catch (error) {
      if (error.message.includes('Error en transcripción local')) {
        throw error;
      }
      throw new Error(`Error en transcripción: ${error.message}`);
    }
  }
  
  // Si no, usar la implementación de API (WHISPER)
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
            audioToTranscribe = await compressAudio(audioPath, moreCompressedPath, videoNumber, totalVideos, videoId, audioCompression);
            compressedAudioPath = moreCompressedPath;
          }
        }
      } else {
        if (showLogCallback) {
          showLogCallback('🗜️', videoNumber, totalVideos, videoId, 'Comprimiendo audio', null, null);
        }
        // Comprimir el audio
        audioToTranscribe = await compressAudio(audioPath, compressedAudioPath, videoNumber, totalVideos, videoId, audioCompression);
        
        // Verificar el tamaño del archivo comprimido
        const compressedStats = statSync(compressedAudioPath);
        const compressedSizeMB = compressedStats.size / (1024 * 1024);
        
        if (compressedSizeMB > 25) {
          // Si aún es muy grande, comprimir más agresivamente
          const moreCompressedPath = join(dir, `${baseName}_min2.mp3`);
          audioToTranscribe = await compressAudio(audioPath, moreCompressedPath, videoNumber, totalVideos, videoId, audioCompression);
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
