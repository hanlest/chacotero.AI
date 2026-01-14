import { google } from 'googleapis';
import { readFileSync, existsSync, createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Obtiene un cliente autenticado de YouTube Data API v3
 * @returns {Promise<object>} Cliente autenticado de YouTube
 */
async function getAuthenticatedClient() {
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
      throw new Error(`Error al cargar el token: ${error.message}`);
    }
  } else {
    // Si no hay token, generar URL de autorización
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
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
      },
    };

    console.log('📤 Iniciando subida de video a YouTube...');
    console.log(`   Título: ${title}`);
    console.log(`   Privacidad: ${privacyStatus}`);
    console.log(`   Archivo: ${videoPath}`);

    // Subir el video usando stream
    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: videoMetadata,
      media: {
        body: createReadStream(videoPath),
      },
    });

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`✅ Video subido exitosamente!`);
    console.log(`   Video ID: ${videoId}`);
    console.log(`   URL: ${videoUrl}`);

    // Si hay miniatura, subirla
    if (thumbnailPath && existsSync(thumbnailPath)) {
      try {
        console.log('📸 Subiendo miniatura...');
        await youtube.thumbnails.set({
          videoId: videoId,
          media: {
            body: createReadStream(thumbnailPath),
          },
        });
        console.log('✅ Miniatura subida exitosamente!');
      } catch (thumbnailError) {
        console.warn(`⚠️  Error al subir miniatura: ${thumbnailError.message}`);
        // No fallar la subida completa si falla la miniatura
      }
    }

    return {
      success: true,
      videoId,
      videoUrl,
      title: response.data.snippet?.title || title,
    };
  } catch (error) {
    console.error('❌ Error al subir video a YouTube:', error.message);
    throw new Error(`Error al subir video a YouTube: ${error.message}`);
  }
}

/**
 * Obtiene la URL de autenticación de YouTube
 * @returns {Promise<string>} URL de autenticación
 */
export async function getAuthUrl() {
  try {
    if (!config.youtube.credentialsPath || !existsSync(config.youtube.credentialsPath)) {
      throw new Error('No se encontró el archivo de credenciales de YouTube. Configura YOUTUBE_CREDENTIALS_PATH en .env');
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
    
    console.log(`[DEBUG YouTube Auth] redirect_uri que se usará: ${redirectUri}`);
    console.log(`[DEBUG YouTube Auth] redirect_uris disponibles en JSON: ${JSON.stringify(redirect_uris)}`);
    
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirectUri
    );

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
      redirect_uri: redirectUri, // Asegurarse de que el redirect_uri coincida
    });

    console.log(`[DEBUG YouTube Auth] URL generada con redirect_uri: ${redirectUri}`);
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
    
    console.log(`[DEBUG YouTube Auth] Guardando código con redirect_uri: ${redirectUri}`);
    console.log(`[DEBUG YouTube Auth] redirect_uris disponibles: ${JSON.stringify(redirect_uris)}`);
    
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
