/* ==========================================================================
   SYNCHRONIZED MEDIA & BROWSER URL MANAGER
   Handles YouTube iFrame API, Play/Pause/Seek Real-Time Synchronization
   ========================================================================== */

class PlayerManager {
  constructor(socket) {
    this.socket = socket;
    this.currentMode = 'screenshare'; // 'screenshare' | 'youtube' | 'web'
    this.currentUrl = '';
    this.ytPlayer = null;
    this.isHost = false;
    this.isSyncing = false; // Prevent echo loop when applying remote sync

    this.ytIframe = document.getElementById('yt-player-iframe');
    this.webIframe = document.getElementById('web-view-iframe');
    this.urlInput = document.getElementById('chrome-url-input');
    this.iframeNotice = document.getElementById('iframe-fallback-banner');

    // Control Deck elements
    this.btnPlayPause = document.getElementById('btn-deck-playpause');
    this.playPauseIcon = document.getElementById('playpause-icon');
    this.playPauseText = document.getElementById('playpause-text');
    this.seekBar = document.getElementById('deck-seek-bar');
  }

  init() {
    // Listen for Chrome address bar navigation
    const btnNav = document.getElementById('btn-navigate-url');
    if (btnNav) {
      btnNav.addEventListener('click', () => this.handleUrlSubmit());
    }

    if (this.urlInput) {
      this.urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.handleUrlSubmit();
      });
    }

    // Tab switching event listeners
    document.querySelectorAll('.chrome-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-tab');
        this.switchTabMode(mode, true);
      });
    });

    // Bookmarks Pills
    const bmYoutube = document.getElementById('bm-youtube-demo');
    if (bmYoutube) {
      bmYoutube.addEventListener('click', () => {
        this.loadUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'youtube', true);
      });
    }

    const bmTrailer = document.getElementById('bm-trailer');
    if (bmTrailer) {
      bmTrailer.addEventListener('click', () => {
        this.loadUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', true);
      });
    }

    const bmLofi = document.getElementById('bm-lofi');
    if (bmLofi) {
      bmLofi.addEventListener('click', () => {
        this.loadUrl('https://www.youtube.com/watch?v=jfKfPfyJRdk', 'youtube', true);
      });
    }

    const bmScreenshare = document.getElementById('bm-screenshare');
    if (bmScreenshare) {
      bmScreenshare.addEventListener('click', () => {
        this.switchTabMode('screenshare', true);
      });
    }

    // Control Deck Play/Pause Click
    if (this.btnPlayPause) {
      this.btnPlayPause.addEventListener('click', () => {
        this.togglePlayPauseDeck();
      });
    }

    // Control Deck Seek Bar Drag
    if (this.seekBar) {
      this.seekBar.addEventListener('change', () => {
        if (this.ytPlayer && typeof this.ytPlayer.getDuration === 'function') {
          const duration = this.ytPlayer.getDuration();
          const targetTime = (this.seekBar.value / 100) * duration;
          this.ytPlayer.seekTo(targetTime, true);
          if (this.isHost) {
            this.socket.emit('sync-playback', { action: 'seek', time: targetTime });
          }
        }
      });
    }

    // Initialize YouTube iFrame API
    this.initYouTubeAPI();
  }

  // Load YouTube API
  initYouTubeAPI() {
    const setupPlayer = () => {
      if (window.YT && window.YT.Player) {
        this.ytPlayer = new window.YT.Player('yt-player-iframe', {
          events: {
            'onReady': () => console.log('[YouTube Player API] Ready!'),
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

  // Handle YouTube Player State Change
  onYouTubeStateChange(event) {
    if (this.isSyncing) return; // ignore events triggered by socket sync

    const state = event.data;
    const currentTime = this.ytPlayer ? this.ytPlayer.getCurrentTime() : 0;

    if (state === window.YT.PlayerState.PLAYING) {
      this.updateDeckPlayPauseUI(true);
      if (this.isHost) {
        this.socket.emit('sync-playback', { action: 'play', time: currentTime });
      }
    } else if (state === window.YT.PlayerState.PAUSED) {
      this.updateDeckPlayPauseUI(false);
      if (this.isHost) {
        this.socket.emit('sync-playback', { action: 'pause', time: currentTime });
      }
    }
  }

  // Toggle Play / Pause from Control Deck
  togglePlayPauseDeck() {
    if (!this.ytPlayer) return;

    const state = this.ytPlayer.getPlayerState();
    if (state === window.YT.PlayerState.PLAYING) {
      this.ytPlayer.pauseVideo();
      this.updateDeckPlayPauseUI(false);
      if (this.isHost) {
        this.socket.emit('sync-playback', { action: 'pause', time: this.ytPlayer.getCurrentTime() });
      }
    } else {
      this.ytPlayer.playVideo();
      this.updateDeckPlayPauseUI(true);
      if (this.isHost) {
        this.socket.emit('sync-playback', { action: 'play', time: this.ytPlayer.getCurrentTime() });
      }
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
      targetUrl = this.convertToYouTubeEmbed(inputVal);
    } else if (!inputVal.startsWith('http://') && !inputVal.startsWith('https://')) {
      targetUrl = `https://${inputVal}`;
    }

    this.loadUrl(targetUrl, mode, true);
  }

  // Convert YouTube link to embed URL with enablejsapi=1
  convertToYouTubeEmbed(url) {
    let videoId = '';
    if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('watch?v=')) {
      videoId = url.split('watch?v=')[1].split('&')[0];
    } else if (url.includes('/embed/')) {
      const parts = url.split('/embed/')[1].split('?')[0];
      videoId = parts;
    }

    return videoId ? `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1` : url;
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
      if (this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function' && videoId) {
        this.ytPlayer.loadVideoById(videoId);
      } else if (this.ytIframe) {
        this.ytIframe.src = this.convertToYouTubeEmbed(url);
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

  extractVideoId(url) {
    if (url.includes('youtu.be/')) {
      return url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('watch?v=')) {
      return url.split('watch?v=')[1].split('&')[0];
    } else if (url.includes('/embed/')) {
      return url.split('/embed/')[1].split('?')[0];
    }
    return '';
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

  // Handle incoming playback sync from socket
  handleSyncPlayback(action, time) {
    console.log(`[Player Sync Action] ${action} at ${time}s`);
    this.isSyncing = true;

    if (this.ytPlayer) {
      if (typeof time === 'number' && Math.abs((this.ytPlayer.getCurrentTime() || 0) - time) > 1.2) {
        this.ytPlayer.seekTo(time, true);
      }

      if (action === 'play') {
        this.ytPlayer.playVideo();
        this.updateDeckPlayPauseUI(true);
      } else if (action === 'pause') {
        this.ytPlayer.pauseVideo();
        this.updateDeckPlayPauseUI(false);
      } else if (action === 'seek') {
        this.ytPlayer.seekTo(time, true);
      }
    }

    setTimeout(() => {
      this.isSyncing = false;
    }, 500);
  }
}

window.PlayerManager = PlayerManager;
