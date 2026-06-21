# MovDate

Watch videos together with friends — paste a link, share the room, and everyone's
playback stays in sync while you talk over voice/video and chat, all in one tab.

## What works, honestly

- **Synced playback** for **YouTube links** and **direct video file links**
  (`.mp4`, `.webm`, `.ogg`, `.mov`, `.m3u8`).
- **Host-controlled playback** — whoever created the room (or the next person in
  line if they leave) is the only one who can play/pause/seek/switch videos.
  Everyone else's player follows along automatically.
- **Live voice & video call** between everyone in the room, peer-to-peer (no
  call server needed) — mute, camera on/off, like a mini Zoom inside the room.
- **Text chat** alongside the video.
- **One link to share** — `https://yourapp.com/room/<code>` is the whole invite.

### What can't work, and why

Subscription streaming sites — Netflix, Disney+, Prime Video, Hulu, etc. —
deliberately block being embedded or controlled by outside code (DRM, no
public players). No watch-party tool, including the commercial ones, can sync
those without a browser extension that hooks into that specific site's player.
MovDate focuses on what's actually embeddable: YouTube and direct video files.

The voice/video call uses a **peer-to-peer mesh** (every browser connects
directly to every other browser). That's free and simple, and works great for
small groups (roughly 2–6 people). Past that, bandwidth and CPU cost grows
quickly per person — see "Scaling the call" below if you need bigger rooms.

## Architecture

```
client/   React (JSX) + Vite — the UI, video player, call grid, chat
server/   Node.js + Express + Socket.io — room state, playback sync, signaling
```

- The server keeps room state **in memory**: who's in the room, who's host,
  what video is loaded, and the last known playback position/time. Nothing is
  written to a database — restarting the server clears all rooms.
- Playback sync: the host's play/pause/seek actions are sent to the server,
  which timestamps and rebroadcasts them to everyone else in the room. New
  joiners get the host's last known position, compensated for time elapsed
  since it was recorded, so they land close to "now" instead of stale.
- Voice/video: the server **never touches audio or video**. It only relays
  WebRTC signaling messages (offers/answers/ICE candidates) so browsers can
  find each other directly; the actual media flows peer-to-peer.

## Local development

You'll need [Node.js](https://nodejs.org) 18+.

```bash
# Terminal 1 — backend
cd server
npm install
cp .env.example .env
npm run dev          # http://localhost:4000

# Terminal 2 — frontend
cd client
npm install
cp .env.example .env
npm run dev          # http://localhost:5173
```

Open `http://localhost:5173`, create a room, then open it again in another
tab/browser (or send the link to a friend on the same network) to test the
sync and call features. Camera/mic access requires a secure context — that's
automatic on `localhost`.

## Deploying

You need **HTTPS** in production: browsers refuse camera/mic access (and some
clipboard/share features) on plain HTTP, except on `localhost`.

### Option A — single deploy (simplest)

Build the client, then let the server serve it from the same origin:

```bash
cd client
npm install
npm run build          # outputs to client/dist

cd ../server
npm install
npm start
```

The server already serves `../client/dist` if it exists, and falls back to
`index.html` for any non-API route (so client-side routing works). Deploy the
whole `movdate/` folder to any Node host (Render, Railway, Fly.io, a VPS,
etc.), set `PORT` if your host requires a specific one, and you're done —
client and server share an origin, so you don't even need `CLIENT_ORIGIN` or
`VITE_SERVER_URL`.

### Option B — split deploy (e.g. Vercel for the client, Render for the server)

1. Deploy `server/` to a Node host. Set the environment variable
   `CLIENT_ORIGIN` to your client's deployed URL (comma-separate multiple
   origins if needed).
2. Deploy `client/` to a static host. Set the environment variable
   `VITE_SERVER_URL` to your server's deployed URL before building.
3. Make sure both are served over HTTPS.

## Scaling the call beyond a handful of people

The peer-to-peer mesh in `client/src/hooks/useMeshCall.js` is intentionally
simple — no extra service, no cost, great for friends watching together. If
you outgrow it:

- **Add a TURN server** (e.g. via [Twilio](https://www.twilio.com/stun-turn),
  [Cloudflare Calls](https://developers.cloudflare.com/calls/), or your own
  [coturn](https://github.com/coturn/coturn) instance) and list it in
  `ICE_SERVERS` in `useMeshCall.js`. This fixes calls failing on strict
  networks (corporate Wi-Fi, some mobile carriers) — STUN alone isn't always
  enough to get two browsers talking directly.
- **Swap the mesh for an SFU** (Selective Forwarding Unit) if you want rooms
  bigger than ~6 people. Self-hosted options include
  [mediasoup](https://mediasoup.org/) and [LiveKit](https://livekit.io/);
  hosted options include LiveKit Cloud, Daily, and Agora. This is a bigger
  change — every participant would send one stream to the SFU instead of one
  stream per peer — but the room/chat/playback-sync code here doesn't need to
  change either way.

## Other things worth knowing

- **No accounts, no auth.** Anyone with a room link can join as anyone. That's
  the point for a quick watch party with friends, but don't use this for
  anything sensitive without adding authentication.
- **No persistence.** Chat history and room state disappear when the server
  restarts or the room empties out.
- **Autoplay policies.** Some browsers block audio/video from starting without
  a direct click. If that happens, the UI shows a one-time "press play" notice
  to whoever got blocked — after that first click, sync continues normally.

## Project structure

```
movdate/
├── server/
│   ├── server.js          Express + Socket.io entry point
│   ├── rooms.js            In-memory room store
│   ├── socketHandlers.js   Join/leave, playback sync, chat, WebRTC signaling
│   └── package.json
└── client/
    ├── index.html
    ├── src/
    │   ├── main.jsx
    │   ├── App.jsx
    │   ├── index.css              Design tokens + layout for the whole app
    │   ├── pages/
    │   │   ├── Home.jsx           Create / join a room
    │   │   └── Room.jsx           The watch-party screen
    │   ├── components/
    │   │   ├── VideoPlayer.jsx    YouTube + direct-file player, sync-driven
    │   │   ├── PlayerControls.jsx Play/pause/seek bar + "load video" form
    │   │   ├── CallGrid.jsx / ParticipantTile.jsx
    │   │   ├── ChatPanel.jsx
    │   │   └── InviteBar.jsx
    │   ├── hooks/
    │   │   ├── useRoomSocket.js   Room state + playback/chat socket events
    │   │   ├── useLocalMedia.js   Camera/mic access, mute/camera toggles
    │   │   └── useMeshCall.js     WebRTC mesh + signaling
    │   └── lib/
    │       ├── socket.js, videoSource.js, youtubeLoader.js
    └── package.json
```
