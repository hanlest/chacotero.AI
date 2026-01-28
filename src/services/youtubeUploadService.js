import { google } from 'googleapis';
import { readFileSync, existsSync, createReadStream, statSync } from 'fs';
import { Readable, Transform } from 'stream';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config/config.js';

// Almacenar progreso de subidas en memoria
const uploadProgress = new Map();
// Almacenar conexiones SSE activas
const uploadSSEConnections = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Carga sharp dinámicamente cuando se necesita
 * @returns {Promise<object>} Instancia de sharp
 */
async function loadSharp() {
  try {
    //console.log('[loadSharp] Intentando cargar sharp...');
    
    // Intentar cargar sharp
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;
    
    //console.log('[loadSharp] ✅ Sharp cargado exitosamente');
    
    // Verificar que sharp funciona haciendo una prueba simple
    try {
      await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 0, g: 0, b: 0 }
        }
      }).toBuffer();
      //console.log('[loadSharp] ✅ Verificación de sharp exitosa');
    } catch (testError) {
      console.warn('[loadSharp] ⚠️  Advertencia: sharp cargado pero falló la verificación:', testError.message);
      // Continuar de todas formas, puede ser un problema menor
    }
    
    return sharp;
  } catch (error) {
    console.error('❌ Error al cargar sharp:', error.message);
    console.error('   Stack:', error.stack);
    console.error('   Código de error:', error.code);
    console.error('   Tipo:', error.constructor.name);
    
    // Información adicional para diagnóstico
    const { platform, arch, versions } = process;
    console.error('   Información del sistema:');
    console.error(`     - Plataforma: ${platform}`);
    console.error(`     - Arquitectura: ${arch}`);
    console.error(`     - Node.js: ${versions.node}`);
    
    // Mensaje más descriptivo según el tipo de error
    if (error.message.includes('ERR_DLOPEN_FAILED') || error.message.includes('Could not load')) {
      const errorMsg = `Error al cargar el módulo nativo de sharp.\n\n` +
        `Posibles soluciones:\n` +
        `1. Reinicia el servidor Node.js (detén y vuelve a iniciar con npm run dev)\n` +
        `2. Reinstala sharp: npm uninstall sharp && npm install --include=optional sharp && npm rebuild sharp\n` +
        `3. Si el problema persiste, verifica que no haya procesos bloqueando el archivo .node\n\n` +
        `Error original: ${error.message}`;
      throw new Error(errorMsg);
    }
    
    throw new Error(`Error al cargar sharp: ${error.message}`);
  }
}

/**
 * Obtiene un cliente autenticado de YouTube Data API v3
 * @returns {Promise<object>} Cliente autenticado de YouTube
 */
export async function getAuthenticatedClient() {
  if (!config.youtube.credentialsPath || !existsSync(config.youtube.credentialsPath)) {
    throw new Error('No se encontró el archivo de credenciales de YouTube. Configura YOUTUBE_CREDENTIALS_PATH en .env');
  }

  const credentials = JSON.parse(readFileSync(config.youtube.credentialsPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web || {};
  
  if (!client_id || !client_secret) {
    throw new Error('El archivo de credenciales no contiene client_id o client_secret');
  }

  // Usar el redirect_uri del archivo de credenciales
  // IMPORTANTE: Este URI DEBE coincidir exactamente con el configurado en Google Cloud Console
  // Para aplicaciones web: debe ser 'http://localhost:PORT/api/video/youtube/callback'
  const defaultRedirectUri = `http://localhost:${config.server.port}/api/video/youtube/callback`;
  const redirectUri = redirect_uris && redirect_uris.length > 0 
    ? redirect_uris[0] 
    : defaultRedirectUri;
  
  console.log(`[DEBUG] Usando redirect_uri: ${redirectUri}`);
  console.log(`[DEBUG] redirect_uris disponibles: ${JSON.stringify(redirect_uris)}`);
  
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri
  );

  // Cargar token si existe
  if (existsSync(config.youtube.tokenPath)) {
    try {
      const token = JSON.parse(readFileSync(config.youtube.tokenPath, 'utf8'));
      oAuth2Client.setCredentials(token);
      
      // Verificar si el token está expirado
      if (token.expiry_date && Date.now() >= token.expiry_date) {
        // Intentar refrescar el token
        try {
          const { credentials: newCredentials } = await oAuth2Client.refreshAccessToken();
          oAuth2Client.setCredentials(newCredentials);
          // Guardar el token actualizado
          const { writeFileSync } = await import('fs');
          writeFileSync(config.youtube.tokenPath, JSON.stringify(newCredentials, null, 2));
        } catch (refreshError) {
          throw new Error('El token de acceso ha expirado y no se pudo refrescar. Necesitas autenticarte nuevamente.');
        }
      }
    } catch (error) {
      // Si el error ya contiene información sobre token expirado, propagarlo tal cual
      if (error.message && (error.message.includes('expirado') || error.message.includes('expirado y no se pudo refrescar'))) {
        throw error;
      }
      throw new Error(`Error al cargar el token: ${error.message}`);
    }
  } else {
    // Si no hay token, generar URL de autorización
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
    });
    
    throw new Error(`No se encontró el token de acceso. Por favor, autentica primero visitando: ${authUrl}`);
  }

  return oAuth2Client;
}

/**
 * Sube un video a YouTube
 * @param {string} videoPath - Ruta del archivo de video a subir
 * @param {object} metadata - Metadatos del video (título, descripción, etc.)
 * @param {string} metadata.title - Título del video
 * @param {string} metadata.description - Descripción del video
 * @param {Array<string>} metadata.tags - Tags del video
 * @param {string} metadata.categoryId - ID de categoría (por defecto: 22 para People & Blogs)
 * @param {string} metadata.privacyStatus - Estado de privacidad ('private', 'unlisted', 'public')
 * @param {string} metadata.thumbnailPath - Ruta de la miniatura (opcional)
 * @returns {Promise<object>} Información del video subido (incluye videoId)
 */
export async function uploadVideoToYouTube(videoPath, metadata = {}) {
  // Generar ID único para esta subida al inicio para que esté disponible en el catch
  const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    if (!existsSync(videoPath)) {
      throw new Error(`El archivo de video no existe: ${videoPath}`);
    }

    const auth = await getAuthenticatedClient();
    const youtube = google.youtube({ version: 'v3', auth });

    const {
      title = 'Sin título',
      description = '',
      tags = [],
      categoryId = '22', // People & Blogs
      privacyStatus = 'public', // private, unlisted, public
      thumbnailPath = null,
    } = metadata;

    // Preparar los metadatos del video
    const videoMetadata = {
      snippet: {
        title,
        description,
        tags,
        categoryId,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false, // Indicar que el video no es para niños
      },
    };

    console.log('📤 Iniciando subida de video a YouTube...');
    console.log(`   Título: ${title}`);
    console.log(`   Privacidad: ${privacyStatus}`);
    console.log(`   Archivo: ${videoPath}`);

    // Obtener tamaño del archivo para calcular progreso
    const fileStats = statSync(videoPath);
    const fileSize = fileStats.size;
    
    // Inicializar progreso con videoTitle y videoPath
    const initialProgress = {
      bytesUploaded: 0,
      totalBytes: fileSize,
      percent: 0,
      status: 'uploading',
      startTime: Date.now(),
      videoTitle: title,
      videoPath: videoPath,
    };
    uploadProgress.set(uploadId, initialProgress);
    
    // Notificar al inicio
    notifyUploadSSEConnections(uploadId, initialProgress);

    // Crear stream personalizado que rastree los bytes
    let bytesUploaded = 0;
    const progressStream = new Transform({
      transform(chunk, encoding, callback) {
        bytesUploaded += chunk.length;
        const percent = Math.min(100, Math.round((bytesUploaded / fileSize) * 100));
        
        // Actualizar progreso
        const progressData = {
          bytesUploaded,
          totalBytes: fileSize,
          percent,
          status: 'uploading',
          startTime: uploadProgress.get(uploadId)?.startTime || Date.now(),
          videoTitle: uploadProgress.get(uploadId)?.videoTitle || title,
          videoPath: uploadProgress.get(uploadId)?.videoPath || videoPath,
        };
        uploadProgress.set(uploadId, progressData);
        
        // Notificar conexiones SSE usando setImmediate para no bloquear
        setImmediate(() => {
          notifyUploadSSEConnections(uploadId, progressData);
        });
        
        // Log cada 5% de progreso
        if (percent % 5 === 0 || bytesUploaded === fileSize) {
          const elapsed = (Date.now() - uploadProgress.get(uploadId).startTime) / 1000;
          const speed = bytesUploaded / elapsed / 1024 / 1024; // MB/s
          console.log(`   📊 Progreso: ${percent}% (${(bytesUploaded / 1024 / 1024).toFixed(2)}MB / ${(fileSize / 1024 / 1024).toFixed(2)}MB) - Velocidad: ${speed.toFixed(2)} MB/s`);
        }
        
        callback(null, chunk);
      },
    });

    // Subir el video usando stream con progreso
    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: videoMetadata,
      media: {
        body: createReadStream(videoPath).pipe(progressStream),
      },
    });
    
    // Marcar como completado
    const completedProgress = {
      bytesUploaded: fileSize,
      totalBytes: fileSize,
      percent: 100,
      status: 'completed',
      startTime: uploadProgress.get(uploadId)?.startTime || Date.now(),
      videoTitle: uploadProgress.get(uploadId)?.videoTitle || title,
      videoPath: uploadProgress.get(uploadId)?.videoPath || videoPath,
      videoId: response.data.id,
      videoUrl: `https://www.youtube.com/watch?v=${response.data.id}`,
    };
    uploadProgress.set(uploadId, completedProgress);
    notifyUploadSSEConnections(uploadId, completedProgress);
    
    // No limpiar automáticamente - mantener para cierre manual

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`✅ Video subido exitosamente!`);
    console.log(`   Video ID: ${videoId}`);
    console.log(`   URL: ${videoUrl}`);

    // Si hay miniatura, subirla
    let thumbnailUploaded = false;
    let thumbnailError = null;
    
    if (thumbnailPath) {
      //console.log(`📸 Verificando miniatura: ${thumbnailPath}`);
      
      // Normalizar ruta: convertir rutas relativas a absolutas
      let normalizedThumbnailPath = thumbnailPath;
      if (!existsSync(normalizedThumbnailPath)) {
        // Si es una ruta relativa, intentar construirla desde storage
        if (!normalizedThumbnailPath.startsWith('/') && !normalizedThumbnailPath.match(/^[A-Za-z]:/)) {
          // Es una ruta relativa
          if (normalizedThumbnailPath.startsWith('storage/')) {
            // Ya tiene el prefijo storage
            normalizedThumbnailPath = join(config.storage.basePath, normalizedThumbnailPath.replace('storage/', ''));
          } else {
            // Intentar desde callsPath
            normalizedThumbnailPath = join(config.storage.callsPath, normalizedThumbnailPath);
          }
        }
      }
      
      //console.log(`   Ruta normalizada: ${normalizedThumbnailPath}`);
      //console.log(`   ¿Existe?: ${existsSync(normalizedThumbnailPath) ? '✅ Sí' : '❌ No'}`);
      
      if (existsSync(normalizedThumbnailPath)) {
        try {
          console.log('📸 Subiendo miniatura...');
          
          // Verificar tamaño del archivo original
          const stats = statSync(normalizedThumbnailPath);
          const fileSizeInBytes = stats.size;
          const fileSizeInMB = fileSizeInBytes / (1024 * 1024);
          const maxSizeInBytes = 2 * 1024 * 1024; // 2MB
          
          //console.log(`   📊 Tamaño original: ${fileSizeInMB.toFixed(2)}MB`);
          
          let thumbnailStream;
          
          // Siempre redimensionar la miniatura a 1920x1080 (resolución recomendada por YouTube)
          //console.log(`   📐 Redimensionando miniatura a 1920x1080...`);
          
          // Cargar sharp dinámicamente
          const sharp = await loadSharp();
          
          // Redimensionar a 1920x1080 estirando la imagen para llenar completamente el espacio
          const optimizedBuffer = await sharp(normalizedThumbnailPath)
            .resize(1920, 1080, {
              fit: 'fill', // Estirar la imagen para llenar exactamente 1920x1080
            })
            .jpeg({ quality: 85 })
            .toBuffer();
          
          // Verificar que el buffer optimizado sea menor a 2MB
          if (optimizedBuffer.length > maxSizeInBytes) {
            // Si aún es muy grande, reducir más la calidad
            console.log(`   ⚠️  Miniatura aún muy grande después de redimensionar, reduciendo calidad...`);
            const moreOptimizedBuffer = await sharp(normalizedThumbnailPath)
              .resize(1920, 1080, {
                fit: 'fill', // Estirar la imagen para llenar exactamente 1920x1080
              })
              .jpeg({ quality: 75 })
              .toBuffer();
            
            thumbnailStream = Readable.from(moreOptimizedBuffer);
            console.log(`   ✅ Miniatura optimizada: ${(moreOptimizedBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
          } else {
            thumbnailStream = Readable.from(optimizedBuffer);
            console.log(`   ✅ Miniatura redimensionada a 1920x1080: ${(optimizedBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
          }
          
          console.log(`   📤 Subiendo miniatura a YouTube para video ${videoId}...`);
          await youtube.thumbnails.set({
            videoId: videoId,
            media: {
              body: thumbnailStream,
            },
          });
          console.log('✅ Miniatura subida exitosamente!');
          thumbnailUploaded = true;
        } catch (error) {
          thumbnailError = error.message;
          console.error(`❌ Error al subir miniatura: ${error.message}`);
          console.error(`   Stack: ${error.stack}`);
          // No fallar la subida completa si falla la miniatura
        }
      } else {
        thumbnailError = `El archivo de miniatura no existe: ${normalizedThumbnailPath}`;
        console.warn(`⚠️  ${thumbnailError}`);
      }
    } else {
      console.log('⚠️  No se especificó ruta de miniatura');
    }

    return {
      success: true,
      videoId,
      videoUrl,
      title: response.data.snippet?.title || title,
      thumbnailUploaded: thumbnailUploaded,
      thumbnailError: thumbnailError || null,
      uploadId, // Devolver el ID de subida para que el cliente pueda consultar el progreso
    };
  } catch (error) {
    // Marcar como error en el progreso si existe uploadId
    if (uploadId && uploadProgress.has(uploadId)) {
      const errorProgress = {
        ...uploadProgress.get(uploadId),
        status: 'error',
        error: error.message,
      };
      uploadProgress.set(uploadId, errorProgress);
      notifyUploadSSEConnections(uploadId, errorProgress);
    }
    console.error('❌ Error al subir video a YouTube:', error.message);
    throw new Error(`Error al subir video a YouTube: ${error.message}`);
  }
}

/**
 * Obtiene el progreso de una subida a YouTube
 * @param {string} uploadId - ID de la subida
 * @returns {object|null} Progreso de la subida o null si no existe
 */
export function getUploadProgress(uploadId) {
  return uploadProgress.get(uploadId) || null;
}

/**
 * Registra una conexión SSE para recibir actualizaciones de progreso
 * @param {string} uploadId - ID de la subida
 * @param {object} res - Response object de Express
 */
export function registerUploadSSEConnection(uploadId, res) {
  if (!uploadSSEConnections.has(uploadId)) {
    uploadSSEConnections.set(uploadId, []);
  }
  
  const connections = uploadSSEConnections.get(uploadId);
  connections.push(res);
  
  // Enviar estado inicial si existe
  const progress = uploadProgress.get(uploadId);
  if (progress) {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  }
  
  // Limpiar conexión cuando se cierre
  res.on('close', () => {
    const conns = uploadSSEConnections.get(uploadId);
    if (conns) {
      const index = conns.indexOf(res);
      if (index > -1) {
        conns.splice(index, 1);
      }
      if (conns.length === 0) {
        uploadSSEConnections.delete(uploadId);
      }
    }
  });
}

/**
 * Notifica a todas las conexiones SSE sobre el progreso de una subida
 * @param {string} uploadId - ID de la subida
 * @param {object} progressData - Datos de progreso
 */
export function notifyUploadSSEConnections(uploadId, progressData) {
  const connections = uploadSSEConnections.get(uploadId);
  if (connections && connections.length > 0) {
    const message = `data: ${JSON.stringify(progressData)}\n\n`;
    connections.forEach((res) => {
      try {
        res.write(message);
      } catch (error) {
        // Ignorar errores de conexión cerrada
      }
    });
  }
}

/**
 * Obtiene todas las subidas activas
 * @returns {Array} Array de objetos con información de subidas activas
 */
export function getActiveUploads() {
  const activeUploads = [];
  uploadProgress.forEach((progress, uploadId) => {
    if (progress.status === 'uploading' || progress.status === 'processing') {
      activeUploads.push({
        uploadId,
        ...progress,
      });
    }
  });
  return activeUploads;
}

/**
 * Resube una miniatura a YouTube para un video existente
 * @param {string} videoId - ID del video de YouTube
 * @param {string} thumbnailPath - Ruta de la miniatura a subir
 * @returns {Promise<object>} Resultado de la operación
 */
export async function reuploadThumbnailToYouTube(videoId, thumbnailPath) {
  try {
    if (!videoId) {
      throw new Error('videoId es requerido');
    }

    console.log('📸 Resubiendo miniatura a YouTube...');
    //console.log(`   Video ID: ${videoId}`);
    //console.log(`   Miniatura original: ${thumbnailPath}`);
    
    // Normalizar ruta: convertir rutas relativas a absolutas
    let normalizedThumbnailPath = thumbnailPath;
    if (!existsSync(normalizedThumbnailPath)) {
      // Si es una ruta relativa, intentar construirla desde storage
      if (!normalizedThumbnailPath.startsWith('/') && !normalizedThumbnailPath.match(/^[A-Za-z]:/)) {
        // Es una ruta relativa
        if (normalizedThumbnailPath.startsWith('storage/')) {
          // Ya tiene el prefijo storage
          normalizedThumbnailPath = join(config.storage.basePath, normalizedThumbnailPath.replace('storage/', ''));
        } else {
          // Intentar desde callsPath
          normalizedThumbnailPath = join(config.storage.callsPath, normalizedThumbnailPath);
        }
      }
    }
    
    //console.log(`   Ruta normalizada: ${normalizedThumbnailPath}`);
    //console.log(`   ¿Existe?: ${existsSync(normalizedThumbnailPath) ? '✅ Sí' : '❌ No'}`);

    if (!normalizedThumbnailPath || !existsSync(normalizedThumbnailPath)) {
      throw new Error(`El archivo de miniatura no existe: ${normalizedThumbnailPath || thumbnailPath}`);
    }

    const auth = await getAuthenticatedClient();
    const youtube = google.youtube({ version: 'v3', auth });

    // Verificar tamaño del archivo original
    const stats = statSync(normalizedThumbnailPath);
    const fileSizeInBytes = stats.size;
    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);
    const maxSizeInBytes = 2 * 1024 * 1024; // 2MB

    //console.log(`   📊 Tamaño original: ${fileSizeInMB.toFixed(2)}MB`);

    let thumbnailStream;

    // Siempre redimensionar la miniatura a 1920x1080 (resolución recomendada por YouTube)
    //console.log(`   📐 Redimensionando miniatura a 1920x1080...`);

    // Cargar sharp dinámicamente
    let sharp;
    try {
      sharp = await loadSharp();
    } catch (sharpError) {
      console.error(`❌ Error al cargar sharp: ${sharpError.message}`);
      throw new Error(`Error al cargar sharp: ${sharpError.message}. Por favor, reinstala sharp ejecutando: npm install --include=optional sharp`);
    }

    // Redimensionar a 1920x1080 estirando la imagen para llenar completamente el espacio
    const optimizedBuffer = await sharp(normalizedThumbnailPath)
      .resize(1920, 1080, {
        fit: 'fill', // Estirar la imagen para llenar exactamente 1920x1080
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Verificar que el buffer optimizado sea menor a 2MB
    if (optimizedBuffer.length > maxSizeInBytes) {
      // Si aún es muy grande, reducir más la calidad
      console.log(`   ⚠️  Miniatura aún muy grande después de redimensionar, reduciendo calidad...`);
      const moreOptimizedBuffer = await sharp(normalizedThumbnailPath)
        .resize(1920, 1080, {
          fit: 'fill', // Estirar la imagen para llenar exactamente 1920x1080
        })
        .jpeg({ quality: 75 })
        .toBuffer();

      thumbnailStream = Readable.from(moreOptimizedBuffer);
      console.log(`   ✅ Miniatura optimizada: ${(moreOptimizedBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
    } else {
      thumbnailStream = Readable.from(optimizedBuffer);
      console.log(`   ✅ Miniatura redimensionada a 1920x1080: ${(optimizedBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
    }

    await youtube.thumbnails.set({
      videoId: videoId,
      media: {
        body: thumbnailStream,
      },
    });
    console.log('✅ Miniatura resubida exitosamente!');

    return {
      success: true,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  } catch (error) {
    console.error('❌ Error al resubir miniatura a YouTube:', error.message);
    throw new Error(`Error al resubir miniatura a YouTube: ${error.message}`);
  }
}

/**
 * Obtiene la URL de autenticación de YouTube
 * @returns {Promise<string>} URL de autenticación
 */
export async function getAuthUrl() {
  try {
    if (!config.youtube.credentialsPath) {
      throw new Error('YOUTUBE_CREDENTIALS_PATH no está configurado en el archivo .env. Por favor, configura esta variable con la ruta al archivo JSON de credenciales descargado de Google Cloud Console.');
    }
    
    if (!existsSync(config.youtube.credentialsPath)) {
      throw new Error(`El archivo de credenciales no existe en la ruta especificada: ${config.youtube.credentialsPath}. Por favor, verifica que el archivo existe y que la ruta en YOUTUBE_CREDENTIALS_PATH es correcta.`);
    }

    const credentials = JSON.parse(readFileSync(config.youtube.credentialsPath, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web || {};
    
    if (!client_id || !client_secret) {
      throw new Error('El archivo de credenciales no contiene client_id o client_secret');
    }

    // Usar el redirect_uri del archivo de credenciales
    // Para aplicaciones web: debe ser 'http://localhost:PORT/api/video/youtube/callback'
    const defaultRedirectUri = `http://localhost:${config.server.port}/api/video/youtube/callback`;
    const redirectUri = redirect_uris && redirect_uris.length > 0 
      ? redirect_uris[0] 
      : defaultRedirectUri;
    
    //console.log(`[DEBUG YouTube Auth] redirect_uri que se usará: ${redirectUri}`);
    //console.log(`[DEBUG YouTube Auth] redirect_uris disponibles en JSON: ${JSON.stringify(redirect_uris)}`);
    
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
      redirect_uri: redirectUri, // Asegurarse de que el redirect_uri coincida
    });

    //console.log(`[DEBUG YouTube Auth] URL generada con redirect_uri: ${redirectUri}`);
    return authUrl;
  } catch (error) {
    throw new Error(`Error al generar URL de autenticación: ${error.message}`);
  }
}

/**
 * Guarda el código de autorización y obtiene el token
 * @param {string} code - Código de autorización obtenido de la URL
 * @returns {Promise<object>} Token de acceso
 */
export async function saveAuthorizationCode(code) {
  try {
    if (!config.youtube.credentialsPath || !existsSync(config.youtube.credentialsPath)) {
      throw new Error('No se encontró el archivo de credenciales de YouTube');
    }

    const credentials = JSON.parse(readFileSync(config.youtube.credentialsPath, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web || {};
    
    if (!client_id || !client_secret) {
      throw new Error('El archivo de credenciales no contiene client_id o client_secret');
    }

    // Usar el redirect_uri del archivo de credenciales
    // Para aplicaciones web: debe ser 'http://localhost:PORT/api/video/youtube/callback'
    const defaultRedirectUri = `http://localhost:${config.server.port}/api/video/youtube/callback`;
    const redirectUri = redirect_uris && redirect_uris.length > 0 
      ? redirect_uris[0] 
      : defaultRedirectUri;
    
    //console.log(`[DEBUG YouTube Auth] Guardando código con redirect_uri: ${redirectUri}`);
    //console.log(`[DEBUG YouTube Auth] redirect_uris disponibles: ${JSON.stringify(redirect_uris)}`);
    
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Guardar el token
    const { writeFileSync } = await import('fs');
    writeFileSync(config.youtube.tokenPath, JSON.stringify(tokens, null, 2));

    console.log('✅ Token guardado exitosamente!');
    return tokens;
  } catch (error) {
    throw new Error(`Error al guardar el código de autorización: ${error.message}`);
  }
}
