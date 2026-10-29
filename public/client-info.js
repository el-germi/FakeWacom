// Collects what this browser's JS can see and reports it to the server once per page load.
// Written in ES5 on purpose (var, function, XMLHttpRequest) so old browsers like IE11 can run it.
(function () {
  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  }

  function has(obj, key) {
    return key in obj;
  }

  var canvas = document.createElement("canvas");
  var gl = safe(function () {
    return canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  });
  var glDebug = gl && safe(function () {
    return gl.getExtension("WEBGL_debug_renderer_info");
  });

  var info = {
    userAgent: navigator.userAgent,
    userAgentData: safe(function () {
      return navigator.userAgentData.toJSON();
    }),
    platform: navigator.platform,
    language: navigator.language || navigator.browserLanguage || navigator.userLanguage,
    languages: navigator.languages ? Array.prototype.slice.call(navigator.languages) : null,
    timezone: safe(function () {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }),
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    cookiesEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack || navigator.msDoNotTrack || window.doNotTrack,
    online: navigator.onLine,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints || navigator.msMaxTouchPoints,
    documentMode: document.documentMode,
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    connection: safe(function () {
      var c = navigator.connection;
      return c && { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
    }),
    webgl: gl && {
      vendor: gl.getParameter(glDebug ? glDebug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(glDebug ? glDebug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    },
    prefers: safe(function () {
      return {
        darkMode: window.matchMedia("(prefers-color-scheme: dark)").matches,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
    }),
    features: {
      localStorage: safe(function () {
        return !!window.localStorage;
      }),
      sessionStorage: safe(function () {
        return !!window.sessionStorage;
      }),
      indexedDB: has(window, "indexedDB"),
      serviceWorker: has(navigator, "serviceWorker"),
      webAssembly: typeof WebAssembly === "object",
      webSocket: has(window, "WebSocket"),
      webWorker: has(window, "Worker"),
      fetch: has(window, "fetch"),
      promise: has(window, "Promise"),
      webGL: !!gl,
      webGL2: safe(function () {
        return !!canvas.getContext("webgl2");
      }),
      webGPU: has(navigator, "gpu"),
      webRTC: has(window, "RTCPeerConnection"),
      geolocation: has(navigator, "geolocation"),
      notifications: has(window, "Notification"),
      clipboard: has(navigator, "clipboard"),
      bluetooth: has(navigator, "bluetooth"),
      mediaDevices: has(navigator, "mediaDevices"),
      touch: has(window, "ontouchstart") || has(window, "MSPointerEvent"),
    },
  };

  var xhr = new XMLHttpRequest();
  xhr.open("POST", "/__client-info");
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.send(JSON.stringify(info));
})();
