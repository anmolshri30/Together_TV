/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for Host -> Maximum 3 Guests Architecture
   Unique Negotiation IDs, Per-Peer Negotiation Lock & Defensive State Guards
   ========================================================================== */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.remoteMediaStream = null; // Accumulated remote stream on guest
    this.peerConnections = new Map(); // targetSocketId -> RTCPeerConnection
    this.peerStates = new Map(); // targetSocketId -> { pc, negotiationInProgress: boolean, currentNegotiationId: string | null }
    this.iceCandidatesQueue = new Map(); // targetSocketId -> Array of RTCIceCandidate
    this.isSharing = false;
    this.isHost = false;
    this.signalingInitialized = false;

    this.videoElement = document.getElementById('remote-stream-video');
    this.placeholderEl = document.getElementById('screenshare-placeholder');

    // Production ICE Server Topology (STUN + Multi-Port TURN Fallbacks)
    this.iceConfig = {
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
      iceServers: [
        // Google Public STUN
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Cloudflare Public STUN
        { urls: 'stun:stun.cloudflare.com:3478' },
        // Twilio Public STUN
        { urls: 'stun:global.stun.twilio.com:3478' },
        // Metered.ca OpenRelay TURN Fallback (Ports 80 & 443 TCP/UDP)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:80?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        // Backup Viagenie TURN Fallback
        {
          urls: 'turn:numb.viagenie.ca',
          username: 'webrtc@live.com',
          credential: 'muazkh'
        }
      ]
    };

    // Diagnostic callback for HUD
    this.onDiagnosticsUpdate = null;

    this.initSocketSignaling();
  }

  getRoleTag() {
    return this.isHost ? 'HOST WEBRTC' : 'GUEST WEBRTC';
  }

  // ==================== 1. PER-PEER NEGOTIATION STATE ====================
  getOrCreatePeerState(targetSocketId) {
    if (!this.peerStates.has(targetSocketId)) {
      this.peerStates.set(targetSocketId, {
        pc: null,
        negotiationInProgress: false,
        currentNegotiationId: null
      });
    }
    return this.peerStates.get(targetSocketId);
  }

  generateNegotiationId() {
    if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'neg-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 9);
  }

  // ==================== 2. DIAGNOSTICS LOGGER ====================
  logPeerState(targetSocketId, actionName, extra = {}) {
    const tag = this.getRoleTag();
    const pc = this.peerConnections.get(targetSocketId);

    if (!pc) {
      console.log(`[${tag}] [${actionName}] Peer: ${targetSocketId} (No RTCPeerConnection)`, extra);
      return;
    }

    const localTracks = this.localStream ? this.localStream.getTracks().length : 0;
    let remoteTracks = 0;
    try {
      const receivers = pc.getReceivers ? pc.getReceivers() : [];
      remoteTracks = receivers.filter(r => r.track && r.track.readyState === 'live').length;
    } catch (e) {
      remoteTracks = 0;
    }

    console.log(`[${tag}] Peer state`, {
      peerId: targetSocketId,
      role: this.isHost ? 'HOST' : 'GUEST',
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
      localTracksCount: localTracks,
      remoteTracksCount: remoteTracks,
      ...extra
    });

    if (typeof this.onDiagnosticsUpdate === 'function') {
      this.onDiagnosticsUpdate();
    }
  }

  getPeerDiagnostics() {
    const diagnostics = [];
    this.peerConnections.forEach((pc, socketId) => {
      let remoteVideo = false;
      let remoteAudio = false;

      try {
        const receivers = pc.getReceivers ? pc.getReceivers() : [];
        receivers.forEach(r => {
          if (r.track && r.track.readyState === 'live') {
            if (r.track.kind === 'video') remoteVideo = true;
            if (r.track.kind === 'audio') remoteAudio = true;
          }
        });
      } catch (e) {}

      diagnostics.push({
        socketId,
        connectionState: pc.connectionState || 'unknown',
        iceConnectionState: pc.iceConnectionState || 'unknown',
        iceGatheringState: pc.iceGatheringState || 'unknown',
        signalingState: pc.signalingState || 'unknown',
        hasRemoteVideo: remoteVideo,
        hasRemoteAudio: remoteAudio
      });
    });
    return diagnostics;
  }

  // ==================== 3. ICE CANDIDATE QUEUE ====================
  async processIceCandidateQueue(targetSocketId, pc) {
    const tag = this.getRoleTag();
    const queue = this.iceCandidatesQueue.get(targetSocketId);

    if (queue && queue.length > 0) {
      console.log(`[${tag}] Flushing ICE candidate queue for ${targetSocketId} (${queue.length} candidate(s))`);
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          const candidateType = candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown');
          console.log(`[${tag}] Queued ICE candidate applied for ${targetSocketId}`, {
            candidateType,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
          });
        } catch (err) {
          console.warn(`[${tag}] Error adding queued ICE candidate for ${targetSocketId}:`, err);
        }
      }
      this.iceCandidatesQueue.delete(targetSocketId);
    }
  }

  // ==================== 4. SOCKET.IO SIGNALING LISTENERS ====================
  initSocketSignaling() {
    // Singleton guard to prevent duplicate listener registration
    if (this.signalingInitialized) {
      console.warn('[WebRTC] Signaling listeners already initialized. Skipping.');
      return;
    }
    this.signalingInitialized = true;
    console.log('[WebRTC] Initializing Socket.IO WebRTC signaling listeners (once)...');

    // 5. Host receives guest-requested-stream
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      console.log(`[HOST WEBRTC] Event 5: Host received guest-requested-stream from Guest (${guestSocketId})`);
      if (this.isSharing && this.localStream) {
        console.log(`[HOST WEBRTC] Active stream available. Checking negotiation lock for Guest (${guestSocketId})...`);
        this.connectToSingleUser(guestSocketId);
      } else {
        console.log(`[HOST WEBRTC] Host is not currently screen sharing. Request from Guest (${guestSocketId}) held.`);
      }
    });

    // 12. Guest receives webrtc-offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer, negotiationId }) => {
      console.log('[GUEST WEBRTC] OFFER RECEIVED', {
        peerId: senderSocketId,
        negotiationId: negotiationId || 'none'
      });

      // 13. Guest creates or reuses RTCPeerConnection
      const pc = this.createPeerConnection(senderSocketId);

      try {
        // 14. Guest sets remote description
        console.log(`[GUEST WEBRTC] Setting remote description (offer) from Host (${senderSocketId})`);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.logPeerState(senderSocketId, 'Guest Remote Description Set');

        // Flush any queued ICE candidates
        await this.processIceCandidateQueue(senderSocketId, pc);

        // 15. Guest creates answer
        console.log(`[GUEST WEBRTC] Creating answer for Host (${senderSocketId})`);
        const answer = await pc.createAnswer();

        // 16. Guest sets local description
        console.log(`[GUEST WEBRTC] Setting local description (answer)`);
        await pc.setLocalDescription(answer);
        this.logPeerState(senderSocketId, 'Guest Local Description Set');

        // 17. Guest sends webrtc-answer with negotiationId
        console.log('[GUEST WEBRTC] ANSWER SENT', {
          peerId: senderSocketId,
          negotiationId: negotiationId || 'none'
        });

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription,
          negotiationId
        });
      } catch (err) {
        console.error(`[GUEST WEBRTC] Offer Handling Error from ${senderSocketId}:`, err);
        this.logPeerState(senderSocketId, 'Offer Handling Failed', { error: err.message });
      }
    });

    // 18. Host receives webrtc-answer
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer, negotiationId }) => {
      const pc = this.peerConnections.get(senderSocketId);
      const peerState = this.getOrCreatePeerState(senderSocketId);

      console.log('[HOST WEBRTC] ANSWER RECEIVED', {
        peerId: senderSocketId,
        negotiationId: negotiationId || 'none',
        signalingState: pc ? pc.signalingState : 'no-pc'
      });

      if (!pc) {
        console.warn(`[HOST WEBRTC] Received answer from ${senderSocketId} but no RTCPeerConnection exists.`);
        peerState.negotiationInProgress = false;
        return;
      }

      // PREVENT DUPLICATE ANSWERS: Defensive state check
      if (pc.signalingState !== 'have-local-offer') {
        console.warn('[HOST WEBRTC] Ignoring unexpected answer', {
          peerId: senderSocketId,
          negotiationId,
          currentSignalingState: pc.signalingState
        });
        return;
      }

      // Verify negotiationId matches current offer in flight
      if (peerState.currentNegotiationId && negotiationId && peerState.currentNegotiationId !== negotiationId) {
        console.warn('[HOST WEBRTC] Ignoring stale answer with negotiationId:', negotiationId, 'current active offer id is:', peerState.currentNegotiationId);
        return;
      }

      try {
        // 19. Host sets remote description
        console.log(`[HOST WEBRTC] Setting remote description (answer) from Guest (${senderSocketId})`);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));

        // Unlock negotiation upon successful answer application
        peerState.negotiationInProgress = false;
        peerState.currentNegotiationId = null;

        console.log('[HOST WEBRTC] ANSWER APPLIED', {
          peerId: senderSocketId,
          negotiationId: negotiationId || 'none',
          signalingState: pc.signalingState
        });

        this.logPeerState(senderSocketId, 'Host Remote Description Set (Answer Applied)');

        // Flush any queued ICE candidates on host
        await this.processIceCandidateQueue(senderSocketId, pc);
      } catch (err) {
        peerState.negotiationInProgress = false;
        console.error(`[HOST WEBRTC] Answer Handling Error from ${senderSocketId}:`, err);
        this.logPeerState(senderSocketId, 'Answer Handling Failed', { error: err.message });
      }
    });

    // 22. ICE candidate received (Host or Guest)
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const tag = this.getRoleTag();
      const pc = this.peerConnections.get(senderSocketId);
      if (!candidate) return;

      const candidateType = candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown');

      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`[${tag}] ICE candidate applied directly for ${senderSocketId}`, { candidateType });
        } catch (err) {
          console.warn(`[${tag}] Failed adding direct ICE candidate from ${senderSocketId}:`, err);
        }
      } else {
        if (!this.iceCandidatesQueue.has(senderSocketId)) {
          this.iceCandidatesQueue.set(senderSocketId, []);
        }
        this.iceCandidatesQueue.get(senderSocketId).push(candidate);
        console.log(`[${tag}] ICE candidate queued for ${senderSocketId} (remote description pending)`, {
          queueLength: this.iceCandidatesQueue.get(senderSocketId).length
        });
      }
    });
  }

  // ==================== 5. CREATE / REUSE PEER CONNECTION ====================
  createPeerConnection(targetSocketId) {
    const tag = this.getRoleTag();
    const existingPc = this.peerConnections.get(targetSocketId);

    // PREVENT DUPLICATE PEER CONNECTIONS: If a healthy connection already exists, reuse it!
    if (existingPc) {
      if (existingPc.connectionState !== 'closed' && existingPc.connectionState !== 'failed') {
        console.log(`[${tag}] Reusing existing active RTCPeerConnection for ${targetSocketId}`, {
          connectionState: existingPc.connectionState,
          iceConnectionState: existingPc.iceConnectionState,
          signalingState: existingPc.signalingState
        });
        return existingPc;
      }
      console.log(`[${tag}] Closing defunct/failed RTCPeerConnection for ${targetSocketId} before re-creating`);
      this.closeSinglePeerConnection(targetSocketId);
    }

    console.log(`[${tag}] CREATE peer ${targetSocketId}`);
    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(targetSocketId, pc);

    const peerState = this.getOrCreatePeerState(targetSocketId);
    peerState.pc = pc;

    console.log(`[${tag}] Active peers:`, Array.from(this.peerConnections.keys()));
    this.logPeerState(targetSocketId, 'PeerConnection Initialized');

    // ICE candidate gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const cType = event.candidate.type || (event.candidate.candidate ? event.candidate.candidate.split(' ')[7] : 'unknown');
        console.log(`[${tag}] Local ICE candidate gathered (${cType}) -> sending to ${targetSocketId}`);

        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      } else {
        console.log(`[${tag}] All local ICE candidates gathered for ${targetSocketId}.`);
      }
    };

    // 29. ontrack fires (Guest side)
    pc.ontrack = (event) => {
      console.log(`[GUEST WEBRTC] ontrack: ${event.track.kind}`);
      console.log('[GUEST WEBRTC] Track details:', {
        kind: event.track.kind,
        enabled: event.track.enabled,
        readyState: event.track.readyState,
        muted: event.track.muted,
        id: event.track.id
      });

      let remoteStream = (event.streams && event.streams[0]) ? event.streams[0] : null;

      if (!remoteStream) {
        if (!this.remoteMediaStream) {
          this.remoteMediaStream = new MediaStream();
        }
        this.remoteMediaStream.addTrack(event.track);
        remoteStream = this.remoteMediaStream;
      } else {
        this.remoteMediaStream = remoteStream;
      }

      console.log('[GUEST WEBRTC] Remote stream ready:', remoteStream);
      console.log('[GUEST WEBRTC] Remote stream tracks:', {
        video: remoteStream.getVideoTracks().length,
        audio: remoteStream.getAudioTracks().length
      });

      this.attachRemoteStreamToGuest(remoteStream);
    };

    // Monitor ICE state
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[${tag}] iceConnectionState changed -> ${state} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `iceConnectionState: ${state}`);

      if (state === 'failed') {
        console.warn(`[${tag}] ICE Connection failed for ${targetSocketId}. Attempting restartIce()...`);
        const pState = this.getOrCreatePeerState(targetSocketId);
        pState.negotiationInProgress = false;
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (state === 'connected' || state === 'completed') {
        console.log(`[${tag}] ✅ WebRTC P2P ICE connected successfully with ${targetSocketId}!`);
      }
    };

    // Monitor connection state
    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      console.log(`[${tag}] connectionState changed -> ${connState} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `connectionState: ${connState}`);

      if (connState === 'failed') {
        const pState = this.getOrCreatePeerState(targetSocketId);
        pState.negotiationInProgress = false;
      } else if (connState === 'closed') {
        console.log(`[${tag}] Connection closed with ${targetSocketId}`);
      }
    };

    pc.onicegatheringstatechange = () => {
      this.logPeerState(targetSocketId, `iceGatheringState: ${pc.iceGatheringState}`);
    };

    pc.onsignalingstatechange = () => {
      this.logPeerState(targetSocketId, `signalingState: ${pc.signalingState}`);
    };

    // Attach local tracks if Host is broadcasting
    if (this.isHost && this.localStream) {
      const videoTracks = this.localStream.getVideoTracks();
      const audioTracks = this.localStream.getAudioTracks();

      videoTracks.forEach((track) => {
        console.log(`[HOST WEBRTC] Adding local video track to peer ${targetSocketId}:`, track.id);
        pc.addTrack(track, this.localStream);
      });

      audioTracks.forEach((track) => {
        console.log(`[HOST WEBRTC] Adding local audio track to peer ${targetSocketId}:`, track.id);
        pc.addTrack(track, this.localStream);
      });
    }

    return pc;
  }

  closeSinglePeerConnection(targetSocketId) {
    const pc = this.peerConnections.get(targetSocketId);
    if (pc) {
      try {
        console.log(`[WebRTC] CLOSE peer ${targetSocketId}`);
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        pc.onconnectionstatechange = null;
        pc.onsignalingstatechange = null;
        pc.onicegatheringstatechange = null;
        pc.close();
      } catch (e) {
        console.warn(`[WebRTC] Error closing peer connection for ${targetSocketId}:`, e);
      }
      this.peerConnections.delete(targetSocketId);
    }
    this.peerStates.delete(targetSocketId);
    this.iceCandidatesQueue.delete(targetSocketId);
  }

  // ==================== 6. CROSS-BROWSER GETDISPLAYMEDIA ====================
  async getDisplayMediaSafe() {
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    const videoConstraints = {
      frameRate: { ideal: 30, max: 60 }
    };

    if (!isFirefox && !isSafari) {
      videoConstraints.displaySurface = 'browser';
    }

    const audioConstraints = (isFirefox || isSafari) ? true : {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 44100
    };

    try {
      console.log('[HOST WEBRTC] Requesting getDisplayMedia with video + audio...');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: audioConstraints
      });
      return stream;
    } catch (audioErr) {
      console.warn('[HOST WEBRTC] Audio capture constraint failed. Retrying video only:', audioErr.message);
      try {
        const videoOnlyStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false
        });
        return videoOnlyStream;
      } catch (videoErr) {
        throw videoErr;
      }
    }
  }

  // ==================== 7. START / STOP SCREEN SHARE (HOST) ====================
  async startScreenShare(userList = []) {
    this.isHost = true;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        if (typeof showToast === 'function') {
          showToast('⚠️ Screen sharing requires HTTPS or localhost!');
        }
        return false;
      }

      const stream = await this.getDisplayMediaSafe();
      this.localStream = stream;
      this.isSharing = true;

      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();

      // VERIFY STREAM TRACKS
      console.log('[HOST WEBRTC] Captured stream', {
        videoTracks: videoTracks.length,
        audioTracks: audioTracks.length
      });

      stream.getTracks().forEach((track, idx) => {
        console.log(`[HOST WEBRTC] Captured track #${idx + 1}`, {
          kind: track.kind,
          enabled: track.enabled,
          readyState: track.readyState,
          muted: track.muted,
          settings: track.getSettings ? track.getSettings() : {}
        });
      });

      if (audioTracks.length > 0) {
        if (typeof showToast === 'function') {
          showToast('🔊 Screen & Tab Audio Sharing Started Live!');
        }
      } else {
        if (typeof showToast === 'function') {
          showToast('🖥️ Video captured. Note: Tab audio was not selected in browser picker.');
        }
      }

      // Host local preview (Muted)
      this.attachLocalStreamToHost(stream);

      // Handle native stop share bar
      if (videoTracks.length > 0) {
        videoTracks[0].onended = () => {
          console.log('[HOST WEBRTC] Host stopped sharing via browser bar');
          this.stopScreenShare();
        };
      }

      // Connect to all active participants in room
      console.log(`[HOST WEBRTC] Initiating stream offer to ${userList.length} participant(s)...`);
      for (const user of userList) {
        if (user.socketId && user.socketId !== this.socket.id) {
          await this.connectToSingleUser(user.socketId);
        }
      }

      this.socket.emit('screen-share-status', { isSharing: true });
      return true;
    } catch (err) {
      console.error('[HOST WEBRTC] Screen capture failed or permission denied:', err);
      if (typeof showToast === 'function') {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showToast('⚠️ Screen share permission denied.');
        } else {
          showToast(`⚠️ Screen share error: ${err.message}`);
        }
      }
      return false;
    }
  }

  // Host creates connection with Negotiation Lock and sends Offer
  async connectToSingleUser(targetSocketId) {
    if (!this.localStream) {
      console.warn(`[HOST WEBRTC] Cannot connect to ${targetSocketId}: localStream is null`);
      return;
    }

    const tracks = this.localStream.getTracks();
    if (tracks.length === 0) {
      console.warn(`[HOST WEBRTC] Cannot connect to ${targetSocketId}: localStream has 0 tracks`);
      return;
    }

    // NEGOTIATION LOCK CHECK: Prevent simultaneous offers to same peer
    const peerState = this.getOrCreatePeerState(targetSocketId);
    if (peerState.negotiationInProgress) {
      console.warn('[HOST WEBRTC] Negotiation already in progress for peer:', targetSocketId, {
        activeNegotiationId: peerState.currentNegotiationId
      });
      return;
    }

    // Create or reuse RTCPeerConnection
    const pc = this.createPeerConnection(targetSocketId);

    // If existing connection is already stable and active, check if renegotiation is needed
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
      console.warn(`[HOST WEBRTC] Cannot create offer for ${targetSocketId}: signalingState is ${pc.signalingState}`);
      return;
    }

    // Generate unique negotiationId and acquire lock
    const negotiationId = this.generateNegotiationId();
    peerState.negotiationInProgress = true;
    peerState.currentNegotiationId = negotiationId;

    // VERIFY RTCPeerConnection TRACKS
    console.log('[HOST WEBRTC] Senders before offer', pc.getSenders().map(sender => ({
      kind: sender.track?.kind,
      readyState: sender.track?.readyState
    })));

    try {
      console.log(`[HOST WEBRTC] Creating offer for Guest (${targetSocketId}) [negId: ${negotiationId}]`);
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });

      await pc.setLocalDescription(offer);

      console.log('[HOST WEBRTC] OFFER SENT', {
        peerId: targetSocketId,
        negotiationId,
        signalingState: pc.signalingState
      });

      this.socket.emit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: pc.localDescription,
        negotiationId
      });
    } catch (err) {
      peerState.negotiationInProgress = false;
      peerState.currentNegotiationId = null;
      console.error(`[HOST WEBRTC] Offer Generation Error for ${targetSocketId}:`, err);
      this.logPeerState(targetSocketId, 'Offer Generation Failed', { error: err.message });
    }
  }

  stopScreenShare() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      this.localStream = null;
    }

    this.isSharing = false;

    this.peerConnections.forEach((pc, socketId) => {
      this.closeSinglePeerConnection(socketId);
    });
    this.peerConnections.clear();
    this.peerStates.clear();
    this.iceCandidatesQueue.clear();

    this.clearVideo();
    this.socket.emit('screen-share-status', { isSharing: false });
    console.log('[HOST WEBRTC] Screen sharing stopped and peer connections closed.');
  }

  // ==================== 8. VIDEO DISPLAY & AUTOPLAY ====================
  attachLocalStreamToHost(stream) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';
      this.videoElement.muted = true; // Host muted locally

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => console.warn('[HOST WEBRTC] Local video playback notice:', e));
      }
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
  }

  // Remote stream attached to video element (Guest side)
  attachRemoteStreamToGuest(remoteStream) {
    if (this.videoElement) {
      if (this.videoElement.srcObject !== remoteStream) {
        console.log('[GUEST WEBRTC] Attaching remote stream');
        this.videoElement.srcObject = remoteStream;
        this.videoElement.style.display = 'block';
        this.videoElement.muted = false;
        console.log('[GUEST WEBRTC] Remote stream attached');

        const playPromise = this.videoElement.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log('[GUEST WEBRTC] Remote video playing');
            })
            .catch((err) => {
              console.error('[GUEST WEBRTC] Video play failed', err);
              console.log('[GUEST WEBRTC] Attempting muted fallback playback due to autoplay policy...');
              this.videoElement.muted = true;
              this.videoElement.play()
                .then(() => {
                  console.log('[GUEST WEBRTC] Remote video playing (muted)');
                  if (typeof showToast === 'function') {
                    showToast('🔊 Click the theatre stage to unmute live stream audio!');
                  }
                })
                .catch(e => console.error('[GUEST WEBRTC] Muted playback also failed', e));
            });
        }
      }
    } else {
      console.error('[GUEST WEBRTC] Error: videoElement (#remote-stream-video) not found in DOM!');
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
  }

  clearVideo() {
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.style.display = 'none';
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'flex';
    }
  }
}

window.WebRTCManager = WebRTCManager;
