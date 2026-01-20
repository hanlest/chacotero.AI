import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pipeline, env } from '@xenova/transformers';
import config from '../config/config.js';
import { logInfo, logError, logWarn } from './loggerService.js';

// Suprimir warnings de transformers
env.suppressWarnings = true;

let pineconeClient = null;
let openaiClient = null;
let localEmbeddingModel = null;

/**
 * Inicializa el cliente de Pinecone
 * @returns {Promise<Pinecone>}
 */
async function initializePinecone() {
  if (pineconeClient) {
    return pineconeClient;
  }

  if (!config.pinecone.apiKey) {
    throw new Error('PINECONE_API_KEY no está configurado en las variables de entorno');
  }

  try {
    // La versión 6.x usa la nueva API global que solo requiere apiKey
    // Si tienes índices pod-based legacy, puedes agregar environment y projectId
    const clientConfig = {
      apiKey: config.pinecone.apiKey,
    };

    // Solo agregar environment si está configurado (para índices pod-based legacy)
    if (config.pinecone.environment) {
      clientConfig.environment = config.pinecone.environment;
      await logInfo(`Inicializando Pinecone con API legacy (environment: ${config.pinecone.environment})`);
    } else {
      await logInfo('Inicializando Pinecone con API global (solo apiKey)');
    }

    // Solo agregar projectId si está configurado
    if (config.pinecone.projectId) {
      clientConfig.projectId = config.pinecone.projectId;
      await logInfo(`Usando projectId: ${config.pinecone.projectId}`);
    }

    pineconeClient = new Pinecone(clientConfig);
    
    await logInfo('Cliente de Pinecone inicializado correctamente');
    return pineconeClient;
  } catch (error) {
    await logError(`Error al inicializar Pinecone: ${error.message}`);
    throw error;
  }
}

/**
 * Inicializa el cliente de OpenAI
 * @returns {OpenAI}
 */
function initializeOpenAI() {
  if (openaiClient) {
    return openaiClient;
  }

  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no está configurado en las variables de entorno');
  }

  openaiClient = new OpenAI({
    apiKey: config.openai.apiKey,
  });

  return openaiClient;
}

/**
 * Carga el modelo de embeddings local (se carga solo una vez)
 * @returns {Promise<Object>} - Modelo de embeddings
 */
async function loadLocalEmbeddingModel() {
  if (localEmbeddingModel) {
    return localEmbeddingModel;
  }

  const modelName = config.embeddings.localModel;
  
  await logInfo(`Cargando modelo de embeddings local: ${modelName}...`);

  try {
    localEmbeddingModel = await pipeline(
      'feature-extraction',
      modelName,
      {
        device: 'cpu', // CPU por ahora, GPU requiere WebGPU
      }
    );
    
    await logInfo(`Modelo de embeddings local cargado: ${modelName}`);
    return localEmbeddingModel;
  } catch (error) {
    await logError(`Error al cargar modelo de embeddings local: ${error.message}`);
    throw error;
  }
}

/**
 * Genera un embedding usando el modelo local
 * @param {string} text - Texto para generar el embedding
 * @returns {Promise<number[]>} - Vector de embedding
 */
async function generateEmbeddingLocal(text) {
  try {
    const model = await loadLocalEmbeddingModel();
    
    // Generar embedding
    // El output de feature-extraction es un tensor con shape [1, sequence_length, hidden_size]
    const output = await model(text, {
      pooling: 'mean', // Promediar los tokens para obtener un vector único
      normalize: true, // Normalizar el vector
    });

    // Convertir tensor a array de números
    // El output puede ser un Tensor o un objeto con .data
    let embedding;
    
    if (output && typeof output.data !== 'undefined') {
      // Si tiene .data (Tensor de ONNX)
      embedding = Array.from(output.data);
    } else if (Array.isArray(output)) {
      // Si ya es un array
      embedding = output;
    } else if (output && output.length) {
      // Si es un tensor con método length
      embedding = Array.from(output);
    } else {
      // Intentar acceder directamente a los valores
      try {
        embedding = Array.from(output);
      } catch (e) {
        throw new Error(`Formato de output no reconocido: ${typeof output}`);
      }
    }

    // Asegurar que tenga la dimensión correcta
    if (embedding.length !== config.embeddings.localDimensions) {
      await logWarn(`Embedding tiene ${embedding.length} dimensiones, esperado ${config.embeddings.localDimensions}. Ajustando...`);
      // Si es mayor, truncar; si es menor, rellenar con ceros
      if (embedding.length > config.embeddings.localDimensions) {
        embedding = embedding.slice(0, config.embeddings.localDimensions);
      } else {
        embedding = [...embedding, ...new Array(config.embeddings.localDimensions - embedding.length).fill(0)];
      }
    }

    await logInfo(`Embedding local generado con ${embedding.length} dimensiones`);
    
    return embedding;
  } catch (error) {
    await logError(`Error al generar embedding local: ${error.message}`);
    throw error;
  }
}

/**
 * Genera un embedding usando OpenAI
 * @param {string} text - Texto para generar el embedding
 * @returns {Promise<number[]>} - Vector de embedding
 */
async function generateEmbeddingOpenAI(text) {
  try {
    const openai = initializeOpenAI();
    
    // Configurar parámetros de embedding
    const embeddingParams = {
      model: config.openai.embeddingModel,
      input: text,
    };

    // Si el modelo es text-embedding-3-small o text-embedding-3-large, 
    // podemos especificar las dimensiones
    if (config.openai.embeddingModel.includes('text-embedding-3')) {
      embeddingParams.dimensions = config.openai.embeddingDimensions;
    }
    
    const response = await openai.embeddings.create(embeddingParams);

    if (!response.data || !response.data[0] || !response.data[0].embedding) {
      throw new Error('No se pudo generar el embedding');
    }

    const embedding = response.data[0].embedding;
    await logInfo(`Embedding OpenAI generado con ${embedding.length} dimensiones`);
    
    return embedding;
  } catch (error) {
    await logError(`Error al generar embedding OpenAI: ${error.message}`);
    throw error;
  }
}

/**
 * Genera un embedding (local o OpenAI según configuración)
 * @param {string} text - Texto para generar el embedding
 * @returns {Promise<number[]>} - Vector de embedding
 */
export async function generateEmbedding(text) {
  if (config.embeddings.provider === 'local') {
    return await generateEmbeddingLocal(text);
  } else {
    return await generateEmbeddingOpenAI(text);
  }
}

/**
 * Obtiene el índice de Pinecone
 * @returns {Promise<Index>}
 */
async function getIndex() {
  const client = await initializePinecone();
  const indexName = config.pinecone.indexName;
  
  try {
    const index = client.index(indexName);
    return index;
  } catch (error) {
    await logError(`Error al obtener índice de Pinecone: ${error.message}`);
    throw error;
  }
}

/**
 * Verifica si una llamada ya existe en Pinecone por callId
 * @param {string} callId - ID de la llamada
 * @returns {Promise<boolean>}
 */
export async function callExists(callId) {
  try {
    const index = await getIndex();
    
    // Buscar por metadata callId usando fetch con filter
    // Nota: Pinecone requiere un vector válido para query, pero podemos usar fetch para buscar por metadata
    try {
      const fetchResponse = await index.fetch([], {
        filter: {
          callId: { $eq: callId },
        },
      });
      
      // Si fetch no funciona, intentar con query usando un vector dummy
      if (!fetchResponse || Object.keys(fetchResponse.records || {}).length === 0) {
        const embeddingDims = config.embeddings.provider === 'local' 
          ? config.embeddings.localDimensions 
          : config.openai.embeddingDimensions;
        const queryResponse = await index.query({
          vector: new Array(embeddingDims).fill(0), // Vector dummy
          topK: 10,
          includeMetadata: true,
          filter: {
            callId: { $eq: callId },
          },
        });
        
        return queryResponse.matches && queryResponse.matches.length > 0;
      }
      
      return Object.keys(fetchResponse.records || {}).length > 0;
    } catch (fetchError) {
      // Si fetch falla, usar query como fallback
      const embeddingDims = config.embeddings.provider === 'local' 
        ? config.embeddings.localDimensions 
        : config.openai.embeddingDimensions;
      const queryResponse = await index.query({
        vector: new Array(embeddingDims).fill(0), // Vector dummy
        topK: 10,
        includeMetadata: true,
        filter: {
          callId: { $eq: callId },
        },
      });

      return queryResponse.matches && queryResponse.matches.length > 0;
    }
  } catch (error) {
    await logWarn(`Error al verificar si la llamada existe: ${error.message}`);
    return false;
  }
}

/**
 * Busca llamadas similares en Pinecone
 * @param {number[]} embedding - Vector de embedding para buscar
 * @param {number} topK - Número de resultados a retornar (default: 10)
 * @param {string} excludeCallId - CallId a excluir de los resultados (opcional)
 * @returns {Promise<Array>} - Array de llamadas similares con similitud
 */
export async function findSimilarCalls(embedding, topK = 10, excludeCallId = null) {
  try {
    const index = await getIndex();
    
    // Construir query con filtro para excluir la llamada actual si se especifica
    const queryOptions = {
      vector: embedding,
      topK: topK + (excludeCallId ? 1 : 0), // Buscar uno más si vamos a excluir
      includeMetadata: true,
    };

    // Si hay un callId para excluir, agregar filtro
    if (excludeCallId) {
      queryOptions.filter = {
        callId: { $ne: excludeCallId }, // Excluir el callId especificado
      };
    }
    
    const queryResponse = await index.query(queryOptions);

    if (!queryResponse.matches || queryResponse.matches.length === 0) {
      return [];
    }

    // Filtrar resultados y mapear
    const results = queryResponse.matches
      .filter(match => {
        // Doble verificación: excluir por callId si coincide
        if (excludeCallId && match.metadata?.callId === excludeCallId) {
          return false;
        }
        return true;
      })
      .map(match => ({
        id: match.id,
        score: match.score,
        fileName: match.metadata?.fileName || null,
        callId: match.metadata?.callId || null,
        title: match.metadata?.title || null,
        summary: match.metadata?.summary || null,
        date: match.metadata?.date || null,
        name: match.metadata?.name || null,
        age: match.metadata?.age || null,
        youtubeVideoId: match.metadata?.youtubeVideoId || null,
      }));

    return results;
  } catch (error) {
    await logError(`Error al buscar llamadas similares: ${error.message}`);
    throw error;
  }
}

/**
 * Sube una llamada a Pinecone
 * @param {string} callId - ID único de la llamada
 * @param {number[]} embedding - Vector de embedding
 * @param {object} metadata - Metadata completo de la llamada
 * @returns {Promise<string>} - ID de Pinecone generado
 */
export async function uploadCall(callId, embedding, metadata) {
  try {
    const index = await getIndex();
    
    // Generar ID único para Pinecone (usar callId o generar UUID)
    const pineconeId = metadata.pineconeId || callId || `call-${Date.now()}`;
    
    // Preparar metadata para Pinecone (solo campos permitidos)
    // Pinecone no acepta null, convertir a strings vacíos
    const pineconeMetadata = {
      callId: metadata.callId || callId || '',
      fileName: metadata.fileName != null ? String(metadata.fileName) : '',
      title: metadata.title != null ? String(metadata.title) : '',
      summary: metadata.summary != null ? String(metadata.summary) : '',
      date: metadata.date != null ? String(metadata.date) : '',
      name: metadata.name != null ? String(metadata.name) : '',
      age: metadata.age != null ? String(metadata.age) : '',
      youtubeVideoId: metadata.youtubeVideoId != null ? String(metadata.youtubeVideoId) : '',
    };

    // Subir a Pinecone
    await index.upsert([
      {
        id: pineconeId,
        values: embedding,
        metadata: pineconeMetadata,
      },
    ]);

    await logInfo(`Llamada ${callId} subida a Pinecone con ID: ${pineconeId}`);
    
    return pineconeId;
  } catch (error) {
    await logError(`Error al subir llamada a Pinecone: ${error.message}`);
    throw error;
  }
}

/**
 * Elimina un registro de Pinecone
 * @param {string} pineconeId - ID del registro en Pinecone
 * @returns {Promise<boolean>} - true si se eliminó exitosamente
 */
export async function deleteFromPinecone(pineconeId) {
  try {
    if (!pineconeId) {
      await logWarn('No se proporcionó pineconeId para eliminar de Pinecone');
      return false;
    }

    const index = await getIndex();
    
    // Eliminar el registro de Pinecone
    // Usar deleteMany con array para compatibilidad con diferentes versiones de Pinecone
    await index.deleteMany([pineconeId]);
    
    await logInfo(`Registro eliminado de Pinecone con ID: ${pineconeId}`);
    return true;
  } catch (error) {
    await logError(`Error al eliminar de Pinecone: ${error.message}`);
    // No lanzar error, solo registrar, para que la eliminación de archivos continúe
    return false;
  }
}

/**
 * Elimina un registro de Pinecone por fileName
 * @param {string} fileName - Nombre del archivo (sin extensión)
 * @returns {Promise<boolean>} - true si se eliminó exitosamente
 */
export async function deleteFromPineconeByFileName(fileName) {
  try {
    if (!fileName) {
      await logWarn('No se proporcionó fileName para eliminar de Pinecone');
      return false;
    }

    const index = await getIndex();
    
    // Buscar el registro en Pinecone por fileName usando query
    const embeddingDims = config.embeddings.provider === 'local' 
      ? config.embeddings.localDimensions 
      : config.openai.embeddingDimensions;
    
    const queryResponse = await index.query({
      vector: new Array(embeddingDims).fill(0), // Vector dummy
      topK: 1,
      includeMetadata: true,
      filter: {
        fileName: { $eq: fileName },
      },
    });
    
    if (!queryResponse.matches || queryResponse.matches.length === 0) {
      await logWarn(`No se encontró registro en Pinecone para fileName: ${fileName}`);
      return false;
    }
    
    // Obtener el pineconeId del primer resultado
    const pineconeId = queryResponse.matches[0].id;
    
    if (!pineconeId) {
      await logWarn(`No se encontró pineconeId en el resultado para fileName: ${fileName}`);
      return false;
    }
    
    // Eliminar el registro
    await index.deleteMany([pineconeId]);
    
    await logInfo(`Registro eliminado de Pinecone para fileName: ${fileName} con ID: ${pineconeId}`);
    return true;
  } catch (error) {
    await logError(`Error al eliminar de Pinecone por fileName: ${error.message}`);
    return false;
  }
}

/**
 * Actualiza los JSONs de las llamadas relacionadas/duplicadas para incluir la llamada actual
 * @param {string} currentFileName - Nombre del archivo de la llamada actual
 * @param {string[]} duplicateOf - Array de nombres de archivos duplicados
 * @param {string[]} relatedCalls - Array de nombres de archivos relacionados
 */
export async function updateRelatedCallsMetadata(currentFileName, duplicateOf, relatedCalls) {
  try {
    // Actualizar llamadas duplicadas
    for (const duplicateFileName of duplicateOf) {
      try {
        const duplicateMetadataPath = join(config.storage.callsPath, `${duplicateFileName}.json`);
        if (existsSync(duplicateMetadataPath)) {
          const duplicateContent = await readFile(duplicateMetadataPath, 'utf-8');
          const duplicateMetadata = JSON.parse(duplicateContent);
          
          // Inicializar arrays si no existen
          if (!Array.isArray(duplicateMetadata.duplicateOf)) {
            duplicateMetadata.duplicateOf = duplicateMetadata.duplicateOf ? [duplicateMetadata.duplicateOf] : [];
          }
          if (!Array.isArray(duplicateMetadata.relatedCalls)) {
            duplicateMetadata.relatedCalls = duplicateMetadata.relatedCalls || [];
          }
          
          // Agregar la llamada actual a duplicateOf si no está ya
          if (!duplicateMetadata.duplicateOf.includes(currentFileName)) {
            duplicateMetadata.duplicateOf.push(currentFileName);
          }
          
          // Guardar metadata actualizado
          await writeFile(duplicateMetadataPath, JSON.stringify(duplicateMetadata, null, 2), 'utf-8');
          await logInfo(`Metadata actualizado para ${duplicateFileName}: agregado ${currentFileName} a duplicateOf`);
        }
      } catch (error) {
        await logWarn(`Error al actualizar metadata de ${duplicateFileName}: ${error.message}`);
      }
    }
    
    // Actualizar llamadas relacionadas
    for (const relatedFileName of relatedCalls) {
      try {
        const relatedMetadataPath = join(config.storage.callsPath, `${relatedFileName}.json`);
        if (existsSync(relatedMetadataPath)) {
          const relatedContent = await readFile(relatedMetadataPath, 'utf-8');
          const relatedMetadata = JSON.parse(relatedContent);
          
          // Inicializar arrays si no existen
          if (!Array.isArray(relatedMetadata.relatedCalls)) {
            relatedMetadata.relatedCalls = relatedMetadata.relatedCalls || [];
          }
          if (!Array.isArray(relatedMetadata.duplicateOf)) {
            relatedMetadata.duplicateOf = relatedMetadata.duplicateOf ? [relatedMetadata.duplicateOf] : [];
          }
          
          // Agregar la llamada actual a relatedCalls si no está ya
          if (!relatedMetadata.relatedCalls.includes(currentFileName)) {
            relatedMetadata.relatedCalls.push(currentFileName);
          }
          
          // Guardar metadata actualizado
          await writeFile(relatedMetadataPath, JSON.stringify(relatedMetadata, null, 2), 'utf-8');
          await logInfo(`Metadata actualizado para ${relatedFileName}: agregado ${currentFileName} a relatedCalls`);
        }
      } catch (error) {
        await logWarn(`Error al actualizar metadata de ${relatedFileName}: ${error.message}`);
      }
    }
  } catch (error) {
    await logWarn(`Error al actualizar metadata de llamadas relacionadas: ${error.message}`);
  }
}

/**
 * Construye el texto formateado para generar el embedding
 * Formato: Nombre: [nombre]\nEdad: [edad]\nDescripcion: [description]\nResumen: [summary]
 * @param {object} metadata - Metadata de la llamada
 * @returns {string} - Texto formateado para embedding
 */
export function buildEmbeddingText(metadata) {
  const parts = [];
  
  // Nombre
  if (metadata.name && metadata.name.trim()) {
    parts.push(`Nombre: ${metadata.name.trim()}`);
  }
  
  // Edad
  if (metadata.age) {
    parts.push(`Edad: ${metadata.age}`);
  }
  
  // Descripción
  if (metadata.description && metadata.description.trim()) {
    parts.push(`Descripcion: ${metadata.description.trim()}`);
  }
  
  // Resumen (obligatorio)
  if (metadata.summary && metadata.summary.trim()) {
    parts.push(`Resumen: ${metadata.summary.trim()}`);
  } else {
    throw new Error('El metadata debe contener un campo "summary" para generar el embedding');
  }
  
  return parts.join('\n');
}

/**
 * Sube solo el embedding a Pinecone sin buscar similares
 * @param {object} metadata - Metadata completo de la llamada
 * @returns {Promise<object>} - Resultado con pineconeId
 */
export async function uploadEmbeddingOnly(metadata) {
  try {
    // Construir texto formateado para embedding
    const embeddingText = buildEmbeddingText(metadata);
    
    await logInfo(`Generando embedding para llamada ${metadata.fileName || metadata.callId}...`);
    await logInfo(`Texto para embedding (primeros 300 caracteres): ${embeddingText.substring(0, 300)}...`);
    const embedding = await generateEmbedding(embeddingText);

    // Guardar embedding en archivo .emb
    const fileName = metadata.fileName || metadata.callId;
    if (fileName) {
      const embeddingPath = join(config.storage.callsPath, `${fileName}.emb`);
      try {
        await writeFile(embeddingPath, JSON.stringify(embedding, null, 2), 'utf-8');
        await logInfo(`Embedding guardado en: ${embeddingPath}`);
      } catch (error) {
        await logWarn(`Error al guardar embedding en archivo: ${error.message}`);
        // Continuar aunque falle el guardado del archivo
      }
    }

    // Subir a Pinecone
    await logInfo(`Subiendo embedding a Pinecone...`);
    const pineconeId = await uploadCall(metadata.callId, embedding, metadata);

    return {
      uploaded: true,
      pineconeId: pineconeId,
    };
  } catch (error) {
    await logError(`Error al subir embedding: ${error.message}`);
    throw error;
  }
}

/**
 * Procesa una llamada: genera embedding, busca similares, detecta duplicados/relacionadas y sube a Pinecone
 * @param {object} metadata - Metadata completo de la llamada
 * @returns {Promise<object>} - Resultado con información de duplicados y relacionadas
 */
export async function processCall(metadata) {
  try {
    // Verificar si ya existe
    const existingCallId = metadata.callId;
    if (existingCallId && await callExists(existingCallId)) {
      await logWarn(`La llamada ${existingCallId} ya existe en Pinecone`);
      return {
        uploaded: false,
        alreadyExists: true,
        pineconeId: metadata.pineconeId || null,
      };
    }

    // Construir texto formateado para embedding
    const embeddingText = buildEmbeddingText(metadata);
    
    await logInfo(`Generando embedding para llamada ${metadata.fileName || metadata.callId}...`);
    await logInfo(`Texto para embedding (primeros 300 caracteres): ${embeddingText.substring(0, 300)}...`);
    const embedding = await generateEmbedding(embeddingText);

    // Guardar embedding en archivo .emb
    const fileName = metadata.fileName || metadata.callId;
    if (fileName) {
      const embeddingPath = join(config.storage.callsPath, `${fileName}.emb`);
      try {
        await writeFile(embeddingPath, JSON.stringify(embedding, null, 2), 'utf-8');
        await logInfo(`Embedding guardado en: ${embeddingPath}`);
      } catch (error) {
        await logWarn(`Error al guardar embedding en archivo: ${error.message}`);
        // Continuar aunque falle el guardado del archivo
      }
    }

    // Buscar llamadas similares (excluyendo la llamada actual si ya existe)
    await logInfo(`Buscando llamadas similares...`);
    const excludeCallId = metadata.callId || null;
    const similarCalls = await findSimilarCalls(embedding, 10, excludeCallId);

    // Usar umbrales configurables
    const duplicateThreshold = config.pinecone.duplicateThreshold;
    const relatedThreshold = config.pinecone.relatedThreshold;

    await logInfo(`Umbrales configurados: Duplicado >= ${(duplicateThreshold * 100).toFixed(4)}% (${duplicateThreshold}), Relacionada >= ${(relatedThreshold * 100).toFixed(4)}% (${relatedThreshold})`);

    const duplicateOf = []; // Array de llamadas duplicadas
    const relatedCalls = [];

    // Log de los scores encontrados para debugging
    if (similarCalls.length > 0) {
      const topScores = similarCalls.slice(0, 3).map(s => `${(s.score * 100).toFixed(4)}%`).join(', ');
      await logInfo(`Top 3 scores de similitud encontrados: ${topScores}`);
    }

    const currentFileName = metadata.fileName || metadata.callId;

    for (const similar of similarCalls) {
      if (similar.score >= duplicateThreshold) {
        // Es un duplicado
        const duplicateFileName = similar.fileName || similar.id;
        if (duplicateFileName && !duplicateOf.includes(duplicateFileName)) {
          duplicateOf.push(duplicateFileName);
          await logWarn(`Llamada duplicada detectada: ${currentFileName} es duplicado de ${duplicateFileName} (similitud: ${(similar.score * 100).toFixed(4)}%)`);
        }
      } else if (similar.score >= relatedThreshold) {
        // Es relacionada
        const relatedFileName = similar.fileName || similar.id;
        if (relatedFileName && !relatedCalls.includes(relatedFileName)) {
          relatedCalls.push(relatedFileName);
        }
      }
    }

    // Preparar información de llamadas similares con porcentajes
    // Solo incluir las que están por encima del umbral de relacionadas (duplicadas o relacionadas)
    await logInfo(`Filtrando llamadas similares: Total encontradas: ${similarCalls.length}, Umbral aplicado: >= ${(relatedThreshold * 100).toFixed(4)}% (${relatedThreshold})`);
    
    // Log de llamadas que no pasan el filtro
    const filteredOut = similarCalls.filter(similar => similar.score < relatedThreshold);
    if (filteredOut.length > 0) {
      const filteredScores = filteredOut.map(s => `${(s.score * 100).toFixed(4)}%`).join(', ');
      await logInfo(`Llamadas filtradas (score < ${(relatedThreshold * 100).toFixed(4)}%): ${filteredScores}`);
    }
    
    const similarCallsInfo = similarCalls
      .filter(similar => similar.score >= relatedThreshold) // Solo las que están por encima del umbral de relacionadas
      .map(similar => {
        const fileName = similar.fileName || similar.id;
        let description = similar.summary || null;
        
        // Si no hay descripción en Pinecone, intentar cargarla desde el archivo JSON
        if (!description && fileName) {
          try {
            const similarMetadataPath = join(config.storage.callsPath, `${fileName}.json`);
            if (existsSync(similarMetadataPath)) {
              const similarMetadataContent = readFileSync(similarMetadataPath, 'utf-8');
              const similarMetadata = JSON.parse(similarMetadataContent);
              description = similarMetadata.description || similarMetadata.summary || null;
            }
          } catch (error) {
            // Si falla, continuar sin descripción
          }
        }
        
        return {
          fileName: fileName,
          callId: similar.callId || null,
          title: similar.title || null,
          description: description,
          similarity: parseFloat((similar.score * 100).toFixed(4)), // Convertir a porcentaje (0-100) con 4 decimales
          score: similar.score, // Mantener score original para ordenamiento
        };
      })
      .sort((a, b) => b.score - a.score); // Ordenar por similitud descendente

    await logInfo(`Llamadas similares después del filtro: ${similarCallsInfo.length} (duplicadas: ${duplicateOf.length}, relacionadas: ${relatedCalls.length})`);

    // Asegurar que todas las llamadas en relatedCalls y duplicateOf estén en similarCallsInfo
    // Esto es importante porque pueden haber sido agregadas previamente o no estar en los resultados de Pinecone
    const existingFileNames = new Set(similarCallsInfo.map(c => c.fileName));
    
    // Agregar llamadas duplicadas que no estén ya en similarCallsInfo
    for (const duplicateFileName of duplicateOf) {
      if (!existingFileNames.has(duplicateFileName)) {
        try {
          const duplicateMetadataPath = join(config.storage.callsPath, `${duplicateFileName}.json`);
          if (existsSync(duplicateMetadataPath)) {
            const duplicateMetadataContent = await readFile(duplicateMetadataPath, 'utf-8');
            const duplicateMetadata = JSON.parse(duplicateMetadataContent);
            
            // Buscar el score en los resultados de Pinecone si está disponible
            let score = 0.98; // Score por defecto para duplicados
            const foundInSimilar = similarCalls.find(s => (s.fileName || s.id) === duplicateFileName);
            if (foundInSimilar) {
              score = foundInSimilar.score;
            }
            
            similarCallsInfo.push({
              fileName: duplicateFileName,
              callId: duplicateMetadata.callId || null,
              title: duplicateMetadata.title || null,
              description: duplicateMetadata.description || duplicateMetadata.summary || null,
              similarity: parseFloat((score * 100).toFixed(4)),
              score: score,
            });
            existingFileNames.add(duplicateFileName);
            await logInfo(`Agregada llamada duplicada faltante a similarCallsInfo: ${duplicateFileName}`);
          }
        } catch (error) {
          await logWarn(`No se pudo cargar información de duplicado ${duplicateFileName}: ${error.message}`);
        }
      }
    }
    
    // Agregar llamadas relacionadas que no estén ya en similarCallsInfo
    for (const relatedFileName of relatedCalls) {
      if (!existingFileNames.has(relatedFileName)) {
        try {
          const relatedMetadataPath = join(config.storage.callsPath, `${relatedFileName}.json`);
          if (existsSync(relatedMetadataPath)) {
            const relatedMetadataContent = await readFile(relatedMetadataPath, 'utf-8');
            const relatedMetadata = JSON.parse(relatedMetadataContent);
            
            // Buscar el score en los resultados de Pinecone si está disponible
            let score = 0.90; // Score por defecto para relacionadas
            const foundInSimilar = similarCalls.find(s => (s.fileName || s.id) === relatedFileName);
            if (foundInSimilar) {
              score = foundInSimilar.score;
            }
            
            similarCallsInfo.push({
              fileName: relatedFileName,
              callId: relatedMetadata.callId || null,
              title: relatedMetadata.title || null,
              description: relatedMetadata.description || relatedMetadata.summary || null,
              similarity: parseFloat((score * 100).toFixed(4)),
              score: score,
            });
            existingFileNames.add(relatedFileName);
            await logInfo(`Agregada llamada relacionada faltante a similarCallsInfo: ${relatedFileName}`);
          }
        } catch (error) {
          await logWarn(`No se pudo cargar información de relacionada ${relatedFileName}: ${error.message}`);
        }
      }
    }
    
    // Re-ordenar por score descendente después de agregar las faltantes
    similarCallsInfo.sort((a, b) => b.score - a.score);
    await logInfo(`similarCallsInfo final después de agregar faltantes: ${similarCallsInfo.length} llamadas`);

    // Actualizar JSONs de las llamadas relacionadas/duplicadas (actualización bidireccional)
    await updateRelatedCallsMetadata(currentFileName, duplicateOf, relatedCalls);

    // Si es duplicado, NO subir a Pinecone
    if (duplicateOf.length > 0) {
      return {
        uploaded: false,
        isDuplicate: true,
        duplicateOf: duplicateOf,
        relatedCalls: relatedCalls,
        similarCalls: similarCallsInfo,
      };
    }

    // Subir a Pinecone
    await logInfo(`Subiendo llamada a Pinecone...`);
    const pineconeId = await uploadCall(metadata.callId, embedding, metadata);

    return {
      uploaded: true,
      pineconeId: pineconeId,
      isDuplicate: false,
      duplicateOf: duplicateOf,
      relatedCalls: relatedCalls,
      similarCalls: similarCallsInfo,
    };
  } catch (error) {
    await logError(`Error al procesar llamada: ${error.message}`);
    throw error;
  }
}
