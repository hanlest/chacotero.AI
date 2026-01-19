import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../swagger/swagger.js';
import videoRoutes from './routes/videoRoutes.js';
import imageRoutes from './routes/imageRoutes.js';
import callRoutes from './routes/callRoutes.js';
import config from './config/config.js';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static('public'));

// CORS (si es necesario para desarrollo)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Debug: Log todas las rutas registradas (antes de las rutas)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/video', videoRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/calls', callRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
  });
});

// 404 handler
app.use((req, res) => {
  console.log(`404 - Ruta no encontrada: ${req.method} ${req.path}`);
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.path,
    method: req.method,
  });
});

// Start server
const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📚 Documentación Swagger disponible en http://localhost:${PORT}/api-docs`);
  console.log(`🎬 Endpoint de procesamiento: POST http://localhost:${PORT}/api/video/process`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Error: El puerto ${PORT} ya está en uso.`);
    console.error(`   Cambia el puerto en el archivo .env o detén el otro servidor.`);
  } else {
    console.error('❌ Error al iniciar el servidor:', err);
  }
  process.exit(1);
});

export default app;
