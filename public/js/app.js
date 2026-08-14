/* ==========================================================================
   CINE-PARTY MAIN APPLICATION CONTROLLER
   Handles Socket.io Rooms, Velvet Curtain Animations, Reactions & UI Flow
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

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

  // Socket.io Signaling & WebRTC initialized in WebRTCManager constructor
  
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

    // Update Header UI
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
      document.getElementById('host-controls-deck').style.display = 'none'; // Hide deck controls for guest
      document.body.classList.add('is-guest-user');
    }

    // Switch View Panels
    viewHome.classList.remove('active');
    viewRoom.classList.add('active');

    openCurtains();
    showToast(`🍿 Welcome to Room ${roomCode}!`);
  }

  // Exit Room
  btnLeaveRoom.addEventListener('click', () => {
    triggerCurtainTransition('Exiting Theatre...', () => {
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
    if (roomState.currentUrl) {
      player.loadUrl(roomState.currentUrl, roomState.mode || 'screenshare', false);
    }

    if (roomState.isScreenSharing) {
      document.getElementById('placeholder-title').textContent = 'Live Host Screen Stream';
      document.getElementById('placeholder-desc').textContent = 'Connecting low-latency audio & video stream...';
    }
  });

  // Promoted to Host Handler
  socket.on('promoted-to-host', () => {
    isHost = true;
    player.isHost = true;

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

  // Host Changed Notice
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

    // If host is screen sharing, stream directly to newly joined user
    if (isHost && webrtc.isSharing && user.socketId) {
      console.log(`[Host] Connecting WebRTC stream to new guest: ${user.socketId}`);
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
        document.getElementById('placeholder-desc').textContent = 'Connecting low-latency audio & video stream...';
      } else {
        document.getElementById('placeholder-title').textContent = 'Host Screen Share Stage';
        document.getElementById('placeholder-desc').textContent = 'Waiting for host to start screen sharing...';
        webrtc.clearVideo();
      }
    }
  });

  // Sync Navigation (Url & Mode)
  socket.on('sync-navigation', ({ url, mode }) => {
    if (!isHost) {
      player.loadUrl(url, mode, false);
      showToast(`🌐 Host navigated stage to ${mode.toUpperCase()} view`);
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
  socket.on('receive-reaction', ({ emoji, username, xPos }) => {
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

  // Click Emoji React Buttons
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

    // Remove element after animation finishes
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3000);
  }

  // ==================== CHAT & AUDIENCE LIST ====================

  // Chat Form Submit
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
    meta.innerHTML = `<span class="chat-sender">${msg.username}</span> <span class="chat-time">${msg.timestamp}</span>`;

    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = msg.text;

    bubble.appendChild(meta);
    bubble.appendChild(text);

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
      li.innerHTML = `
        <span class="aud-name">${u.username}</span>
        <span class="aud-badge">${u.isHost ? '🎬 Host' : '🎟️ Guest'}</span>
      `;
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
