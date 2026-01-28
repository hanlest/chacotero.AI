import { appendFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from '../config/config.js';

// Ruta para los logs
const logsPath = join(config.storage.basePath, 'logs');

// Asegurar que el directorio de logs existe (sincrónico para inicialización)
if (!existsSync(logsPath)) {
  try {
    mkdirSync(logsPath, { recursive: true });
  } catch (err) {
    console.error('Error al crear directorio de logs:', err.message);
  }
}

// Buffer para logs (escribir en batch para mejor rendimiento)
let logBuffer = [];
let isWriting = false;
const BUFFER_SIZE = 50; // Escribir cuando haya 50 logs en el buffer
const FLUSH_INTERVAL = 5000; // O escribir cada 5 segundos

// Archivo de log actual (se crea uno por día)
let currentLogFile = null;

/**
 * Obtiene el nombre del archivo de log para la fecha actual
 * @returns {string} - Nombre del archivo de log
 */
function getLogFileName() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  return `log_${dateStr}.txt`;
}

/**
 * Obtiene la ruta completa del archivo de log actual
 * @returns {string} - Ruta completa del archivo de log
 */
function getCurrentLogPath() {
  return join(logsPath, getLogFileName());
}

/**
 * Formatea un mensaje de log con timestamp
 * @param {string} level - Nivel del log (INFO, ERROR, DEBUG, WARN)
 * @param {string} message - Mensaje a loguear
 * @returns {string} - Mensaje formateado
 */
function formatLogMessage(level, message) {
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 23); // YYYY-MM-DD HH:mm:ss.SSS
  return `[${timestamp}] [${level}] ${message}\n`;
}

/**
 * Escribe logs del buffer al archivo
 */
async function flushLogs() {
  if (isWriting || logBuffer.length === 0) {
    return;
  }

  isWriting = true;
  const logsToWrite = [...logBuffer];
  logBuffer = [];

  try {
    const logPath = getCurrentLogPath();
    const logContent = logsToWrite.join('');
    
    // Si el archivo no existe, crearlo. Si existe, agregar al final
    if (!existsSync(logPath)) {
      await writeFile(logPath, logContent, 'utf-8');
    } else {
      await appendFile(logPath, logContent, 'utf-8');
    }
  } catch (error) {
    // Si falla la escritura, intentar escribir en consola como fallback
    console.error('Error al escribir logs:', error.message);
    // Intentar escribir los logs en consola
    logsToWrite.forEach(log => process.stdout.write(log));
  } finally {
    isWriting = false;
  }
}

/**
 * Agrega un log al buffer y lo escribe si es necesario
 * @param {string} level - Nivel del log
 * @param {string} message - Mensaje a loguear
 */
async function addLog(level, message) {
  const formattedMessage = formatLogMessage(level, message);
  logBuffer.push(formattedMessage);

  // Escribir si el buffer está lleno
  if (logBuffer.length >= BUFFER_SIZE) {
    await flushLogs();
  }
}

/**
 * Fuerza la escritura de todos los logs pendientes
 */
export async function flushAllLogs() {
  await flushLogs();
}

/**
 * Escribe un log de información
 * @param {string} message - Mensaje a loguear
 */
export async function logInfo(message) {
  await addLog('INFO', message);
}

/**
 * Escribe un log de error
 * @param {string} message - Mensaje a loguear
 */
export async function logError(message) {
  await addLog('ERROR', message);
}

/**
 * Escribe un log de advertencia
 * @param {string} message - Mensaje a loguear
 */
export async function logWarn(message) {
  await addLog('WARN', message);
}

/**
 * Escribe un log de debug
 * @param {string} message - Mensaje a loguear
 */
export async function logDebug(message) {
  await addLog('DEBUG', message);
}

/**
 * Escribe un log de progreso de video (formato especial)
 * @param {string} videoId - ID del video
 * @param {string} status - Estado del procesamiento
 * @param {number} percent - Porcentaje de progreso (opcional)
 * @param {number} elapsed - Tiempo transcurrido en segundos (opcional)
 */
export async function logVideoProgress(videoId, status, percent = null, elapsed = null) {
  let message = `Video ${videoId}: ${status}`;
  if (percent !== null) {
    message += ` ${percent.toFixed(1)}%`;
  }
  if (elapsed !== null) {
    message += ` | ${elapsed.toFixed(1)}s`;
  }
  await addLog('INFO', message);
}

/**
 * Escribe un log de error de video
 * @param {string} videoId - ID del video
 * @param {string} error - Mensaje de error
 */
export async function logVideoError(videoId, error) {
  await addLog('ERROR', `Video ${videoId}: ${error}`);
}

/**
 * Escribe un log de prompt enviado a la IA
 * @param {string} service - Nombre del servicio (ej: "Procesamiento de datos", "Generación de imagen")
 * @param {string} videoId - ID del video (opcional)
 * @param {object} apiRequest - Objeto completo de la solicitud a la API
 */
export async function logAIPrompt(service, videoId = null, apiRequest = null) {
  if (!apiRequest) {
    return;
  }
  
  const videoPrefix = videoId ? `Video ${videoId} - ` : '';
  const header = `${videoPrefix}Prompt enviado a ${service}:`;
  await addLog('PROMPT', header);
  
  // Formatear el prompt de forma legible
  if (apiRequest.messages) {
    // Para Chat Completions (GPT)
    await addLog('PROMPT', `  Modelo: ${apiRequest.model || 'N/A'}`);
    await addLog('PROMPT', `  Temperatura: ${apiRequest.temperature || 'N/A'}`);
    await addLog('PROMPT', `  Mensajes:`);
    
    // Usar for...of en lugar de forEach para manejar async correctamente
    for (let idx = 0; idx < apiRequest.messages.length; idx++) {
      const msg = apiRequest.messages[idx];
      await addLog('PROMPT', `    [${idx + 1}] ${msg.role.toUpperCase()}:`);
      // Dividir el contenido en líneas si es muy largo
      const content = msg.content;
      const maxLineLength = 200; // Máximo de caracteres por línea
      
      if (content.length <= maxLineLength) {
        await addLog('PROMPT', `      ${content}`);
      } else {
        // Dividir en líneas más pequeñas
        for (let i = 0; i < content.length; i += maxLineLength) {
          const chunk = content.substring(i, i + maxLineLength);
          await addLog('PROMPT', `      ${chunk}`);
        }
      }
    }
  } else if (apiRequest.prompt) {
    // Para Image Generation (DALL-E)
    await addLog('PROMPT', `  Modelo: ${apiRequest.model || 'N/A'}`);
    await addLog('PROMPT', `  Tamaño: ${apiRequest.size || 'N/A'}`);
    await addLog('PROMPT', `  Calidad: ${apiRequest.quality || 'N/A'}`);
    await addLog('PROMPT', `  Estilo: ${apiRequest.style || 'N/A'}`);
    await addLog('PROMPT', `  Prompt:`);
    
    // Dividir el prompt en líneas si es muy largo
    const prompt = apiRequest.prompt;
    const maxLineLength = 200; // Máximo de caracteres por línea
    
    if (prompt.length <= maxLineLength) {
      await addLog('PROMPT', `    ${prompt}`);
    } else {
      // Dividir en líneas más pequeñas
      for (let i = 0; i < prompt.length; i += maxLineLength) {
        const chunk = prompt.substring(i, i + maxLineLength);
        await addLog('PROMPT', `    ${chunk}`);
      }
    }
  }
  
  // Separador al final
  await addLog('PROMPT', '---');
}

// Flush automático cada cierto tiempo
setInterval(() => {
  flushLogs().catch(err => {
    console.error('Error en flush automático de logs:', err.message);
  });
}, FLUSH_INTERVAL);

// Flush al cerrar la aplicación
process.on('SIGINT', async () => {
  await flushAllLogs();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await flushAllLogs();
  process.exit(0);
});

// Flush antes de que el proceso termine
process.on('exit', async () => {
  await flushAllLogs();
});
