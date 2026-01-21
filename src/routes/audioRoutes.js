import express from 'express';
import multer from 'multer';
import { checkProcessedAudio, processAudio, uploadAudioFile, uploadTranscriptionFile } from '../controllers/videoController.js';

const router = express.Router();

// Configurar multer para manejar archivos de audio
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB máximo para archivos de audio
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo archivos de audio
    if (file.mimetype.startsWith('audio/') || file.originalname.toLowerCase().endsWith('.mp3')) {
      cb(null, true);
    } else {
      req.fileValidationError = 'Solo se permiten archivos de audio (MP3)';
      cb(null, false);
    }
  },
});

// Configurar multer para manejar archivos de transcripción (.srt o .txt)
const uploadTranscription = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo para archivos de transcripción
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo archivos .srt, .txt o texto plano
    const fileName = file.originalname.toLowerCase();
    if (fileName.endsWith('.srt') || fileName.endsWith('.txt') || file.mimetype === 'text/plain' || file.mimetype === 'application/x-subrip') {
      cb(null, true);
    } else {
      req.fileValidationError = 'Solo se permiten archivos de transcripción (.srt o .txt)';
      cb(null, false);
    }
  },
});

/**
 * @swagger
 * /api/audio/check-processed:
 *   post:
 *     summary: Verifica si un audio ya fue procesado
 *     tags: [Audio]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - audioId
 *             properties:
 *               audioId:
 *                 type: string
 *                 description: ID del audio
 *                 example: "abc123def45"
 *           example:
 *             audioId: "abc123def45"
 *     responses:
 *       200:
 *         description: Verificación completada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 audioId:
 *                   type: string
 *                 isProcessed:
 *                   type: boolean
 *                 callsCount:
 *                   type: number
 *                 calls:
 *                   type: array
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/check-processed', checkProcessedAudio);

/**
 * @swagger
 * /api/audio/upload:
 *   post:
 *     summary: Sube un archivo de audio desde el PC
 *     tags: [Audio]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - audio
 *             properties:
 *               audio:
 *                 type: string
 *                 format: binary
 *                 description: Archivo de audio MP3
 *     responses:
 *       200:
 *         description: Archivo de audio subido exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/upload', uploadAudio.single('audio'), uploadAudioFile);

/**
 * @swagger
 * /api/audio/upload-transcription:
 *   post:
 *     summary: Sube un archivo de transcripción (.srt) para un audio
 *     tags: [Audio]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - transcription
 *               - audioId
 *             properties:
 *               transcription:
 *                 type: string
 *                 format: binary
 *                 description: Archivo de transcripción en formato SRT
 *               audioId:
 *                 type: string
 *                 description: ID del audio al que pertenece la transcripción
 *     responses:
 *       200:
 *         description: Archivo de transcripción subido exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/upload-transcription', uploadTranscription.single('transcription'), uploadTranscriptionFile);

/**
 * @swagger
 * /api/audio/process:
 *   post:
 *     summary: "Procesa un audio MP3: separa llamadas, recorta audios y limpia temporales"
 *     tags: [Audio]
 *     description: |
 *       Este endpoint recibe un archivo de audio MP3 y su transcripción SRT, separa las llamadas,
 *       recorta los audios individuales y genera los archivos finales. Los archivos temporales se eliminan al finalizar.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - audioPath
 *               - transcriptionPath
 *               - videoId
 *             properties:
 *               audioPath:
 *                 type: string
 *                 description: Ruta al archivo de audio MP3
 *                 example: "storage/temp/abc123def45.mp3"
 *               transcriptionPath:
 *                 type: string
 *                 description: Ruta al archivo de transcripción SRT
 *                 example: "storage/temp/abc123def45.srt"
 *               videoId:
 *                 type: string
 *                 description: ID del audio
 *                 example: "abc123def45"
 *               youtubeUrl:
 *                 type: string
 *                 nullable: true
 *                 description: URL de YouTube (opcional, puede ser null para audios locales)
 *                 example: null
 *               uploadDate:
 *                 type: string
 *                 description: Fecha de subida del audio (formato ISO o YYYY-MM-DD)
 *                 example: "2024-01-15"
 *               thumbnailUrl:
 *                 type: string
 *                 nullable: true
 *                 description: URL de la miniatura (opcional)
 *                 example: null
 *               saveProcessingPrompt:
 *                 type: boolean
 *                 description: Si es true, guarda el prompt de procesamiento de datos como archivo .txt
 *                 default: false
 *                 example: false
 *               saveImagePrompt:
 *                 type: boolean
 *                 description: Si es true, guarda el prompt de generación de imagen como archivo .txt
 *                 default: false
 *                 example: false
 *               thumbnail:
 *                 type: object
 *                 nullable: true
 *                 description: "Configuración para generar miniatura. Si es null, NO se generará miniatura."
 *                 properties:
 *                   model:
 *                     type: string
 *                     enum: ['gpt-image-1.5']
 *                     default: 'gpt-image-1.5'
 *                   size:
 *                     type: string
 *                     enum: ['1536x1024']
 *                     default: '1536x1024'
 *                   quality:
 *                     type: string
 *                     enum: ['medium']
 *                     default: 'medium'
 *                   saveImagePrompt:
 *                     type: boolean
 *                     default: false
 *               downloadOriginalThumbnail:
 *                 type: boolean
 *                 description: Si es true, descarga la miniatura original
 *                 default: false
 *                 example: false
 *           example:
 *             audioPath: "storage/temp/abc123def45.mp3"
 *             transcriptionPath: "storage/temp/abc123def45.srt"
 *             videoId: "abc123def45"
 *             youtubeUrl: null
 *             uploadDate: "2024-01-15"
 *             thumbnailUrl: null
 *             saveProcessingPrompt: false
 *             saveImagePrompt: false
 *             thumbnail:
 *               model: "gpt-image-1.5"
 *               size: "1536x1024"
 *               quality: "medium"
 *               saveImagePrompt: false
 *             downloadOriginalThumbnail: false
 *     responses:
 *       200:
 *         description: Audio procesado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoId:
 *                   type: string
 *                 processed:
 *                   type: boolean
 *                 calls:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Error en la solicitud (archivos faltantes o inválidos)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process', processAudio);

export default router;
