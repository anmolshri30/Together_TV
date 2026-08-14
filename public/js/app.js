/* ==========================================================================
   CINE-PARTY MAIN APPLICATION CONTROLLER
   Handles Socket.io Rooms, Velvet Curtain Animations, Reactions & UI Flow
   Fix #1: io() transport config with reconnection & timeout
   Fix #5: Socket lifecycle handlers (connect_error, disconnect, reconnect)
   Fix #7: Delayed request-host-stream emit
   Fix #8: sessionStorage room recovery on reconnect
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // Fix #1: Explicit transport order, reconnection settings, timeout tuning
  const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    upgrade: true
  });

  // Instantiate Modules
  const webrtc = new WebRTCManager(socket);
  const player = new PlayerManager(socket);
  player.init();

  // App State
  let currentUser = null;
  let currentRoomCode = null;
  let isHost = false;
  let roomUsers = [];

  // DOM Elements
  const viewHome = document.getElementById('view-home');
  const viewRoom = document.getElementById('view-room');
  const curtainOverlay = document.getElementById('curtain-overlay');
  const curtainRoomName = document.getElementById('curtain-room-name');

  const usernameInput = document.getElementById('username-input');
  const roomCodeInput = document.getElementById('room-code-input');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');

  const displayRoomCode = document.getElementById('display-room-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const ticketCodePill = document.getElementById('ticket-code-display');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnToggleLights = document.getElementById('btn-toggle-lights');
  const lightsBtnText = document.getElementById('lights-btn-text');
  const userRoleBadge = document.getElementById('user-role-badge');

  // Screen Share CTA Buttons
  const btnStartShareCta = document.getElementById('btn-start-share-cta');
  const btnDeckShare = document.getElementById('btn-deck-share');
  const deckShareText = document.getElementById('deck-share-text');

  // Floating Reactions Layer
  const reactionsLayer = document.getElementById('floating-reactions-layer');

  // Chat & Sidebar Elements
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatMessagesBox = document.getElementById('chat-messages-box');
  const audienceListUl = document.getElementById('audience-list');
  const audienceCountEl = document.getElementById('audience-count');

  // ==================== FIX #5: SOCKET LIFECYCLE HANDLERS ====================

  socket.on('connect', () => {
    console.log(`[Socket] Connected! ID: ${socket.id} | Transport: ${socket.io.engine.transport.name}`);

    // Fix #8: On reconnect, if we were in a room, rejoin it
    const savedRoom = sessionStorage.getItem('cp_roomCode');
    const savedName = sessionStorage.getItem('cp_username');
    const savedIsHost = sessionStorage.getItem('cp_isHost') === 'true';

    if (savedRoom && currentRoomCode) {
      console.log(`[Socket] Rejoining room ${savedRoom} after reconnect...`);
      if (savedIsHost) {
        socket.emit('create-room', { username: savedName || 'Director Host 🎬' });
      } else {
        socket.emit('rejoin-room', { roomCode: savedRoom, username: savedName });
      }
    }
  });

  // Log transport upgrades
  socket.io.engine.on('upgrade', (transport) => {
    console.log(`[Socket] Transport upgraded to: ${transport.name}`);
  });

  // Fix #5: Show user-friendly connection error toast
  socket.on('connect_error', (err) => {
    console.error('[Socket] Connection error:', err.message);
    showToast(`🔌 Connection error: ${err.message}. Retrying...`);
  });

  // Fix #5: Handle disconnection from server
  socket.on('disconnect', (reason) => {
    console.warn(`[Socket] Disconnected: ${reason}`);
    if (reason === 'io server disconnect') {
      // Server forced disconnect — try manual reconnect
      socket.connect();
    }
    if (currentRoomCode) {
      showToast('📡 Connection lost. Reconnecting...');
    }
  });

  // Fix #5: Handle successful reconnect
  socket.on('reconnect', (attemptNumber) => {
    console.log(`[Socket] Reconnected after ${attemptNumber} attempt(s)`);
    showToast('✅ Reconnected to server!');
  });

  socket.on('reconnect_failed', () => {
    showToast('❌ Could not reconnect. Please refresh the page.');
  });

  // ==================== LOBBY & ROOM ROUTING ====================

  // Create Room Click
  btnCreateRoom.addEventListener('click', () => {
    const name = usernameInput.value.trim() || 'Director Host 🎬';
    triggerCurtainTransition('Creating VIP Theatre Room...', () => {
      socket.emit('create-room', { username: name });
    });
  });

  // Join Room Click
  btnJoinRoom.addEventListener('click', () => {
    const name = usernameInput.value.trim() || 'VIP Guest 🎟️';
    const code = roomCodeInput.value.trim();

    if (!code) {
      showToast('⚠️ Please enter a Theatre Ticket Code to join!');
      return;
    }

    triggerCurtainTransition(`Redeeming Ticket ${code.toUpperCase()}...`, () => {
      socket.emit('join-room', { roomCode: code, username: name });
    });
  });

  // Velvet Curtain Transition Trigger
  function triggerCurtainTransition(titleText, callback) {
    if (curtainRoomName) curtainRoomName.textContent = titleText;
    curtainOverlay.classList.add('closed');

    setTimeout(() => {
      if (typeof callback === 'function') callback();
    }, 1200);
  }

  function openCurtains() {
    setTimeout(() => {
      curtainOverlay.classList.remove('closed');
    }, 400);
  }

  // Switch to Room View
  function enterRoomView(roomCode, hostStatus, userObj, roomState) {
    currentRoomCode = roomCode;
    isHost = hostStatus;
    currentUser = userObj;
    player.isHost = hostStatus;

    // Fix #8: Persist room info to sessionStorage for reconnect recovery
    sessionStorage.setItem('cp_roomCode', roomCode);
    sessionStorage.setItem('cp_username', userObj.username || '');
    sessionStorage.setItem('cp_isHost', hostStatus ? 'true' : 'false');

    displayRoomCode.textContent = roomCode;

    if (isHost) {
      userRoleBadge.className = 'role-badge host-badge';
      userRoleBadge.innerHTML = '<span>🎬 HOST</span>';
      document.getElementById('host-screenshare-cta').classList.remove('hidden');
      document.getElementById('guest-waiting-cta').classList.add('hidden');
      document.getElementById('address-bar-status').classList.remove('hidden');
      document.getElementById('host-controls-deck').style.display = 'flex';
      document.body.classList.remove('is-guest-user');
    } else {
      userRoleBadge.className = 'role-badge guest-badge';
      userRoleBadge.innerHTML = '<span>🎟️ GUEST</span>';
      document.getElementById('host-screenshare-cta').classList.add('hidden');
      document.getElementById('guest-waiting-cta').classList.remove('hidden');
      document.getElementById('host-controls-deck').style.display = 'none';
      document.body.classList.add('is-guest-user');
    }

    viewHome.classList.remove('active');
    viewRoom.classList.add('active');

    openCurtains();
    showToast(`🍿 Welcome to Room ${roomCode}!`);
  }

  // Exit Room — clear session storage
  btnLeaveRoom.addEventListener('click', () => {
    triggerCurtainTransition('Exiting Theatre...', () => {
      sessionStorage.removeItem('cp_roomCode');
      sessionStorage.removeItem('cp_username');
      sessionStorage.removeItem('cp_isHost');
      webrtc.stopScreenShare();
      window.location.reload();
    });
  });

  // ==================== SOCKET.IO EVENT LISTENERS ====================

  // Room Created (Host)
  socket.on('room-created', ({ roomCode, isHost: hostFlag, user, roomState }) => {
    enterRoomView(roomCode, hostFlag, user, roomState);
    updateAudienceList(roomState.users);
  });

  // Room Joined (Participant)
  socket.on('room-joined', ({ roomCode, isHost: hostFlag, user, roomState }) => {
    enterRoomView(roomCode, hostFlag, user, roomState);
    updateAudienceList(roomState.users);

    // Initial state sync
    if (roomState.currentUrl && roomState.mode !== 'screenshare') {
      player.loadUrl(roomState.currentUrl, roomState.mode, false);
    }

    if (roomState.isScreenSharing) {
      document.getElementById('placeholder-title').textContent = 'Live Host Screen Stream';
      document.getElementById('placeholder-desc').textContent = 'Connecting live stream...';

      // Fix #7: Delay request-host-stream to allow server-side roomCode registration to complete
      setTimeout(() => {
        console.log('[Guest] Requesting active WebRTC stream from host...');
        socket.emit('request-host-stream');
      }, 600);
    }
  });

  // Fix #8: Server says room no longer exists after rejoin attempt
  socket.on('rejoin-error', () => {
    sessionStorage.removeItem('cp_roomCode');
    sessionStorage.removeItem('cp_username');
    sessionStorage.removeItem('cp_isHost');
    showToast('⚠️ Your previous room has ended. Please create or join a new one.');
    // Show home view
    viewRoom.classList.remove('active');
    viewHome.classList.add('active');
    openCurtains();
  });

  // Promoted to Host Handler
  socket.on('promoted-to-host', () => {
    isHost = true;
    player.isHost = true;
    sessionStorage.setItem('cp_isHost', 'true');

    userRoleBadge.className = 'role-badge host-badge';
    userRoleBadge.innerHTML = '<span>🎬 HOST</span>';
    document.getElementById('host-screenshare-cta').classList.remove('hidden');
    document.getElementById('guest-waiting-cta').classList.add('hidden');
    document.getElementById('address-bar-status').classList.remove('hidden');
    document.getElementById('host-controls-deck').style.display = 'flex';
    document.body.classList.remove('is-guest-user');

    showToast('👑 You are now the Director Host of this Theatre!');
    addSystemChatMessage('👑 You have been promoted to Room Host!');
  });

  // Host Changed Notice (for other guests)
  socket.on('host-changed', ({ newHostUsername }) => {
    addSystemChatMessage(`🎬 ${newHostUsername} is now the Director Host!`);
  });

  // Join Error
  socket.on('join-error', ({ message }) => {
    openCurtains();
    showToast(`❌ ${message}`);
  });

  // User Joined Room Notice
  socket.on('user-joined', ({ user, users }) => {
    updateAudienceList(users);
    addSystemChatMessage(`🎟️ ${user.username} entered the theatre!`);

    // If host is screen sharing, initiate WebRTC stream to newly joined user
    if (isHost && webrtc.isSharing && user.socketId) {
      console.log(`[Host] New guest ${user.socketId} joined — connecting WebRTC stream`);
      webrtc.connectToSingleUser(user.socketId);
    }
  });

  // User Left Room Notice
  socket.on('user-left', ({ username, users }) => {
    updateAudienceList(users);
    addSystemChatMessage(`👋 ${username} left the theatre.`);
  });

  // Peer Registered
  socket.on('peer-registered', ({ users }) => {
    updateAudienceList(users);
  });

  // Screen Share Status Update
  socket.on('screen-share-status', ({ isSharing }) => {
    if (!isHost) {
      if (isSharing) {
        document.getElementById('placeholder-title').textContent = 'Live Host Screen Stream';
        document.getElementById('placeholder-desc').textContent = 'Connecting live stream...';
      } else {
        document.getElementById('placeholder-title').textContent = 'Host Screen Share Stage';
        document.getElementById('placeholder-desc').textContent = 'Waiting for host to start screen sharing... 🍿';
        webrtc.clearVideo();
      }
    }
  });

  // Sync Navigation (URL & Mode)
  socket.on('sync-navigation', ({ url, mode }) => {
    if (!isHost) {
      player.loadUrl(url, mode, false);
      showToast(`🌐 Host navigated to ${mode.toUpperCase()} view`);
    }
  });

  // Sync Playback (Play/Pause)
  socket.on('sync-playback', ({ action, time }) => {
    if (!isHost) {
      player.handleSyncPlayback(action, time);
    }
  });

  // Dim Lights Sync
  socket.on('lights-toggled', ({ dimmed }) => {
    document.body.classList.toggle('lights-dimmed', dimmed);
    lightsBtnText.textContent = dimmed ? 'Brighten' : 'Dim Lights';
  });

  // Receive Reaction Emoji
  socket.on('receive-reaction', ({ emoji, xPos }) => {
    spawnFloatingEmoji(emoji, xPos);
  });

  // Receive Chat Message
  socket.on('receive-chat', (msgData) => {
    renderChatMessage(msgData);
  });

  // ==================== SCREEN SHARE & HOST CONTROLS ====================

  async function handleScreenShareToggle() {
    if (!isHost) {
      showToast('⚠️ Only the Room Host can start Screen Share!');
      return;
    }

    if (webrtc.isSharing) {
      webrtc.stopScreenShare();
      deckShareText.textContent = 'Share Screen';
      showToast('⏹️ Screen sharing stopped.');
    } else {
      const roomStateUsers = roomUsers || [];
      const success = await webrtc.startScreenShare(roomStateUsers);
      if (success) {
        deckShareText.textContent = 'Stop Share';
        showToast('🍿 Screen & Audio Sharing Started Live!');
      }
    }
  }

  if (btnStartShareCta) btnStartShareCta.addEventListener('click', handleScreenShareToggle);
  if (btnDeckShare) btnDeckShare.addEventListener('click', handleScreenShareToggle);

  // Toggle Lights Button
  btnToggleLights.addEventListener('click', () => {
    const isDimmed = document.body.classList.contains('lights-dimmed');
    socket.emit('toggle-lights', { dimmed: !isDimmed });
  });

  // Copy Ticket Code
  function copyTicketCode() {
    if (!currentRoomCode) return;
    navigator.clipboard.writeText(currentRoomCode).then(() => {
      showToast(`📋 Ticket Code ${currentRoomCode} copied to clipboard!`);
    }).catch(() => {
      showToast(`Ticket Code: ${currentRoomCode}`);
    });
  }

  if (ticketCodePill) ticketCodePill.addEventListener('click', copyTicketCode);
  if (btnCopyCode) btnCopyCode.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTicketCode();
  });

  // ==================== FLOATING EMOJI REACTION SYSTEM ====================

  document.querySelectorAll('.btn-emoji-react').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      socket.emit('send-reaction', { emoji });
    });
  });

  function spawnFloatingEmoji(emoji, xPercentage) {
    if (!reactionsLayer) return;

    const el = document.createElement('span');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    el.style.left = `${xPercentage || Math.random() * 80 + 10}%`;

    reactionsLayer.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3000);
  }

  // ==================== CHAT & AUDIENCE LIST ====================

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) {
      socket.emit('send-chat', { text });
      chatInput.value = '';
    }
  });

  function renderChatMessage(msg) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.isHost ? 'host-bubble' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    // Sanitize username output to prevent XSS
    const safeUsername = document.createTextNode(msg.username);
    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.appendChild(safeUsername);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = msg.timestamp;

    meta.appendChild(senderSpan);
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(timeSpan);

    const textEl = document.createElement('div');
    textEl.className = 'chat-text';
    textEl.textContent = msg.text;

    bubble.appendChild(meta);
    bubble.appendChild(textEl);

    chatMessagesBox.appendChild(bubble);
    chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  }

  function addSystemChatMessage(text) {
    const sys = document.createElement('div');
    sys.className = 'chat-system-msg';
    sys.textContent = text;
    chatMessagesBox.appendChild(sys);
    chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  }

  function updateAudienceList(users) {
    roomUsers = users || [];
    if (audienceCountEl) audienceCountEl.textContent = roomUsers.length;

    if (!audienceListUl) return;
    audienceListUl.innerHTML = '';

    roomUsers.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'audience-member';
      // Use textContent for safe rendering
      const nameSpan = document.createElement('span');
      nameSpan.className = 'aud-name';
      nameSpan.textContent = u.username;
      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'aud-badge';
      badgeSpan.textContent = u.isHost ? '🎬 Host' : '🎟️ Guest';
      li.appendChild(nameSpan);
      li.appendChild(badgeSpan);
      audienceListUl.appendChild(li);
    });
  }

  // Sidebar Tab Switcher (Chat vs Audience)
  document.querySelectorAll('.sidebar-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetSide = tab.getAttribute('data-side');

      document.querySelectorAll('.sidebar-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const sidePanel = document.getElementById(`side-panel-${targetSide}`);
      if (sidePanel) sidePanel.classList.add('active');
    });
  });

  // ==================== TOAST NOTIFICATION UTILITY ====================
  function showToast(message) {
    let container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-30px)';
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3500);
  }

  window.showToast = showToast;
});
