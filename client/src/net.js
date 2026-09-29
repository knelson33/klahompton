// Online voyages: connect to the game server and hand back the room (its state holds every ship).
// Every voyage is private: "new" creates one with a fresh 4-letter code, "join" finds one by its code.
import { Client, Callbacks } from '@colyseus/sdk';

// the game server runs beside the page in development (port 2567); set VITE_SERVER_URL when it lives elsewhere
export const serverUrl = () => import.meta.env.VITE_SERVER_URL || `${location.protocol}//${location.hostname}:2567`;

export async function newVoyage(name) {
  const room = await new Client(serverUrl()).create('voyage', { name });
  return { room, callbacks: Callbacks.get(room) };
}
export async function joinVoyage(code, name) {
  const room = await new Client(serverUrl()).joinById(code.toUpperCase(), { name });
  return { room, callbacks: Callbacks.get(room) };
}
