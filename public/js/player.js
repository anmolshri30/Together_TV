/* ==========================================================================
   SYNCHRONIZED MEDIA & BROWSER URL MANAGER
   Handles YouTube iFrame API, Direct Video Sync, and Chrome URL Navigation
   ========================================================================== */

class PlayerManager {
  constructor(socket) {
    this.socket = socket;
    this.currentMode = 'screenshare'; // 'screenshare' | 'youtube' | 'web'
    this.currentUrl = '';
    this.ytPlayer = null;
    this.isHost = false;

    this.ytIframe = document.getElementById('yt-player-iframe');
    this.webIframe = document.getElementById('web-view-iframe');
    this.urlInput = document.getElementById('chrome-url-input');
    this.iframeNotice = document.getElementById('iframe-fallback-banner');
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
      tab.addEventListener('click', (e) => {
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
  }

  // Handle submit from URL input
  handleUrlSubmit() {
    const inputVal = (this.urlInput ? this.urlInput.value : '').trim();
    if (!inputVal) return;

    let targetUrl = inputVal;
    let mode = 'web';

    // Auto-detect YouTube URL
    if (inputVal.includes('youtube.com') || inputVal.includes('youtu.be')) {
      mode = 'youtube';
      targetUrl = this.convertToYouTubeEmbed(inputVal);
    } else if (!inputVal.startsWith('http://') && !inputVal.startsWith('https://')) {
      // Treat as search query or add https://
      targetUrl = `https://${inputVal}`;
    }

    this.loadUrl(targetUrl, mode, true);
  }

  // Helper to extract YouTube ID & convert to embed URL
  convertToYouTubeEmbed(url) {
    let videoId = '';
    if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('watch?v=')) {
      videoId = url.split('watch?v=')[1].split('&')[0];
    } else if (url.includes('/embed/')) {
      return url;
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

    // Switch active tab UI
    this.switchTabMode(mode, false);

    if (mode === 'youtube') {
      if (this.ytIframe) {
        const embedUrl = this.convertToYouTubeEmbed(url);
        this.ytIframe.src = embedUrl;
      }
    } else if (mode === 'web') {
      if (this.webIframe) {
        this.webIframe.src = url;
      }
      // Show CORS notice banner
      if (this.iframeNotice) {
        this.iframeNotice.classList.remove('hidden');
      }
    }

    if (broadcast && this.isHost) {
      this.socket.emit('sync-navigation', { url: this.currentUrl, mode: this.currentMode });
    }
  }

  // Switch Chrome Tab View (screenshare | youtube | web)
  switchTabMode(mode, broadcast = false) {
    this.currentMode = mode;

    // Update Chrome Tab styles
    document.querySelectorAll('.chrome-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === mode);
    });

    // Update Viewport stage panels
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

  // Sync playback action from socket (play, pause, seek)
  handleSyncPlayback(action, time) {
    console.log(`[Player Sync] Action: ${action}, Time: ${time}`);
    // Future expansion: postMessage to YouTube iFrame API if enabled
  }
}

window.PlayerManager = PlayerManager;
