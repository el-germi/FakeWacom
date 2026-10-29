// Streams every touch/pointer event on #pad to the server over a WebSocket.
// ES5 on purpose so IE11 (Windows RT) can run it. IE11 has Pointer Events but no Touch Events;
// browsers without Pointer Events fall back to Touch Events.
(function () {
	var pad = document.getElementById("pad");
	var status = document.getElementById("status");
	var socket = null;

	function setStatus(text) {
		status.textContent = text;
	}

	function send(msg) {
		if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
	}

	function hello() {
		send({ type: "hello", width: window.innerWidth, height: window.innerHeight });
	}

	// Screen frames arrive as binary JPEGs. Only the newest one is worth showing: while an image is
	// decoding, a newer frame replaces any waiting one. Every frame, shown or dropped, is acked so
	// the server knows how many are still in flight.
	var canvas = document.getElementById("screen");
	var ctx = canvas.getContext("2d");
	var hud = document.getElementById("hud");
	var lastImage = null;
	var waitingFrame = null;
	var decoding = false;

	function fitCanvas() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		drawScreen();
	}

	function drawScreen() {
		if (lastImage) ctx.drawImage(lastImage, 0, 0, canvas.width, canvas.height);
	}

	function showNextFrame() {
		if (decoding || !waitingFrame) return;
		decoding = true;
		var url = URL.createObjectURL(new Blob([waitingFrame], { type: "image/jpeg" }));
		waitingFrame = null;
		var img = new Image();
		var finish = function () {
			URL.revokeObjectURL(url);
			decoding = false;
			send({ type: "ack" });
			showNextFrame();
		};
		img.onload = function () {
			lastImage = img;
			drawScreen();
			hud.style.display = "none";
			finish();
		};
		img.onerror = finish;
		img.src = url;
	}

	function onFrame(data) {
		if (waitingFrame) send({ type: "ack" }); // dropped unseen
		waitingFrame = data;
		showNextFrame();
	}

	function connect() {
		var proto = location.protocol === "https:" ? "wss://" : "ws://";
		var token = (location.search.match(/[?&]token=([^&]*)/) || [])[1] || "";
		socket = new WebSocket(proto + location.host + "/touch?token=" + token);
		socket.binaryType = "arraybuffer";
		socket.onopen = function () {
			setStatus("waiting for screen");
			hello();
		};
		socket.onmessage = function (e) {
			if (typeof e.data !== "string") onFrame(e.data);
		};
		socket.onclose = function () {
			hud.style.display = "block";
			setStatus("disconnected, retrying");
			waitingFrame = null;
			decoding = false;
			setTimeout(connect, 1000);
		};
	}

	// Browsers only go fullscreen from a user gesture, so the first tap of the page asks for it.
	// Mouse counts as a gesture on down, touch and pen only on up, so it asks on both. That tap is
	// used up instead of clicking on the PC. One try per page load, so a refused request can't keep
	// eating taps.
	var root = document.documentElement;
	var goFullscreen = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
	var fullscreenTapId = null;

	function isFullscreen() {
		return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
	}

	function requestFullscreen() {
		if (isFullscreen()) return;
		try {
			var result = goFullscreen.call(root);
			if (result && result.then) result.then(null, function () {}); // refused: not a gesture yet
		} catch (e) {}
	}

	// True when the event belongs to the fullscreen tap and must not reach the PC.
	function fullscreenTap(type, id) {
		if (!goFullscreen) return false;
		if (type === "down" && fullscreenTapId === null) {
			if (isFullscreen()) {
				goFullscreen = null;
				return false;
			}
			fullscreenTapId = id;
		}
		if (id !== fullscreenTapId) return false;
		if (type === "down" || type === "up") requestFullscreen();
		if (type === "up" || type === "cancel") goFullscreen = null;
		return true;
	}

	function now() {
		return Math.round(window.performance && performance.now ? performance.now() : new Date().getTime());
	}

	if (window.PointerEvent) {
		var names = {
			pointerdown: "down",
			pointermove: "move",
			pointerup: "up",
			pointercancel: "cancel",
			pointerleave: "leave",
		};
		var sendPointer = function (type, e) {
			send({
				type: type,
				id: e.pointerId,
				pointerType: e.pointerType,
				x: e.clientX,
				y: e.clientY,
				pressure: e.pressure,
				tiltX: e.tiltX,
				tiltY: e.tiltY,
				twist: e.twist,
				buttons: e.buttons,
				width: e.width,
				height: e.height,
				time: now(),
			});
		};
		var onPointer = function (e) {
			e.preventDefault();
			if (fullscreenTap(names[e.type], e.pointerId)) return;
			// A browser merges several samples into one pointermove; send them all so strokes stay smooth.
			var samples = e.type === "pointermove" && e.getCoalescedEvents ? e.getCoalescedEvents() : null;
			if (samples && samples.length) {
				for (var i = 0; i < samples.length; i++) sendPointer("move", samples[i]);
			} else {
				sendPointer(names[e.type], e);
			}
		};
		for (var type in names) pad.addEventListener(type, onPointer, false);
		pad.addEventListener("contextmenu", function (e) { e.preventDefault(); }, false);
	} else {
		var touchNames = { touchstart: "down", touchmove: "move", touchend: "up", touchcancel: "cancel" };
		var onTouch = function (e) {
			e.preventDefault();
			for (var i = 0; i < e.changedTouches.length; i++) {
				var t = e.changedTouches[i];
				if (fullscreenTap(touchNames[e.type], t.identifier)) continue;
				send({
					type: touchNames[e.type],
					id: t.identifier,
					pointerType: "touch",
					x: t.clientX,
					y: t.clientY,
					pressure: t.force,
					width: (t.radiusX || 0) * 2,
					height: (t.radiusY || 0) * 2,
					time: now(),
				});
			}
		};
		for (var touchType in touchNames) pad.addEventListener(touchType, onTouch, false);
	}

	window.addEventListener("resize", function () {
		fitCanvas();
		hello();
	}, false);
	fitCanvas();
	connect();
})();
