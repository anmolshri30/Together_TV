/* ==========================================================================
   SYNCHRONIZED MEDIA & BROWSER URL MANAGER
   Continuous YouTube Sync with Latency-Compensated Drift Correction
   Host-Only Play/Pause/Seek Controls, Chrome Address Bar & Bookmarks
   ========================================================================== */

class PlayerManager {
  constructor(socket) {
    this.socket = socket;
    this.currentMode = 'screenshare'; // 'screenshare' | 'youtube' | 'web'
    this.currentUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    this.currentVideoId = 'aqz-KE-bpKQ';
    this.ytPlayer = null;
    this.isHost = false;
    this.isSyncing = false; // Prevent echo broadcast loops during remote sync updates
    this.pendingVideoId = null;

    this.webIframe = document.getElementById('web-view-iframe');
    this.urlInput = document.getElementById('chrome-url-input');
    this.iframeNotice = document.getElementById('iframe-fallback-banner');

    // Control Deck elements
    this.btnPlayPause = document.getElementById('btn-deck-playpause');
    this.playPauseIcon = document.getElementById('playpause-icon');
    this.playPauseText = document.getElementById('playpause-text');
    this.seekBar = document.getElementById('deck-seek-bar');
  }

  // Safe helper for YT.PlayerState enum
  getYTStates() {
    return {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: (window.YT && window.YT.PlayerState) ? window.YT.PlayerState.PLAYING : 1,
      PAUSED: (window.YT && window.YT.PlayerState) ? window.YT.PlayerState.PAUSED : 2,
      BUFFERING: (window.YT && window.YT.PlayerState) ? window.YT.PlayerState.BUFFERING : 3,
      CUED: 5
    };
  }

  init() {
    // Chrome address bar navigation
    const btnNav = document.getElementById('btn-navigate-url');
    if (btnNav) {
      btnNav.addEventListener('click', () => {
        if (this.isHost) this.handleUrlSubmit();
      });
    }

    if (this.urlInput) {
      this.urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && this.isHost) this.handleUrlSubmit();
      });
    }

    // Tab switching event listeners
    document.querySelectorAll('.chrome-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-tab');
        this.switchTabMode(mode, this.isHost);
      });
    });

    // Quick Bookmarks Pills (Host only)
    const bmYoutube = document.getElementById('bm-youtube-demo');
    if (bmYoutube) {
      bmYoutube.addEventListener('click', () => {
        if (this.isHost) this.loadUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'youtube', true);
      });
    }

    const bmTrailer = document.getElementById('bm-trailer');
    if (bmTrailer) {
      bmTrailer.addEventListener('click', () => {
        if (this.isHost) this.loadUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', true);
      });
    }

    const bmLofi = document.getElementById('bm-lofi');
    if (bmLofi) {
      bmLofi.addEventListener('click', () => {
        if (this.isHost) this.loadUrl('https://www.youtube.com/watch?v=jfKfPfyJRdk', 'youtube', true);
      });
    }

    const bmScreenshare = document.getElementById('bm-screenshare');
    if (bmScreenshare) {
      bmScreenshare.addEventListener('click', () => {
        if (this.isHost) this.switchTabMode('screenshare', true);
      });
    }

    // Control Deck Play/Pause Click (Host only)
    if (this.btnPlayPause) {
      this.btnPlayPause.addEventListener('click', () => {
        if (this.isHost) this.togglePlayPauseDeck();
      });
    }

    // Control Deck Seek Bar Drag (Host only)
    if (this.seekBar) {
      this.seekBar.addEventListener('change', () => {
        if (this.isHost && this.ytPlayer && typeof this.ytPlayer.getDuration === 'function') {
          const duration = this.ytPlayer.getDuration();
          const targetTime = (this.seekBar.value / 100) * duration;
          this.ytPlayer.seekTo(targetTime, true);
          this.socket.emit('sync-playback', { action: 'seek', time: targetTime });
        }
      });
    }

    // Socket Listener: Continuous Heartbeat Sync (Guest Side)
    this.socket.on('sync-heartbeat', ({ time, isPlaying, mode, videoId, timestamp }) => {
      if (this.isHost || !this.ytPlayer) return;

      // If host switched video ID, load new video
      if (videoId && videoId !== this.currentVideoId) {
        console.log(`[YouTube Sync] Video changed by host to ${videoId}`);
        this.currentVideoId = videoId;
        if (typeof this.ytPlayer.loadVideoById === 'function') {
          this.ytPlayer.loadVideoById(videoId, time || 0);
        }
        return;
      }

      this.isSyncing = true;
      const ytStates = this.getYTStates();
      const currTime = typeof this.ytPlayer.getCurrentTime === 'function' ? this.ytPlayer.getCurrentTime() : 0;
      const state = typeof this.ytPlayer.getPlayerState === 'function' ? this.ytPlayer.getPlayerState() : -1;

      // Step 12: Calculate expected playback position using elapsed network latency
      const elapsedLatency = timestamp ? Math.max(0, (Date.now() - timestamp) / 1000) : 0;
      const expectedTime = isPlaying ? (time + elapsedLatency) : time;
      const drift = Math.abs(currTime - expectedTime);

      // Apply proportional drift correction
      if (typeof expectedTime === 'number' && !isNaN(expectedTime)) {
        if (drift > 2.0) {
          // Large drift (> 2.0s) -> immediate seek
          console.log(`[YouTube Sync] Correcting large drift (${drift.toFixed(2)}s) -> seeking to ${expectedTime.toFixed(1)}s`);
          this.ytPlayer.seekTo(expectedTime, true);
        } else if (drift > 0.8) {
          // Moderate drift (0.8s - 2.0s) -> gentle seek without jitter
          this.ytPlayer.seekTo(expectedTime, true);
        }
      }

      // Synchronize play / pause state
      if (isPlaying && state !== ytStates.PLAYING && state !== ytStates.BUFFERING) {
        if (typeof this.ytPlayer.playVideo === 'function') this.ytPlayer.playVideo();
        this.updateDeckPlayPauseUI(true);
      } else if (!isPlaying && state === ytStates.PLAYING) {
        if (typeof this.ytPlayer.pauseVideo === 'function') this.ytPlayer.pauseVideo();
        this.updateDeckPlayPauseUI(false);
      }

      setTimeout(() => {
        this.isSyncing = false;
      }, 400);
    });

    // Sync Button Click (Guest Side)
    const btnSync = document.getElementById('btn-video-sync');
    if (btnSync) {
      btnSync.addEventListener('click', (e) => {
        e.stopPropagation();
        this.forceSync();
      });
    }

    // Host receives request to broadcast fresh authoritative sync snapshot
    this.socket.on('guest-requested-sync', () => {
      if (this.isHost && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function' && this.currentMode === 'youtube') {
        const time = this.ytPlayer.getCurrentTime();
        const isPlaying = (this.ytPlayer.getPlayerState() === this.getYTStates().PLAYING);
        this.socket.emit('sync-heartbeat', {
          time,
          isPlaying,
          mode: this.currentMode,
          videoId: this.currentVideoId,
          timestamp: Date.now()
        });
      }
    });

    // Initialize YouTube IFrame API & Heartbeat
    this.initYouTubeAPI();
    this.startHostHeartbeatLoop();
  }

  // Force authoritative sync refresh (Guest Side)
  forceSync() {
    console.log('[Player] Guest requested immediate authoritative sync from Host');
    this.socket.emit('request-host-sync');
    if (typeof showToast === 'function') {
      showToast('🔄 Synchronizing stage with host...');
    }
  }

  // Continuous Heartbeat Loop (Host Side - every 1.5s)
  startHostHeartbeatLoop() {
    setInterval(() => {
      const ytStates = this.getYTStates();
      if (this.isHost && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function' && this.currentMode === 'youtube') {
        const time = this.ytPlayer.getCurrentTime();
        const isPlaying = (this.ytPlayer.getPlayerState() === ytStates.PLAYING);

        // Update seek bar progress in host control deck
        if (this.seekBar && typeof this.ytPlayer.getDuration === 'function') {
          const duration = this.ytPlayer.getDuration();
          if (duration > 0) {
            this.seekBar.value = (time / duration) * 100;
          }
        }

        this.socket.emit('sync-heartbeat', {
          time,
          isPlaying,
          mode: this.currentMode,
          videoId: this.currentVideoId,
          timestamp: Date.now()
        });
      }
    }, 1500);
  }

  // Load YouTube IFrame API dynamically
  initYouTubeAPI() {
    const setupPlayer = () => {
      if (window.YT && window.YT.Player) {
        console.log('[YouTube API] Initializing YT.Player instance...');
        this.ytPlayer = new window.YT.Player('yt-player-container', {
          height: '100%',
          width: '100%',
          videoId: this.currentVideoId,
          playerVars: {
            'autoplay': 0,
            'controls': 1,
            'enablejsapi': 1,
            'rel': 0,
            'modestbranding': 1,
            'origin': window.location.origin
          },
          events: {
            'onReady': () => {
              console.log('[YouTube Player API] Ready & Synced!');
              if (this.pendingVideoId && typeof this.ytPlayer.loadVideoById === 'function') {
                this.ytPlayer.loadVideoById(this.pendingVideoId);
                this.currentVideoId = this.pendingVideoId;
                this.pendingVideoId = null;
              }
            },
            'onStateChange': (event) => this.onYouTubeStateChange(event)
          }
        });
      }
    };

    if (window.YT && window.YT.Player) {
      setupPlayer();
    } else {
      window.onYouTubeIframeAPIReady = () => {
        setupPlayer();
      };
    }
  }

  // Handle YouTube Player State Changes
  onYouTubeStateChange(event) {
    if (this.isSyncing) return;

    const state = event.data;
    const ytStates = this.getYTStates();
    const currentTime = this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function' ? this.ytPlayer.getCurrentTime() : 0;

    if (state === ytStates.PLAYING) {
      this.updateDeckPlayPauseUI(true);
      if (this.isHost) {
        console.log(`[Host YouTube] Play at ${currentTime.toFixed(1)}s -> Broadcasting to room`);
        this.socket.emit('sync-playback', { action: 'play', time: currentTime });
      }
    } else if (state === ytStates.PAUSED) {
      this.updateDeckPlayPauseUI(false);
      if (this.isHost) {
        console.log(`[Host YouTube] Pause at ${currentTime.toFixed(1)}s -> Broadcasting to room`);
        this.socket.emit('sync-playback', { action: 'pause', time: currentTime });
      }
    }
  }

  // Toggle Play / Pause from Control Deck
  togglePlayPauseDeck() {
    if (!this.ytPlayer || !this.isHost) return;

    const ytStates = this.getYTStates();
    const state = typeof this.ytPlayer.getPlayerState === 'function' ? this.ytPlayer.getPlayerState() : -1;

    if (state === ytStates.PLAYING) {
      this.ytPlayer.pauseVideo();
      this.updateDeckPlayPauseUI(false);
      this.socket.emit('sync-playback', { action: 'pause', time: this.ytPlayer.getCurrentTime() });
    } else {
      this.ytPlayer.playVideo();
      this.updateDeckPlayPauseUI(true);
      this.socket.emit('sync-playback', { action: 'play', time: this.ytPlayer.getCurrentTime() });
    }
  }

  updateDeckPlayPauseUI(isPlaying) {
    if (this.playPauseIcon) this.playPauseIcon.textContent = isPlaying ? '⏸️' : '▶️';
    if (this.playPauseText) this.playPauseText.textContent = isPlaying ? 'Pause' : 'Play';
  }

  // Handle submit from URL input
  handleUrlSubmit() {
    const inputVal = (this.urlInput ? this.urlInput.value : '').trim();
    if (!inputVal) return;

    let targetUrl = inputVal;
    let mode = 'web';

    if (inputVal.includes('youtube.com') || inputVal.includes('youtu.be')) {
      mode = 'youtube';
    } else if (!inputVal.startsWith('http://') && !inputVal.startsWith('https://')) {
      targetUrl = `https://${inputVal}`;
    }

    this.loadUrl(targetUrl, mode, true);
  }

  // Robust YouTube ID Extraction
  extractVideoId(url) {
    if (!url) return '';
    const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regExp);
    return (match && match[1]) ? match[1] : '';
  }

  // Load URL into appropriate player/iframe
  loadUrl(url, mode, broadcast = false) {
    this.currentUrl = url;
    this.currentMode = mode;

    if (this.urlInput) {
      this.urlInput.value = url;
    }

    this.switchTabMode(mode, false);

    if (mode === 'youtube') {
      const videoId = this.extractVideoId(url);
      if (videoId) {
        this.currentVideoId = videoId;
        if (this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function') {
          this.ytPlayer.loadVideoById(videoId);
        } else {
          this.pendingVideoId = videoId;
        }
      }
    } else if (mode === 'web') {
      if (this.webIframe) {
        this.webIframe.src = url;
      }
      if (this.iframeNotice) {
        this.iframeNotice.classList.remove('hidden');
      }
    }

    if (broadcast && this.isHost) {
      this.socket.emit('sync-navigation', { url: this.currentUrl, mode: this.currentMode });
    }
  }

  // Switch Chrome Tab View
  switchTabMode(mode, broadcast = false) {
    this.currentMode = mode;

    document.querySelectorAll('.chrome-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === mode);
    });

    document.querySelectorAll('.stage-view-panel').forEach((panel) => {
      panel.classList.remove('active');
    });

    const activePanel = document.getElementById(`viewport-${mode}`);
    if (activePanel) {
      activePanel.classList.add('active');
    }

    if (broadcast && this.isHost) {
      this.socket.emit('sync-navigation', { url: this.currentUrl, mode: this.currentMode });
    }
  }

  // Handle incoming playback sync from socket (play/pause/seek)
  handleSyncPlayback(action, time) {
    console.log(`[Player Sync Action] ${action} at ${time}s`);
    this.isSyncing = true;

    if (this.ytPlayer) {
      const currTime = typeof this.ytPlayer.getCurrentTime === 'function' ? this.ytPlayer.getCurrentTime() : 0;

      if (typeof time === 'number' && Math.abs(currTime - time) > 0.8) {
        if (typeof this.ytPlayer.seekTo === 'function') {
          this.ytPlayer.seekTo(time, true);
        }
      }

      if (action === 'play' && typeof this.ytPlayer.playVideo === 'function') {
        this.ytPlayer.playVideo();
        this.updateDeckPlayPauseUI(true);
      } else if (action === 'pause' && typeof this.ytPlayer.pauseVideo === 'function') {
        this.ytPlayer.pauseVideo();
        this.updateDeckPlayPauseUI(false);
      } else if (action === 'seek' && typeof this.ytPlayer.seekTo === 'function') {
        this.ytPlayer.seekTo(time, true);
      }
    }

    setTimeout(() => {
      this.isSyncing = false;
    }, 400);
  }
}

window.PlayerManager = PlayerManager;
