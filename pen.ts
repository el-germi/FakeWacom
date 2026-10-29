import koffi from "koffi";
import { getArea, getDesktopOrigin } from "./screen.ts";

// Windows pen injection (Windows 10 1809+): CreateSyntheticPointerDevice + InjectSyntheticPointerInput.
// Apps see a real Windows Ink pen with pressure/tilt. Apps that only speak the Wacom WinTab API won't.

const PT_PEN = 3;
const FEEDBACK_DEFAULT = 1;

const POINTER_FLAG = {
	NEW: 0x1,
	INRANGE: 0x2,
	INCONTACT: 0x4,
	FIRSTBUTTON: 0x10,
	SECONDBUTTON: 0x20,
	PRIMARY: 0x2000,
	CONFIDENCE: 0x4000,
	CANCELED: 0x8000,
	DOWN: 0x10000,
	UPDATE: 0x20000,
	UP: 0x40000,
};
const BASE = POINTER_FLAG.PRIMARY | POINTER_FLAG.CONFIDENCE;
const CHANGE = { NONE: 0, FIRSTBUTTON_DOWN: 1, FIRSTBUTTON_UP: 2 };
const PEN_FLAG = { BARREL: 0x1, INVERTED: 0x2, ERASER: 0x4 };
const PEN_MASK_ALL = 0x1 | 0x2 | 0x4 | 0x8; // pressure, rotation, tiltX, tiltY
const MAX_PRESSURE = 1024;

const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
const POINTER_INFO = koffi.struct("POINTER_INFO", {
	pointerType: "uint32",
	pointerId: "uint32",
	frameId: "uint32",
	pointerFlags: "uint32",
	sourceDevice: "void *",
	hwndTarget: "void *",
	ptPixelLocation: POINT,
	ptHimetricLocation: POINT,
	ptPixelLocationRaw: POINT,
	ptHimetricLocationRaw: POINT,
	dwTime: "uint32",
	historyCount: "uint32",
	inputData: "int32",
	dwKeyStates: "uint32",
	performanceCount: "uint64",
	buttonChangeType: "uint32",
});
const POINTER_PEN_INFO = koffi.struct("POINTER_PEN_INFO", {
	pointerInfo: POINTER_INFO,
	penFlags: "uint32",
	penMask: "uint32",
	pressure: "uint32",
	rotation: "uint32",
	tiltX: "int32",
	tiltY: "int32",
});
const POINTER_TOUCH_INFO = koffi.struct("POINTER_TOUCH_INFO", {
	pointerInfo: POINTER_INFO,
	touchFlags: "uint32",
	touchMask: "uint32",
	rcContact: RECT,
	rcContactRaw: RECT,
	orientation: "uint32",
	pressure: "uint32",
});
// The real C type is a union of touch and pen; Windows reads sizeof(union) bytes, so declare both.
const POINTER_TYPE_INFO = koffi.struct("POINTER_TYPE_INFO", {
	type: "uint32",
	data: koffi.union("POINTER_TYPE_INFO_DATA", { touchInfo: POINTER_TOUCH_INFO, penInfo: POINTER_PEN_INFO }),
});

export interface PenEvent {
	type: "down" | "move" | "up" | "cancel" | "leave";
	id: number;
	pointerType: string;
	x: number;
	y: number;
	pressure: number;
	tiltX: number;
	tiltY: number;
	twist: number;
	buttons: number;
}

export interface Pen {
	/** Handles one message from public/touch.js. */
	handle(msg: Record<string, unknown>): void;
	/** Lifts the pen and removes the synthetic device. */
	close(): void;
}

const num = (v: unknown, fallback: number, min: number, max: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function parseEvent(msg: Record<string, unknown>): PenEvent | null {
	const type = msg.type;
	if (type !== "down" && type !== "move" && type !== "up" && type !== "cancel" && type !== "leave") return null;
	return {
		type,
		id: num(msg.id, 0, -1e9, 1e9),
		pointerType: typeof msg.pointerType === "string" ? msg.pointerType : "touch",
		x: num(msg.x, 0, -1e6, 1e6),
		y: num(msg.y, 0, -1e6, 1e6),
		pressure: num(msg.pressure, 0, 0, 1),
		tiltX: Math.round(num(msg.tiltX, 0, -90, 90)),
		tiltY: Math.round(num(msg.tiltY, 0, -90, 90)),
		twist: Math.round(num(msg.twist, 0, 0, 359)),
		buttons: Math.round(num(msg.buttons, 0, 0, 0xffff)),
	};
}

/** Returns null (after logging why) when pen injection isn't available on this machine. */
export function createPen(): Pen | null {
	if (process.platform !== "win32") {
		console.warn("[pen] pen injection is Windows-only; streaming without it");
		return null;
	}

	const user32 = koffi.load("user32.dll");
	const kernel32 = koffi.load("kernel32.dll");
	const CreateSyntheticPointerDevice = user32.func(
		"void *CreateSyntheticPointerDevice(uint32 pointerType, uint32 maxCount, uint32 mode)",
	);
	const DestroySyntheticPointerDevice = user32.func("void DestroySyntheticPointerDevice(void *device)");
	const InjectSyntheticPointerInput = user32.func(
		"bool InjectSyntheticPointerInput(void *device, POINTER_TYPE_INFO *pointerInfo, uint32 count)",
	);
	const GetLastError = kernel32.func("uint32 GetLastError()");

	// The page's full surface maps onto this rectangle of the virtual desktop (shared with the screen stream).
	const area = getArea();
	const origin = getDesktopOrigin();

	const device = CreateSyntheticPointerDevice(PT_PEN, 1, FEEDBACK_DEFAULT);
	if (!device) {
		console.warn(`[pen] CreateSyntheticPointerDevice failed (error ${GetLastError()}); needs Windows 10 1809+`);
		return null;
	}

	let viewport = { w: 0, h: 0 };
	let owner: number | null = null; // pointer id currently driving the pen; others are ignored
	let inRange = false;
	let inContact = false;
	let warned = false;

	function inject(flags: number, ev: PenEvent, change: number, extraPenFlags = 0) {
		// Windows wants these relative to the desktop's top-left corner; negative values are dropped.
		const px = area.x - origin.x + Math.round(Math.min(1, Math.max(0, ev.x / viewport.w)) * (area.w - 1));
		const py = area.y - origin.y + Math.round(Math.min(1, Math.max(0, ev.y / viewport.h)) * (area.h - 1));
		const contact = (flags & POINTER_FLAG.INCONTACT) !== 0;
		// Touch screens report a flat 0.5 or 0 while touching; give them a usable mid pressure.
		const pressure = contact ? (ev.pressure > 0 ? ev.pressure : 0.5) : 0;
		const eraser = (ev.buttons & 32) !== 0;
		const barrel = (ev.buttons & 2) !== 0;
		const pt = { x: px, y: py };
		const ok = InjectSyntheticPointerInput(
			device,
			{
				type: PT_PEN,
				data: {
					penInfo: {
						pointerInfo: {
							pointerType: PT_PEN,
							pointerId: 1,
							frameId: 0,
							pointerFlags: flags | (barrel ? POINTER_FLAG.SECONDBUTTON : 0),
							sourceDevice: null,
							hwndTarget: null,
							ptPixelLocation: pt,
							ptHimetricLocation: { x: 0, y: 0 },
							ptPixelLocationRaw: pt,
							ptHimetricLocationRaw: { x: 0, y: 0 },
							dwTime: 0,
							historyCount: 1,
							inputData: 0,
							dwKeyStates: 0,
							performanceCount: 0n,
							buttonChangeType: change,
						},
						penFlags: (barrel ? PEN_FLAG.BARREL : 0) | (eraser ? PEN_FLAG.ERASER | PEN_FLAG.INVERTED : 0) | extraPenFlags,
						penMask: PEN_MASK_ALL,
						pressure: Math.round(pressure * MAX_PRESSURE),
						rotation: ev.twist,
						tiltX: ev.tiltX,
						tiltY: ev.tiltY,
					},
				},
			},
			1,
		);
		if (!ok && !warned) {
			warned = true;
			console.warn(`[pen] InjectSyntheticPointerInput failed (error ${GetLastError()}), flags 0x${flags.toString(16)}`);
		}
	}

	const enterRange = (ev: PenEvent) => {
		if (inRange) return;
		inject(BASE | POINTER_FLAG.NEW | POINTER_FLAG.INRANGE | POINTER_FLAG.UPDATE, ev, CHANGE.NONE);
		inRange = true;
	};

	const liftPen = (ev: PenEvent, canceled = false) => {
		if (!inContact) return;
		inject(BASE | POINTER_FLAG.INRANGE | POINTER_FLAG.UP | (canceled ? POINTER_FLAG.CANCELED : 0), ev, CHANGE.FIRSTBUTTON_UP);
		inContact = false;
	};

	const leaveRange = (ev: PenEvent) => {
		liftPen(ev);
		if (inRange) inject(BASE | POINTER_FLAG.UPDATE, ev, CHANGE.NONE);
		inRange = false;
		owner = null;
	};

	return {
		handle(msg) {
			if (msg.type === "hello") {
				viewport = { w: num(msg.width, 0, 0, 1e6), h: num(msg.height, 0, 0, 1e6) };
				return;
			}
			const ev = parseEvent(msg);
			if (!ev || !viewport.w || !viewport.h) return;

			switch (ev.type) {
				case "down":
					if (owner !== null && owner !== ev.id) return; // second finger / palm
					owner = ev.id;
					enterRange(ev);
					if (!inContact) {
						inject(BASE | POINTER_FLAG.INRANGE | POINTER_FLAG.INCONTACT | POINTER_FLAG.FIRSTBUTTON | POINTER_FLAG.DOWN, ev, CHANGE.FIRSTBUTTON_DOWN);
						inContact = true;
					}
					break;
				case "move":
					if (owner === null) {
						if (ev.pointerType === "touch") return; // touch only moves while down
						owner = ev.id; // pen/mouse hover
					}
					if (owner !== ev.id) return;
					enterRange(ev);
					inject(
						BASE | POINTER_FLAG.INRANGE | POINTER_FLAG.UPDATE | (inContact ? POINTER_FLAG.INCONTACT | POINTER_FLAG.FIRSTBUTTON : 0),
						ev,
						CHANGE.NONE,
					);
					break;
				case "up":
				case "cancel":
					if (owner !== ev.id) return;
					liftPen(ev, ev.type === "cancel");
					if (ev.pointerType === "touch") leaveRange(ev); // a finger can't hover
					break;
				case "leave":
					if (owner !== ev.id) return;
					leaveRange(ev);
					break;
			}
		},
		close() {
			if (viewport.w && viewport.h) {
				const ev: PenEvent = { type: "leave", id: owner ?? 0, pointerType: "pen", x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0, twist: 0, buttons: 0 };
				leaveRange(ev);
			}
			DestroySyntheticPointerDevice(device);
		},
	};
}
