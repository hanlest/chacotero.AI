# Configuración de YouTube Data API v3 para Subir Videos

## Pasos para Activar la API

### 1. Crear Proyecto en Google Cloud Console
1. Ve a https://console.cloud.google.com/
2. Crea un proyecto nuevo o selecciona uno existente

### 2. Habilitar YouTube Data API v3
1. En el proyecto, ve a **"APIs y servicios"** > **"Biblioteca"**
2. Busca **"YouTube Data API v3"**
3. Haz clic en **"Habilitar"**

### 3. Crear Credenciales OAuth 2.0
1. Ve a **"APIs y servicios"** > **"Credenciales"**
2. Clic en **"Crear credenciales"** > **"ID de cliente de OAuth"**
3. Tipo de aplicación: **"Aplicación de escritorio"** (recomendado para este caso)
4. Nombre: "Chacotero AI" (o el que prefieras)
5. **IMPORTANTE**: En "URIs de redirección autorizados", agrega:
   - `urn:ietf:wg:oauth:2.0:oob` (para aplicaciones de escritorio)
   - O si prefieres usar localhost: `http://localhost` o `http://localhost:3000`
6. Clic en **"Crear"**
7. **Descarga el archivo JSON de credenciales**

### 4. Configurar Pantalla de Consentimiento OAuth
1. Ve a **"APIs y servicios"** > **"Pantalla de consentimiento de OAuth"**
2. Selecciona **"Externo"** (o "Interno" si tienes Google Workspace)
3. Completa la información requerida:
   - Nombre de la aplicación
   - Email de soporte
   - Email del desarrollador
4. En **"Alcances"**, agrega:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube` (opcional, para más permisos)
5. Guarda y continúa

### 5. Configurar en tu Proyecto

#### 5.1. Guardar Credenciales
1. Guarda el archivo JSON descargado en: `storage/youtube-credentials.json`
2. El archivo debe tener este formato:
```json
{
  "installed": {
    "client_id": "tu-client-id.apps.googleusercontent.com",
    "project_id": "tu-project-id",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "tu-client-secret",
    "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob"]
  }
}
```

**⚠️ IMPORTANTE**: El `redirect_uri` en el archivo JSON debe coincidir EXACTAMENTE con el que configuraste en Google Cloud Console. Si obtienes el error `redirect_uri_mismatch`:
1. Ve a Google Cloud Console > APIs y servicios > Credenciales
2. Edita tu ID de cliente OAuth 2.0
3. Verifica que en "URIs de redirección autorizados" esté exactamente: `urn:ietf:wg:oauth:2.0:oob`
4. Guarda los cambios
5. Vuelve a intentar la autenticación

#### 5.2. Configurar Variables de Entorno
Agrega al archivo `.env`:
```env
YOUTUBE_CREDENTIALS_PATH=storage/youtube-credentials.json
YOUTUBE_TOKEN_PATH=storage/youtube-token.json
YOUTUBE_CHANNEL_ID=tu_channel_id_aqui
```

#### 5.3. Instalar Dependencias
```bash
npm install googleapis
```

### 6. Obtener Channel ID
Para obtener tu Channel ID:
1. Ve a https://www.youtube.com/account_advanced
2. Tu Channel ID aparece en la sección "Información de la cuenta"
3. O usa esta URL: `https://www.youtube.com/channel/TU_CHANNEL_ID`

### 7. Primera Autenticación
La primera vez que uses la API, necesitarás autenticarte:
1. El sistema te pedirá abrir una URL en el navegador
2. Inicia sesión con tu cuenta de Google
3. Autoriza la aplicación
4. Copia el código de autorización
5. Pégalo en la consola
6. Se generará automáticamente el archivo `youtube-token.json`

## Notas Importantes

- **Costo**: YouTube Data API v3 es **GRATIS** hasta 10,000 unidades de cuota por día
- **Límites**: 
  - Subir video: 1,600 unidades de cuota
  - Listar videos: 1 unidad de cuota
  - Obtener detalles: 1 unidad de cuota
- **Cuota diaria**: 10,000 unidades (suficiente para ~6 videos por día)
- **Autenticación**: Solo necesitas autenticarte una vez, el token se guarda automáticamente

## Recursos Útiles

- Documentación oficial: https://developers.google.com/youtube/v3
- Cuotas y límites: https://developers.google.com/youtube/v3/getting-started#quota
- Guía de autenticación: https://developers.google.com/youtube/v3/guides/auth
