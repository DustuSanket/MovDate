import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { Server } from 'socket.io';
import { registerSocketHandlers } from './socketHandlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
// Comma-separated list of allowed client origins, e.g. "https://movdate.app,https://www.movdate.app"
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim())
  : '*';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'movdate-server' }));

// Optional single-deploy mode: if you build the client (npm run build in /client)
// and it lands in ../client/dist, this server will also serve it directly so you
// only need to deploy one app. If that folder doesn't exist, these just no-op.
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/socket.io') || req.path === '/health') return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`MovDate server listening on port ${PORT}`);
});
