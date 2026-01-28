import OpenAI from 'openai';
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import { logDebug, logError, logInfo, logWarn, logAIPrompt } from './loggerService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * Carga el prompt de generación de título desde el archivo
 * @returns {Promise<{systemMessage: string, userMessageTemplate: string}>}
 */
async function loadTitleGenerationPrompt() {
  const promptPath = join(__dirname, '../../public/prompts/title-generation.txt');
  const promptContent = await readFile(promptPath, 'utf-8');
  
  // Separar SYSTEM MESSAGE y USER MESSAGE usando el separador "---"
  const parts = promptContent.split('---');
  
  if (parts.length < 2) {
    throw new Error('El archivo de prompt no tiene el formato esperado (debe tener SYSTEM MESSAGE y USER MESSAGE separados por ---)');
  }
  
  // Extraer SYSTEM MESSAGE (desde "SYSTEM MESSAGE:" hasta "---")
  const systemMessageMatch = parts[0].match(/SYSTEM MESSAGE:\s*([\s\S]*?)(?=\n---|$)/);
  const systemMessage = systemMessageMatch ? systemMessageMatch[1].trim() : '';
  
  if (!systemMessage) {
    throw new Error('No se pudo extraer el SYSTEM MESSAGE del archivo de prompt');
  }
  
  // Extraer USER MESSAGE (desde "USER MESSAGE:" hasta el final)
  const userMessageMatch = parts[1].match(/USER MESSAGE:\s*([\s\S]*)/);
  const userMessageTemplate = userMessageMatch ? userMessageMatch[1].trim() : '';
  
  if (!userMessageTemplate) {
    throw new Error('No se pudo extraer el USER MESSAGE del archivo de prompt');
  }
  
  return { systemMessage, userMessageTemplate };
}

/**
 * Genera un nuevo título usando IA basado en el resumen de la llamada
 * @param {string} summary - Resumen de la llamada
 * @returns {Promise<string>} - Nuevo título generado
 */
export async function generateTitle(summary) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Cargar el prompt de generación de título
    const { systemMessage, userMessageTemplate } = await loadTitleGenerationPrompt();
    
    // Reemplazar [SUMMARY] con el resumen real
    const userMessage = userMessageTemplate.replace('[SUMMARY]', summary || '');
    
    const apiRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    };
    
    await logAIPrompt('Generación de título', 'N/A', apiRequest);
    
    const response = await openai.chat.completions.create(apiRequest);
    
    // Extraer JSON de la respuesta
    let responseText = response.choices[0].message.content.trim();
    
    // Intentar extraer JSON si viene envuelto en texto
    let jsonStart = responseText.indexOf('{');
    let jsonEnd = -1;
    
    if (jsonStart !== -1) {
      let braceCount = 0;
      for (let i = jsonStart; i < responseText.length; i++) {
        if (responseText[i] === '{') braceCount++;
        if (responseText[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }
    
    if (jsonStart !== -1 && jsonEnd !== -1) {
      responseText = responseText.substring(jsonStart, jsonEnd);
    }
    
    const result = JSON.parse(responseText);
    
    if (!result.title) {
      throw new Error('La respuesta de la IA no contiene el campo title');
    }
    
    return result.title;
  } catch (error) {
    await logError(`Error al generar título: ${error.message}`);
    throw new Error(`Error al generar título: ${error.message}`);
  }
}

/**
 * Carga el prompt de generación de escena desde el archivo
 * @returns {Promise<{systemMessage: string, userMessageTemplate: string}>}
 */
async function loadSceneGenerationPrompt() {
  const promptPath = join(__dirname, '../../public/prompts/scene-generation.txt');
  const promptContent = await readFile(promptPath, 'utf-8');
  
  // Separar SYSTEM MESSAGE y USER MESSAGE usando el separador "---"
  const parts = promptContent.split('---');
  
  if (parts.length < 2) {
    throw new Error('El archivo de prompt no tiene el formato esperado (debe tener SYSTEM MESSAGE y USER MESSAGE separados por ---)');
  }
  
  // Extraer SYSTEM MESSAGE (desde "SYSTEM MESSAGE:" hasta "---")
  const systemMessageMatch = parts[0].match(/SYSTEM MESSAGE:\s*([\s\S]*?)(?=\n---|$)/);
  const systemMessage = systemMessageMatch ? systemMessageMatch[1].trim() : '';
  
  if (!systemMessage) {
    throw new Error('No se pudo extraer el SYSTEM MESSAGE del archivo de prompt');
  }
  
  // Extraer USER MESSAGE (desde "USER MESSAGE:" hasta el final)
  const userMessageMatch = parts[1].match(/USER MESSAGE:\s*([\s\S]*)/);
  const userMessageTemplate = userMessageMatch ? userMessageMatch[1].trim() : '';
  
  if (!userMessageTemplate) {
    throw new Error('No se pudo extraer el USER MESSAGE del archivo de prompt');
  }
  
  return { systemMessage, userMessageTemplate };
}

/**
 * Genera el thumbnailScene usando IA basado en el resumen de la llamada
 * @param {string} summary - Resumen de la llamada
 * @returns {Promise<string>} - Escena para la miniatura
 */
export async function generateThumbnailScene(summary) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Cargar el prompt de generación de escena
    const { systemMessage, userMessageTemplate } = await loadSceneGenerationPrompt();
    
    // Reemplazar [SUMMARY] con el resumen real
    const userMessage = userMessageTemplate.replace('[SUMMARY]', summary || '');
    
    const apiRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    };
    
    await logAIPrompt('Generación de escena para miniatura', 'N/A', apiRequest);
    
    const response = await openai.chat.completions.create(apiRequest);
    
    // Extraer JSON de la respuesta
    let responseText = response.choices[0].message.content.trim();
    
    // Intentar extraer JSON si viene envuelto en texto
    let jsonStart = responseText.indexOf('{');
    let jsonEnd = -1;
    
    if (jsonStart !== -1) {
      let braceCount = 0;
      for (let i = jsonStart; i < responseText.length; i++) {
        if (responseText[i] === '{') braceCount++;
        if (responseText[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }
    
    if (jsonStart !== -1 && jsonEnd !== -1) {
      responseText = responseText.substring(jsonStart, jsonEnd);
    }
    
    const result = JSON.parse(responseText);
    
    if (!result.thumbnailScene) {
      throw new Error('La respuesta de la IA no contiene el campo thumbnailScene');
    }
    
    return result.thumbnailScene;
  } catch (error) {
    await logError(`Error al generar thumbnailScene: ${error.message}`);
    throw new Error(`Error al generar escena para miniatura: ${error.message}`);
  }
}

/**
 * Carga el prompt de generación de metadata desde el archivo
 * @returns {Promise<{systemMessage: string, userMessageTemplate: string}>}
 */
async function loadSummaryGenerationPrompt() {
  const promptPath = join(__dirname, '../../public/prompts/summary-generation.txt');
  const promptContent = await readFile(promptPath, 'utf-8');
  
  // Separar SYSTEM MESSAGE y USER MESSAGE usando el separador "---"
  const parts = promptContent.split('---');
  const systemMessage = parts[0].replace('SYSTEM MESSAGE:', '').trim();
  const userMessageTemplate = parts.length > 1 ? parts[1].replace('USER MESSAGE:', '').trim() : '';
  
  return { systemMessage, userMessageTemplate };
}

/**
 * Genera metadata completa desde una transcripción usando IA
 * @param {string} transcription - Texto completo de la transcripción
 * @returns {Promise<object>} - Metadata completa generada (title, description, summary, name, age, topic, tags, thumbnailScene, startText, endText)
 */
export async function generateMetadataFromTranscription(transcription) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  if (!transcription || transcription.trim() === '') {
    throw new Error('La transcripción está vacía');
  }

  try {
    // Cargar el prompt de generación de metadata
    const { systemMessage, userMessageTemplate } = await loadSummaryGenerationPrompt();
    
    // Reemplazar [TRANSCRIPCIÓN COMPLETA AQUÍ] con la transcripción real
    const userMessage = userMessageTemplate.replace('[TRANSCRIPCIÓN COMPLETA AQUÍ]', transcription);
    
    const apiRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    };

    await logAIPrompt('Generación de metadata desde transcripción', 'N/A', apiRequest);

    const response = await openai.chat.completions.create(apiRequest);

    // Extraer JSON de la respuesta
    let responseText = response.choices[0].message.content.trim();

    // Intentar extraer JSON si viene envuelto en texto
    let jsonStart = responseText.indexOf('{');
    let jsonEnd = -1;

    if (jsonStart !== -1) {
      let braceCount = 0;
      for (let i = jsonStart; i < responseText.length; i++) {
        if (responseText[i] === '{') braceCount++;
        if (responseText[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }

    if (jsonStart !== -1 && jsonEnd !== -1) {
      responseText = responseText.substring(jsonStart, jsonEnd);
    }

    const result = JSON.parse(responseText);

    // Validar que tenga los campos mínimos requeridos
    if (!result.summary) {
      throw new Error('La respuesta de la IA no contiene el campo summary');
    }
    if (!result.title) {
      throw new Error('La respuesta de la IA no contiene el campo title');
    }

    return result;
  } catch (error) {
    await logError(`Error al generar metadata desde transcripción: ${error.message}`);
    throw new Error(`Error al generar metadata desde transcripción: ${error.message}`);
  }
}

/**
 * Genera un resumen detallado desde una transcripción usando IA
 * @param {string} transcription - Texto completo de la transcripción
 * @returns {Promise<string>} - Resumen detallado generado
 */
export async function generateSummaryFromTranscription(transcription) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  if (!transcription || transcription.trim() === '') {
    throw new Error('La transcripción está vacía');
  }

  try {
    const systemMessage = `Eres un experto en análisis de contenido de radio. Tu tarea es generar un resumen detallado y completo de una llamada telefónica en un programa de radio. El resumen debe incluir TODOS los puntos, eventos, situaciones y detalles mencionados en la conversación, ya que se usará para búsqueda por contenido.`;

    const userMessage = `Analiza esta transcripción de una llamada telefónica y genera un resumen detallado y completo que incluya todos los aspectos relevantes de la conversación:

${transcription}

Responde ÚNICAMENTE con JSON válido en el siguiente formato:
{
  "summary": "resumen detallado y completo aquí"
}`;

    const apiRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    };

    await logAIPrompt('Generación de resumen desde transcripción', 'N/A', apiRequest);

    const response = await openai.chat.completions.create(apiRequest);

    // Extraer JSON de la respuesta
    let responseText = response.choices[0].message.content.trim();

    // Intentar extraer JSON si viene envuelto en texto
    let jsonStart = responseText.indexOf('{');
    let jsonEnd = -1;

    if (jsonStart !== -1) {
      let braceCount = 0;
      for (let i = jsonStart; i < responseText.length; i++) {
        if (responseText[i] === '{') braceCount++;
        if (responseText[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }

    if (jsonStart !== -1 && jsonEnd !== -1) {
      responseText = responseText.substring(jsonStart, jsonEnd);
    }

    const result = JSON.parse(responseText);

    if (!result.summary) {
      throw new Error('La respuesta de la IA no contiene el campo summary');
    }

    return result.summary;
  } catch (error) {
    await logError(`Error al generar resumen desde transcripción: ${error.message}`);
    throw new Error(`Error al generar resumen desde transcripción: ${error.message}`);
  }
}

/**
 * Carga el prompt de procesamiento de datos desde el archivo
 * @returns {Promise<{systemMessage: string, userMessageTemplate: string}>}
 */
async function loadCallSeparationPrompt() {
  const promptPath = join(__dirname, '../../public/prompts/call-separation.txt');
  const promptContent = await readFile(promptPath, 'utf-8');
  
  // Separar SYSTEM MESSAGE y USER MESSAGE usando el separador "---"
  const parts = promptContent.split('---');
  
  if (parts.length < 2) {
    throw new Error('El archivo de prompt no tiene el formato esperado (debe tener SYSTEM MESSAGE y USER MESSAGE separados por ---)');
  }
  
  // Extraer SYSTEM MESSAGE (desde "SYSTEM MESSAGE:" hasta "---")
  const systemMessageMatch = parts[0].match(/SYSTEM MESSAGE:\s*([\s\S]*?)(?=\n---|$)/);
  const systemMessage = systemMessageMatch ? systemMessageMatch[1].trim() : '';
  
  if (!systemMessage) {
    throw new Error('No se pudo extraer el SYSTEM MESSAGE del archivo de prompt');
  }
  
  // Extraer USER MESSAGE (desde "USER MESSAGE:" hasta el final)
  const userMessageMatch = parts[1].match(/USER MESSAGE:\s*([\s\S]*)/);
  const userMessageTemplate = userMessageMatch ? userMessageMatch[1].trim() : '';
  
  if (!userMessageTemplate) {
    throw new Error('No se pudo extraer el USER MESSAGE del archivo de prompt');
  }
  
  return { systemMessage, userMessageTemplate };
}

/**
 * Procesa los datos de una transcripción usando IA para identificar y extraer llamadas
 * @param {Array} segments - Segmentos de la transcripción con timestamps
 * @param {string} fullTranscription - Transcripción completa
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @returns {Promise<Array<{start: number, end: number, transcription: string}>>}
 */
export async function separateCalls(segments, fullTranscription, videoNumber = 1, totalVideos = 1, videoId = '', savePrompt = false, promptOutputPath = null) {
  await logInfo(`Video ${videoId}: separateCalls iniciado`);
  
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }
  
  // Debug: verificar parámetros de guardado (solo en archivo de log)
  if (savePrompt) {
    await logDebug(`Guardar prompt de procesamiento: ${savePrompt}, path: ${promptOutputPath}`);
  }

  // Declarar variables fuera del try para que estén disponibles en el catch
  let progressInterval = null;

  try {
    await logInfo(`Video ${videoId}: Cargando prompts de procesamiento`);
    
    // Enviar transcripción completa con timestamps (SRT completo)
    // GPT-5.2 tiene suficiente contexto (128k tokens) para procesar la transcripción completa
    
    // Simular progreso mientras se procesa
    const startTime = Date.now();
    let lastUpdate = Date.now();
    
    // Estimar tiempo basado en la longitud de la transcripción
    const transcriptionLength = fullTranscription.length;
    let estimatedDuration = Math.max(10, Math.min(60, transcriptionLength / 10000)); // 10k caracteres por segundo (ratio duplicado), mínimo 10s, máximo 60s
    let lastElapsed = 0;
    
    await logInfo(`Video ${videoId}: Transcripción length: ${transcriptionLength}, duración estimada: ${estimatedDuration}s`);
    
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
    
    // Cargar prompts desde el archivo
    const { systemMessage, userMessageTemplate } = await loadCallSeparationPrompt();
    
    await logInfo(`Video ${videoId}: Prompts cargados, preparando mensaje`);
    
    // Reemplazar el placeholder de transcripción con la transcripción real
    const userMessage = userMessageTemplate.replace('[TRANSCRIPCIÓN COMPLETA AQUÍ]', fullTranscription);
    
    await logInfo(`Video ${videoId}: Mensaje preparado, length: ${userMessage.length}`);

    // Sistema de reintentos para errores de conexión
    const maxRetries = 3;
    let retryCount = 0;
    let response;
    
    await logInfo(`Video ${videoId}: Iniciando llamada a OpenAI API`);
    
    while (retryCount <= maxRetries) {
      try {
        // Preparar el objeto de la solicitud que se enviará a la API
        const apiRequest = {
          model: 'gpt-5.2', // GPT-5.2 - mejor razonamiento, memoria extendida y 38% menos errores
          messages: [
            {
              role: 'system',
              content: systemMessage,
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
          temperature: 0.1, // Temperatura baja para respuestas más estrictas y precisas
        };
        
        // Guardar prompt si está habilitado (justo antes de la llamada a la API)
        await logDebug(`Verificando guardado - retryCount: ${retryCount}, savePrompt: ${savePrompt}, promptOutputPath: ${promptOutputPath}`);
        if (savePrompt && promptOutputPath && retryCount === 0) {
          
          const { existsSync } = await import('fs');
          
          try {
            await logDebug(`Intentando guardar prompt en: ${promptOutputPath}`);
            
            await writeFile(promptOutputPath, JSON.stringify(apiRequest, null, 2), 'utf-8');
            
            const fileExists = existsSync(promptOutputPath);
            
            if (fileExists) {
              const { statSync } = await import('fs');
              const stats = statSync(promptOutputPath);
            }
            
            await logDebug(`Prompt guardado exitosamente: ${promptOutputPath}`);
            console.log(`✅ Prompt guardado exitosamente: ${promptOutputPath}`);
          } catch (error) {
            await logError(`Error al guardar prompt de procesamiento: ${error.message}`);
            await logError(`Stack: ${error.stack}`);
          }
        } else if (retryCount === 0) {
          await logDebug(`No se guardará prompt - savePrompt: ${savePrompt}, promptOutputPath: ${promptOutputPath}, retryCount: ${retryCount}`);
        }
        
        // Loguear el prompt en el archivo de log (solo en el primer intento)
        if (retryCount === 0) {
          await logAIPrompt('Procesamiento de datos', videoId, apiRequest);
        }
        
        await logInfo(`Video ${videoId}: Llamando a OpenAI API (intento ${retryCount + 1})`);
        
        // Simular progreso mientras se procesa
        progressInterval = setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000;
          
          // Ajustar dinámicamente la estimación si está tomando más tiempo del esperado
          // Si han pasado más de 5 segundos y el progreso estimado sería > 100%, ajustar la duración estimada
          if (elapsed > 5 && (elapsed / estimatedDuration) * 100 > 90) {
            // Ajustar la duración estimada para que el progreso sea más realista
            estimatedDuration = elapsed / 0.95; // Ajustar para que el progreso esté en ~95% cuando ha pasado este tiempo
          }
          
          // Calcular progreso con función logarítmica para que avance más rápido al inicio y más lento al final
          const linearProgress = Math.min(0.99, (elapsed / estimatedDuration));
          // Aplicar curva logarítmica suave para que el progreso no se estanque
          const estimatedProgress = Math.min(99, linearProgress * 100);
          
          if (showLogCallback && Date.now() - lastUpdate > 500) {
            const statusText = retryCount > 0 ? `Procesando contenido (reintento ${retryCount})` : 'Procesando contenido';
            showLogCallback('🤖', videoNumber, totalVideos, videoId, statusText, estimatedProgress, elapsed);
            lastUpdate = Date.now();
            lastElapsed = elapsed;
          }
        }, 500);
        
        response = await openai.chat.completions.create(apiRequest);
        
        await logInfo(`Video ${videoId}: Respuesta recibida de OpenAI`);
        await logInfo(`Video ${videoId}: Longitud de respuesta: ${response.choices[0].message.content.length}`);
        
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
            showLogCallback('🤖', videoNumber, totalVideos, videoId, `Error de conexión. Reintentando en ${delay/1000}s... (${retryCount}/${maxRetries})`, null, null);
          }
          
          // Esperar antes de reintentar
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Reiniciar el tiempo de inicio para el nuevo intento
          startTime = Date.now();
          lastUpdate = Date.now();
          continue; // Reintentar
        }
        
        // Si no es un error de conexión o se agotaron los reintentos, lanzar el error
        if (isConnectionError(apiError)) {
          throw new Error('Error de conexión con la API de OpenAI después de varios intentos. Verifica tu conexión a internet y que la API key sea válida.');
        } else {
          throw apiError; // Re-lanzar otros errores
        }
      }
    }
    
    // Limpiar intervalo de progreso si aún está activo
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    
    const elapsed = (Date.now() - startTime) / 1000;
    if (showLogCallback) {
      showLogCallback('🤖', videoNumber, totalVideos, videoId, 'Procesando contenido', 100, elapsed);
    }

    // Extraer JSON de la respuesta (puede venir con texto adicional)
    let responseText = response.choices[0].message.content.trim();
    
    // Intentar extraer JSON si viene envuelto en texto
    // Buscar el primer { y el último } balanceado
    let jsonStart = responseText.indexOf('{');
    let jsonEnd = -1;
    
    if (jsonStart !== -1) {
      let braceCount = 0;
      for (let i = jsonStart; i < responseText.length; i++) {
        if (responseText[i] === '{') braceCount++;
        if (responseText[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      
      if (jsonEnd !== -1) {
        responseText = responseText.substring(jsonStart, jsonEnd);
      } else {
        // Si no se encuentra el cierre balanceado, intentar con regex
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          responseText = jsonMatch[0];
        }
      }
    }
    
    // Limpiar el JSON: remover comentarios y caracteres problemáticos
    const cleanedJson = responseText
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remover comentarios /* */
      .replace(/\/\/.*$/gm, '') // Remover comentarios //
      .replace(/,\s*}/g, '}') // Remover comas finales antes de }
      .replace(/,\s*]/g, ']'); // Remover comas finales antes de ]
    
    responseText = cleanedJson;
    
    // Parsear respuesta
    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch (parseError) {
      // console.warn('Error al parsear JSON de procesamiento de datos:', parseError.message);
      // console.warn('Respuesta recibida (primeros 500 caracteres):', responseText.substring(0, 500));
      
      // Intentar reparar JSON común: comas finales, comillas no cerradas, etc.
      try {
        // Intentar reparar comas finales
        let repairedJson = responseText
          .replace(/,(\s*[}\]])/g, '$1') // Remover comas antes de } o ]
          .replace(/([^"])\s*:\s*([^",\[\]{}]+)\s*([,}])/g, '$1: "$2"$3') // Agregar comillas a valores sin comillas
          .replace(/'/g, '"'); // Reemplazar comillas simples por dobles
        
        analysis = JSON.parse(repairedJson);
        // console.log('✅ JSON reparado exitosamente');
      } catch (repairError) {
        // console.warn('No se pudo reparar el JSON, usando fallback');
        // Si falla el parsing, retornar toda la transcripción como una llamada
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];
        return [
          {
            start: firstSegment?.start || 0,
            end: lastSegment?.end || 0,
            transcription: fullTranscription,
          },
        ];
      }
    }
    
    // Extraer el array de llamadas del objeto JSON
    let calls = analysis.calls || [];
    
    await logInfo(`Video ${videoId}: Parseando respuesta JSON`);
    
    // Si no hay calls pero hay propiedades start/end, asumir que es una sola llamada
    if (calls.length === 0 && analysis.start !== undefined && analysis.end !== undefined) {
      calls = [analysis];
    }
    
    await logInfo(`Video ${videoId}: Calls extraídas del JSON: ${calls.length}`);
    
    if (calls.length > 0) {
      const firstCall = calls[0];
      await logInfo(`Video ${videoId}: Primera llamada - thumbnailScene: ${firstCall.thumbnailScene ? 'SÍ' : 'NO'}`);
    }

    // Log de las llamadas recibidas de la IA (comentado para mantener una sola línea)
    // console.log(`📞 Llamadas recibidas de la IA: ${calls.length}`);
    // calls.forEach((call, idx) => {
    //   const startText = call.startText ? `"${call.startText.substring(0, 50)}${call.startText.length > 50 ? '...' : ''}"` : 'N/A';
    //   const endText = call.endText ? `"${call.endText.substring(0, 50)}${call.endText.length > 50 ? '...' : ''}"` : 'N/A';
    //   const startTime = call.startTime !== undefined ? formatTime(call.startTime) : 'N/A';
    //   const endTime = call.endTime !== undefined ? formatTime(call.endTime) : 'N/A';
    //   console.log(`   Llamada ${idx + 1}:  name: ${call.name || 'N/A'}, title: ${call.title || 'N/A'}`);
    //   console.log(`      Inicio: ${startTime} - ${startText}`);
    //   console.log(`      Fin: ${endTime} - ${endText}`);
    // });

    // Usar los tiempos directos de la IA (startTime y endTime)
    // La IA siempre debe proporcionar estos tiempos extraídos del SRT
    const callsWithTimestamps = calls.map((call) => {
      if (call.startTime !== undefined && call.endTime !== undefined && 
          typeof call.startTime === 'number' && typeof call.endTime === 'number') {
        return {
          ...call,
          start: call.startTime,
          end: call.endTime,
        };
      }
      
      // Fallback: Si la IA no proporcionó tiempos, convertir números de línea
      // console.warn(`⚠️  Llamada sin startTime/endTime, usando conversión de números de línea como fallback`);
      return convertLineNumberToTimestamp(call, segments);
    });

    // Validar y ajustar timestamps usando los segmentos reales
    const validatedCalls = validateAndAdjustCalls(callsWithTimestamps, segments);
    
    // Log de las llamadas validadas (comentado para mantener una sola línea)
    // console.log(`✅ Llamadas validadas: ${validatedCalls.length}`);
    // validatedCalls.forEach((call, idx) => {
    //   console.log(`   Llamada ${idx + 1}: start=${formatTime(call.start)}, end=${formatTime(call.end)}`);
    // });

    // Si no se encontraron separaciones, retornar toda la transcripción como una llamada
    if (validatedCalls.length === 0) {
      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];
      
      return [
        {
          start: firstSegment?.start || 0,
          end: lastSegment?.end || 0,
          transcription: fullTranscription,
        },
      ];
    }

    // Extraer transcripciones para cada llamada y preservar todos los metadatos
    return validatedCalls.map((call) => {
      const callSegments = segments.filter(
        (seg) => seg.start >= call.start && seg.end <= call.end
      );
      const callTranscription = callSegments.map((seg) => seg.text).join(' ');

      return {
        start: call.start,
        end: call.end,
        transcription: callTranscription || fullTranscription,
        // Preservar todos los metadatos de la IA: name, age, title, topic, tags, description, summary, thumbnail
        name: call.name,
        age: call.age,
        title: call.title,
        topic: call.topic,
        tags: call.tags,
        description: call.description,
        summary: call.summary,
        thumbnailScene: call.thumbnailScene,
        startText: call.startText,
        endText: call.endText,
      };
    });
    
  } catch (error) {
    await logError(`Video ${videoId}: ERROR en separateCalls: ${error.message}`);
    await logError(`Video ${videoId}: Stack: ${error.stack}`);
    // Limpiar intervalo de progreso si aún está activo
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    
    // Si es un error de conexión después de reintentos, mostrar mensaje
    if (error.message && error.message.includes('Error de conexión')) {
      // El error ya fue lanzado con un mensaje descriptivo, re-lanzarlo
      throw error;
    }
    
    // Para otros errores, usar fallback pero mostrar el error
    await logWarn(`Video ${videoId}: Usando fallback por error en separateCalls`);
    
    // Fallback: retornar toda la transcripción como una llamada
    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    
    return [
      {
        start: firstSegment?.start || 0,
        end: lastSegment?.end || 0,
        transcription: fullTranscription,
      },
    ];
  }
}

/**
 * Convierte números de línea a timestamps usando los segmentos (fallback)
 * @param {object} call - Llamada con números de línea (start, end)
 * @param {Array} segments - Segmentos con timestamps
 * @returns {object} - Llamada con timestamps convertidos
 */
function convertLineNumberToTimestamp(call, segments) {
  if (!segments || segments.length === 0) {
    // console.warn('⚠️  No hay segmentos disponibles para convertir números de línea');
    return call;
  }

  let startTimestamp = call.start;
  let endTimestamp = call.end;

  // Detectar si son números de línea: si son enteros pequeños (< 10000)
  const isLikelyLineNumber = Number.isInteger(call.start) && 
                              Number.isInteger(call.end) &&
                              call.start >= 0 && 
                              call.end > call.start &&
                              (call.start < 10000 || call.end < 10000);

  if (isLikelyLineNumber) {
    // Convertir números de línea a índices de segmentos: cada línea corresponde a un segmento
    // Los números de línea son 1-indexed, los segmentos son 0-indexed
    const startSegmentIndex = Math.max(0, Math.min(call.start - 1, segments.length - 1));
    const endSegmentIndex = Math.max(0, Math.min(call.end - 1, segments.length - 1));
    
    const startSegment = segments[startSegmentIndex];
    const endSegment = segments[endSegmentIndex];
    
    if (startSegment) {
      startTimestamp = startSegment.start;
    }
    if (endSegment) {
      endTimestamp = endSegment.end;
    }
    
    // console.log(`   📍 Llamada (fallback): líneas ${call.start}-${call.end} → segmentos ${startSegmentIndex}-${endSegmentIndex} → timestamps ${formatTime(startTimestamp)}-${formatTime(endTimestamp)}`);
  } else {
    // Ya son timestamps
    // console.log(`   ⏱️  Llamada: timestamps directos ${formatTime(startTimestamp)}-${formatTime(endTimestamp)}`);
  }

  return {
    ...call,
    start: startTimestamp,
    end: endTimestamp,
  };
}

/**
 * Valida y ajusta los timestamps de las llamadas usando los segmentos reales
 * @param {Array} calls - Llamadas identificadas por IA (con timestamps)
 * @param {Array} segments - Segmentos reales de la transcripción
 * @returns {Array} - Llamadas validadas
 */
function validateAndAdjustCalls(calls, segments) {
  if (!segments || segments.length === 0) {
    // console.warn('⚠️  No hay segmentos disponibles para validar llamadas');
    return [];
  }

  const totalDuration = segments[segments.length - 1].end;
  // console.log(`🔍 Validando ${calls.length} llamadas contra ${segments.length} segmentos (duración total: ${formatTime(totalDuration)})`);
  
  const validatedCalls = calls
    .filter((call) => {
      // Validar que los timestamps sean válidos
      if (typeof call.start !== 'number' || typeof call.end !== 'number') {
        // console.warn(`   ❌ Llamada rechazada: timestamps no son números (start: ${typeof call.start}, end: ${typeof call.end})`);
        return false;
      }
      if (call.start < 0) {
        // console.warn(`   ❌ Llamada rechazada: start negativo (${call.start})`);
        return false;
      }
      if (call.end > totalDuration) {
        // console.warn(`   ❌ Llamada rechazada: end mayor que duración total (${call.end} > ${totalDuration})`);
        return false;
      }
      if (call.start >= call.end) {
        // console.warn(`   ❌ Llamada rechazada: start >= end (${call.start} >= ${call.end})`);
        return false;
      }
      // console.log(`   ✅ Llamada válida: ${formatTime(call.start)} - ${formatTime(call.end)}`);
      return true;
    })
    .map((call) => {
      // Ajustar a los timestamps más cercanos de los segmentos reales
      let adjustedStart = call.start;
      let adjustedEnd = call.end;

      // Encontrar el segmento más cercano al inicio
      const startSegment = segments.find((seg) => seg.start <= call.start && seg.end >= call.start);
      if (startSegment) {
        adjustedStart = startSegment.start;
      }

      // Encontrar el segmento más cercano al fin
      const endSegment = segments.find((seg) => seg.start <= call.end && seg.end >= call.end);
      if (endSegment) {
        adjustedEnd = endSegment.end;
      } else {
        // Si no hay segmento que contenga el fin, usar el último segmento antes del fin
        const lastSegmentBeforeEnd = segments
          .filter((seg) => seg.end <= call.end)
          .pop();
        if (lastSegmentBeforeEnd) {
          adjustedEnd = lastSegmentBeforeEnd.end;
        }
      }

      return {
        ...call, // Preservar todas las propiedades de la llamada (name, age, title, etc.)
        start: adjustedStart,
        end: adjustedEnd,
      };
    });
  
  // console.log(`✅ Validación completada: ${validatedCalls.length} de ${calls.length} llamadas pasaron la validación`);
  return validatedCalls;
}
