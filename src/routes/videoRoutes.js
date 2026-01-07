import express from 'express';
import { processVideo, processPlaylist } from '../controllers/videoController.js';

const router = express.Router();

/**
 * @swagger
 * /api/video/process:
 *   post:
 *     summary: Procesa uno o más videos de YouTube y extrae las llamadas
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - youtubeUrls
 *             properties:
 *               youtubeUrls:
 *                 type: array
 *                 description: Array de URLs de videos de YouTube. Para un solo video, usar array con un elemento.
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
 *             example:
 *               youtubeUrls:
 *                 - "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *                 - "https://www.youtube.com/watch?v=WJpZsGmE-kU"
 *     responses:
 *       200:
 *         description: Video(s) procesado(s) exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalVideos:
 *                   type: number
 *                   description: Total de videos procesados
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
 *                   description: Array con los resultados de cada video procesado
 *                   items:
 *                     type: object
 *                     properties:
 *                       youtubeUrl:
 *                         type: string
 *                         description: URL del video procesado
 *                       videoId:
 *                         type: string
 *                         description: ID del video de YouTube
 *                       processed:
 *                         type: boolean
 *                         description: Indica si el video fue procesado ahora o ya existía
 *                       message:
 *                         type: string
 *                         description: Mensaje informativo (solo si processed es false)
 *                       calls:
 *                         type: array
 *                         description: Array de llamadas extraídas del video
 *                         items:
 *                           $ref: '#/components/schemas/Call'
 *                       error:
 *                         type: string
 *                         description: Mensaje de error si el procesamiento falló
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
 *     summary: Procesa una o más playlists de YouTube y extrae las llamadas de cada video
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - playlistUrls
 *             properties:
 *               playlistUrls:
 *                 type: array
 *                 description: Array de URLs de playlists de YouTube. Para una sola playlist, usar array con un elemento.
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["https://www.youtube.com/playlist?list=PLxxxxxx"]
 *             example:
 *               playlistUrls:
 *                 - "https://www.youtube.com/playlist?list=PLxxxxxx"
 *                 - "https://www.youtube.com/@nofingway1/videos"
 *     responses:
 *       200:
 *         description: Playlist(s) procesada(s) exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: Respuesta para una sola playlist
 *                   properties:
 *                     playlistUrl:
 *                       type: string
 *                       description: URL de la playlist procesada
 *                     totalVideos:
 *                       type: number
 *                       description: Total de videos en la playlist
 *                     processed:
 *                       type: number
 *                       description: Número de videos procesados exitosamente
 *                     skipped:
 *                       type: number
 *                       description: Número de videos omitidos (ya procesados)
 *                     errors:
 *                       type: number
 *                       description: Número de videos con error
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           videoId:
 *                             type: string
 *                           videoTitle:
 *                             type: string
 *                           processed:
 *                             type: boolean
 *                           calls:
 *                             type: array
 *                             items:
 *                               $ref: '#/components/schemas/Call'
 *                 - type: object
 *                   description: Respuesta para múltiples playlists
 *                   properties:
 *                     totalPlaylists:
 *                       type: number
 *                       description: Total de playlists procesadas
 *                     totalVideos:
 *                       type: number
 *                       description: Total de videos en todas las playlists
 *                     processed:
 *                       type: number
 *                       description: Número total de videos procesados exitosamente
 *                     skipped:
 *                       type: number
 *                       description: Número total de videos omitidos (ya procesados)
 *                     errors:
 *                       type: number
 *                       description: Número total de videos con error
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           playlistUrl:
 *                             type: string
 *                           totalVideos:
 *                             type: number
 *                           processed:
 *                             type: number
 *                           skipped:
 *                             type: number
 *                           errors:
 *                             type: number
 *                           results:
 *                             type: array
 *       400:
 *         description: Error en la solicitud (URL inválida o faltante)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process-playlist', processPlaylist);

export default router;
