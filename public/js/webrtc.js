/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for Host -> Maximum 3 Guests Architecture
   Production Diagnostics, ICE Candidate Queuing & Cross-Browser Screen Capture
   ========================================================================== */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.peerConnections = new Map(); // targetSocketId -> RTCPeerConnection
    this.iceCandidatesQueue = new Map(); // targetSocketId -> Array of RTCIceCandidate
    this.isSharing = false;

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
        // Metered.ca OpenRelay TURN Fallback (Ports 80 & 443 TCP/UDP for symmetric NAT/firewalls)
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

    // Diagnostic event callbacks for UI Debug Mode
    this.onDiagnosticsUpdate = null;

    this.initSocketSignaling();
  }

  // ==================== 1. DIAGNOSTICS LOGGER ====================
  logPeerState(targetSocketId, tag, extra = {}) {
    const pc = this.peerConnections.get(targetSocketId);
    if (!pc) {
      console.log(`[WebRTC Diagnostic] [${tag}] Peer: ${targetSocketId} (No active RTCPeerConnection)`, extra);
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

    console.log(`[WebRTC Diagnostic] [${tag}] Peer: ${targetSocketId}`, {
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
    const queue = this.iceCandidatesQueue.get(targetSocketId);
    if (queue && queue.length > 0) {
      this.logPeerState(targetSocketId, 'Flushing ICE Candidate Queue', { queuedCount: queue.length });
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          this.logPeerState(targetSocketId, 'Queued Candidate Applied', {
            candidateType: candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown')
          });
        } catch (err) {
          console.warn(`[WebRTC] Failed to add queued ICE candidate for ${targetSocketId}:`, err);
        }
      }
      this.iceCandidatesQueue.delete(targetSocketId);
    }
  }

  // ==================== 3. SOCKET.IO SIGNALING LISTENERS ====================
  initSocketSignaling() {
    // A. Guest receives WebRTC Offer from Host
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      console.log(`[WebRTC] Received Offer from Host (${senderSocketId})`);
      const pc = this.createPeerConnection(senderSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.logPeerState(senderSocketId, 'Remote Offer Applied (setRemoteDescription success)');

        // Flush any ICE candidates that arrived before the offer was set
        await this.processIceCandidateQueue(senderSocketId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.logPeerState(senderSocketId, 'Local Answer Created & Set (setLocalDescription)');

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription
        });
        console.log(`[WebRTC] Answer sent back to Host (${senderSocketId})`);
      } catch (err) {
        console.error(`[WebRTC Offer Error] Failed handling offer from ${senderSocketId}:`, err);
        this.logPeerState(senderSocketId, 'Offer Error', { error: err.message });
      }
    });

    // B. Host receives WebRTC Answer from Guest
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log(`[WebRTC] Received Answer from Guest (${senderSocketId})`);
      const pc = this.peerConnections.get(senderSocketId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          this.logPeerState(senderSocketId, 'Remote Answer Applied (setRemoteDescription success)');

          // Flush any ICE candidates queued on Host side
          await this.processIceCandidateQueue(senderSocketId, pc);
        } catch (err) {
          console.error(`[WebRTC Answer Error] Failed setting remote answer from ${senderSocketId}:`, err);
          this.logPeerState(senderSocketId, 'Answer Error', { error: err.message });
        }
      } else {
        console.warn(`[WebRTC] Received answer from ${senderSocketId} but no peer connection exists.`);
      }
    });

    // C. Host receives stream request from newly joined Guest
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      console.log(`[WebRTC] Guest ${guestSocketId} explicitly requested active host stream.`);
      if (this.isSharing && this.localStream) {
        this.connectToSingleUser(guestSocketId);
      } else {
        console.log(`[WebRTC] Host is not currently sharing a screen. Request from ${guestSocketId} deferred.`);
      }
    });

    // D. Receive ICE Candidate
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const pc = this.peerConnections.get(senderSocketId);
      if (!candidate) return;

      const candidateType = candidate.type || (candidate.candidate ? candidate.candidate.split(' ')[7] : 'unknown');

      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          this.logPeerState(senderSocketId, 'Direct ICE Candidate Applied', { candidateType });
        } catch (err) {
          console.warn(`[WebRTC] Failed to add direct ICE candidate for ${senderSocketId}:`, err);
        }
      } else {
        // Buffer candidate until setRemoteDescription completes
        if (!this.iceCandidatesQueue.has(senderSocketId)) {
          this.iceCandidatesQueue.set(senderSocketId, []);
        }
        this.iceCandidatesQueue.get(senderSocketId).push(candidate);
        this.logPeerState(senderSocketId, 'ICE Candidate Queued', {
          candidateType,
          queueLength: this.iceCandidatesQueue.get(senderSocketId).length
        });
      }
    });
  }

  // ==================== 4. CREATE / MANAGE PEER CONNECTION ====================
  createPeerConnection(targetSocketId) {
    // Close existing connection if already present to prevent duplicate handlers
    if (this.peerConnections.has(targetSocketId)) {
      console.log(`[WebRTC] Closing old RTCPeerConnection for ${targetSocketId} before re-creating.`);
      this.closeSinglePeerConnection(targetSocketId);
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(targetSocketId, pc);
    this.logPeerState(targetSocketId, 'PeerConnection Created');

    // Transmit local ICE candidate to remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const cType = event.candidate.type || (event.candidate.candidate ? event.candidate.candidate.split(' ')[7] : 'unknown');
        this.logPeerState(targetSocketId, 'Local ICE Candidate Gathered', { candidateType: cType });

        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      } else {
        this.logPeerState(targetSocketId, 'All Local ICE Candidates Gathered (Null Candidate)');
      }
    };

    // Receive remote tracks (Guest side)
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Remote Track Received from ${targetSocketId}: kind = ${event.track.kind}`);
      this.logPeerState(targetSocketId, 'Remote Track Event', {
        kind: event.track.kind,
        streamsCount: event.streams ? event.streams.length : 0
      });

      if (event.streams && event.streams[0]) {
        this.attachStreamToVideo(event.streams[0], false);
      }
    };

    // Monitor ICE Connection State
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      this.logPeerState(targetSocketId, `ICE State Change: ${iceState}`);

      if (iceState === 'failed') {
        console.warn(`[WebRTC] ICE Connection failed for ${targetSocketId}. Attempting restartIce()...`);
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (iceState === 'disconnected') {
        console.warn(`[WebRTC] ICE Connection disconnected for ${targetSocketId}. Waiting for network recovery...`);
      } else if (iceState === 'connected' || iceState === 'completed') {
        console.log(`[WebRTC] ✅ Media stream connected successfully with ${targetSocketId}`);
      }
    };

    // Monitor overall Connection State
    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      this.logPeerState(targetSocketId, `Connection State Change: ${connState}`);

      if (connState === 'failed') {
        console.error(`[WebRTC] RTCPeerConnection failed with ${targetSocketId}.`);
        if (this.peerConnections.size === 1 && !this.isSharing) {
          this.clearVideo();
        }
      } else if (connState === 'closed') {
        this.logPeerState(targetSocketId, 'Connection Closed');
      }
    };

    // Monitor ICE Gathering State
    pc.onicegatheringstatechange = () => {
      this.logPeerState(targetSocketId, `ICE Gathering State: ${pc.iceGatheringState}`);
    };

    // Monitor Signaling State
    pc.onsignalingstatechange = () => {
      this.logPeerState(targetSocketId, `Signaling State: ${pc.signalingState}`);
    };

    // If Host has an active screen stream, attach all tracks to this new connection
    if (this.localStream) {
      const tracks = this.localStream.getTracks();
      console.log(`[WebRTC] Attaching ${tracks.length} local track(s) to peer ${targetSocketId}`);
      tracks.forEach((track) => {
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

    // Attempt 1: Capture with audio enabled
    try {
      console.log('[WebRTC] Requesting getDisplayMedia with video + audio...');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: audioConstraints
      });
      return stream;
    } catch (audioErr) {
      console.warn('[WebRTC] Combined video+audio capture rejected or unsupported:', audioErr.message);
      // Attempt 2: Fallback to video only
      try {
        console.log('[WebRTC] Retrying getDisplayMedia with video only...');
        const videoOnlyStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false
        });
        return videoOnlyStream;
      } catch (videoErr) {
        throw videoErr; // User cancelled or permission denied
      }
    }
  }

  // ==================== 6. START / STOP SCREEN SHARE ====================
  async startScreenShare(userList = []) {
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

      console.log(`[WebRTC] Screen capture active: ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s)`);

      if (videoTracks.length > 0) {
        console.log('[WebRTC] Video Track Settings:', videoTracks[0].getSettings());
      }

      if (audioTracks.length > 0) {
        console.log('[WebRTC] Audio Track Settings:', audioTracks[0].getSettings());
        if (typeof showToast === 'function') {
          showToast('🔊 Screen & Tab Audio Sharing Started Live!');
        }
      } else {
        // Step 8: Clear feedback if browser/capture surface did not provide audio
        if (typeof showToast === 'function') {
          showToast('🖥️ Video captured successfully, but this browser/tab did not provide audio.');
        }
      }

      // Attach locally for Host preview (Muted to eliminate feedback echo)
      this.attachStreamToVideo(stream, true);

      // Handle browser's native floating "Stop Sharing" bar
      if (videoTracks.length > 0) {
        videoTracks[0].onended = () => {
          console.log('[WebRTC] Host stopped sharing via native browser bar.');
          this.stopScreenShare();
        };
      }

      // Broadcast offer to all other participants currently in room
      console.log(`[WebRTC] Initiating stream offer to ${userList.length} participant(s)...`);
      for (const user of userList) {
        if (user.socketId !== this.socket.id) {
          await this.connectToSingleUser(user.socketId);
        }
      }

      this.socket.emit('screen-share-status', { isSharing: true });
      return true;
    } catch (err) {
      console.error('[WebRTC] Screen share failed or was cancelled by user:', err);
      if (typeof showToast === 'function') {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showToast('⚠️ Screen share cancelled or permission denied.');
        } else {
          showToast(`⚠️ Screen share error: ${err.message}`);
        }
      }
      return false;
    }
  }

  async connectToSingleUser(targetSocketId) {
    if (!this.localStream) {
      console.warn(`[WebRTC] Cannot connect to ${targetSocketId}: localStream is null`);
      return;
    }

    const tracks = this.localStream.getTracks();
    if (tracks.length === 0) {
      console.warn(`[WebRTC] Cannot connect to ${targetSocketId}: localStream has 0 tracks`);
      return;
    }

    console.log(`[WebRTC] Preparing WebRTC Offer for Guest ${targetSocketId} (${tracks.length} tracks)...`);
    const pc = this.createPeerConnection(targetSocketId);

    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });
      await pc.setLocalDescription(offer);
      this.logPeerState(targetSocketId, 'Local Offer Created & Set', { sdpType: offer.type });

      this.socket.emit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: pc.localDescription
      });
      console.log(`[WebRTC] Offer transmitted to Guest ${targetSocketId}`);
    } catch (err) {
      console.error(`[WebRTC] Failed generating offer for ${targetSocketId}:`, err);
      this.logPeerState(targetSocketId, 'Offer Generation Failed', { error: err.message });
    }
  }

  stopScreenShare() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {}
      });
      this.localStream = null;
    }

    this.isSharing = false;

    // Cleanly close all active peer connections
    this.peerConnections.forEach((pc, socketId) => {
      this.closeSinglePeerConnection(socketId);
    });
    this.peerConnections.clear();
    this.iceCandidatesQueue.clear();

    this.clearVideo();
    this.socket.emit('screen-share-status', { isSharing: false });
    console.log('[WebRTC] Screen sharing stopped and all peer connections dismantled.');
  }

  // ==================== 7. VIDEO ATTACHMENT & AUTOPLAY RECOVERY ====================
  attachStreamToVideo(stream, isLocalStream = false) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';

      // Host local preview must remain muted to avoid infinite loopback echo
      this.videoElement.muted = Boolean(isLocalStream);

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Autoplay Policy] Unmuted video playback blocked by browser. Retrying muted:', err);
          this.videoElement.muted = true;
          this.videoElement.play().then(() => {
            if (typeof showToast === 'function' && !isLocalStream) {
              showToast('🔊 Click anywhere on the cinema stage to enable audio!');
            }
          }).catch(e => console.error('[WebRTC] Final video playback error:', e));
        });
      }
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
