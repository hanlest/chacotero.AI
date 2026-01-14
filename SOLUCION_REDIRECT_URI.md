# Solución Detallada: Error redirect_uri_mismatch

## ¿Qué significa este error?

El error `redirect_uri_mismatch` ocurre cuando el URI de redirección que tu aplicación está usando NO coincide exactamente con los URIs autorizados configurados en Google Cloud Console.

## Solución Paso a Paso

### Paso 1: Verificar tu archivo de credenciales

1. Abre el archivo configurado en `YOUTUBE_CREDENTIALS_PATH` (en tu caso: `storage/client_secret_20947047368-a5895jet6j2td3b5udf04b93qds5gcad.apps.googleusercontent.com.json`)
2. Busca la sección `redirect_uris` dentro de `web`
3. Debe contener: `["http://localhost:3005/api/video/youtube/callback"]`

### Paso 2: Ir a Google Cloud Console

1. Ve a: https://console.cloud.google.com/
2. Selecciona tu proyecto "historias-chile"
3. Ve a: **"APIs y servicios"** > **"Credenciales"**
4. Busca tu **"ID de cliente de OAuth 2.0"** con ID: `20947047368-a5895jet6j2td3b5udf04b93qds5gcad`
5. Haz clic en el **lápiz (✏️)** o en el nombre para editarlo

### Paso 3: Configurar URIs de Redirección Autorizados

En la sección **"URIs de redirección autorizados"**, debes agregar EXACTAMENTE:

```
http://localhost:3005/api/video/youtube/callback
```

**⚠️ IMPORTANTE:**
- El URI debe coincidir EXACTAMENTE (mayúsculas/minúsculas, espacios, etc.)
- No agregues espacios extra
- No agregues comillas en Google Cloud Console (solo el texto)
- El puerto (3005) debe coincidir con el puerto de tu servidor

### Paso 4: Verificar el Tipo de Aplicación

Asegúrate de que el tipo de aplicación sea **"Aplicación web"** (no "Aplicación de escritorio").

### Paso 5: Guardar Cambios

1. Haz clic en **"Guardar"** o **"Save"**
2. Espera 1-2 minutos para que los cambios se propaguen

### Paso 6: Probar Nuevamente

1. Elimina el archivo `storage/youtube-token.json` si existe (para forzar nueva autenticación)
2. Intenta subir un video nuevamente desde `videos.html`
3. Se abrirá una nueva pestaña con la página de autorización de Google
4. Después de autorizar, Google redirigirá a `http://localhost:3005/api/video/youtube/callback`
5. El código capturará automáticamente el código y guardará el token
6. Verás una página de éxito y la ventana se cerrará automáticamente

## ¿Cómo Funciona Ahora?

1. **Usuario hace clic en "Subir a YouTube"** en `videos.html`
2. **Se abre una nueva pestaña** con la URL de autenticación de Google
3. **Usuario autoriza** la aplicación
4. **Google redirige** a `http://localhost:3005/api/video/youtube/callback?code=...`
5. **El endpoint `/api/video/youtube/callback`** captura el código automáticamente
6. **Se guarda el token** en `storage/youtube-token.json`
7. **Se muestra una página de éxito** que se cierra automáticamente después de 3 segundos
8. **El usuario puede volver a intentar** subir el video (ahora con el token guardado)

## Verificación Final

Para verificar que todo está correcto:

1. **Google Cloud Console** tiene: `http://localhost:3005/api/video/youtube/callback`
2. **Tu archivo JSON** tiene: `"redirect_uris": ["http://localhost:3005/api/video/youtube/callback"]`
3. **Ambos son exactamente iguales** (sin espacios extra, sin diferencias)
4. **El tipo de aplicación** es "Aplicación web"

## Si el Error Persiste

1. Verifica que guardaste los cambios en Google Cloud Console
2. Espera 2-3 minutos para que los cambios se propaguen
3. Elimina `storage/youtube-token.json` y vuelve a intentar
4. Verifica que no hay espacios o caracteres extra en los URIs
5. Asegúrate de estar usando el mismo proyecto de Google Cloud que el del archivo JSON
6. Verifica que el puerto (3005) coincide con el puerto de tu servidor (revisa `PORT` en `.env`)
