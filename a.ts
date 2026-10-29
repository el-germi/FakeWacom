import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createPen } from "./pen.ts";
import { startScreenStream } from "./stream.ts";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// Server-side view: log the headers every page visit exposes.
// JSON.stringify keeps client-controlled values from injecting newlines into the log.
app.use((req, _res, next) => {
	if (req.accepts(["html", "*/*"]) === "html" && req.method === "GET") {
		console.log(
			`[visit] ${new Date().toISOString()} ${req.ip} ${req.path}`,
			JSON.stringify({
				userAgent: req.get("user-agent"),
				acceptLanguage: req.get("accept-language"),
				acceptEncoding: req.get("accept-encoding"),
				referer: req.get("referer"),
				secChUa: req.get("sec-ch-ua"),
				secChUaPlatform: req.get("sec-ch-ua-platform"),
				secChUaMobile: req.get("sec-ch-ua-mobile"),
			}),
		);
	}
	next();
});

// Client-side view: public/client-info.js posts what the browser's JS can see.
app.post("/__client-info", express.json({ limit: "10kb" }), (req, res) => {
	console.log(`[client] ${req.ip}`, JSON.stringify(req.body));
	res.sendStatus(204);
});

app.use(express.static(path.join(import.meta.dirname, "public")));

const server = app.listen(port, host, () => {
	console.log(`Listening on http://${host}:${port}`);
});

// Touch stream: public/touch.js sends one JSON message per touch/pointer event, and each
// connection drives its own synthetic Windows pen (pen.ts).
//
// Anyone who can open this socket can move your pen and click, so it needs the token
// (PAD_TOKEN, or a random one saved to .pad-token). Open the page as /?token=<token>.
const tokenFile = path.join(import.meta.dirname, ".pad-token");
const token =
	process.env.PAD_TOKEN ??
	(fs.existsSync(tokenFile)
		? fs.readFileSync(tokenFile, "utf8").trim()
		: (() => {
			const t = crypto.randomBytes(12).toString("hex");
			fs.writeFileSync(tokenFile, t);
			return t;
		})());
console.log(`Open the pad at http://<this-pc-ip>:${port}/?token=${token}`);

const logTouch = process.env.TOUCH_LOG === "1"; // one line per event floods the console while drawing

function tokenOk(given: string | null) {
	const a = Buffer.from(given ?? "");
	const b = Buffer.from(token);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const touchSocket = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/touch") return socket.destroy();
	if (!tokenOk(url.searchParams.get("token"))) {
		socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		return;
	}
	touchSocket.handleUpgrade(req, socket, head, (ws) => touchSocket.emit("connection", ws, req));
});

// Screen stream: JPEG frames go out as binary messages over the same socket. The client acks each
// frame it has dealt with and we keep at most MAX_IN_FLIGHT unacked, so a slow Wi-Fi link drops
// frames instead of building up seconds of latency. A frame skipped for a busy client is parked in
// `pending` and sent on the next ack, so a static screen can never leave the client on a stale image.
const MAX_IN_FLIGHT = 2;
const ACK_TIMEOUT_MS = 1000;
interface Viewer {
	inFlight: number;
	sentAt: number;
	pending: Buffer | null;
}
const viewers = new Map<WebSocket, Viewer>();

function sendFrame(socket: WebSocket, viewer: Viewer, jpeg: Buffer) {
	const now = Date.now();
	if (viewer.inFlight >= MAX_IN_FLIGHT && now - viewer.sentAt > ACK_TIMEOUT_MS) viewer.inFlight = 0; // lost ack
	if (viewer.inFlight >= MAX_IN_FLIGHT) {
		viewer.pending = jpeg;
		return;
	}
	viewer.pending = null;
	viewer.inFlight++;
	viewer.sentAt = now;
	socket.send(jpeg, { binary: true });
}

const stream = startScreenStream({
	wanted: () => viewers.size > 0,
	onFrame: (jpeg) => {
		for (const [socket, viewer] of viewers) if (socket.readyState === WebSocket.OPEN) sendFrame(socket, viewer, jpeg);
	},
});

touchSocket.on("connection", (socket, req) => {
	const ip = req.socket.remoteAddress;
	console.log(`[touch] ${ip} connected`);
	const pen = createPen();
	const viewer: Viewer = { inFlight: 0, sentAt: 0, pending: null };
	viewers.set(socket, viewer);
	if (stream?.latest) sendFrame(socket, viewer, stream.latest);
	socket.on("message", (data, isBinary) => {
		if (isBinary) return;
		try {
			const msg = JSON.parse(data.toString());
			if (msg?.type === "ack") {
				viewer.inFlight = Math.max(0, viewer.inFlight - 1);
				if (viewer.pending) sendFrame(socket, viewer, viewer.pending);
				return;
			}
			if (logTouch) console.log(`[touch] ${ip}`, JSON.stringify(msg));
			if (msg && typeof msg === "object") pen?.handle(msg);
		} catch {
			// ignore malformed messages
		}
	});
	socket.on("close", () => {
		viewers.delete(socket);
		pen?.close();
		console.log(`[touch] ${ip} disconnected`);
	});
});