const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();

// Trust reverse proxy (Render, GoDaddy, Nginx, Cloudflare)
app.set('trust proxy', 1);

app.use(cors());

// Automatically redirect http:// to https:// on production deployments
app.use((req, res, next) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto && forwardedProto !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Socket.IO production configuration
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  transports: ['websocket', 'polling']
});

// In-memory room store
// roomCode -> { roomCode, hostSocketId, hostUsername, currentUrl, mode, isPlaying, currentTime, lightsDimmed, isScreenSharing, users: Map }
const rooms = new Map();

// Maximum participants: 1 Host + 3 Guests = 4 Total
const MAX_ROOM_CAPACITY = 4;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `CINEMA-${code}`;
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id} | Transport: ${socket.conn.transport.name} | RemoteIP: ${socket.handshake.address}`);

  socket.conn.on('upgrade', (transport) => {
    console.log(`[Socket Upgraded] ID: ${socket.id} -> ${transport.name}`);
  });

  // ==================== 1. CREATE ROOM (HOST) ====================
  socket.on('create-room', ({ username }) => {
    const roomCode = generateRoomCode();
    const hostUser = {
      socketId: socket.id,
      username: (username || 'Director Host 🎬').trim(),
      isHost: true,
      joinedAt: Date.now()
    };

    const room = {
      roomCode,
      hostSocketId: socket.id,
      hostUsername: hostUser.username,
      currentUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ?enablejsapi=1',
      mode: 'screenshare',
      isPlaying: false,
      currentTime: 0,
      lightsDimmed: false,
      isScreenSharing: false,
      users: new Map([[socket.id, hostUser]])
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-created', {
      roomCode,
      isHost: true,
      user: hostUser,
      roomState: {
        currentUrl: room.currentUrl,
        mode: room.mode,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lightsDimmed: room.lightsDimmed,
        isScreenSharing: room.isScreenSharing,
        users: Array.from(room.users.values())
      }
    });

    console.log(`[Room Created] ${roomCode} by ${hostUser.username} (${socket.id})`);
  });

  // ==================== 2. JOIN ROOM (GUEST - MAX 3 GUESTS) ====================
  socket.on('join-room', ({ roomCode, username }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join-error', {
        code: 'ROOM_NOT_FOUND',
        message: 'Theatre Room Code not found! Double check your ticket code.'
      });
      return;
    }

    // Step 9: Room capacity check - 1 Host + Max 3 Guests = Max 4 Users
    if (room.users.size >= MAX_ROOM_CAPACITY) {
      console.warn(`[Room Full] ${socket.id} rejected from ${code}. Current capacity: ${room.users.size}/${MAX_ROOM_CAPACITY}`);
      socket.emit('join-error', {
        code: 'ROOM_FULL',
        message: 'This room is full. Maximum 3 guests are allowed.'
      });
      return;
    }

    const guestUser = {
      socketId: socket.id,
      username: (username || `VIP Guest #${Math.floor(Math.random() * 900 + 100)} 🎟️`).trim(),
      isHost: false,
      joinedAt: Date.now()
    };

    room.users.set(socket.id, guestUser);
    socket.join(code);
    socket.roomCode = code;

    const userList = Array.from(room.users.values());

    // Send full current room state to joining guest
    socket.emit('room-joined', {
      roomCode: code,
      isHost: false,
      user: guestUser,
      hostSocketId: room.hostSocketId,
      roomState: {
        currentUrl: room.currentUrl,
        mode: room.mode,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lightsDimmed: room.lightsDimmed,
        isScreenSharing: room.isScreenSharing,
        users: userList
      }
    });

    // Notify other participants in room
    socket.to(code).emit('user-joined', {
      user: guestUser,
      users: userList
    });

    console.log(`[User Joined] ${guestUser.username} (${socket.id}) joined ${code} [${userList.length}/${MAX_ROOM_CAPACITY}]`);
  });

  // ==================== 3. REJOIN ROOM (RECONNECT RECOVERY) ====================
  socket.on('rejoin-room', ({ roomCode, username, wasHost }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('rejoin-error', {
        code: 'ROOM_EXPIRED',
        message: 'Your previous room has ended. Please create or join a new one.'
      });
      return;
    }

    // Determine if this reconnecting user should be host
    let isUserHost = false;
    if (wasHost && (!room.hostSocketId || !room.users.has(room.hostSocketId))) {
      isUserHost = true;
      room.hostSocketId = socket.id;
    }

    // If room is already at capacity with other active sockets, reject
    if (!room.users.has(socket.id) && room.users.size >= MAX_ROOM_CAPACITY) {
      socket.emit('join-error', {
        code: 'ROOM_FULL',
        message: 'This room is full. Maximum 3 guests are allowed.'
      });
      return;
    }

    const restoredUser = {
      socketId: socket.id,
      username: (username || (isUserHost ? 'Director Host 🎬' : 'Reconnected Guest 🎟️')).trim(),
      isHost: isUserHost,
      joinedAt: Date.now()
    };

    room.users.set(socket.id, restoredUser);
    socket.join(code);
    socket.roomCode = code;

    const userList = Array.from(room.users.values());

    socket.emit('room-joined', {
      roomCode: code,
      isHost: isUserHost,
      user: restoredUser,
      hostSocketId: room.hostSocketId,
      roomState: {
        currentUrl: room.currentUrl,
        mode: room.mode,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lightsDimmed: room.lightsDimmed,
        isScreenSharing: room.isScreenSharing,
        users: userList
      }
    });

    socket.to(code).emit('user-joined', {
      user: restoredUser,
      users: userList
    });

    console.log(`[Rejoin Room] ${restoredUser.username} (${socket.id}) restored in ${code} (Host: ${isUserHost})`);
  });

  // ==================== 4. WEBRTC SIGNALING RELAY ====================
  // 3 & 4. Server receives request-host-stream and forwards guest-requested-stream to Host
  socket.on('request-host-stream', () => {
    const code = socket.roomCode;
    const ts = new Date().toISOString();
    console.log(`[SERVER WEBRTC] [${ts}] Event 3: request-host-stream RECEIVED from Guest (${socket.id}) in Room (${code || 'none'})`);

    if (!code) {
      console.warn(`[SERVER WEBRTC] Cannot route request-host-stream: Socket ${socket.id} has no roomCode.`);
      return;
    }
    const room = rooms.get(code);
    if (!room || !room.hostSocketId) {
      console.warn(`[SERVER WEBRTC] Cannot route request-host-stream: Room ${code} or hostSocketId not found.`);
      return;
    }

    console.log(`[SERVER WEBRTC] [${ts}] Event 4: guest-requested-stream SENT to Host (${room.hostSocketId}) for Guest (${socket.id})`);
    io.to(room.hostSocketId).emit('guest-requested-stream', {
      guestSocketId: socket.id,
      timestamp: Date.now()
    });
  });

  // 11. Host -> Guest Offer
  socket.on('webrtc-offer', ({ targetSocketId, offer, negotiationId }) => {
    if (!targetSocketId || !offer) return;
    const ts = new Date().toISOString();
    console.log(`[SERVER WEBRTC] [${ts}] Event 11: Relaying webrtc-offer from Host (${socket.id}) to Guest (${targetSocketId}) [negId: ${negotiationId || 'none'}]`);
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer,
      negotiationId
    });
  });

  // 17. Guest -> Host Answer
  socket.on('webrtc-answer', ({ targetSocketId, answer, negotiationId }) => {
    if (!targetSocketId || !answer) return;
    const ts = new Date().toISOString();
    console.log(`[SERVER WEBRTC] [${ts}] Event 17: Relaying webrtc-answer from Guest (${socket.id}) to Host (${targetSocketId}) [negId: ${negotiationId || 'none'}]`);
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer,
      negotiationId
    });
  });

  // 21. Bidirectional ICE Candidate exchange
  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    if (!targetSocketId || !candidate) return;
    const cType = candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown');
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // Host screen sharing status broadcast
  socket.on('screen-share-status', ({ isSharing }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.isScreenSharing = Boolean(isSharing);
    io.to(code).emit('screen-share-status', { isSharing: room.isScreenSharing });
    console.log(`[Screen Share Status] Room ${code}: isSharing = ${room.isScreenSharing}`);
  });

  // ==================== 5. SYNCHRONIZED NAVIGATION & MEDIA ====================
  // Host navigates URL or switches Stage Tab (screenshare | youtube | web)
  socket.on('sync-navigation', ({ url, mode }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    if (url !== undefined) room.currentUrl = url;
    if (mode !== undefined) room.mode = mode;

    io.to(code).emit('sync-navigation', {
      url: room.currentUrl,
      mode: room.mode,
      sender: socket.id
    });
  });

  // Host Play / Pause / Seek event
  socket.on('sync-playback', ({ action, time }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    if (action === 'play') room.isPlaying = true;
    if (action === 'pause') room.isPlaying = false;
    if (time !== undefined) room.currentTime = time;

    socket.to(code).emit('sync-playback', {
      action,
      time: room.currentTime,
      timestamp: Date.now(),
      senderSocketId: socket.id
    });
  });

  // Host continuous heartbeat (every ~1.5s)
  socket.on('sync-heartbeat', ({ time, isPlaying, mode, videoId }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    room.currentTime = time;
    room.isPlaying = isPlaying;
    if (mode) room.mode = mode;

    socket.to(code).emit('sync-heartbeat', {
      time,
      isPlaying,
      mode: room.mode,
      videoId,
      timestamp: Date.now()
    });
  });

  // ==================== 6. THEATRE INTERACTIONS ====================
  // Dim Stage Lights Toggle
  socket.on('toggle-lights', ({ dimmed }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.lightsDimmed = Boolean(dimmed);
    io.to(code).emit('lights-toggled', { dimmed: room.lightsDimmed });
  });

  // Floating Emoji Reaction
  socket.on('send-reaction', ({ emoji }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    const username = user ? user.username : 'Someone';

    io.to(code).emit('receive-reaction', {
      emoji,
      username,
      id: Math.random().toString(36).substring(2, 9),
      xPos: Math.random() * 80 + 10
    });
  });

  // Chat message
  socket.on('send-chat', ({ text }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user || !text || !text.trim()) return;

    const msgData = {
      senderId: socket.id,
      username: user.username,
      isHost: user.isHost,
      text: text.trim().substring(0, 500),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    io.to(code).emit('receive-chat', msgData);
  });

  // ==================== 7. DISCONNECT & CLEANUP ====================
  socket.on('disconnect', (reason) => {
    console.log(`[Socket Disconnected] ID: ${socket.id} | Reason: ${reason}`);
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);

    if (room.users.size === 0) {
      rooms.delete(code);
      console.log(`[Room Deleted] ${code} is now empty and has been removed.`);
    } else {
      // If host disconnected, promote the next oldest participant to Host
      if (room.hostSocketId === socket.id) {
        room.isScreenSharing = false;
        const nextSocketId = room.users.keys().next().value;
        const newHost = room.users.get(nextSocketId);
        if (newHost) {
          newHost.isHost = true;
          room.hostSocketId = nextSocketId;
          room.hostUsername = newHost.username;
          io.to(nextSocketId).emit('promoted-to-host');
          io.to(code).emit('host-changed', {
            newHostUsername: newHost.username,
            newHostSocketId: nextSocketId
          });
          console.log(`[Host Promoted] ${newHost.username} (${nextSocketId}) is now host of ${code}`);
        }
      }

      io.to(code).emit('user-left', {
        socketId: socket.id,
        username: user ? user.username : 'A guest',
        users: Array.from(room.users.values())
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ======================================================
  🍿 CINE-PARTY THEATRE & SHARED BROWSER RUNNING! 🎬
  ======================================================
  Port: ${PORT} | Bind: 0.0.0.0
  Max Room Capacity: ${MAX_ROOM_CAPACITY} (1 Host + 3 Guests)
  Signaling: Socket.IO (transports: websocket, polling)
  Proxy Trust: Enabled (1 hop)
  ======================================================
  `);
});
