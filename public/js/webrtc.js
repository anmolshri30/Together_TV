/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE
   Handles DisplayMedia Capture & Real-Time Peer-to-Peer Stream Broadcasting
   ========================================================================== */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peer = null;
    this.peerId = null;
    this.localStream = null;
    this.activeCalls = new Map(); // socketId/peerId -> PeerCall
    this.isSharing = false;

    this.videoElement = document.getElementById('remote-stream-video');
    this.placeholderEl = document.getElementById('screenshare-placeholder');
  }

  // Initialize PeerJS Client
  initPeer() {
    return new Promise((resolve, reject) => {
      // Create random peer ID or use PeerJS auto-id
      this.peer = new Peer(undefined, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        console.log(`[PeerJS Initialized] ID: ${id}`);
        this.peerId = id;
        this.socket.emit('register-peer', { peerId: id });
        resolve(id);
      });

      // Handle incoming stream calls (For Participants)
      this.peer.on('call', (call) => {
        console.log(`[PeerJS Incoming Call] From: ${call.peer}`);
        call.answer(); // Answer incoming host stream

        call.on('stream', (remoteStream) => {
          console.log('[PeerJS Stream Received]', remoteStream);
          this.attachStreamToVideo(remoteStream);
        });

        call.on('close', () => {
          console.log('[PeerJS Call Closed]');
          this.clearVideo();
        });

        call.on('error', (err) => {
          console.error('[PeerJS Call Error]', err);
        });
      });

      this.peer.on('error', (err) => {
        console.warn('[PeerJS Error]', err);
      });
    });
  }

  // Start Screen & Audio Sharing (Host Only)
  async startScreenShare(userList = []) {
    try {
      console.log('[WebRTC] Requesting getDisplayMedia with audio...');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser', // default to tab/browser window
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

      // Attach stream locally
      this.attachStreamToVideo(stream);

      // Handle when host stops sharing via browser native bar
      stream.getVideoTracks()[0].onended = () => {
        console.log('[WebRTC] Host stopped screen sharing');
        this.stopScreenShare();
      };

      // Call all active peers in room
      this.broadcastStreamToPeers(userList);

      // Notify server
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

  // Call all connected peer IDs in the room
  broadcastStreamToPeers(userList) {
    if (!this.localStream || !this.peer) return;

    userList.forEach((u) => {
      if (u.peerId && u.peerId !== this.peerId) {
        console.log(`[WebRTC] Calling peer ${u.peerId}...`);
        const call = this.peer.call(u.peerId, this.localStream);
        if (call) {
          this.activeCalls.set(u.peerId, call);
        }
      }
    });
  }

  // Call a newly joined single peer (Host -> new guest)
  callSinglePeer(peerId) {
    if (!this.localStream || !this.peer || !peerId || peerId === this.peerId) return;
    console.log(`[WebRTC] Calling newly joined peer ${peerId}...`);
    const call = this.peer.call(peerId, this.localStream);
    if (call) {
      this.activeCalls.set(peerId, call);
    }
  }

  // Stop Screen Share
  stopScreenShare() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.isSharing = false;

    // Close all active calls
    this.activeCalls.forEach((call) => call.close());
    this.activeCalls.clear();

    this.clearVideo();
    this.socket.emit('screen-share-status', { isSharing: false });
  }

  // Attach Stream to Stage Video Element
  attachStreamToVideo(stream) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';

      // Try playing with sound first
      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Autoplay Policy] Video play blocked with sound, attempting muted playback:', err);
          this.videoElement.muted = true;
          this.videoElement.play().then(() => {
            if (typeof showToast === 'function') {
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
