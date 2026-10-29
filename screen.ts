import koffi, { type LibraryHandle } from "koffi";

// Windows GDI screen capture. The captured rectangle is the same one the pen maps onto,
// so what the browser shows lines up exactly with where the pen lands.

export interface Area {
	x: number;
	y: number;
	w: number;
	h: number;
}

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000; // include layered/transparent windows

let area: Area | null = null;
let desktopOrigin = { x: 0, y: 0 };

/**
 * Top-left of the virtual desktop (negative when a monitor sits left of or above the primary).
 * Pen injection takes coordinates relative to this point, not absolute screen coordinates.
 */
export function getDesktopOrigin() {
	getArea();
	return desktopOrigin;
}

/**
 * The rectangle of the virtual desktop (can start at negative x/y) the pad maps onto.
 * PAD_AREA: "primary" (default), "all" (every monitor), or "x,y,width,height".
 */
export function getArea(): Area {
	if (area) return area;
	const user32 = koffi.load("user32.dll");
	// Without this Windows hands us DPI-scaled coordinates and the pen/capture land in the wrong place.
	user32.func("bool SetProcessDPIAware()")();
	const metric = user32.func("int GetSystemMetrics(int index)");
	desktopOrigin = { x: metric(76), y: metric(77) };

	const spec = process.env.PAD_AREA ?? "primary";
	const parts = spec.split(",").map(Number);
	if (spec === "all") {
		area = { x: metric(76), y: metric(77), w: metric(78), h: metric(79) };
	} else if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
		area = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
	} else {
		area = { x: 0, y: 0, w: metric(0), h: metric(1) };
	}
	console.log(`[screen] pad area: x=${area.x} y=${area.y} ${area.w}x${area.h}`);
	return area;
}

export interface Capturer {
	width: number;
	height: number;
	/** Fills `into` (width*height*4 bytes, top-down BGRA) with the current pixels of the area. */
	grab(into: Buffer): Promise<void>;
}

// koffi runs `.async` calls on a worker thread, which keeps the 10-20 ms blits off the event loop
// (otherwise pen events would stall behind every frame).
function callAsync<T>(fn: ReturnType<LibraryHandle["func"]>, ...args: unknown[]): Promise<T> {
	return new Promise((resolve, reject) => {
		fn.async(...args, (err: Error | null, result: T) => (err ? reject(err) : resolve(result)));
	});
}

export function createCapturer(): Capturer {
	const { x, y, w, h } = getArea();
	const user32 = koffi.load("user32.dll");
	const gdi32 = koffi.load("gdi32.dll");

	const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
		biSize: "uint32",
		biWidth: "int32",
		biHeight: "int32",
		biPlanes: "uint16",
		biBitCount: "uint16",
		biCompression: "uint32",
		biSizeImage: "uint32",
		biXPelsPerMeter: "int32",
		biYPelsPerMeter: "int32",
		biClrUsed: "uint32",
		biClrImportant: "uint32",
	});

	const GetDC = user32.func("void *GetDC(void *hwnd)");
	const CreateCompatibleDC = gdi32.func("void *CreateCompatibleDC(void *hdc)");
	const CreateCompatibleBitmap = gdi32.func("void *CreateCompatibleBitmap(void *hdc, int w, int h)");
	const SelectObject = gdi32.func("void *SelectObject(void *hdc, void *obj)");
	const BitBlt = gdi32.func("bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)");
	const GetDIBits = gdi32.func(
		"int GetDIBits(void *hdc, void *bitmap, uint32 start, uint32 lines, void *bits, BITMAPINFOHEADER *info, uint32 usage)",
	);

	const screenDC = GetDC(null);
	const memDC = CreateCompatibleDC(screenDC);
	const bitmap = CreateCompatibleBitmap(screenDC, w, h);
	const oldBitmap = SelectObject(memDC, bitmap);
	const info = {
		biSize: 40,
		biWidth: w,
		biHeight: -h, // negative = top-down rows
		biPlanes: 1,
		biBitCount: 32,
		biCompression: 0, // BI_RGB
		biSizeImage: w * h * 4,
		biXPelsPerMeter: 0,
		biYPelsPerMeter: 0,
		biClrUsed: 0,
		biClrImportant: 0,
	};

	return {
		width: w,
		height: h,
		async grab(into) {
			if (into.length < w * h * 4) throw new Error("capture buffer too small");
			await callAsync(BitBlt, memDC, 0, 0, w, h, screenDC, x, y, SRCCOPY | CAPTUREBLT);
			// GetDIBits requires the bitmap not be selected into a DC.
			SelectObject(memDC, oldBitmap);
			try {
				const lines = await callAsync<number>(GetDIBits, screenDC, bitmap, 0, h, into, info, 0);
				if (lines !== h) throw new Error(`GetDIBits returned ${lines} of ${h} lines`);
			} finally {
				SelectObject(memDC, bitmap);
			}
		},
	};
}
