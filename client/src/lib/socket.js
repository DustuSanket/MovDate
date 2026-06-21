import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

// autoConnect is off — useRoomSocket calls socket.connect() once it actually
// has a room to join, and disconnects on unmount.
export const socket = io(SERVER_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
});
