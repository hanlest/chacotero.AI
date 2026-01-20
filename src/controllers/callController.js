import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import config from '../config/config.js';
import { processCall, generateEmbedding, findSimilarCalls, buildEmbeddingText, uploadCall, deleteFromPineconeByFileName } from '../services/pineconeService.js';
import { logInfo, logError, logWarn } from '../services/loggerService.js';

/**
 * Sube una llamada a Pinecone
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function uploadCallToPinecone(req, res) {
  try {
    const { callId, fileName, metadataPath } = req.body;

    // Determinar el nombre del archivo
    let targetFileName = null;
    
    if (fileName) {
      targetFileName = fileName;
    } else if (callId) {
      // Buscar el archivo por callId
      const callsPath = config.storage.callsPath;
      const files = await import('fs/promises').then(m => m.readdir(callsPath));
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      for (const file of jsonFiles) {
        try {
          const filePath = join(callsPath, file);
          const content = await readFile(filePath, 'utf-8');
          const metadata = JSON.parse(content);
          
          if (metadata.callId === callId) {
            targetFileName = metadata.fileName || file.replace('.json', '');
            break;
          }
        } catch (error) {
          // Continuar con el siguiente archivo
          continue;
        }
      }
      
      if (!targetFileName) {
        return res.status(404).json({
          error: 'No se encontró la llamada con el callId proporcionado',
        });
      }
    } else if (metadataPath) {
      // Extraer el nombre del archivo de la ruta
      const pathParts = metadataPath.split(/[/\\]/);
      const fileNameWithExt = pathParts[pathParts.length - 1];
      targetFileName = fileNameWithExt.replace('.json', '');
    } else {
      return res.status(400).json({
        error: 'Se requiere callId, fileName o metadataPath',
      });
    }

    // Construir ruta del archivo de metadata
    const metadataFilePath = join(config.storage.callsPath, `${targetFileName}.json`);
    
    if (!existsSync(metadataFilePath)) {
      return res.status(404).json({
        error: `No se encontró el archivo de metadata: ${metadataFilePath}`,
      });
    }

    // Leer metadata
    const metadataContent = await readFile(metadataFilePath, 'utf-8');
    const metadata = JSON.parse(metadataContent);

    // Verificar que tenga summary
    if (!metadata.summary || metadata.summary.trim() === '') {
      return res.status(400).json({
        error: 'El metadata debe contener un campo "summary" para subir a Pinecone',
      });
    }

    await logInfo(`Subiendo embedding de llamada ${targetFileName} a Pinecone...`);

    // Importar función para subir solo embedding
    const { uploadEmbeddingOnly } = await import('../services/pineconeService.js');

    // Subir solo el embedding (sin buscar similares)
    const result = await uploadEmbeddingOnly(metadata);

    // Actualizar metadata con la información de Pinecone
    const updatedMetadata = {
      ...metadata,
      pineconeUploaded: result.uploaded,
      pineconeId: result.pineconeId || metadata.pineconeId || null,
      pineconeUploadDate: result.uploaded ? new Date().toISOString() : (metadata.pineconeUploadDate || null),
    };

    // Guardar metadata actualizado
    await writeFile(metadataFilePath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');
    await logInfo(`Metadata actualizado para ${targetFileName}`);

    // Preparar respuesta
    const response = {
      success: true,
      fileName: targetFileName,
      uploaded: result.uploaded,
      pineconeId: result.pineconeId || null,
      message: result.uploaded 
        ? 'Embedding subido exitosamente a Pinecone'
        : 'Error al subir embedding',
    };

    return res.json(response);
  } catch (error) {
    await logError(`Error en uploadCallToPinecone: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al subir llamada a Pinecone',
      message: error.message,
    });
  }
}

/**
 * Re-valida una llamada ya subida a Pinecone contra la base de datos
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function revalidateCallInPinecone(req, res) {
  try {
    const { callId, fileName, metadataPath } = req.body;

    // Determinar el nombre del archivo
    let targetFileName = null;
    
    if (fileName) {
      targetFileName = fileName;
    } else if (callId) {
      // Buscar el archivo por callId
      const callsPath = config.storage.callsPath;
      const files = await import('fs/promises').then(m => m.readdir(callsPath));
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      
      for (const file of jsonFiles) {
        try {
          const filePath = join(callsPath, file);
          const content = await readFile(filePath, 'utf-8');
          const metadata = JSON.parse(content);
          
          if (metadata.callId === callId) {
            targetFileName = metadata.fileName || file.replace('.json', '');
            break;
          }
        } catch (error) {
          // Continuar con el siguiente archivo
          continue;
        }
      }
      
      if (!targetFileName) {
        return res.status(404).json({
          error: 'No se encontró la llamada con el callId proporcionado',
        });
      }
    } else if (metadataPath) {
      // Extraer el nombre del archivo de la ruta
      const pathParts = metadataPath.split(/[/\\]/);
      const fileNameWithExt = pathParts[pathParts.length - 1];
      targetFileName = fileNameWithExt.replace('.json', '');
    } else {
      return res.status(400).json({
        error: 'Se requiere callId, fileName o metadataPath',
      });
    }

    // Construir ruta del archivo de metadata
    const metadataFilePath = join(config.storage.callsPath, `${targetFileName}.json`);
    
    if (!existsSync(metadataFilePath)) {
      return res.status(404).json({
        error: `No se encontró el archivo de metadata: ${metadataFilePath}`,
      });
    }

    // Leer metadata
    const metadataContent = await readFile(metadataFilePath, 'utf-8');
    const metadata = JSON.parse(metadataContent);

    // Verificar que esté subida a Pinecone
    if (!metadata.pineconeUploaded) {
      return res.status(400).json({
        error: 'Esta llamada no está subida a Pinecone. Use el endpoint de subida primero.',
      });
    }

    // Verificar que tenga summary
    if (!metadata.summary || metadata.summary.trim() === '') {
      return res.status(400).json({
        error: 'El metadata debe contener un campo "summary" para re-validar',
      });
    }

    await logInfo(`Re-validando llamada ${targetFileName} contra Pinecone...`);

    // Intentar leer embedding del archivo .emb si existe
    let embedding = null;
    const embeddingPath = join(config.storage.callsPath, `${targetFileName}.emb`);
    if (existsSync(embeddingPath)) {
      try {
        const embeddingContent = await readFile(embeddingPath, 'utf-8');
        embedding = JSON.parse(embeddingContent);
        await logInfo(`Embedding cargado desde archivo: ${embeddingPath}`);
      } catch (error) {
        await logWarn(`Error al leer embedding del archivo: ${error.message}. Generando nuevo embedding...`);
      }
    }

    // Importar funciones necesarias
    const { findSimilarCalls, updateRelatedCallsMetadata, generateEmbedding: generateEmbeddingFn } = await import('../services/pineconeService.js');

    // Importar buildEmbeddingText
    const { buildEmbeddingText } = await import('../services/pineconeService.js');
    
    // Si no se pudo leer el embedding, generarlo
    if (!embedding) {
      await logInfo(`Generando embedding para re-validación...`);
      const embeddingText = buildEmbeddingText(metadata);
      await logInfo(`Texto para embedding (primeros 300 caracteres): ${embeddingText.substring(0, 300)}...`);
      embedding = await generateEmbeddingFn(embeddingText);
    }
    await logInfo(`Buscando llamadas similares en Pinecone...`);
    const excludeCallId = metadata.callId || null;
    const similarCalls = await findSimilarCalls(embedding, 10, excludeCallId);

    // Usar umbrales configurables
    const duplicateThreshold = config.pinecone.duplicateThreshold;
    const relatedThreshold = config.pinecone.relatedThreshold;

    await logInfo(`Umbrales: Duplicado >= ${(duplicateThreshold * 100).toFixed(4)}%, Relacionada >= ${(relatedThreshold * 100).toFixed(4)}%`);

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
    // Cargar títulos desde los archivos JSON si no están en Pinecone
    await logInfo(`Preparando similarCallsInfo: Total similarCalls: ${similarCalls.length}, relatedCalls detectadas: ${relatedCalls.length}, duplicateOf detectadas: ${duplicateOf.length}`);
    const similarCallsInfo = [];
    for (const similar of similarCalls) {
      const scorePercent = (similar.score * 100).toFixed(4);
      await logInfo(`Procesando llamada similar: ${similar.fileName || similar.id}, score: ${scorePercent}%, umbral: ${(relatedThreshold * 100).toFixed(4)}%, pasa filtro: ${similar.score >= relatedThreshold}`);
      
      if (similar.score >= relatedThreshold) {
        let title = similar.title || null;
        const fileName = similar.fileName || similar.id;
        
        // Si no hay título, intentar cargarlo desde el archivo JSON
        if (!title && fileName) {
          try {
            const similarMetadataPath = join(config.storage.callsPath, `${fileName}.json`);
            if (existsSync(similarMetadataPath)) {
              const similarMetadataContent = await readFile(similarMetadataPath, 'utf-8');
              const similarMetadata = JSON.parse(similarMetadataContent);
              title = similarMetadata.title || null;
            }
          } catch (error) {
            // Si falla, continuar sin título
            await logWarn(`No se pudo cargar título para ${fileName}: ${error.message}`);
          }
        }
        
        // Cargar descripción desde el archivo JSON si no está en Pinecone
        let description = similar.summary || null;
        if (!description && fileName) {
          try {
            const similarMetadataPath = join(config.storage.callsPath, `${fileName}.json`);
            if (existsSync(similarMetadataPath)) {
              const similarMetadataContent = await readFile(similarMetadataPath, 'utf-8');
              const similarMetadata = JSON.parse(similarMetadataContent);
              description = similarMetadata.description || similarMetadata.summary || null;
            }
          } catch (error) {
            await logWarn(`No se pudo cargar descripción para ${fileName}: ${error.message}`);
          }
        }
        
        similarCallsInfo.push({
          fileName: fileName,
          callId: similar.callId || null,
          title: title,
          description: description,
          similarity: parseFloat((similar.score * 100).toFixed(4)), // Convertir a porcentaje (0-100) con 4 decimales
          score: similar.score, // Mantener score original para ordenamiento
        });
        await logInfo(`Agregada a similarCallsInfo: ${fileName} (${scorePercent}%)`);
      } else {
        await logInfo(`Filtrada (score < umbral): ${similar.fileName || similar.id} (${scorePercent}% < ${(relatedThreshold * 100).toFixed(4)}%)`);
      }
    }
    
    // Ordenar por score descendente
    similarCallsInfo.sort((a, b) => b.score - a.score);
    await logInfo(`similarCallsInfo final: ${similarCallsInfo.length} llamadas`);

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

    // Actualizar metadata con los nuevos resultados
    // La re-validación REEMPLAZA completamente los datos existentes con los nuevos resultados
    // Asegurar que duplicateOf y relatedCalls sean arrays
    const duplicateOfArray = duplicateOf.length > 0 ? [...duplicateOf] : [];
    const relatedCallsArray = relatedCalls.length > 0 ? [...relatedCalls] : [];
    
    await logInfo(`Re-validación: Reemplazando datos existentes. Nuevos duplicados: ${duplicateOfArray.length}, Nuevas relacionadas: ${relatedCallsArray.length}`);

    const updatedMetadata = {
      ...metadata,
      isDuplicate: duplicateOfArray.length > 0,
      duplicateOf: duplicateOfArray,
      relatedCalls: relatedCallsArray,
      pineconeRevalidatedDate: new Date().toISOString(),
    };

    // Guardar metadata actualizado
    await writeFile(metadataFilePath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');
    await logInfo(`Metadata actualizado para ${targetFileName} después de re-validación`);
    await logInfo(`Llamadas similares a mostrar en modal: ${similarCallsInfo.length}`);
    if (similarCallsInfo.length > 0) {
      const callsInfo = similarCallsInfo.map(c => `${c.fileName} (${c.similarity}%)`).join(', ');
      await logInfo(`Detalles: ${callsInfo}`);
    }

    // Preparar respuesta
    const response = {
      success: true,
      fileName: targetFileName,
      isDuplicate: duplicateOfArray.length > 0,
      duplicateOf: duplicateOfArray,
      relatedCalls: relatedCallsArray,
      similarCalls: similarCallsInfo,
      currentCallDescription: metadata.description || metadata.summary || null,
      message: duplicateOfArray.length > 0
        ? `Re-validación completada. Se encontraron ${duplicateOfArray.length} duplicado(s) y ${relatedCallsArray.length} llamada(s) relacionada(s).`
        : relatedCallsArray.length > 0
          ? `Re-validación completada. Se encontraron ${relatedCallsArray.length} llamada(s) relacionada(s).`
          : 'Re-validación completada. No se encontraron llamadas duplicadas ni relacionadas.',
    };

    return res.json(response);
  } catch (error) {
    await logError(`Error en revalidateCallInPinecone: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al re-validar llamada en Pinecone',
      message: error.message,
    });
  }
}

/**
 * Re-sube el embedding de una llamada a Pinecone (actualiza el existente)
 * Siempre genera el embedding desde cero y busca llamadas similares
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function resubmitEmbeddingToPinecone(req, res) {
  try {
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({
        error: 'Se requiere el parámetro "fileName"',
      });
    }

    // Construir ruta del archivo de metadata
    const metadataFilePath = join(config.storage.callsPath, `${fileName}.json`);
    
    if (!existsSync(metadataFilePath)) {
      return res.status(404).json({
        error: `No se encontró el archivo de metadata: ${metadataFilePath}`,
      });
    }

    // Leer metadata
    const metadataContent = await readFile(metadataFilePath, 'utf-8');
    const metadata = JSON.parse(metadataContent);

    // Verificar que esté subida a Pinecone
    if (!metadata.pineconeUploaded) {
      return res.status(400).json({
        error: 'Esta llamada no está subida a Pinecone. Use el endpoint de subida primero.',
      });
    }

    // Verificar que tenga summary
    if (!metadata.summary || metadata.summary.trim() === '') {
      return res.status(400).json({
        error: 'El metadata debe contener un campo "summary" para generar el embedding',
      });
    }

    await logInfo(`Re-subiendo embedding de llamada ${fileName} a Pinecone (generando desde cero)...`);

    // Importar función para re-subir solo embedding
    const { uploadEmbeddingOnly } = await import('../services/pineconeService.js');

    // Re-subir solo el embedding (sin buscar similares)
    const result = await uploadEmbeddingOnly(metadata);

    // Actualizar metadata
    const updatedMetadata = {
      ...metadata,
      pineconeId: result.pineconeId || metadata.pineconeId || null,
      pineconeResubmittedDate: new Date().toISOString(),
    };

    // Guardar metadata actualizado
    await writeFile(metadataFilePath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');
    await logInfo(`Metadata actualizado para ${fileName} después de re-subir embedding`);

    // Preparar respuesta
    const response = {
      success: true,
      fileName: fileName,
      pineconeId: result.pineconeId || null,
      message: result.uploaded 
        ? 'Embedding re-subido exitosamente a Pinecone'
        : 'Error al re-subir embedding',
    };

    return res.json(response);
  } catch (error) {
    await logError(`Error en resubmitEmbeddingToPinecone: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al re-subir embedding a Pinecone',
      message: error.message,
    });
  }
}

/**
 * Busca llamadas usando búsqueda semántica
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function searchCalls(req, res) {
  try {
    const { query, topK = 10, minScore = 0.0 } = req.body;

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({
        error: 'Se requiere un parámetro "query" (pregunta o texto de búsqueda)',
      });
    }

    const searchQuery = query.trim();
    await logInfo(`Buscando llamadas con query: "${searchQuery}"`);

    // Generar embedding de la pregunta
    await logInfo(`Generando embedding para la búsqueda...`);
    const queryEmbedding = await generateEmbedding(searchQuery);

    // Buscar llamadas similares
    await logInfo(`Buscando llamadas similares en Pinecone...`);
    const similarCalls = await findSimilarCalls(queryEmbedding, Math.max(1, Math.min(topK, 100)));

    // Filtrar por score mínimo y preparar respuesta
    const filteredCalls = similarCalls
      .filter(call => call.score >= minScore)
      .map(call => ({
        fileName: call.fileName,
        callId: call.callId,
        title: call.title,
        summary: call.summary,
        date: call.date,
        name: call.name,
        age: call.age,
        youtubeVideoId: call.youtubeVideoId,
        similarity: parseFloat((call.score * 100).toFixed(4)), // Porcentaje de similitud con 4 decimales
        score: call.score, // Score original (0-1)
      }))
      .sort((a, b) => b.score - a.score); // Ordenar por similitud descendente

    await logInfo(`Encontradas ${filteredCalls.length} llamadas similares`);

    return res.json({
      success: true,
      query: searchQuery,
      results: filteredCalls,
      total: filteredCalls.length,
      topK: topK,
      minScore: minScore,
    });
  } catch (error) {
    await logError(`Error en searchCalls: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al buscar llamadas',
      message: error.message,
    });
  }
}

/**
 * Guarda las relaciones de similitud entre llamadas en un archivo JSON
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function saveSimilarities(req, res) {
  try {
    const { similarities } = req.body;

    if (!similarities || !Array.isArray(similarities)) {
      return res.status(400).json({
        error: 'El campo similarities es requerido y debe ser un array',
      });
    }

    // Construir la ruta del archivo en STORAGE_PATH
    const similaritiesFilePath = join(config.storage.basePath, 'similarities.json');

    // Leer archivo existente si existe
    let existingData = {
      lastUpdated: null,
      totalRelations: 0,
      similarities: []
    };

    if (existsSync(similaritiesFilePath)) {
      try {
        const existingContent = await readFile(similaritiesFilePath, 'utf-8');
        existingData = JSON.parse(existingContent);
      } catch (error) {
        await logWarn(`Error al leer archivo de similitudes existente, creando uno nuevo: ${error.message}`);
      }
    }

    // Agregar nuevas similitudes (evitar duplicados)
    const existingMap = new Map();
    existingData.similarities.forEach(sim => {
      const key = `${sim.source}::${sim.target}`;
      existingMap.set(key, sim);
    });

    // Agregar o actualizar similitudes
    similarities.forEach(sim => {
      const key = `${sim.source}::${sim.target}`;
      const reverseKey = `${sim.target}::${sim.source}`;
      
      // Si ya existe (en cualquier dirección), actualizar si la nueva similitud es mayor
      if (existingMap.has(key)) {
        const existing = existingMap.get(key);
        if (sim.similarity > existing.similarity) {
          existingMap.set(key, sim);
        }
      } else if (existingMap.has(reverseKey)) {
        const existing = existingMap.get(reverseKey);
        if (sim.similarity > existing.similarity) {
          existingMap.delete(reverseKey);
          existingMap.set(key, sim);
        }
      } else {
        existingMap.set(key, sim);
      }
    });

    // Convertir map a array
    const updatedSimilarities = Array.from(existingMap.values());

    // Ordenar por similitud (de mayor a menor)
    updatedSimilarities.sort((a, b) => b.similarity - a.similarity);

    // Crear objeto final
    const finalData = {
      lastUpdated: new Date().toISOString(),
      totalRelations: updatedSimilarities.length,
      similarities: updatedSimilarities
    };

    // Guardar archivo
    await writeFile(similaritiesFilePath, JSON.stringify(finalData, null, 2), 'utf-8');
    await logInfo(`Similitudes guardadas: ${updatedSimilarities.length} relaciones en ${similaritiesFilePath}`);

    return res.json({
      success: true,
      message: `Se guardaron ${updatedSimilarities.length} relaciones de similitud`,
      totalRelations: updatedSimilarities.length,
      newRelations: similarities.length,
      filePath: similaritiesFilePath,
    });
  } catch (error) {
    await logError(`Error en saveSimilarities: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al guardar similitudes',
      message: error.message,
    });
  }
}

/**
 * Obtiene las similitudes guardadas desde el archivo
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function getSimilarities(req, res) {
  try {
    const similaritiesFilePath = join(config.storage.basePath, 'similarities.json');

    if (!existsSync(similaritiesFilePath)) {
      return res.json({
        success: true,
        similarities: [],
        totalRelations: 0,
        lastUpdated: null,
        message: 'No hay similitudes guardadas',
      });
    }

    const content = await readFile(similaritiesFilePath, 'utf-8');
    const data = JSON.parse(content);

    return res.json({
      success: true,
      similarities: data.similarities || [],
      totalRelations: data.totalRelations || 0,
      lastUpdated: data.lastUpdated || null,
    });
  } catch (error) {
    await logError(`Error en getSimilarities: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al leer similitudes',
      message: error.message,
    });
  }
}

/**
 * Elimina similitudes relacionadas con un fileName del archivo
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function removeSimilaritiesByFileName(req, res) {
  try {
    const { fileName } = req.body;

    if (!fileName || fileName.trim() === '') {
      return res.status(400).json({
        error: 'El campo fileName es requerido',
      });
    }

    const similaritiesFilePath = join(config.storage.basePath, 'similarities.json');

    if (!existsSync(similaritiesFilePath)) {
      return res.json({
        success: true,
        removed: 0,
        message: 'No hay similitudes guardadas',
      });
    }

    const content = await readFile(similaritiesFilePath, 'utf-8');
    const data = JSON.parse(content);

    // Filtrar similitudes que no contengan el fileName
    const originalCount = (data.similarities || []).length;
    data.similarities = (data.similarities || []).filter(
      sim => sim.source !== fileName && sim.target !== fileName
    );
    const removedCount = originalCount - data.similarities.length;

    // Actualizar totalRelations y lastUpdated
    data.totalRelations = data.similarities.length;
    data.lastUpdated = new Date().toISOString();

    // Guardar archivo actualizado
    await writeFile(similaritiesFilePath, JSON.stringify(data, null, 2), 'utf-8');
    await logInfo(`Similitudes eliminadas para ${fileName}: ${removedCount} relaciones removidas`);

    return res.json({
      success: true,
      removed: removedCount,
      totalRelations: data.totalRelations,
      message: `Se eliminaron ${removedCount} relación(es) de similitud`,
    });
  } catch (error) {
    await logError(`Error en removeSimilaritiesByFileName: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al eliminar similitudes',
      message: error.message,
    });
  }
}

/**
 * Elimina un registro de Pinecone por fileName
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function deleteFromPineconeByFileNameEndpoint(req, res) {
  try {
    const { fileName } = req.body;

    if (!fileName || fileName.trim() === '') {
      return res.status(400).json({
        error: 'El campo fileName es requerido',
      });
    }

    const deleted = await deleteFromPineconeByFileName(fileName);

    if (deleted) {
      return res.json({
        success: true,
        message: `Registro eliminado de Pinecone para ${fileName}`,
        fileName: fileName,
      });
    } else {
      return res.status(404).json({
        error: 'No se encontró el registro en Pinecone',
        fileName: fileName,
      });
    }
  } catch (error) {
    await logError(`Error en deleteFromPineconeByFileNameEndpoint: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al eliminar de Pinecone',
      message: error.message,
    });
  }
}
