/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for Host -> Maximum 3 Guests Architecture
   Comprehensive Production Diagnostics with [HOST WEBRTC] / [GUEST WEBRTC] Logging
   ========================================================================== */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.remoteMediaStream = null; // Accumulated remote stream on guest
    this.peerConnections = new Map(); // targetSocketId -> RTCPeerConnection
    this.iceCandidatesQueue = new Map(); // targetSocketId -> Array of RTCIceCandidate
    this.isSharing = false;
    this.isHost = false;

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

  // ==================== 1. DIAGNOSTICS LOGGER ====================
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

    console.log(`[${tag}] [${actionName}] Peer state`, {
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

  // ==================== 2. ICE CANDIDATE QUEUE ====================
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

  // ==================== 3. SOCKET.IO SIGNALING LISTENERS ====================
  initSocketSignaling() {
    // 5. Host receives guest-requested-stream
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      console.log(`[HOST WEBRTC] Event 5: Host received guest-requested-stream from Guest (${guestSocketId})`);
      if (this.isSharing && this.localStream) {
        console.log(`[HOST WEBRTC] Active stream available. Initiating peer connection to Guest (${guestSocketId})...`);
        this.connectToSingleUser(guestSocketId);
      } else {
        console.log(`[HOST WEBRTC] Host is not currently screen sharing. Request from Guest (${guestSocketId}) held.`);
      }
    });

    // 12. Guest receives webrtc-offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      console.log(`[GUEST WEBRTC] Event 12: Guest received webrtc-offer from Host (${senderSocketId})`);
      
      // 13. Guest creates RTCPeerConnection
      console.log(`[GUEST WEBRTC] Event 13: Guest creating RTCPeerConnection for Host (${senderSocketId})`);
      const pc = this.createPeerConnection(senderSocketId);

      try {
        // 14. Guest sets remote description
        console.log(`[GUEST WEBRTC] Event 14: Guest setting remote description (offer)`);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.logPeerState(senderSocketId, 'Guest Remote Description Set');

        // 24. Flush any queued ICE candidates
        await this.processIceCandidateQueue(senderSocketId, pc);

        // 15. Guest creates answer
        console.log(`[GUEST WEBRTC] Event 15: Guest creating answer`);
        const answer = await pc.createAnswer();

        // 16. Guest sets local description
        console.log(`[GUEST WEBRTC] Event 16: Guest setting local description (answer)`);
        await pc.setLocalDescription(answer);
        this.logPeerState(senderSocketId, 'Guest Local Description Set');

        // 17. Guest sends webrtc-answer
        console.log(`[GUEST WEBRTC] Event 17: Guest sending webrtc-answer to Host (${senderSocketId})`);
        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription
        });
      } catch (err) {
        console.error(`[GUEST WEBRTC] Offer Handling Error from ${senderSocketId}:`, err);
        this.logPeerState(senderSocketId, 'Offer Handling Failed', { error: err.message });
      }
    });

    // 18. Host receives webrtc-answer
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log(`[HOST WEBRTC] Event 18: Host received webrtc-answer from Guest (${senderSocketId})`);
      const pc = this.peerConnections.get(senderSocketId);

      if (pc) {
        try {
          // 19. Host sets remote description
          console.log(`[HOST WEBRTC] Event 19: Host setting remote description (answer) from Guest (${senderSocketId})`);
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          this.logPeerState(senderSocketId, 'Host Remote Description Set (Answer Applied)');

          // 24. Flush any queued ICE candidates on host
          await this.processIceCandidateQueue(senderSocketId, pc);
        } catch (err) {
          console.error(`[HOST WEBRTC] Answer Handling Error from ${senderSocketId}:`, err);
          this.logPeerState(senderSocketId, 'Answer Handling Failed', { error: err.message });
        }
      } else {
        console.warn(`[HOST WEBRTC] Received answer from ${senderSocketId} but no RTCPeerConnection found.`);
      }
    });

    // 22. ICE candidate received (Host or Guest)
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const tag = this.getRoleTag();
      const pc = this.peerConnections.get(senderSocketId);
      if (!candidate) return;

      const candidateType = candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown');
      console.log(`[${tag}] Event 22: ICE candidate received from ${senderSocketId}`, {
        candidateType,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex
      });

      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          // 24. ICE candidate applied
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`[${tag}] Event 24: ICE candidate applied directly for ${senderSocketId}`, { candidateType });
        } catch (err) {
          console.warn(`[${tag}] Failed adding direct ICE candidate from ${senderSocketId}:`, err);
        }
      } else {
        // 23. ICE candidate queued
        if (!this.iceCandidatesQueue.has(senderSocketId)) {
          this.iceCandidatesQueue.set(senderSocketId, []);
        }
        this.iceCandidatesQueue.get(senderSocketId).push(candidate);
        console.log(`[${tag}] Event 23: ICE candidate queued for ${senderSocketId} (remote description pending)`, {
          queueLength: this.iceCandidatesQueue.get(senderSocketId).length
        });
      }
    });
  }

  // ==================== 4. CREATE PEER CONNECTION ====================
  createPeerConnection(targetSocketId) {
    const tag = this.getRoleTag();

    // Close any previous peer connection for this target socket
    if (this.peerConnections.has(targetSocketId)) {
      console.log(`[${tag}] Closing previous RTCPeerConnection for ${targetSocketId}`);
      this.closeSinglePeerConnection(targetSocketId);
    }

    // 6 / 13. Create RTCPeerConnection
    console.log(`[${tag}] Creating new RTCPeerConnection for target: ${targetSocketId}`);
    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(targetSocketId, pc);

    this.logPeerState(targetSocketId, 'PeerConnection Initialized');

    // 20 / 21. ICE candidate generated & sent
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const cType = event.candidate.type || (event.candidate.candidate ? event.candidate.candidate.split(' ')[7] : 'unknown');
        console.log(`[${tag}] Event 20/21: ICE candidate generated & sending to ${targetSocketId}`, {
          candidateType: cType,
          protocol: event.candidate.protocol,
          address: event.candidate.address,
          port: event.candidate.port
        });

        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      } else {
        console.log(`[${tag}] Event 25: All local ICE candidates gathered (null candidate). Gathering complete.`);
      }
    };

    // 29. ontrack fires (Guest side)
    pc.ontrack = (event) => {
      console.log(`[GUEST WEBRTC] Event 29: ontrack fired!`, event.track.kind);
      console.log(`[GUEST WEBRTC] Track details:`, {
        kind: event.track.kind,
        enabled: event.track.enabled,
        readyState: event.track.readyState,
        muted: event.track.muted,
        id: event.track.id
      });

      // 30 / 31 / 32. Remote MediaStream & Tracks
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

      console.log('[GUEST WEBRTC] Event 30: Remote stream ready', remoteStream);
      console.log('[GUEST WEBRTC] Event 31/32: Remote stream track count:', {
        videoTracks: remoteStream.getVideoTracks().length,
        audioTracks: remoteStream.getAudioTracks().length
      });

      // 33. Remote stream attached to video element
      this.attachRemoteStreamToGuest(remoteStream);
    };

    // 25. iceGatheringState
    pc.onicegatheringstatechange = () => {
      console.log(`[${tag}] Event 25: iceGatheringState changed -> ${pc.iceGatheringState} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `iceGatheringState: ${pc.iceGatheringState}`);
    };

    // 26. iceConnectionState
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[${tag}] Event 26: iceConnectionState changed -> ${state} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `iceConnectionState: ${state}`);

      if (state === 'failed') {
        console.warn(`[${tag}] ICE Connection failed for ${targetSocketId}. Triggering restartIce()...`);
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (state === 'connected' || state === 'completed') {
        console.log(`[${tag}] ✅ WebRTC P2P ICE connected successfully with ${targetSocketId}!`);
      }
    };

    // 27. connectionState
    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      console.log(`[${tag}] Event 27: connectionState changed -> ${connState} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `connectionState: ${connState}`);

      if (connState === 'failed') {
        console.error(`[${tag}] RTCPeerConnection failed with ${targetSocketId}`);
      }
    };

    // 28. signalingState
    pc.onsignalingstatechange = () => {
      console.log(`[${tag}] Event 28: signalingState changed -> ${pc.signalingState} for ${targetSocketId}`);
      this.logPeerState(targetSocketId, `signalingState: ${pc.signalingState}`);
    };

    // If Host has active screen stream, attach all tracks to new peer connection
    if (this.isHost && this.localStream) {
      const videoTracks = this.localStream.getVideoTracks();
      const audioTracks = this.localStream.getAudioTracks();

      // 7. Host adds video track
      videoTracks.forEach((track) => {
        console.log(`[HOST WEBRTC] Event 7: Host adding video track to peer ${targetSocketId}`, {
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState
        });
        pc.addTrack(track, this.localStream);
      });

      // 8. Host adds audio track
      audioTracks.forEach((track) => {
        console.log(`[HOST WEBRTC] Event 8: Host adding audio track to peer ${targetSocketId}`, {
          id: track.id,
          enabled: track.enabled,
          readyState: track.readyState
        });
        pc.addTrack(track, this.localStream);
      });
    }

    return pc;
  }

  closeSinglePeerConnection(targetSocketId) {
    const pc = this.peerConnections.get(targetSocketId);
    if (pc) {
      try {
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
    this.iceCandidatesQueue.delete(targetSocketId);
  }

  // ==================== 5. CROSS-BROWSER GETDISPLAYMEDIA ====================
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

  // ==================== 6. START / STOP SCREEN SHARE (HOST) ====================
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

      // Handle browser's native stop share bar
      if (videoTracks.length > 0) {
        videoTracks[0].onended = () => {
          console.log('[HOST WEBRTC] Host stopped sharing via browser bar');
          this.stopScreenShare();
        };
      }

      // Connect to all active participants in room
      console.log(`[HOST WEBRTC] Connecting stream to ${userList.length} participant(s)...`);
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

  // 6 - 11. Host creates connection, attaches tracks, creates offer, sends offer
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

    console.log(`[HOST WEBRTC] Initiating WebRTC handshake with Guest (${targetSocketId})`);
    
    // 6. Host creates RTCPeerConnection (tracks are attached inside createPeerConnection)
    const pc = this.createPeerConnection(targetSocketId);

    // VERIFY RTCPeerConnection TRACKS
    console.log('[HOST WEBRTC] Senders before offer', pc.getSenders().map(sender => ({
      kind: sender.track?.kind,
      readyState: sender.track?.readyState
    })));

    try {
      // 9. Host creates offer
      console.log(`[HOST WEBRTC] Event 9: Host creating offer for Guest (${targetSocketId})`);
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });

      // 10. Host sets local description
      console.log(`[HOST WEBRTC] Event 10: Host setting local description (offer)`);
      await pc.setLocalDescription(offer);
      this.logPeerState(targetSocketId, 'Host Local Description Set (Offer Created)');

      // 11. Host sends webrtc-offer
      console.log(`[HOST WEBRTC] Event 11: Host sending webrtc-offer to Guest (${targetSocketId})`);
      this.socket.emit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: pc.localDescription
      });
    } catch (err) {
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
    this.iceCandidatesQueue.clear();

    this.clearVideo();
    this.socket.emit('screen-share-status', { isSharing: false });
    console.log('[HOST WEBRTC] Screen sharing stopped and peer connections closed.');
  }

  // ==================== 7. VIDEO DISPLAY & AUTOPLAY ====================
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

  // 33. Remote stream attached to video element (Guest side)
  attachRemoteStreamToGuest(remoteStream) {
    if (this.videoElement) {
      console.log('[GUEST WEBRTC] Event 33: Attaching remote stream to video element');
      this.videoElement.srcObject = remoteStream;
      this.videoElement.style.display = 'block';
      this.videoElement.muted = false;

      console.log('[GUEST WEBRTC] Remote stream attached. Calling video.play()...');

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            console.log('[GUEST WEBRTC] ✅ Remote video playing successfully with audio!');
          })
          .catch((err) => {
            console.error('[GUEST WEBRTC] Video play failed (Autoplay policy):', err);
            console.log('[GUEST WEBRTC] Attempting muted fallback playback...');
            this.videoElement.muted = true;
            this.videoElement.play()
              .then(() => {
                console.log('[GUEST WEBRTC] Remote video playing (muted fallback)');
                if (typeof showToast === 'function') {
                  showToast('🔊 Click the theatre stage to unmute live stream audio!');
                }
              })
              .catch(e => console.error('[GUEST WEBRTC] Muted playback also failed:', e));
          });
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
