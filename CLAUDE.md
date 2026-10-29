# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows-only "remote drawing tablet": a phone/tablet opens the page in a browser, sees a live JPEG stream of the PC's screen, and its touch/pen input is injected on the PC as a real Windows Ink pen (pressure, tilt, eraser, barrel button).

## Commands

- `npm start` runs `node --watch a.ts`. Node 24 runs the `.ts` files directly through type stripping, so there is no build step. Imports therefore use explicit `.ts` extensions, and the code sticks to erasable TypeScript syntax (`verbatimModuleSyntax`, no enums or namespaces).
- There are no tests and no lint setup. `tsconfig.json` is `noEmit` and only used for type checking, but `typescript` isn't installed; use `npx -p typescript tsc` to type-check.
- Open the pad at `http://<pc-ip>:3000/?token=<token>`. The token comes from `PAD_TOKEN`, or from `.pad-token`, which is generated on first run.

Environment variables:

- `PORT` (default 3000) and `HOST` (default `0.0.0.0`). It binds to all interfaces on purpose so devices on the LAN can reach it.
- `PAD_AREA`: `primary` (default), `all`, or `x,y,w,h` in virtual-desktop pixels.
- `PAD_STREAM_WIDTH`, `PAD_STREAM_QUALITY`, `PAD_STREAM_FPS`: JPEG stream tuning.
- `TOUCH_LOG=1` logs every input event.

## Architecture

The modules call Win32 directly through **koffi** FFI (user32/gdi32/kernel32). They have no native addon of their own.

- [a.ts](a.ts) is the Express server and serves `public/`. One WebSocket at `/touch`, authorized by the token, carries both directions:
  - client → server: JSON text messages. `hello` sends the viewport size, pointer events go to that connection's pen, and `ack` acknowledges a frame.
  - server → client: binary JPEG frames. Flow control allows `MAX_IN_FLIGHT` unacked frames per viewer. When the client is busy, the newest frame is parked in `pending` and sent on the next ack, so a slow link drops frames instead of adding latency, and a static screen never leaves a stale image.
  - It also logs visitor headers and what `public/client-info.js` posts to `/__client-info`.
- [screen.ts](screen.ts): `getArea()` picks the capture rectangle **and** the rectangle the pen maps onto. Both use the same rectangle, so the image lines up with where the pen lands. It calls `SetProcessDPIAware()` first; without it, coordinates come back DPI-scaled. The GDI capturer uses BitBlt + GetDIBits, run through koffi `.async` on a worker thread so that capture doesn't block pen events.
- [stream.ts](stream.ts): the capture loop. It runs only while a viewer exists (`wanted()`), skips identical frames, and encodes frame N with sharp while it captures frame N+1. It swaps BGRA→RGB with `recomb`.
- [pen.ts](pen.ts): one synthetic pen device per connection (`CreateSyntheticPointerDevice`/`InjectSyntheticPointerInput`, Windows 10 1809+). Notes on how it behaves:
  - Client coordinates are scaled from the `hello` viewport to the pad area, then offset relative to the virtual-desktop origin. That origin can be negative on multi-monitor setups.
  - The first pointer id to go down owns the pen, and others are ignored, which rejects palms and second fingers. A touch leaves range on lift because a finger can't hover; pen and mouse can hover.
  - Struct layouts mirror the Win32 headers exactly. `POINTER_TYPE_INFO` must declare the touch/pen union because Windows reads `sizeof(union)`.
  - Apps that only use WinTab won't see this pen.
- `public/`: the client. **It is ES5 on purpose** (`var`, no arrow functions, XHR) so that IE11 on Windows RT can run it. Keep it that way. [public/touch.js](public/touch.js) uses Pointer Events (including coalesced events) and falls back to Touch Events. It shows only the newest frame on a full-window canvas and acks every frame, whether shown or dropped.
