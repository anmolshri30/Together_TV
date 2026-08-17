/* ==========================================================================
   WEBRTC SCREEN & AUDIO SHARING MODULE (DIRECT SOCKET.IO SIGNALING)
   Native WebRTC RTCPeerConnection for Host -> Maximum 3 Guests Architecture
   - Adaptive Screen Capture (1080p @ 30 FPS default)
   - Per-Guest Adaptive Outgoing Bitrate & Sender Parameters (HIGH / MEDIUM / LOW)
   - Real-Time RTC Stats Monitoring with Conservative Quality Transitions
   - Mobile-First Video Player, Fullscreen API, Orientation Lock, PiP & Touch Overlay
   - Network / ICE / Remote Track Recovery & Connection Quality Indicator
   - Safe Area Compliance & Autoplay Recovery
   ========================================================================== */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.remoteMediaStream = null; // Accumulated remote stream on guest
    this.peerConnections = new Map(); // targetSocketId -> RTCPeerConnection
    this.peerStates = new Map(); // targetSocketId -> { pc, negotiationInProgress, currentNegotiationId, currentQuality, statsTimer, lastStats, consecutivePoorSamples, consecutiveHealthySamples, targetBitrate }
    this.iceCandidatesQueue = new Map(); // targetSocketId -> Array of RTCIceCandidate
    this.isSharing = false;
    this.isHost = false;
    this.signalingInitialized = false;

    // Quality profiles for adaptive outgoing stream
    this.QUALITY_PROFILES = {
      HIGH: { label: '1080p HD', maxBitrate: 4000000, maxFramerate: 30, scaleDown: 1.0 },
      MEDIUM: { label: '720p', maxBitrate: 2500000, maxFramerate: 30, scaleDown: 1.5 },
      LOW: { label: '480p SD', maxBitrate: 1000000, maxFramerate: 24, scaleDown: 2.0 }
    };

    // DOM Elements
    this.videoElement = document.getElementById('remote-stream-video');
    this.placeholderEl = document.getElementById('screenshare-placeholder');
    this.touchOverlay = document.getElementById('video-touch-overlay');
    this.qualityBadge = document.getElementById('btn-quality-badge');
    this.qualityLabel = document.getElementById('quality-label-text');
    this.qualityStatsPopup = document.getElementById('quality-stats-popup');
    this.btnPip = document.getElementById('btn-video-pip');
    this.btnFullscreen = document.getElementById('btn-video-fullscreen');
    this.iconFullscreen = document.getElementById('video-fullscreen-icon');
    this.btnAudioToggle = document.getElementById('btn-video-audio-toggle');
    this.iconAudio = document.getElementById('video-audio-icon');
    this.centerCta = document.getElementById('video-center-cta');
    this.bufferingIndicator = document.getElementById('video-buffering-indicator');
    this.btnSync = document.getElementById('btn-video-sync');

    // Controls overlay auto-hide timer
    this.controlsHideTimeout = null;
    this.guestStatsTimer = null;
    this.lastGuestStats = null;

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
    this.initTouchAndUIControls();
    this.initNetworkListeners();
  }

  getRoleTag() {
    return this.isHost ? 'HOST WEBRTC' : 'GUEST WEBRTC';
  }

  // ==================== 1. PER-PEER NEGOTIATION & QUALITY STATE ====================
  getOrCreatePeerState(targetSocketId) {
    if (!this.peerStates.has(targetSocketId)) {
      this.peerStates.set(targetSocketId, {
        pc: null,
        negotiationInProgress: false,
        currentNegotiationId: null,
        currentQuality: 'HIGH',
        statsTimer: null,
        lastStats: null,
        consecutivePoorSamples: 0,
        consecutiveHealthySamples: 0,
        targetBitrate: 4000000
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

  // ==================== 2. ADAPTIVE WEBRTC SENDER QUALITY ====================
  async applySenderQuality(targetSocketId, qualityLevel) {
    const pc = this.peerConnections.get(targetSocketId);
    const peerState = this.peerStates.get(targetSocketId);
    if (!pc || !peerState) return;

    if (peerState.currentQuality === qualityLevel) return;

    const senders = pc.getSenders ? pc.getSenders() : [];
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (!videoSender || typeof videoSender.getParameters !== 'function') return;

    const profile = this.QUALITY_PROFILES[qualityLevel] || this.QUALITY_PROFILES.HIGH;

    try {
      const params = videoSender.getParameters();
      if (!params || !params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      params.encodings[0].maxBitrate = profile.maxBitrate;
      params.encodings[0].maxFramerate = profile.maxFramerate;
      if (typeof params.encodings[0].scaleResolutionDownBy !== 'undefined' || qualityLevel !== 'HIGH') {
        params.encodings[0].scaleResolutionDownBy = profile.scaleDown;
      }

      await videoSender.setParameters(params);
      const oldQuality = peerState.currentQuality;
      peerState.currentQuality = qualityLevel;
      peerState.targetBitrate = profile.maxBitrate;

      console.log(`[WEBRTC QUALITY] Guest ${targetSocketId}: ${oldQuality} → ${qualityLevel} (Target: ${(profile.maxBitrate / 1000000).toFixed(1)} Mbps @ ${profile.maxFramerate} FPS)`);
    } catch (e) {
      console.warn(`[WEBRTC QUALITY] Notice updating sender parameters for ${targetSocketId}:`, e.message);
    }
  }

  startHostStatsMonitoring(targetSocketId) {
    const peerState = this.getOrCreatePeerState(targetSocketId);
    if (peerState.statsTimer) {
      clearInterval(peerState.statsTimer);
    }

    peerState.statsTimer = setInterval(async () => {
      const pc = this.peerConnections.get(targetSocketId);
      if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        clearInterval(peerState.statsTimer);
        peerState.statsTimer = null;
        return;
      }

      try {
        const stats = await pc.getStats();
        let currentPacketsSent = 0;
        let currentPacketsLost = 0;
        let currentRtt = 0;

        stats.forEach(report => {
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            currentPacketsLost = report.packetsLost || 0;
            currentRtt = (report.roundTripTime || 0) * 1000;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            currentPacketsSent = report.packetsSent || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (!currentRtt && report.currentRoundTripTime) {
              currentRtt = report.currentRoundTripTime * 1000;
            }
          }
        });

        if (!peerState.lastStats) {
          peerState.lastStats = { packetsSent: currentPacketsSent, packetsLost: currentPacketsLost, timestamp: Date.now() };
          return;
        }

        const deltaSent = Math.max(0, currentPacketsSent - peerState.lastStats.packetsSent);
        const deltaLost = Math.max(0, currentPacketsLost - peerState.lastStats.packetsLost);
        peerState.lastStats = { packetsSent: currentPacketsSent, packetsLost: currentPacketsLost, timestamp: Date.now() };

        const totalDelta = deltaSent + deltaLost;
        const lossRatePercent = totalDelta > 0 ? (deltaLost / totalDelta) * 100 : 0;
        const currQ = peerState.currentQuality || 'HIGH';

        // Conservative quality transitions
        if (lossRatePercent > 10 || currentRtt > 550) {
          // Severe conditions -> Move to LOW
          peerState.consecutivePoorSamples = (peerState.consecutivePoorSamples || 0) + 1;
          peerState.consecutiveHealthySamples = 0;
          if (peerState.consecutivePoorSamples >= 2 && currQ !== 'LOW') {
            console.log(`[WEBRTC QUALITY] Guest ${targetSocketId}: ${currQ} → LOW (reason: severe loss ${lossRatePercent.toFixed(1)}%, RTT ${currentRtt.toFixed(0)}ms)`);
            await this.applySenderQuality(targetSocketId, 'LOW');
          }
        } else if (lossRatePercent > 4 || currentRtt > 350) {
          // Moderate conditions -> Step down one level
          peerState.consecutivePoorSamples = (peerState.consecutivePoorSamples || 0) + 1;
          peerState.consecutiveHealthySamples = 0;
          if (peerState.consecutivePoorSamples >= 3) {
            const nextQ = currQ === 'HIGH' ? 'MEDIUM' : 'LOW';
            if (nextQ !== currQ) {
              console.log(`[WEBRTC QUALITY] Guest ${targetSocketId}: ${currQ} → ${nextQ} (reason: packet loss ${lossRatePercent.toFixed(1)}%, RTT ${currentRtt.toFixed(0)}ms)`);
              await this.applySenderQuality(targetSocketId, nextQ);
              peerState.consecutivePoorSamples = 0;
            }
          }
        } else if (lossRatePercent < 2 && currentRtt < 220) {
          // Healthy conditions -> Require 4 consecutive good samples (10s) before upgrading
          peerState.consecutiveHealthySamples = (peerState.consecutiveHealthySamples || 0) + 1;
          peerState.consecutivePoorSamples = 0;
          if (peerState.consecutiveHealthySamples >= 4) {
            const nextQ = currQ === 'LOW' ? 'MEDIUM' : (currQ === 'MEDIUM' ? 'HIGH' : 'HIGH');
            if (nextQ !== currQ) {
              console.log(`[WEBRTC QUALITY] Guest ${targetSocketId}: ${currQ} → ${nextQ} (reason: network recovered, loss ${lossRatePercent.toFixed(1)}%, RTT ${currentRtt.toFixed(0)}ms)`);
              await this.applySenderQuality(targetSocketId, nextQ);
            }
            peerState.consecutiveHealthySamples = 0;
          }
        } else {
          // Steady conditions
          peerState.consecutivePoorSamples = 0;
          peerState.consecutiveHealthySamples = 0;
        }
      } catch (e) {}
    }, 2500);
  }

  // ==================== 3. GUEST STATS & QUALITY MONITORING ====================
  startGuestStatsMonitoring(pc) {
    if (this.guestStatsTimer) {
      clearInterval(this.guestStatsTimer);
    }

    this.guestStatsTimer = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        this.updateConnectionQualityUI('reconnecting', 'Reconnecting...', { rtt: 0, loss: 0, res: '-', fps: 0 });
        return;
      }

      try {
        const stats = await pc.getStats();
        let packetsLost = 0;
        let packetsReceived = 0;
        let currentRtt = 0;
        let frameWidth = 0;
        let frameHeight = 0;
        let fps = 0;

        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
            frameWidth = report.frameWidth || 0;
            frameHeight = report.frameHeight || 0;
            fps = report.framesPerSecond || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime) {
              currentRtt = report.currentRoundTripTime * 1000;
            }
          }
        });

        if (!this.lastGuestStats) {
          this.lastGuestStats = { packetsReceived, packetsLost, timestamp: Date.now() };
          return;
        }

        const deltaRecv = Math.max(0, packetsReceived - this.lastGuestStats.packetsReceived);
        const deltaLost = Math.max(0, packetsLost - this.lastGuestStats.packetsLost);
        this.lastGuestStats = { packetsReceived, packetsLost, timestamp: Date.now() };

        const totalDelta = deltaRecv + deltaLost;
        const lossPercent = totalDelta > 0 ? (deltaLost / totalDelta) * 100 : 0;
        const resLabel = frameWidth > 0 ? `${frameWidth}×${frameHeight}` : (this.videoElement && this.videoElement.videoWidth ? `${this.videoElement.videoWidth}×${this.videoElement.videoHeight}` : 'HD');

        let status = 'excellent';
        let label = '🟢 Excellent';

        if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'disconnected') {
          status = 'reconnecting';
          label = '⚪ Reconnecting';
        } else if (lossPercent >= 8 || currentRtt >= 450) {
          status = 'poor';
          label = '🔴 Poor';
        } else if (lossPercent >= 3 || currentRtt >= 280) {
          status = 'fair';
          label = '🟠 Fair';
        } else if (lossPercent >= 1 || currentRtt >= 160) {
          status = 'good';
          label = '🟡 Good';
        }

        this.updateConnectionQualityUI(status, label, {
          rtt: Math.round(currentRtt),
          loss: lossPercent.toFixed(1),
          res: resLabel,
          fps: Math.round(fps)
        });
      } catch (e) {}
    }, 2500);
  }

  updateConnectionQualityUI(status, label, metrics = {}) {
    if (this.qualityBadge) {
      this.qualityBadge.className = `badge-quality quality-${status}`;
      if (this.qualityLabel) {
        this.qualityLabel.textContent = metrics.res && metrics.res !== '-' ? metrics.res : label;
      }
    }

    const statStatus = document.getElementById('stat-status');
    const statResolution = document.getElementById('stat-resolution');
    const statFps = document.getElementById('stat-fps');
    const statRtt = document.getElementById('stat-rtt');
    const statLoss = document.getElementById('stat-loss');

    if (statStatus) statStatus.textContent = label;
    if (statResolution) statResolution.textContent = metrics.res || '-';
    if (statFps) statFps.textContent = metrics.fps ? `${metrics.fps} FPS` : '-';
    if (statRtt) statRtt.textContent = metrics.rtt ? `${metrics.rtt} ms` : '-';
    if (statLoss) statLoss.textContent = `${metrics.loss || '0'}%`;
  }

  // ==================== 4. DIAGNOSTICS LOGGER ====================
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

  // ==================== 5. ICE CANDIDATE QUEUE ====================
  async processIceCandidateQueue(targetSocketId, pc) {
    const tag = this.getRoleTag();
    const queue = this.iceCandidatesQueue.get(targetSocketId);

    if (queue && queue.length > 0) {
      console.log(`[${tag}] Flushing ICE candidate queue for ${targetSocketId} (${queue.length} candidate(s))`);
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn(`[${tag}] Error adding queued ICE candidate for ${targetSocketId}:`, err.message);
        }
      }
      this.iceCandidatesQueue.delete(targetSocketId);
    }
  }

  // ==================== 6. SOCKET.IO SIGNALING LISTENERS ====================
  initSocketSignaling() {
    if (this.signalingInitialized) return;
    this.signalingInitialized = true;

    // 5. Host receives guest-requested-stream
    this.socket.on('guest-requested-stream', ({ guestSocketId }) => {
      console.log(`[HOST WEBRTC] Event 5: Host received guest-requested-stream from Guest (${guestSocketId})`);
      if (this.isSharing && this.localStream) {
        this.connectToSingleUser(guestSocketId);
      }
    });

    // 12. Guest receives webrtc-offer
    this.socket.on('webrtc-offer', async ({ senderSocketId, offer, negotiationId }) => {
      console.log('[GUEST WEBRTC] OFFER RECEIVED', {
        peerId: senderSocketId,
        negotiationId: negotiationId || 'none'
      });

      const pc = this.createPeerConnection(senderSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        this.logPeerState(senderSocketId, 'Guest Remote Description Set');

        await this.processIceCandidateQueue(senderSocketId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log('[GUEST WEBRTC] ANSWER SENT', {
          peerId: senderSocketId,
          negotiationId: negotiationId || 'none'
        });

        this.socket.emit('webrtc-answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription,
          negotiationId
        });

        this.startGuestStatsMonitoring(pc);
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
        peerState.negotiationInProgress = false;
        return;
      }

      if (pc.signalingState !== 'have-local-offer') {
        console.warn('[HOST WEBRTC] Ignoring unexpected answer', {
          peerId: senderSocketId,
          negotiationId,
          currentSignalingState: pc.signalingState
        });
        return;
      }

      if (peerState.currentNegotiationId && negotiationId && peerState.currentNegotiationId !== negotiationId) {
        console.warn('[HOST WEBRTC] Ignoring stale answer with negotiationId:', negotiationId);
        return;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        peerState.negotiationInProgress = false;
        peerState.currentNegotiationId = null;

        console.log('[HOST WEBRTC] ANSWER APPLIED', {
          peerId: senderSocketId,
          negotiationId: negotiationId || 'none',
          signalingState: pc.signalingState
        });

        this.logPeerState(senderSocketId, 'Host Remote Description Set (Answer Applied)');
        await this.processIceCandidateQueue(senderSocketId, pc);

        // Start Host-side adaptive quality stats loop for this guest
        this.startHostStatsMonitoring(senderSocketId);
      } catch (err) {
        peerState.negotiationInProgress = false;
        console.error(`[HOST WEBRTC] Answer Handling Error from ${senderSocketId}:`, err);
        this.logPeerState(senderSocketId, 'Answer Handling Failed', { error: err.message });
      }
    });

    // 22. ICE candidate received
    this.socket.on('webrtc-ice-candidate', async ({ senderSocketId, candidate }) => {
      const tag = this.getRoleTag();
      const pc = this.peerConnections.get(senderSocketId);
      if (!candidate) return;

      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn(`[${tag}] Failed adding direct ICE candidate:`, err.message);
        }
      } else {
        if (!this.iceCandidatesQueue.has(senderSocketId)) {
          this.iceCandidatesQueue.set(senderSocketId, []);
        }
        this.iceCandidatesQueue.get(senderSocketId).push(candidate);
      }
    });
  }

  // ==================== 7. CREATE / REUSE PEER CONNECTION ====================
  createPeerConnection(targetSocketId) {
    const tag = this.getRoleTag();
    const existingPc = this.peerConnections.get(targetSocketId);

    if (existingPc) {
      if (existingPc.connectionState !== 'closed' && existingPc.connectionState !== 'failed') {
        return existingPc;
      }
      this.closeSinglePeerConnection(targetSocketId);
    }

    console.log(`[${tag}] CREATE peer ${targetSocketId}`);
    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(targetSocketId, pc);

    const peerState = this.getOrCreatePeerState(targetSocketId);
    peerState.pc = pc;

    // ICE candidate gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // 29. ontrack fires (Guest side)
    pc.ontrack = (event) => {
      console.log(`[GUEST WEBRTC] ontrack: ${event.track.kind}`);

      // Track recovery listeners
      if (event.track.kind === 'video') {
        event.track.onmute = () => {
          console.log('[GUEST WEBRTC] Video track temporarily muted/buffering...');
          if (this.bufferingIndicator) this.bufferingIndicator.classList.remove('hidden');
        };
        event.track.onunmute = () => {
          console.log('[GUEST WEBRTC] Video track unmuted/resumed live!');
          if (this.bufferingIndicator) this.bufferingIndicator.classList.add('hidden');
        };
      }

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

      this.attachRemoteStreamToGuest(remoteStream);
    };

    // Monitor ICE state
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[${tag}] iceConnectionState: ${state} for ${targetSocketId}`);
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
        if (this.bufferingIndicator) this.bufferingIndicator.classList.add('hidden');
      }
    };

    // Monitor connection state
    pc.onconnectionstatechange = () => {
      const connState = pc.connectionState;
      this.logPeerState(targetSocketId, `connectionState: ${connState}`);

      if (connState === 'failed') {
        const pState = this.getOrCreatePeerState(targetSocketId);
        pState.negotiationInProgress = false;
      }
    };

    // Attach local tracks if Host is broadcasting
    if (this.isHost && this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    return pc;
  }

  closeSinglePeerConnection(targetSocketId) {
    const pc = this.peerConnections.get(targetSocketId);
    const peerState = this.peerStates.get(targetSocketId);

    if (peerState && peerState.statsTimer) {
      clearInterval(peerState.statsTimer);
      peerState.statsTimer = null;
    }

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
      } catch (e) {}
      this.peerConnections.delete(targetSocketId);
    }
    this.peerStates.delete(targetSocketId);
    this.iceCandidatesQueue.delete(targetSocketId);
  }

  // ==================== 8. ADAPTIVE GETDISPLAYMEDIA CAPTURE ====================
  async getDisplayMediaSafe() {
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // Default target: 1920x1080 @ 30 FPS maximum (never default to 60fps)
    const videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 }
    };

    if (!isFirefox && !isSafari) {
      videoConstraints.displaySurface = 'browser';
    }

    // High quality direct movie/tab audio without artificial voice processing
    const audioConstraints = (isFirefox || isSafari) ? true : {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000
    };

    try {
      console.log('[HOST WEBRTC] Requesting getDisplayMedia with video (max 30fps) + clean tab audio...');
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

  // ==================== 9. START / STOP SCREEN SHARE (HOST) ====================
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

      // PART 2: Determine & Log Capture Capabilities
      if (videoTracks.length > 0) {
        const settings = videoTracks[0].getSettings ? videoTracks[0].getSettings() : {};
        console.log('[HOST WEBRTC] Capture settings', {
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
          displaySurface: settings.displaySurface,
          aspectRatio: settings.aspectRatio
        });
      }

      console.log('[HOST WEBRTC] Captured stream', {
        videoTracks: videoTracks.length,
        audioTracks: audioTracks.length
      });

      if (audioTracks.length > 0) {
        if (typeof showToast === 'function') {
          showToast('🔊 Screen & Tab Audio Sharing Started Live!');
        }
      } else {
        if (typeof showToast === 'function') {
          showToast('🖥️ Video captured. Tip: Share a Chrome Tab with audio checked for sound.');
        }
      }

      this.attachLocalStreamToHost(stream);

      if (videoTracks.length > 0) {
        videoTracks[0].onended = () => {
          console.log('[HOST WEBRTC] Host stopped sharing via browser bar');
          this.stopScreenShare();
        };
      }

      // Connect to all active participants
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

  async connectToSingleUser(targetSocketId) {
    if (!this.localStream) return;

    const tracks = this.localStream.getTracks();
    if (tracks.length === 0) return;

    const peerState = this.getOrCreatePeerState(targetSocketId);
    if (peerState.negotiationInProgress) {
      console.warn('[HOST WEBRTC] Negotiation already in progress for peer:', targetSocketId);
      return;
    }

    const pc = this.createPeerConnection(targetSocketId);

    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
      return;
    }

    const negotiationId = this.generateNegotiationId();
    peerState.negotiationInProgress = true;
    peerState.currentNegotiationId = negotiationId;

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

  // ==================== 10. TOUCH CONTROLS, FULLSCREEN & PIP ====================
  initTouchAndUIControls() {
    const stageContainer = document.getElementById('cinema-viewport') || document.getElementById('viewport-screenshare');

    // Tap/Hover auto-hide controls management
    const showControlsTemporarily = () => {
      if (!this.touchOverlay) return;
      this.touchOverlay.classList.add('active');

      if (this.controlsHideTimeout) clearTimeout(this.controlsHideTimeout);
      this.controlsHideTimeout = setTimeout(() => {
        if (this.touchOverlay && !this.touchOverlay.matches(':hover')) {
          this.touchOverlay.classList.remove('active');
        }
      }, 3000);
    };

    if (stageContainer) {
      stageContainer.addEventListener('mousemove', showControlsTemporarily);
      stageContainer.addEventListener('touchstart', (e) => {
        // Toggle controls visibility on touch without disrupting playback
        if (this.touchOverlay && !this.touchOverlay.classList.contains('active')) {
          this.touchOverlay.classList.add('active');
          showControlsTemporarily();
        }
      }, { passive: true });
    }

    // Fullscreen Toggle Button
    if (this.btnFullscreen) {
      this.btnFullscreen.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFullscreen(stageContainer || document.documentElement);
      });
    }

    // Picture-in-Picture Button
    if (this.btnPip) {
      if (document.pictureInPictureEnabled && this.videoElement && typeof this.videoElement.requestPictureInPicture === 'function') {
        this.btnPip.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (document.pictureInPictureElement) {
              await document.exitPictureInPicture();
            } else if (this.videoElement) {
              await this.videoElement.requestPictureInPicture();
            }
          } catch (err) {
            console.warn('[PiP] Picture-in-picture error:', err.message);
          }
        });
      } else {
        this.btnPip.style.display = 'none'; // Hide if unsupported
      }
    }

    // Audio Mute/Unmute Toggle
    if (this.btnAudioToggle) {
      this.btnAudioToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMute();
      });
    }

    // Center CTA (Autoplay Unlock)
    if (this.centerCta) {
      this.centerCta.addEventListener('click', () => {
        this.unlockAudioPlayback();
      });
    }

    // Quality Badge Click (Toggle Stats Tooltip)
    if (this.qualityBadge) {
      this.qualityBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.qualityStatsPopup) {
          this.qualityStatsPopup.classList.toggle('hidden');
        }
      });
    }

    // Close stats popup on outside click
    document.addEventListener('click', (e) => {
      if (this.qualityStatsPopup && !this.qualityStatsPopup.contains(e.target) && e.target !== this.qualityBadge) {
        this.qualityStatsPopup.classList.add('hidden');
      }
    });

    // Fullscreen change listener
    const onFullscreenChange = () => {
      const isFull = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      if (this.iconFullscreen) {
        this.iconFullscreen.textContent = isFull ? '🗗' : '⛶';
      }
      if (stageContainer) {
        stageContainer.classList.toggle('is-fullscreen', isFull);
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  }

  async toggleFullscreen(element) {
    try {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if (element.webkitRequestFullscreen) {
          await element.webkitRequestFullscreen();
        }

        // Lock to landscape on mobile where supported
        if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.lock === 'function') {
          screen.orientation.lock('landscape').catch(() => {});
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          await document.webkitExitFullscreen();
        }
      }
    } catch (e) {
      console.warn('[Fullscreen] Notice:', e.message);
    }
  }

  toggleMute() {
    if (!this.videoElement) return;
    this.videoElement.muted = !this.videoElement.muted;
    if (this.iconAudio) {
      this.iconAudio.textContent = this.videoElement.muted ? '🔇' : '🔊';
    }
    if (typeof showToast === 'function') {
      showToast(this.videoElement.muted ? '🔇 Audio muted' : '🔊 Audio unmuted');
    }
  }

  unlockAudioPlayback() {
    if (!this.videoElement) return;
    this.videoElement.muted = false;
    this.videoElement.play().then(() => {
      if (this.centerCta) this.centerCta.classList.add('hidden');
      if (this.iconAudio) this.iconAudio.textContent = '🔊';
      if (typeof showToast === 'function') showToast('🔊 Live theatre sound enabled!');
    }).catch(e => {
      console.warn('[Audio Unlock] Playback retry error:', e.message);
    });
  }

  // ==================== 11. NETWORK CHANGE LISTENERS ====================
  initNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('[Network] Browser is online. Verifying ICE connections...');
      if (typeof showToast === 'function') showToast('🌐 Network connection restored');
      this.peerConnections.forEach((pc) => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          if (typeof pc.restartIce === 'function') pc.restartIce();
        }
      });
    });

    window.addEventListener('offline', () => {
      console.warn('[Network] Browser is offline.');
      if (typeof showToast === 'function') showToast('⚠️ Network connection dropped. Reconnecting...');
      if (this.bufferingIndicator) this.bufferingIndicator.classList.remove('hidden');
    });
  }

  // ==================== 12. VIDEO ATTACHMENT & RECOVERY ====================
  attachLocalStreamToHost(stream) {
    if (this.videoElement) {
      this.videoElement.srcObject = stream;
      this.videoElement.style.display = 'block';
      this.videoElement.muted = true; // Host muted locally to prevent echo

      const playPromise = this.videoElement.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {});
      }
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
    if (this.touchOverlay) {
      this.touchOverlay.style.display = 'flex';
    }
  }

  attachRemoteStreamToGuest(remoteStream) {
    if (this.videoElement) {
      if (this.videoElement.srcObject !== remoteStream) {
        console.log('[GUEST WEBRTC] Attaching remote stream to video element');
        this.videoElement.srcObject = remoteStream;
        this.videoElement.style.display = 'block';
        this.videoElement.muted = false;

        const playPromise = this.videoElement.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              console.log('[GUEST WEBRTC] Remote video playing with sound');
              if (this.centerCta) this.centerCta.classList.add('hidden');
              if (this.iconAudio) this.iconAudio.textContent = '🔊';
            })
            .catch((err) => {
              console.warn('[GUEST WEBRTC] Unmuted playback blocked by browser policy. Falling back to muted with tap prompt:', err.message);
              this.videoElement.muted = true;
              this.videoElement.play().then(() => {
                if (this.centerCta) this.centerCta.classList.remove('hidden');
                if (this.iconAudio) this.iconAudio.textContent = '🔇';
              }).catch(() => {});
            });
        }
      }
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'none';
    }
    if (this.touchOverlay) {
      this.touchOverlay.style.display = 'flex';
    }
  }

  clearVideo() {
    if (this.guestStatsTimer) {
      clearInterval(this.guestStatsTimer);
      this.guestStatsTimer = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.style.display = 'none';
    }

    if (this.placeholderEl) {
      this.placeholderEl.style.display = 'flex';
    }
    if (this.touchOverlay) {
      this.touchOverlay.style.display = 'none';
    }
    if (this.centerCta) {
      this.centerCta.classList.add('hidden');
    }
    if (this.bufferingIndicator) {
      this.bufferingIndicator.classList.add('hidden');
    }
  }
}

window.WebRTCManager = WebRTCManager;
