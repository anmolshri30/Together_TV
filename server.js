const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Mount PeerJS Server on /peerjs for reliable WebRTC signaling on custom domains
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/peerapp'
});
app.use('/peerjs', peerServer);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Store rooms in memory
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `CINEMA-${code}`;
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Create Room (Host)
  socket.on('create-room', ({ username }) => {
    const roomCode = generateRoomCode();
    const user = {
      socketId: socket.id,
      username: username || 'Director Host 🎬',
      isHost: true,
      peerId: null
    };

    const room = {
      roomCode,
      hostSocketId: socket.id,
      hostPeerId: null,
      currentUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ?enablejsapi=1',
      mode: 'screenshare', // 'screenshare' | 'youtube' | 'web'
      isPlaying: false,
      currentTime: 0,
      lightsDimmed: false,
      users: new Map([[socket.id, user]])
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-created', {
      roomCode,
      isHost: true,
      user,
      roomState: {
        currentUrl: room.currentUrl,
        mode: room.mode,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lightsDimmed: room.lightsDimmed,
        users: Array.from(room.users.values())
      }
    });

    console.log(`[Room Created] ${roomCode} by ${user.username}`);
  });

  // Join Room (Participant)
  socket.on('join-room', ({ roomCode, username }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join-error', { message: 'Theatre Room Code not found! Double check your ticket code.' });
      return;
    }

    const user = {
      socketId: socket.id,
      username: username || `VIP Guest #${Math.floor(Math.random() * 900 + 100)} 🎟️`,
      isHost: false,
      peerId: null
    };

    room.users.set(socket.id, user);
    socket.join(code);
    socket.roomCode = code;

    const userList = Array.from(room.users.values());

    // Send state to joined user
    socket.emit('room-joined', {
      roomCode: code,
      isHost: false,
      user,
      hostSocketId: room.hostSocketId,
      hostPeerId: room.hostPeerId,
      roomState: {
        currentUrl: room.currentUrl,
        mode: room.mode,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lightsDimmed: room.lightsDimmed,
        users: userList
      }
    });

    // Notify others in room
    socket.to(code).emit('user-joined', {
      user,
      users: userList
    });

    console.log(`[User Joined] ${user.username} joined room ${code}`);
  });

  // Register Peer ID for WebRTC
  socket.on('register-peer', ({ peerId }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (user) {
      user.peerId = peerId;
      if (user.isHost) {
        room.hostPeerId = peerId;
      }
    }

    // Broadcast updated peer info to room
    io.to(code).emit('peer-registered', {
      socketId: socket.id,
      peerId,
      isHost: user ? user.isHost : false,
      users: Array.from(room.users.values())
    });
  });

  // Host Screen Sharing State
  socket.on('screen-share-status', ({ isSharing }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;

    io.to(code).emit('screen-share-status', { isSharing });
  });

  // Host Navigates URL / Mode
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

  // Media Playback Sync (Play / Pause / Seek)
  socket.on('sync-playback', ({ action, time }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (action === 'play') room.isPlaying = true;
    if (action === 'pause') room.isPlaying = false;
    if (time !== undefined) room.currentTime = time;

    socket.to(code).emit('sync-playback', {
      action,
      time: room.currentTime,
      senderSocketId: socket.id
    });
  });

  // Toggle Dim Stage Lights
  socket.on('toggle-lights', ({ dimmed }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.lightsDimmed = dimmed;
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

  // Chat Message
  socket.on('send-chat', ({ text }) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user || !text.trim()) return;

    const msgData = {
      senderId: socket.id,
      username: user.username,
      isHost: user.isHost,
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    io.to(code).emit('receive-chat', msgData);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ID: ${socket.id}`);
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);

    if (room.users.size === 0) {
      rooms.delete(code);
      console.log(`[Room Closed] ${code} deleted (empty)`);
    } else {
      if (room.hostSocketId === socket.id) {
        const nextSocketId = room.users.keys().next().value;
        const newHost = room.users.get(nextSocketId);
        if (newHost) {
          newHost.isHost = true;
          room.hostSocketId = nextSocketId;
          io.to(nextSocketId).emit('promoted-to-host');
          io.to(code).emit('host-changed', { newHostUsername: newHost.username, newHostSocketId: nextSocketId });
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
server.listen(PORT, () => {
  console.log(`
  ======================================================
  🍿 CINE-PARTY WATCH PARTY & SHARED BROWSER IS RUNNING! 🎬
  ======================================================
  Local Server: http://localhost:${PORT}
  PeerServer WebRTC: /peerjs mounted natively
  Room Signaling: Socket.io Enabled
  ======================================================
  `);
});
