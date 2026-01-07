import express from 'express';
import { processVideo, processPlaylist } from '../controllers/videoController.js';

const router = express.Router();

/**
 * @swagger
 * /api/video/process:
 *   post:
 *     summary: Procesa un video de YouTube y extrae las llamadas
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - youtubeUrl
 *             properties:
 *               youtubeUrl:
 *                 type: string
 *                 description: URL del video de YouTube
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Video procesado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 videoId:
 *                   type: string
 *                   description: ID del video de YouTube
 *                 processed:
 *                   type: boolean
 *                   description: Indica si el video fue procesado ahora o ya existía
 *                 message:
 *                   type: string
 *                   description: Mensaje informativo (solo si processed es false)
 *                 calls:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Call'
 *       400:
 *         description: Error en la solicitud (URL inválida o faltante)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process', processVideo);

/**
 * @swagger
 * /api/video/process-playlist:
 *   post:
 *     summary: Procesa una playlist de YouTube y extrae las llamadas de cada video
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - playlistUrl
 *             properties:
 *               playlistUrl:
 *                 type: string
 *                 description: URL de la playlist de YouTube
 *                 example: "https://www.youtube.com/playlist?list=PLxxxxxx"
 *     responses:
 *       200:
 *         description: Playlist procesada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 playlistUrl:
 *                   type: string
 *                   description: URL de la playlist procesada
 *                 totalVideos:
 *                   type: number
 *                   description: Total de videos en la playlist
 *                 processed:
 *                   type: number
 *                   description: Número de videos procesados exitosamente
 *                 skipped:
 *                   type: number
 *                   description: Número de videos omitidos (ya procesados)
 *                 errors:
 *                   type: number
 *                   description: Número de videos con error
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       videoId:
 *                         type: string
 *                       videoTitle:
 *                         type: string
 *                       processed:
 *                         type: boolean
 *                       calls:
 *                         type: array
 *                         items:
 *                           $ref: '#/components/schemas/Call'
 *       400:
 *         description: Error en la solicitud (URL inválida o faltante)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process-playlist', processPlaylist);

export default router;
