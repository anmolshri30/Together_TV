/* ==========================================================================
   CINE-PARTY MAIN APPLICATION CONTROLLER
   Handles Socket.io Rooms, Velvet Curtain Animations, Reactions, Chat & UI Flow
   Production Reconnect Recovery, Room Limits & WebRTC Diagnostics Panel
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  // Dynamic Socket.io connection utilizing current origin
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

  // ==================== DEBUG MODE PANEL (?debug=1) ====================
  const urlParams = new URLSearchParams(window.location.search);
  const isDebugMode = urlParams.get('debug') === '1' || localStorage.getItem('cineparty_debug') === '1';

  let debugPanel = null;
  if (isDebugMode) {
    debugPanel = document.createElement('div');
    debugPanel.id = 'debug-diagnostics-panel';
    debugPanel.className = 'debug-panel';
    document.body.appendChild(debugPanel);
    console.log('[Debug Mode Active] Diagnostic HUD mounted in viewport.');
  }

  function updateDebugPanel() {
    if (!isDebugMode || !debugPanel) return;

    const transportName = socket.connected && socket.io && socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : 'none';
    const peerDiagnostics = webrtc.getPeerDiagnostics();

    let peersHtml = '';
    if (peerDiagnostics.length === 0) {
      peersHtml = '<div class="debug-row muted">No active WebRTC peers</div>';
    } else {
      peerDiagnostics.forEach((p, idx) => {
        peersHtml += `
          <div class="debug-peer-card">
            <div class="debug-peer-header">Peer #${idx + 1} (${p.socketId.substring(0, 6)}...):</div>
            <div class="debug-subrow">Conn: <span class="badge-${p.connectionState}">${p.connectionState}</span></div>
            <div class="debug-subrow">ICE: <span class="badge-${p.iceConnectionState}">${p.iceConnectionState}</span></div>
            <div class="debug-subrow">Sig: <span>${p.signalingState}</span></div>
            <div class="debug-subrow">Media: Video ${p.hasRemoteVideo ? '✅' : '❌'} | Audio ${p.hasRemoteAudio ? '✅' : '❌'}</div>
          </div>
        `;
      });
    }

    debugPanel.innerHTML = `
      <div class="debug-header">🛠️ Cine-Party Diagnostics</div>
      <div class="debug-row">Socket: <strong class="${socket.connected ? 'text-green' : 'text-red'}">${socket.connected ? 'CONNECTED' : 'DISCONNECTED'}</strong> (${transportName})</div>
      <div class="debug-row">Role: <strong>${isHost ? '🎬 HOST' : '🎟️ GUEST'}</strong></div>
      <div class="debug-row">Room: <strong>${currentRoomCode || 'None'}</strong> (${roomUsers.length}/4)</div>
      <div class="debug-row">Screen Share: <strong>${webrtc.isSharing ? 'ACTIVE' : 'OFF'}</strong></div>
      <div class="debug-section-title">WebRTC Peers (${peerDiagnostics.length}/3):</div>
      ${peersHtml}
    `;
  }

  if (isDebugMode) {
    setInterval(updateDebugPanel, 1000);
    webrtc.onDiagnosticsUpdate = updateDebugPanel;
  }

  // ==================== SOCKET.IO LIFECYCLE HANDLERS ====================
  socket.on('connect', () => {
    const transportName = socket.io.engine.transport.name;
    console.log(`[Socket] Connected! ID: ${socket.id} | Transport: ${transportName}`);
    updateDebugPanel();

    const savedRoom = sessionStorage.getItem('cp_roomCode');
    const savedName = sessionStorage.getItem('cp_username');
    const savedIsHost = sessionStorage.getItem('cp_isHost') === 'true';

    if (savedRoom && currentRoomCode) {
      console.log(`[Socket Reconnect] Restoring room session for ${savedRoom}...`);
      socket.emit('rejoin-room', {
        roomCode: savedRoom,
        username: savedName,
        wasHost: savedIsHost
      });
    }
  });

  socket.io.engine.on('upgrade', (transport) => {
    console.log(`[Socket Upgrade] Transport upgraded to: ${transport.name}`);
    updateDebugPanel();
  });

  socket.on('connect_error', (err) => {
    console.error('[Socket Connection Error]:', err.message);
    updateDebugPanel();
    showToast(`🔌 Connection notice: ${err.message}. Reconnecting...`);
  });

  socket.on('disconnect', (reason) => {
    console.warn(`[Socket Disconnected] Reason: ${reason}`);
    updateDebugPanel();
    if (reason === 'io server disconnect') {
      socket.connect();
    }
    if (currentRoomCode) {
      showToast('📡 Connection momentarily lost. Re-establishing link...');
    }
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log(`[Socket Reconnected] Successfully reconnected on attempt ${attemptNumber}`);
    showToast('✅ Reconnected to theatre server!');
    updateDebugPanel();
  });

  socket.on('reconnect_failed', () => {
    showToast('❌ Reconnect failed. Please refresh your browser.');
    updateDebugPanel();
  });

  // ==================== LOBBY & ROOM ROUTING ====================

  // Create Room Click (Host)
  btnCreateRoom.addEventListener('click', () => {
    const name = usernameInput.value.trim() || 'Director Host 🎬';
    triggerCurtainTransition('Creating VIP Theatre Room...', () => {
      socket.emit('create-room', { username: name });
    });
  });

  // Join Room Click (Guest)
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

  function enterRoomView(roomCode, hostStatus, userObj, roomState) {
    currentRoomCode = roomCode;
    isHost = hostStatus;
    currentUser = userObj;
    webrtc.isHost = hostStatus;
    player.isHost = hostStatus;

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
    updateDebugPanel();
  }

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
    console.log(`[HOST WEBRTC] Room Created: ${roomCode} by ${user.username}`);
    enterRoomView(roomCode, hostFlag, user, roomState);
    updateAudienceList(roomState.users);
  });

  // 1. Guest joins room
  socket.on('room-joined', ({ roomCode, isHost: hostFlag, user, roomState }) => {
    console.log(`[GUEST WEBRTC] Event 1: Guest joined room ${roomCode} (Host: ${hostFlag})`);
    enterRoomView(roomCode, hostFlag, user, roomState);
    updateAudienceList(roomState.users);

    if (roomState.currentUrl && roomState.mode !== 'screenshare') {
      player.loadUrl(roomState.currentUrl, roomState.mode, false);
    }

    // 2. Guest sends request-host-stream if host is already sharing
    if (roomState.isScreenSharing) {
      document.getElementById('placeholder-title').textContent = 'Live Host Screen Stream';
      document.getElementById('placeholder-desc').textContent = 'Connecting low-latency stream...';

      console.log(`[GUEST WEBRTC] [${new Date().toISOString()}] Event 2: request-host-stream SENT (socket: ${socket.id}, room: ${roomCode})`);
      socket.emit('request-host-stream');
    } else {
      document.getElementById('placeholder-title').textContent = 'Host Screen Share Stage';
      document.getElementById('placeholder-desc').textContent = 'Host has not started sharing yet.';
    }
  });

  socket.on('join-error', ({ code, message }) => {
    openCurtains();
    if (code === 'ROOM_FULL') {
      showToast('🚫 This room is full. Maximum 3 guests are allowed.');
    } else {
      showToast(`❌ ${message || 'Failed to join room'}`);
    }
  });

  socket.on('rejoin-error', ({ message }) => {
    sessionStorage.removeItem('cp_roomCode');
    sessionStorage.removeItem('cp_username');
    sessionStorage.removeItem('cp_isHost');
    showToast(`⚠️ ${message || 'Room session expired.'}`);
    viewRoom.classList.remove('active');
    viewHome.classList.add('active');
    openCurtains();
  });

  socket.on('promoted-to-host', () => {
    isHost = true;
    webrtc.isHost = true;
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
    updateDebugPanel();
  });

  socket.on('host-changed', ({ newHostUsername }) => {
    addSystemChatMessage(`🎬 ${newHostUsername} is now the Director Host!`);
  });

  socket.on('user-joined', ({ user, users }) => {
    updateAudienceList(users);
    addSystemChatMessage(`🎟️ ${user.username} entered the theatre!`);

    // If host is actively sharing, connect to newly joined guest
    if (isHost && webrtc.isSharing && user.socketId) {
      console.log(`[HOST WEBRTC] New guest ${user.socketId} joined while sharing. Initiating connection...`);
      webrtc.connectToSingleUser(user.socketId);
    }
    updateDebugPanel();
  });

  socket.on('user-left', ({ socketId, username, users }) => {
    updateAudienceList(users);
    addSystemChatMessage(`👋 ${username} left the theatre.`);
    webrtc.closeSinglePeerConnection(socketId);
    updateDebugPanel();
  });

  socket.on('screen-share-status', ({ isSharing }) => {
    console.log(`[${isHost ? 'HOST WEBRTC' : 'GUEST WEBRTC'}] screen-share-status received: isSharing = ${isSharing}`);

    if (!isHost) {
      if (isSharing) {
        document.getElementById('placeholder-title').textContent = 'Live Host Screen Stream';
        document.getElementById('placeholder-desc').textContent = 'Connecting low-latency stream...';
      } else {
        document.getElementById('placeholder-title').textContent = 'Host Screen Share Stage';
        document.getElementById('placeholder-desc').textContent = 'Host has not started sharing yet.';
        webrtc.clearVideo();
      }
    }
    updateDebugPanel();
  });

  socket.on('sync-navigation', ({ url, mode }) => {
    if (!isHost) {
      player.loadUrl(url, mode, false);
      showToast(`🌐 Stage view updated to ${mode.toUpperCase()}`);
    }
  });

  socket.on('sync-playback', ({ action, time }) => {
    if (!isHost) {
      player.handleSyncPlayback(action, time);
    }
  });

  socket.on('lights-toggled', ({ dimmed }) => {
    document.body.classList.toggle('lights-dimmed', dimmed);
    lightsBtnText.textContent = dimmed ? 'Brighten' : 'Dim Lights';
  });

  socket.on('receive-reaction', ({ emoji, xPos }) => {
    spawnFloatingEmoji(emoji, xPos);
  });

  socket.on('receive-chat', (msgData) => {
    renderChatMessage(msgData);
  });

  // ==================== SCREEN SHARE & HOST CONTROLS ====================
  async function handleScreenShareToggle() {
    if (!isHost) {
      showToast('⚠️ Only the Room Host can broadcast screen & audio!');
      return;
    }

    if (webrtc.isSharing) {
      webrtc.stopScreenShare();
      deckShareText.textContent = 'Share Screen';
      showToast('⏹️ Screen sharing stopped.');
    } else {
      const currentParticipants = roomUsers || [];
      const success = await webrtc.startScreenShare(currentParticipants);
      if (success) {
        deckShareText.textContent = 'Stop Share';
      }
    }
    updateDebugPanel();
  }

  if (btnStartShareCta) btnStartShareCta.addEventListener('click', handleScreenShareToggle);
  if (btnDeckShare) btnDeckShare.addEventListener('click', handleScreenShareToggle);

  btnToggleLights.addEventListener('click', () => {
    const isDimmed = document.body.classList.contains('lights-dimmed');
    socket.emit('toggle-lights', { dimmed: !isDimmed });
  });

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

    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.textContent = msg.username;

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

  // Mobile Drawer Toggle Button
  const btnMobileChat = document.getElementById('btn-toggle-mobile-chat');
  const theatreSidebar = document.getElementById('theatre-sidebar');
  const mobileChatBadge = document.getElementById('mobile-chat-badge');

  if (btnMobileChat && theatreSidebar) {
    btnMobileChat.addEventListener('click', () => {
      theatreSidebar.classList.toggle('mobile-open');
      const isOpen = theatreSidebar.classList.contains('mobile-open');
      btnMobileChat.classList.toggle('active', isOpen);
      if (isOpen && mobileChatBadge) {
        mobileChatBadge.classList.add('hidden');
      }
    });
  }

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
