import sharp, { type Matrix3x3 } from "sharp";
import { createCapturer } from "./screen.ts";

// Captures the pad area and emits JPEG frames. Tunables (env):
//   PAD_STREAM_WIDTH    output width in px, default 1280 (never upscales)
//   PAD_STREAM_QUALITY  JPEG quality 1-100, default 60
//   PAD_STREAM_FPS      frame cap, default 30
const outWidth = Number(process.env.PAD_STREAM_WIDTH ?? 1280);
const quality = Number(process.env.PAD_STREAM_QUALITY ?? 60);
const fps = Number(process.env.PAD_STREAM_FPS ?? 30);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScreenStream {
	/** Most recent frame, so a new viewer sees the screen even when nothing is changing. */
	latest: Buffer | null;
}

// Windows captures BGRA but libvips reads raw 4-channel data as RGBA, so swap R and B.
const swapRedBlue: Matrix3x3 = [
	[0, 0, 1],
	[0, 1, 0],
	[1, 0, 0],
];

export function encodeFrame(raw: Buffer, width: number, height: number): Promise<Buffer> {
	let image = sharp(raw, { raw: { width, height, channels: 4 } });
	if (width > outWidth) image = image.resize({ width: outWidth, kernel: "linear" });
	return image.recomb(swapRedBlue).removeAlpha().jpeg({ quality, chromaSubsampling: "4:2:0" }).toBuffer();
}

/** Returns null (after logging why) when screen capture isn't available. */
export function startScreenStream(opts: {
	/** Capturing pauses while this is false, so an idle server costs nothing. */
	wanted: () => boolean;
	onFrame: (jpeg: Buffer) => void;
}): ScreenStream | null {
	if (process.platform !== "win32") {
		console.warn("[stream] screen capture is Windows-only; not streaming the screen");
		return null;
	}

	const capturer = createCapturer();
	const stream: ScreenStream = { latest: null };
	const interval = 1000 / fps;
	const size = capturer.width * capturer.height * 4;
	let current = Buffer.allocUnsafe(size);
	let previous = Buffer.allocUnsafe(size);
	let havePrevious = false;
	// Encoding of `previous` runs while the next frame is captured into `current`, so the frame
	// rate is limited by the slower of the two steps instead of their sum.
	let encoding: Promise<void> = Promise.resolve();

	(async () => {
		while (true) {
			const started = performance.now();
			if (!opts.wanted()) {
				havePrevious = false; // the next viewer gets a fresh frame even if nothing changed
				await sleep(200);
				continue;
			}
			try {
				await capturer.grab(current);
				// Idle desktop: skip encoding and sending identical frames.
				if (!havePrevious || !current.equals(previous)) {
					await encoding; // keeps frames in order and frees the buffer we swap in as `current`
					const frame = current;
					encoding = encodeFrame(frame, capturer.width, capturer.height).then(
						(jpeg) => {
							stream.latest = jpeg;
							opts.onFrame(jpeg);
						},
						(err) => console.warn("[stream] encode failed:", err instanceof Error ? err.message : err),
					);
					[current, previous] = [previous, current];
					havePrevious = true;
				}
			} catch (err) {
				console.warn("[stream] frame failed:", err instanceof Error ? err.message : err);
				await sleep(1000);
			}
			await sleep(Math.max(0, interval - (performance.now() - started)));
		}
	})();

	return stream;
}
