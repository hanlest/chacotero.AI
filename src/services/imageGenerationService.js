import OpenAI from 'openai';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import FormData from 'form-data';
import { Readable } from 'stream';
import config from '../config/config.js';
import { logError, logDebug, logAIPrompt, logInfo, logWarn } from './loggerService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

let showLogCallback = null;

/**
 * Configura el callback para mostrar logs
 * @param {Function} callback - Función callback para mostrar logs
 */
export function setLogCallback(callback) {
  showLogCallback = callback;
}

/**
 * Lee el prompt desde el archivo
 * @returns {Promise<string>} - Contenido del prompt
 */
export async function loadImagePrompt() {
  try {
    const promptPath = join(__dirname, '../../storage/prompts/image-generation.txt');
    const promptTemplate = await readFile(promptPath, 'utf-8');
    return promptTemplate;
  } catch (error) {
    // Si no existe el archivo, usar prompt por defecto
    console.warn('No se encontró el archivo de prompt, usando prompt por defecto');
    return `Genera una imagen miniatura que represente visualmente el contenido de esta llamada de radio.

Contexto:
- Título: {title}
- Descripción: {description}
- Tema: {theme}
- Resumen: {summary}
- Tags: {tags}

Requisitos de la imagen:
- Debe ser una ilustración o representación visual del tema principal de la llamada
- Estilo: profesional, apropiado para contenido de radio, sin contenido ofensivo
- Colores: vibrantes pero profesionales
- Composición: centrada, clara, fácil de entender de un vistazo
- No incluir texto en la imagen
- Dimensiones: 1792x1024 píxeles (formato 16:9, horizontal/landscape)

Genera un prompt detallado para DALL-E que describa la imagen a crear basándote en el contenido de la llamada. El prompt debe ser descriptivo pero conciso, enfocándose en los elementos visuales clave que representen el tema y la esencia de la historia. El prompt debe especificar que la imagen debe ser en formato 16:9 (landscape/horizontal).`;
  }
}

/**
 * Genera un prompt para DALL-E basado en los metadatos de la llamada
 * @param {object} metadata - Metadatos de la llamada (title, description, theme, summary, tags)
 * @returns {Promise<string>} - Prompt para DALL-E
 */
async function generateImagePrompt(metadata) {
  await logDebug(`[generateImagePrompt] Iniciando generación de prompt`);
  await logDebug(`[generateImagePrompt] metadata.thumbnailScene existe: ${!!metadata.thumbnailScene}`);
  await logDebug(`[generateImagePrompt] metadata.thumbnailScene valor: ${metadata.thumbnailScene ? metadata.thumbnailScene.substring(0, 100) + '...' : 'null'}`);
  
  if (!config.openai.apiKey) {
    await logError(`[generateImagePrompt] OPENAI_API_KEY no configurada`);
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Si ya tenemos un thumbnailScene generado por la IA de procesamiento de datos, agregarlo al final del template
    if (metadata.thumbnailScene && metadata.thumbnailScene.trim()) {
      await logInfo(`[generateImagePrompt] Cargando template del prompt...`);
      // Cargar template del prompt
      const promptTemplate = await loadImagePrompt();
      await logDebug(`[generateImagePrompt] Template cargado (longitud: ${promptTemplate.length} caracteres)`);
      
      // Agregar la escena al final del template en lugar de reemplazar
      const imagePrompt = `${promptTemplate.trim()}\n\nLa escena es la siguiente: ${metadata.thumbnailScene.trim()}`;
      await logInfo(`[generateImagePrompt] Prompt final generado (longitud: ${imagePrompt.length} caracteres)`);
      
      return imagePrompt;
    }

    // Si no hay thumbnailScene, lanzar error (siempre debería venir del procesamiento de datos)
    await logError(`[generateImagePrompt] No se encontró thumbnailScene en metadata`);
    await logDebug(`[generateImagePrompt] Metadata disponible: ${JSON.stringify(Object.keys(metadata))}`);
    throw new Error('No se encontró escena (thumbnailScene) para generar la imagen. El procesamiento de datos debería proporcionar este campo.');
  } catch (error) {
    await logError(`[generateImagePrompt] Error: ${error.message}`);
    await logError(`[generateImagePrompt] Stack: ${error.stack}`);
    
    // Fallback: generar un prompt simple basado en el título y tema
    await logWarn(`[generateImagePrompt] Usando prompt fallback`);
    const fallbackPrompt = `A professional illustration representing ${metadata.theme || 'a radio call'}, ${metadata.title || ''}, vibrant colors, centered composition, radio show style, 16:9 aspect ratio, landscape format`;
    await logDebug(`[generateImagePrompt] Prompt fallback: ${fallbackPrompt}`);
    return fallbackPrompt;
  }
}

/**
 * Genera una imagen usando DALL-E y la guarda
 * @param {object} metadata - Metadatos de la llamada
 * @param {string} outputPath - Ruta donde guardar la imagen
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @param {number} callNumber - Número de la llamada (para logs)
 * @param {number} totalCalls - Total de llamadas (para logs)
 * @param {object} imageConfig - Configuración de la imagen (size, quality, style)
 * @returns {Promise<string>} - Ruta del archivo de imagen guardado
 */
export async function generateThumbnailImage(metadata, outputPath, videoNumber = 1, totalVideos = 1, videoId = '', callNumber = 1, totalCalls = 1, imageConfig = { size: '1536x1024', quality: 'medium' }, savePrompt = false, promptOutputPath = null) {
  console.log('[generateThumbnailImage] Iniciando generación de miniatura');
  console.log(`[generateThumbnailImage] Parámetros: videoId=${videoId}, callNumber=${callNumber}, outputPath=${outputPath}`);
  await logInfo(`[generateThumbnailImage] Iniciando generación de miniatura`);
  await logDebug(`[generateThumbnailImage] Parámetros: videoId=${videoId}, callNumber=${callNumber}, outputPath=${outputPath}`);
  await logDebug(`[generateThumbnailImage] imageConfig: ${JSON.stringify(imageConfig)}`);
  await logDebug(`[generateThumbnailImage] metadata tiene thumbnailScene: ${!!metadata.thumbnailScene}`);
  
  if (!config.openai.apiKey) {
    console.error('[generateThumbnailImage] OPENAI_API_KEY no configurada');
    await logError(`[generateThumbnailImage] OPENAI_API_KEY no configurada`);
    throw new Error('OPENAI_API_KEY no configurada');
  }

  const startTime = Date.now();
  
  try {
    if (showLogCallback) {
      showLogCallback('🎨', videoNumber, totalVideos, videoId, `Generando imagen (${callNumber}/${totalCalls})...`, null, null);
    }

    console.log('[generateThumbnailImage] Generando prompt para la imagen...');
    await logInfo(`[generateThumbnailImage] Generando prompt para la imagen...`);
    // Generar prompt para la imagen
    const imagePrompt = await generateImagePrompt(metadata);
    console.log(`[generateThumbnailImage] Prompt generado (longitud: ${imagePrompt.length} caracteres)`);
    console.log(`[generateThumbnailImage] Prompt preview: ${imagePrompt.substring(0, 200)}...`);
    await logDebug(`[generateThumbnailImage] Prompt generado (longitud: ${imagePrompt.length} caracteres)`);
    await logDebug(`[generateThumbnailImage] Prompt: ${imagePrompt.substring(0, 200)}...`);
    
    // Generar imagen con gpt-image-1.5 usando la configuración proporcionada
    const imageModel = imageConfig.model || 'gpt-image-1.5';
    const imageSize = imageConfig.size || '1536x1024';
    const imageQuality = imageConfig.quality || 'medium';
    
    await logInfo(`[generateThumbnailImage] Configuración: model=${imageModel}, size=${imageSize}, quality=${imageQuality}`);
    
    // Preparar el objeto de la solicitud que se enviará a la API
    const apiRequest = {
      model: imageModel,
      prompt: imagePrompt,
      size: imageSize,
      quality: imageQuality,
    };
    
    await logInfo(`[generateThumbnailImage] Preparando solicitud a OpenAI API...`);
    
    // Guardar prompt si está habilitado (justo antes de la llamada a la API)
    if (savePrompt && promptOutputPath) {
      try {
        await writeFile(promptOutputPath, JSON.stringify(apiRequest, null, 2), 'utf-8');
        await logInfo(`[generateThumbnailImage] Prompt guardado en: ${promptOutputPath}`);
      } catch (error) {
        await logError(`[generateThumbnailImage] Error al guardar prompt de imagen: ${error.message}`);
      }
    }
    
    // Loguear el prompt en el archivo de log
    await logAIPrompt('Generación de imagen', videoId, apiRequest);
    
    console.log('[generateThumbnailImage] Llamando a OpenAI API (images.generate)...');
    await logInfo(`[generateThumbnailImage] Llamando a OpenAI API (images.generate)...`);
    const response = await openai.images.generate(apiRequest);
    console.log('[generateThumbnailImage] Respuesta recibida de OpenAI API');
    await logInfo(`[generateThumbnailImage] Respuesta recibida de OpenAI API`);

    // El nuevo modelo devuelve base64 en lugar de URL
    if (!response.data || !response.data[0]) {
      await logError(`[generateThumbnailImage] Respuesta de API no tiene data o data[0]`);
      await logDebug(`[generateThumbnailImage] Respuesta completa: ${JSON.stringify(response, null, 2)}`);
      throw new Error('No se recibió imagen en la respuesta de la API');
    }
    
    if (!response.data[0].b64_json) {
      await logError(`[generateThumbnailImage] Respuesta no tiene b64_json`);
      await logDebug(`[generateThumbnailImage] Estructura de response.data[0]: ${JSON.stringify(Object.keys(response.data[0]))}`);
      throw new Error('No se recibió imagen en base64 de la API');
    }

    const base64Image = response.data[0].b64_json;
    const outputFormat = response.output_format || 'png';
    await logInfo(`[generateThumbnailImage] Imagen recibida en base64 (formato: ${outputFormat}, tamaño base64: ${base64Image.length} caracteres)`);

    // Convertir base64 a buffer
    await logInfo(`[generateThumbnailImage] Convirtiendo base64 a buffer...`);
    const imageBuffer = Buffer.from(base64Image, 'base64');
    await logInfo(`[generateThumbnailImage] Buffer creado (tamaño: ${imageBuffer.length} bytes)`);

    // Asegurar que la extensión del archivo coincida con el formato de salida
    const outputPathWithExtension = outputPath.replace(/\.(jpg|jpeg|png)$/i, `.${outputFormat}`);
    await logInfo(`[generateThumbnailImage] Guardando imagen en: ${outputPathWithExtension}`);
    
    // Guardar imagen
    await writeFile(outputPathWithExtension, imageBuffer);
    await logInfo(`[generateThumbnailImage] Imagen guardada exitosamente en: ${outputPathWithExtension}`);

    const elapsed = (Date.now() - startTime) / 1000;
    await logInfo(`[generateThumbnailImage] Proceso completado en ${elapsed.toFixed(2)}s`);
    
    if (showLogCallback) {
      showLogCallback('🎨', videoNumber, totalVideos, videoId, `Imagen generada (${callNumber}/${totalCalls})`, 100, elapsed);
    }

    return outputPathWithExtension;
  } catch (error) {
    const elapsed = (Date.now() - startTime) / 1000;
    console.error(`[generateThumbnailImage] Error después de ${elapsed.toFixed(2)}s: ${error.message}`);
    console.error(`[generateThumbnailImage] Stack: ${error.stack}`);
    await logError(`[generateThumbnailImage] Error después de ${elapsed.toFixed(2)}s: ${error.message}`);
    await logError(`[generateThumbnailImage] Stack: ${error.stack}`);
    
    if (error.response) {
      console.error(`[generateThumbnailImage] Error response de API:`, error.response.data || error.response);
      await logError(`[generateThumbnailImage] Error response de API: ${JSON.stringify(error.response.data || error.response, null, 2)}`);
    }
    
    if (showLogCallback) {
      showLogCallback('🎨', videoNumber, totalVideos, videoId, `Error: ${error.message}`, null, elapsed);
    }
    throw new Error(`Error al generar imagen: ${error.message}`);
  }
}

/**
 * Genera una imagen directamente desde un prompt
 * @param {string} prompt - Prompt para generar la imagen
 * @param {object} imageConfig - Configuración de la imagen (model, size, quality)
 * @returns {Promise<{base64: string, format: string, buffer: Buffer}>} - Imagen en base64 y buffer
 */
export async function generateImageFromPrompt(prompt, imageConfig = {}) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Generar imagen con gpt-image-1.5 usando la configuración proporcionada
    const imageModel = imageConfig.model || 'gpt-image-1.5';
    const imageSize = imageConfig.size || '1536x1024';
    const imageQuality = imageConfig.quality || 'medium';
    
    // Preparar el objeto de la solicitud que se enviará a la API
    const apiRequest = {
      model: imageModel,
      prompt: prompt,
      size: imageSize,
      quality: imageQuality,
    };
    
    // Loguear el prompt en el archivo de log
    await logAIPrompt('Generación de imagen directa', 'N/A', apiRequest);
    
    const response = await openai.images.generate(apiRequest);

    // El nuevo modelo devuelve base64 en lugar de URL
    if (!response.data || !response.data[0] || !response.data[0].b64_json) {
      throw new Error('No se recibió imagen en base64 de la API');
    }

    const base64Image = response.data[0].b64_json;
    const outputFormat = response.output_format || 'png';

    // Convertir base64 a buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');

    return {
      base64: base64Image,
      format: outputFormat,
      buffer: imageBuffer,
    };
  } catch (error) {
    await logError(`Error al generar imagen desde prompt: ${error.message}`);
    throw new Error(`Error al generar imagen: ${error.message}`);
  }
}

/**
 * Modifica/edita una imagen existente usando la API de edición de OpenAI
 * @param {string} imageBase64 - Imagen en base64 (sin el prefijo data:image/...)
 * @param {string} prompt - Prompt descriptivo para la modificación
 * @param {object} editConfig - Configuración de la edición (model, mode, size)
 * @returns {Promise<{base64: string, format: string, buffer: Buffer}>} - Imagen editada en base64 y buffer
 */
export async function editImageFromBase64(imageBase64, prompt, editConfig = {}) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Limpiar el base64 si viene con el prefijo data URI
    let cleanBase64 = imageBase64;
    if (imageBase64.includes(',')) {
      cleanBase64 = imageBase64.split(',')[1];
    }

    // Generar imagen editada con gpt-image-1.5 usando la configuración proporcionada
    const imageModel = editConfig.model || 'gpt-image-1.5';
    const editMode = editConfig.mode || 'variations';
    const imageSize = editConfig.size || '1536x1024';
    
    // Convertir base64 a Buffer para el FormData
    const imageBuffer = Buffer.from(cleanBase64, 'base64');
    
    // Crear FormData para multipart/form-data
    // Nota: El parámetro 'mode' no es aceptado por la API de OpenAI images/edits
    // El comportamiento de variaciones se controla a través del prompt
    const formData = new FormData();
    formData.append('model', imageModel);
    formData.append('prompt', prompt);
    formData.append('image', imageBuffer, {
      filename: 'image.png',
      contentType: 'image/png',
    });
    formData.append('size', imageSize);
    
    // Preparar el objeto de la solicitud para logging (sin la imagen)
    const apiRequest = {
      model: imageModel,
      prompt: prompt,
      image: '[BASE64_IMAGE]',
      size: imageSize,
    };
    
    // Loguear el prompt en el archivo de log
    await logAIPrompt('Edición de imagen', 'N/A', apiRequest);
    
    // Obtener headers del FormData (incluye Content-Type con boundary)
    const formHeaders = formData.getHeaders();
    
    // Convertir FormData a buffer usando el método getBuffer()
    // form-data tiene un método getBuffer() síncrono que convierte el stream a buffer
    const formBuffer = formData.getBuffer();
    
    // Hacer llamada HTTP directa a la API de edición de imágenes usando multipart/form-data
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        ...formHeaders,
        'Authorization': `Bearer ${config.openai.apiKey}`,
      },
      body: formBuffer,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(errorData.error?.message || `Error HTTP ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();

    // El modelo devuelve base64
    if (!responseData.data || !responseData.data[0] || !responseData.data[0].b64_json) {
      throw new Error('No se recibió imagen editada en base64 de la API');
    }

    const base64Image = responseData.data[0].b64_json;
    const outputFormat = responseData.output_format || 'png';

    // Convertir base64 a buffer
    const editedImageBuffer = Buffer.from(base64Image, 'base64');

    return {
      base64: base64Image,
      format: outputFormat,
      buffer: editedImageBuffer,
    };
  } catch (error) {
    await logError(`Error al editar imagen: ${error.message}`);
    throw new Error(`Error al editar imagen: ${error.message}`);
  }
}
