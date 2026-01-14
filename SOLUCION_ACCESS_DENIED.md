# Solución: Error 403 - access_denied

## ¿Qué significa este error?

El error `403: access_denied` con el mensaje "Historias Chile API no completó el proceso de verificación de Google" significa que tu aplicación OAuth está en modo **"Testing"** (Prueba), y solo los usuarios que están en la lista de "Test users" pueden acceder.

## Solución Rápida: Agregar Usuarios de Prueba

### Paso 1: Ir a Google Cloud Console

1. Ve a: https://console.cloud.google.com/
2. Selecciona tu proyecto: **"historias-chile"**
3. Ve a: **"APIs y servicios"** > **"Pantalla de consentimiento de OAuth"**

### Paso 2: Agregar Usuarios de Prueba

1. En la sección **"Usuarios de prueba"** (Test users), haz clic en **"+ AGREGAR USUARIOS"** o **"+ ADD USERS"**
2. Ingresa tu dirección de correo electrónico de Google (la misma que usas para acceder a YouTube)
3. Haz clic en **"AGREGAR"** o **"ADD"**
4. Repite este proceso para cada cuenta de Google que quieras que tenga acceso

**⚠️ IMPORTANTE:**
- Debes usar la misma cuenta de Google que quieres usar para subir videos a YouTube
- Puedes agregar hasta 100 usuarios de prueba
- Los usuarios de prueba recibirán un email de invitación (pueden ignorarlo)

### Paso 3: Guardar Cambios

1. Haz clic en **"GUARDAR"** o **"SAVE"**
2. Espera unos segundos para que los cambios se apliquen

### Paso 4: Probar Nuevamente

1. Elimina el archivo `storage/youtube-token.json` si existe
2. Intenta subir un video nuevamente desde `videos.html`
3. Ahora deberías poder autorizar la aplicación sin el error 403

## Solución Alternativa: Cambiar a Modo Producción (Requiere Verificación)

Si quieres que cualquier usuario pueda usar tu aplicación sin agregarlos manualmente, necesitas:

### Opción A: Cambiar a Producción (Requiere Verificación de Google)

1. Ve a: **"APIs y servicios"** > **"Pantalla de consentimiento de OAuth"**
2. En la parte superior, haz clic en **"PUBLICAR APLICACIÓN"** o **"PUBLISH APP"**
3. Google te pedirá completar el proceso de verificación, que incluye:
   - Política de privacidad
   - Términos de servicio
   - Información sobre el uso de datos
   - Revisión manual de Google (puede tardar varios días o semanas)

**⚠️ NOTA:** Este proceso puede tardar mucho tiempo y requiere documentación adicional.

### Opción B: Mantener en Modo Testing (Recomendado para Desarrollo)

Para desarrollo personal, es más fácil mantener la app en modo "Testing" y simplemente agregar tu cuenta como usuario de prueba.

## Verificar el Estado de la Aplicación

Para verificar si tu aplicación está en modo Testing o Production:

1. Ve a: **"APIs y servicios"** > **"Pantalla de consentimiento de OAuth"**
2. En la parte superior verás:
   - **"En pruebas"** (Testing) - Solo usuarios de prueba pueden acceder
   - **"En producción"** (Production) - Cualquier usuario puede acceder (requiere verificación)

## Resumen de Pasos Rápidos

1. ✅ Ir a Google Cloud Console > "APIs y servicios" > "Pantalla de consentimiento de OAuth"
2. ✅ Clic en "+ AGREGAR USUARIOS" en la sección "Usuarios de prueba"
3. ✅ Agregar tu email de Google
4. ✅ Guardar
5. ✅ Probar nuevamente

## Preguntas Frecuentes

**P: ¿Puedo agregar múltiples cuentas?**
R: Sí, puedes agregar hasta 100 usuarios de prueba.

**P: ¿Los usuarios de prueba reciben un email?**
R: Sí, pero pueden ignorarlo. El acceso se otorga automáticamente.

**P: ¿Cuánto tiempo tarda en aplicarse?**
R: Generalmente es inmediato, pero puede tardar hasta 1-2 minutos.

**P: ¿Necesito verificar la aplicación para uso personal?**
R: No, el modo Testing es suficiente para uso personal. Solo necesitas verificación si quieres que cualquier usuario pueda usar tu app.
