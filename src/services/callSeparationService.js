import OpenAI from 'openai';
import config from '../config/config.js';

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
 * Separa múltiples llamadas en una transcripción usando IA
 * @param {Array} segments - Segmentos de la transcripción con timestamps
 * @param {string} fullTranscription - Transcripción completa
 * @param {number} videoNumber - Número del video (para logs)
 * @param {number} totalVideos - Total de videos (para logs)
 * @param {string} videoId - ID del video (para logs)
 * @returns {Promise<Array<{start: number, end: number, transcription: string}>>}
 */
export async function separateCalls(segments, fullTranscription, videoNumber = 1, totalVideos = 1, videoId = '') {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    // Enviar transcripción completa con timestamps (SRT completo)
    // GPT-5.2 tiene suficiente contexto (128k tokens) para procesar la transcripción completa
    
    // Simular progreso mientras se procesa
    const startTime = Date.now();
    let lastUpdate = Date.now();
    
    // Estimar tiempo basado en la longitud de la transcripción
    const transcriptionLength = fullTranscription.length;
    let estimatedDuration = Math.max(10, Math.min(60, transcriptionLength / 5000)); // 5k caracteres por segundo, mínimo 10s, máximo 60s
    let lastElapsed = 0;
    
    const progressInterval = setInterval(() => {
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
        showLogCallback('🤖', videoNumber, totalVideos, videoId, 'Separando llamadas', estimatedProgress, elapsed);
        lastUpdate = Date.now();
        lastElapsed = elapsed;
      }
    }, 500);
    
    // System message: Define el rol y comportamiento del modelo
    const systemMessage = `Eres un experto en análisis de contenido de radio. Tu tarea es identificar separaciones entre llamadas telefónicas en programas de radio. Considera que generalmente hay un saludo inicial a los escuchas antes de la primera llamada.

Indicadores de separación:
- **Inicio de llamada**: ocurre *exactamente* cuando el conductor **saluda al llamante** y **pregunta su nombre** con frases como "¿Con quién hablo?" o "¿Cuál es su nombre?".
- **Fin de llamada**: ocurre *exactamente* cuando el conductor **despide al llamante y dice que va a poner un tema/canción** o dice explícitamente que la historia ha terminado.


Responde ÚNICAMENTE con JSON válido, sin explicaciones ni texto adicional.`;

    // User message: Proporciona los datos y el formato específico esperado
    const userMessage = `Analiza esta transcripción e identifica las llamadas separadas:

${fullTranscription}

Formato de respuesta requerido (JSON):
{
  "calls": [
    {
      "start": 0,
      "end": 120,
      "startTime": 0.5,
      "endTime": 180.3,
      "startText": "primeras palabras de la llamada",
      "endText": "últimas palabras de la llamada",
      "name": "Agustín",
      "age": 17,
      "title": "El triángulo amoroso de las hermanas",
      "topic": "romance",
      "tags": ["romance", "hermanas", "triángulo amoroso"],
      "description": "Agustín cuenta su historia de amor con dos hermanas.",
      "summary": "Agustín (17 años) llama al programa para contar su situación sentimental. Está involucrado románticamente con dos hermanas, lo que genera conflictos y dilemas morales. Describe cómo conoció a ambas, los sentimientos que tiene por cada una, y la complejidad de la situación. Menciona momentos específicos de interacción con cada hermana y cómo esto afecta su vida diaria. Al final, le pide a la conductora que le ponga un tema musical relacionado con su situación."
    }
  ]
}

Cada objeto en "calls" debe tener:
- "start": numero de la linea de la transcripcion donde comienza una llamada
- "end": numero de linea de la transcripcion donde termina una llamada
- "startTime": tiempo de inicio de la llamada en segundos (extraer del timestamp del SRT en la línea "start")
- "endTime": tiempo de fin de la llamada en segundos (extraer del timestamp del SRT en la línea "end")
- "startText": primeras palabras de la llamada (string)
- "endText": últimas palabras de la llamada (string)
- "name": nombre del llamante (string)
- "age": edad del llamante (number)
- "title": titulo de la llamada basado en el contenido de la misma (string)
- "topic": tema de la llamada basado en el contenido de la misma, usar solo una palabra o frase corta (string)
- "tags": tags de la llamada basado en el contenido de la misma, cada tag debe ser una palabra o frase corta (array de strings)
- "description": descripción breve de la llamada (2-3 oraciones máximo, resumen conciso del tema principal)
- "summary": resumen detallado y completo de la llamada que incluya TODOS los puntos, eventos, situaciones y detalles mencionados. Este resumen se usará para búsqueda por contenido, por lo que debe ser exhaustivo y mencionar todos los aspectos relevantes de la conversación (string, puede ser extenso)

Si solo hay una llamada, retorna un array con un solo elemento.`;

    
    const response = await openai.chat.completions.create({
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
    });

    clearInterval(progressInterval);
    const elapsed = (Date.now() - startTime) / 1000;
    if (showLogCallback) {
      showLogCallback('🤖', videoNumber, totalVideos, videoId, 'Separando llamadas', 100, elapsed);
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
      // console.warn('Error al parsear JSON de separación de llamadas:', parseError.message);
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
    
    // Si no hay calls pero hay propiedades start/end, asumir que es una sola llamada
    if (calls.length === 0 && analysis.start !== undefined && analysis.end !== undefined) {
      calls = [analysis];
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
        // Preservar todos los metadatos de la IA: name, age, title, topic, tags, description, summary
        name: call.name,
        age: call.age,
        title: call.title,
        topic: call.topic,
        tags: call.tags,
        description: call.description,
        summary: call.summary,
        startText: call.startText,
        endText: call.endText,
      };
    });
  } catch (error) {
    console.error('Error en separación de llamadas:', error);
    
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
