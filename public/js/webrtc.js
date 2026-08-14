/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for HD Low-Latency Screen & Audio Share
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

    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // TURN Relay Servers for NAT & Strict Firewall Traversal over Internet
        {
          urls: 'turn:openrelay.metered.ca:80',
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
        }
      ]
    };

    this.initSocketSignaling();
  }

  // Process queued candidates after remote description is set
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
    }
  }

  // Socket.io Native WebRTC Signaling
  initSocketSignaling() {
    // Receive Offer from Host (Guest side)
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer }) => {
      console.log(`[WebRTC Direct] Received Offer from Host (${senderSocketId})`);
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
      console.log(`[WebRTC Direct] Received Answer from Guest (${senderSocketId})`);
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

    // Guest Requests Stream (Host side)
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      if (this.isSharing && this.localStream) {
        console.log(`[WebRTC Host] Guest ${guestSocketId} requested stream. Sending WebRTC offer...`);
        this.connectToSingleUser(guestSocketId);
      }
    });

    // Receive ICE Candidate
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
          // Queue candidate until remote description is set
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

    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections.set(targetSocketId, pc);

    // Send ICE candidates to target socket
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // Receive remote tracks (Guest side)
    pc.ontrack = (event) => {
      console.log('[WebRTC Direct Track Received]', event.streams[0]);
      if (event.streams && event.streams[0]) {
        this.attachStreamToVideo(event.streams[0], false);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC ICE State] ${targetSocketId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[WebRTC] Connection failed for ${targetSocketId}, attempting ICE restart...`);
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      } else if (pc.iceConnectionState === 'disconnected') {
        console.warn(`[WebRTC] ICE Connection disconnected for ${targetSocketId}`);
      }
    };

    // If host has active stream, add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    return pc;
  }

  // Start Screen Share (Host Only)
  async startScreenShare(userList = []) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        if (typeof showToast === 'function') {
          showToast('⚠️ Screen sharing requires HTTPS! Please access site via https://');
        }
        alert('WebRTC Screen Sharing is blocked on unencrypted HTTP connections across the internet. Please use HTTPS (e.g. https://yourdomain.com)');
        return false;
      }

      console.log('[WebRTC Direct] Requesting getDisplayMedia with audio...');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
          frameRate: { ideal: 30, max: 60 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });

      this.localStream = stream;
      this.isSharing = true;

      // Attach stream locally for Host (Muted to prevent audio echo)
      this.attachStreamToVideo(stream, true);

      // Handle when host stops sharing via browser native bar
      stream.getVideoTracks()[0].onended = () => {
        console.log('[WebRTC] Host stopped screen sharing');
        this.stopScreenShare();
      };

      // Call all active users in room
      userList.forEach((user) => {
        if (user.socketId !== this.socket.id) {
          this.connectToSingleUser(user.socketId);
        }
      });

      this.socket.emit('screen-share-status', { isSharing: true });
      return true;
    } catch (err) {
      console.error('[WebRTC] Screen Share Error / Cancelled:', err);
      if (typeof showToast === 'function') {
        showToast('⚠️ Screen Share cancelled or permission denied.');
      }
      return false;
    }
  }

  async connectToSingleUser(targetSocketId) {
    if (!this.localStream) return;
    console.log(`[WebRTC Direct] Creating Offer for target user ${targetSocketId}...`);

    const pc = this.createPeerConnection(targetSocketId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socket.emit('webrtc-offer', {
        targetSocketId: targetSocketId,
        offer: pc.localDescription
      });
    } catch (err) {
      console.error('[WebRTC Offer Generation Error]', err);
    }
  }

  // Stop Screen Share
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

  // Attach Stream to Stage Video Element
  attachStreamToVideo(stream, isLocalStream = false) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';

      if (isLocalStream) {
        // Host should always be muted locally to prevent feedback echo
        this.videoElement.muted = true;
      } else {
        this.videoElement.muted = false;
      }

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Autoplay Policy] Video play blocked, attempting muted playback:', err);
          this.videoElement.muted = true;
          this.videoElement.play().then(() => {
            if (typeof showToast === 'function' && !isLocalStream) {
              showToast('🔊 Click anywhere on stage to unmute video audio!');
            }
          }).catch(e => console.error('Video play failed:', e));
        });
      }
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
  }

  // Clear Stage Video
  clearVideo() {
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'flex';
    }
  }
}

window.WebRTCManager = WebRTCManager;
