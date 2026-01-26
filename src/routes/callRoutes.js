import express from 'express';
import { uploadCallToPinecone, searchCalls, revalidateCallInPinecone, resubmitEmbeddingToPinecone, saveSimilarities, deleteFromPineconeByFileNameEndpoint, getSimilarities, removeSimilaritiesByFileName, removeSpecificSimilarity } from '../controllers/callController.js';

const router = express.Router();

/**
 * @swagger
 * /api/calls/upload-to-pinecone:
 *   post:
 *     summary: Sube una llamada a Pinecone para búsqueda vectorial
 *     tags: [Calls]
 *     description: |
 *       Sube el resumen de una llamada a Pinecone, genera embeddings, detecta duplicados y llamadas relacionadas,
 *       y actualiza el metadata JSON con la información de Pinecone.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo de la llamada (sin extensión .json)
 *                 example: "abc123 - 1 - Título de la llamada"
 *               callId:
 *                 type: string
 *                 description: ID único de la llamada (alternativa a fileName)
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *               metadataPath:
 *                 type: string
 *                 description: Ruta completa al archivo de metadata (alternativa a fileName)
 *                 example: "/path/to/storage/calls/abc123 - 1 - Título.json"
 *     responses:
 *       200:
 *         description: Llamada procesada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 fileName:
 *                   type: string
 *                   example: "abc123 - 1 - Título de la llamada"
 *                 uploaded:
 *                   type: boolean
 *                   description: Indica si la llamada fue subida a Pinecone
 *                   example: true
 *                 alreadyExists:
 *                   type: boolean
 *                   description: Indica si la llamada ya existía en Pinecone
 *                   example: false
 *                 isDuplicate:
 *                   type: boolean
 *                   description: Indica si la llamada es un duplicado
 *                   example: false
 *                 duplicateOf:
 *                   type: string
 *                   nullable: true
 *                   description: Nombre del archivo de la llamada original si es duplicado
 *                   example: null
 *                 relatedCalls:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array de nombres de archivos de llamadas relacionadas
 *                   example: []
 *                 pineconeId:
 *                   type: string
 *                   nullable: true
 *                   description: ID de la llamada en Pinecone
 *                   example: "550e8400-e29b-41d4-a716-446655440000"
 *                 message:
 *                   type: string
 *                   example: "Llamada subida exitosamente a Pinecone"
 *       400:
 *         description: Error en la solicitud (falta fileName, callId o metadataPath, o falta summary en metadata)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Se requiere callId, fileName o metadataPath"
 *       404:
 *         description: No se encontró la llamada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "No se encontró el archivo de metadata: /path/to/file.json"
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error al subir llamada a Pinecone"
 *                 message:
 *                   type: string
 *                   example: "Error detallado del servidor"
 */
router.post('/upload-to-pinecone', uploadCallToPinecone);

/**
 * @swagger
 * /api/calls/search:
 *   post:
 *     summary: Busca llamadas usando búsqueda semántica
 *     tags: [Calls]
 *     description: |
 *       Busca llamadas en Pinecone usando búsqueda semántica. Genera un embedding de la pregunta
 *       y encuentra las llamadas más similares basándose en el significado semántico.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: Pregunta o texto de búsqueda
 *                 example: llamadas sobre abuso sexual
 *               topK:
 *                 type: integer
 *                 description: Número máximo de resultados a retornar
 *                 example: 10
 *                 minimum: 1
 *                 maximum: 100
 *               minScore:
 *                 type: number
 *                 description: Score mínimo de similitud
 *                 example: 0.5
 *                 minimum: 0.0
 *                 maximum: 1.0
 *     responses:
 *       200:
 *         description: Búsqueda exitosa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 query:
 *                   type: string
 *                   example: llamadas sobre abuso sexual
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fileName:
 *                         type: string
 *                         example: abc123 - 1 - Denuncia por abuso
 *                       callId:
 *                         type: string
 *                         example: 550e8400-e29b-41d4-a716-446655440000
 *                       title:
 *                         type: string
 *                         example: Denuncia por abuso sexual
 *                       summary:
 *                         type: string
 *                         example: Llamada sobre denuncia de abuso sexual
 *                       date:
 *                         type: string
 *                         example: 2024-01-15
 *                       name:
 *                         type: string
 *                         example: María
 *                       age:
 *                         type: integer
 *                         example: 35
 *                       youtubeVideoId:
 *                         type: string
 *                         example: dQw4w9WgXcQ
 *                       similarity:
 *                         type: integer
 *                         description: Porcentaje de similitud (0-100)
 *                         example: 87
 *                       score:
 *                         type: number
 *                         description: Score de similitud (0.0-1.0)
 *                         example: 0.87
 *                 total:
 *                   type: integer
 *                   description: Número total de resultados encontrados
 *                   example: 5
 *                 topK:
 *                   type: integer
 *                   example: 10
 *                 minScore:
 *                   type: number
 *                   example: 0.0
 *       400:
 *         description: Error en la solicitud (falta query o query vacío)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Se requiere un parámetro query (pregunta o texto de búsqueda)
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Error al buscar llamadas
 *                 message:
 *                   type: string
 *                   example: Error detallado del servidor
 */
router.post('/search', searchCalls);

/**
 * @swagger
 * /api/calls/revalidate:
 *   post:
 *     summary: Re-valida una llamada ya subida a Pinecone
 *     tags: [Calls]
 *     description: |
 *       Re-ejecuta la búsqueda de llamadas similares para una llamada ya subida a Pinecone,
 *       actualizando los metadatos con nuevos duplicados y llamadas relacionadas encontradas.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo de la llamada (sin extensión .json)
 *                 example: "abc123 - 1 - Título de la llamada"
 *               callId:
 *                 type: string
 *                 description: ID único de la llamada (alternativa a fileName)
 *                 example: "550e8400-e29b-41d4-a716-446655440000"
 *               metadataPath:
 *                 type: string
 *                 description: Ruta completa al archivo de metadata (alternativa a fileName)
 *                 example: "/path/to/storage/calls/abc123 - 1 - Título.json"
 *     responses:
 *       200:
 *         description: Re-validación completada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 fileName:
 *                   type: string
 *                   example: "abc123 - 1 - Título de la llamada"
 *                 isDuplicate:
 *                   type: boolean
 *                   description: Indica si la llamada es un duplicado
 *                   example: false
 *                 duplicateOf:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array de nombres de archivos de llamadas duplicadas
 *                   example: []
 *                 relatedCalls:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Array de nombres de archivos de llamadas relacionadas
 *                   example: ["abc456 - 1 - Otra llamada"]
 *                 similarCalls:
 *                   type: array
 *                   description: Lista de llamadas similares con porcentajes de similitud
 *                   example: []
 *                 message:
 *                   type: string
 *                   example: "Re-validación completada. Se encontraron 2 llamada(s) relacionada(s)."
 *       400:
 *         description: Error en la solicitud
 *       404:
 *         description: No se encontró la llamada
 *       500:
 *         description: Error interno del servidor
 */
router.post('/revalidate', revalidateCallInPinecone);

/**
 * @swagger
 * /api/calls/resubmit-embedding:
 *   post:
 *     summary: Re-sube el embedding de una llamada a Pinecone
 *     tags: [Calls]
 *     description: |
 *       Genera un nuevo embedding con el formato actualizado (incluyendo nombre, edad, descripción y resumen)
 *       y actualiza el embedding existente en Pinecone, pisando el anterior.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo de la llamada (sin extensión .json)
 *                 example: "abc123 - 1 - Título de la llamada"
 *     responses:
 *       200:
 *         description: Embedding re-subido exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 fileName:
 *                   type: string
 *                   example: "abc123 - 1 - Título de la llamada"
 *                 pineconeId:
 *                   type: string
 *                   example: "550e8400-e29b-41d4-a716-446655440000"
 *                 message:
 *                   type: string
 *                   example: "Embedding re-subido exitosamente a Pinecone"
 *       400:
 *         description: Error en la solicitud
 *       404:
 *         description: No se encontró la llamada
 *       500:
 *         description: Error interno del servidor
 */
router.post('/resubmit-embedding', resubmitEmbeddingToPinecone);

/**
 * @swagger
 * /api/calls/save-similarities:
 *   post:
 *     summary: Guarda las relaciones de similitud entre llamadas
 *     tags: [Calls]
 *     description: Guarda las relaciones de similitud encontradas entre llamadas en un archivo JSON
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - similarities
 *             properties:
 *               similarities:
 *                 type: array
 *                 description: Array de relaciones de similitud
 *                 items:
 *                   type: object
 *                   properties:
 *                     source:
 *                       type: string
 *                     sourceTitle:
 *                       type: string
 *                     target:
 *                       type: string
 *                     targetTitle:
 *                       type: string
 *                     similarity:
 *                       type: number
 *                     type:
 *                       type: string
 *     responses:
 *       200:
 *         description: Similitudes guardadas exitosamente
 *       500:
 *         description: Error interno del servidor
 */
router.post('/save-similarities', saveSimilarities);

/**
 * @swagger
 * /api/calls/delete-from-pinecone:
 *   post:
 *     summary: Elimina un registro de Pinecone por fileName
 *     tags: [Calls]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo (sin extensión)
 *     responses:
 *       200:
 *         description: Registro eliminado exitosamente
 *       404:
 *         description: No se encontró el registro en Pinecone
 *       500:
 *         description: Error interno del servidor
 */
router.post('/delete-from-pinecone', deleteFromPineconeByFileNameEndpoint);

/**
 * @swagger
 * /api/calls/get-similarities:
 *   get:
 *     summary: Obtiene las similitudes guardadas desde el archivo
 *     tags: [Calls]
 *     responses:
 *       200:
 *         description: Similitudes obtenidas exitosamente
 *       500:
 *         description: Error interno del servidor
 */
router.get('/get-similarities', getSimilarities);

/**
 * @swagger
 * /api/calls/remove-similarities:
 *   post:
 *     summary: Elimina similitudes relacionadas con un fileName
 *     tags: [Calls]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo
 *     responses:
 *       200:
 *         description: Similitudes eliminadas exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/remove-similarities', removeSimilaritiesByFileName);
router.post('/remove-specific-similarity', removeSpecificSimilarity);

export default router;
