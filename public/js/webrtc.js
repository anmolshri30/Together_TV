/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for HD Low-Latency Screen & Audio Share
   Fix #3: Track verification before createOffer
   Fix #4: Reliable TURN server list with iceTransportPolicy
   Fix #6: Cross-browser getDisplayMedia audio constraints (Chrome/Firefox/Safari)
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

    // Fix #4: Expanded & reliable TURN + STUN list with iceTransportPolicy
    this.iceConfig = {
      iceTransportPolicy: 'all',
      iceServers: [
        // Google STUN
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        // Cloudflare STUN (reliable)
        { urls: 'stun:stun.cloudflare.com:3478' },
        // Twilio STUN
        { urls: 'stun:global.stun.twilio.com:3478' },
        // OpenRelay TURN — multiple ports for NAT/firewall traversal
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
        // Backup TURN via numb.viagenie.ca (highly available)
        {
          urls: 'turn:numb.viagenie.ca',
          username: 'webrtc@live.com',
          credential: 'muazkh'
        }
      ]
    };

    this.initSocketSignaling();
  }

  // Process queued ICE candidates after setRemoteDescription completes
  async processIceCandidateQueue(targetSocketId, pc) {
    const queue = this.iceCandidatesQueue.get(targetSocketId);
    if (queue && queue.length > 0) {
      console.log(`[WebRTC] Draining ${queue.length} queued ICE candidates for ${targetSocketId}`);
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('[WebRTC Queued Candidate Error]', err);
        }
      }
      this.iceCandidatesQueue.delete(targetSocketId);
    }
  }

  // Socket.io Native WebRTC Signaling
  initSocketSignaling() {
    // Receive Offer from Host (Guest side)
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      console.log(`[WebRTC] Received Offer from Host (${senderSocketId})`);
      const pc = this.createPeerConnection(senderSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await this.processIceCandidateQueue(senderSocketId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription
        });
      } catch (err) {
        console.error('[WebRTC Offer Error]', err);
      }
    });

    // Receive Answer from Guest (Host side)
    this.socket.on('webrtc-answer', async ({ senderSocketId, answer }) => {
      console.log(`[WebRTC] Received Answer from Guest (${senderSocketId})`);
      const pc = this.peerConnections.get(senderSocketId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await this.processIceCandidateQueue(senderSocketId, pc);
        } catch (err) {
          console.error('[WebRTC Answer Error]', err);
        }
      }
    });

    // Guest Requests Stream (Host side) — triggered when guest joins an active share
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      if (this.isSharing && this.localStream) {
        console.log(`[WebRTC Host] Guest ${guestSocketId} requested stream. Initiating offer...`);
        this.connectToSingleUser(guestSocketId);
      }
    });

    // Receive ICE Candidate — queue if remote description not yet set
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const pc = this.peerConnections.get(senderSocketId);
      if (candidate) {
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.warn('[WebRTC Candidate Error]', err);
          }
        } else {
          // Buffer candidates until remote description is set
          if (!this.iceCandidatesQueue.has(senderSocketId)) {
            this.iceCandidatesQueue.set(senderSocketId, []);
          }
          this.iceCandidatesQueue.get(senderSocketId).push(candidate);
        }
      }
    });
  }

  createPeerConnection(targetSocketId) {
    if (this.peerConnections.has(targetSocketId)) {
      this.peerConnections.get(targetSocketId).close();
      this.peerConnections.delete(targetSocketId);
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(targetSocketId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // Receive remote video track (Guest side)
    pc.ontrack = (event) => {
      console.log('[WebRTC Track Received]', event.streams[0]);
      if (event.streams && event.streams[0]) {
        this.attachStreamToVideo(event.streams[0], false);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[WebRTC ICE State] ${targetSocketId}: ${state}`);

      if (state === 'failed') {
        console.warn(`[WebRTC] ICE failed for ${targetSocketId} — attempting restartIce()`);
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (state === 'disconnected') {
        console.warn(`[WebRTC] ICE disconnected for ${targetSocketId} — waiting for recovery`);
      } else if (state === 'connected' || state === 'completed') {
        console.log(`[WebRTC] ✅ ICE connected for ${targetSocketId}`);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC Connection State] ${targetSocketId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        this.clearVideo();
        if (typeof showToast === 'function') {
          showToast('⚠️ Stream connection lost. Host may need to restart screen share.');
        }
      }
    };

    // Attach local tracks if host is already sharing
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    return pc;
  }

  // Fix #6: Cross-browser safe getDisplayMedia with audio constraint fallback
  async getDisplayMediaSafe() {
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    const videoConstraints = {
      frameRate: { ideal: 30, max: 60 }
    };

    // Chrome/Edge: supports displaySurface
    if (!isFirefox && !isSafari) {
      videoConstraints.displaySurface = 'browser';
    }

    // Firefox/Safari: audio constraints as object cause NotSupportedError — use boolean
    const audioConstraints = (isFirefox || isSafari) ? true : {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 44100
    };

    // First attempt: with audio
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: audioConstraints
      });
    } catch (audioErr) {
      // If audio capture fails (some OS/browsers block tab audio), retry video-only
      console.warn('[WebRTC] Audio capture failed, retrying video-only:', audioErr.message);
      if (typeof showToast === 'function') {
        showToast('🔇 Audio capture unavailable on this browser — sharing video only.');
      }
      return await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false
      });
    }
  }

  // Start Screen Share (Host Only)
  async startScreenShare(userList = []) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        if (typeof showToast === 'function') {
          showToast('⚠️ Screen sharing requires HTTPS. Please access the site via https://');
        }
        return false;
      }

      console.log('[WebRTC] Requesting getDisplayMedia...');
      const stream = await this.getDisplayMediaSafe();

      this.localStream = stream;
      this.isSharing = true;

      // Attach locally — muted to prevent audio feedback echo on host side
      this.attachStreamToVideo(stream, true);

      // Handle native browser "Stop sharing" button
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          console.log('[WebRTC] Host stopped screen sharing (browser stop button)');
          this.stopScreenShare();
        };
      }

      // Fix #3: Verify tracks are attached before sending offers
      const trackCount = stream.getTracks().length;
      console.log(`[WebRTC] Stream ready with ${trackCount} tracks. Connecting to ${userList.length - 1} peer(s)...`);

      // Call all active users in room
      for (const user of userList) {
        if (user.socketId !== this.socket.id) {
          await this.connectToSingleUser(user.socketId);
        }
      }

      this.socket.emit('screen-share-status', { isSharing: true });
      return true;
    } catch (err) {
      console.error('[WebRTC] Screen Share Error:', err);
      if (typeof showToast === 'function') {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showToast('⚠️ Screen share permission denied. Please allow screen access and try again.');
        } else {
          showToast(`⚠️ Screen share failed: ${err.message}`);
        }
      }
      return false;
    }
  }

  // Fix #3: Ensure tracks are verified before creating offer
  async connectToSingleUser(targetSocketId) {
    if (!this.localStream) return;

    const tracks = this.localStream.getTracks();
    if (tracks.length === 0) {
      console.warn(`[WebRTC] No tracks in localStream — skipping offer to ${targetSocketId}`);
      return;
    }

    console.log(`[WebRTC] Creating offer for ${targetSocketId} (${tracks.length} tracks)...`);
    const pc = this.createPeerConnection(targetSocketId);

    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false
      });
      await pc.setLocalDescription(offer);

      this.socket.emit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: pc.localDescription
      });
    } catch (err) {
      console.error('[WebRTC] Offer Generation Error:', err);
    }
  }

  // Stop Screen Share — clean up all peer connections
  stopScreenShare() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.isSharing = false;

    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();
    this.iceCandidatesQueue.clear();

    this.clearVideo();
    this.socket.emit('screen-share-status', { isSharing: false });
  }

  // Attach stream to stage video element
  attachStreamToVideo(stream, isLocalStream = false) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';

      // Host always muted locally to prevent audio feedback
      this.videoElement.muted = isLocalStream ? true : false;

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Autoplay Policy] Blocked — retrying muted:', err);
          this.videoElement.muted = true;
          this.videoElement.play().then(() => {
            if (typeof showToast === 'function' && !isLocalStream) {
              showToast('🔊 Click anywhere on stage to unmute audio!');
            }
          }).catch(e => console.error('[Video Play Failed]', e));
        });
      }
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
  }

  // Clear stage video and show placeholder
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
